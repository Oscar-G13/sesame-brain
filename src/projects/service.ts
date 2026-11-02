import {validateSourceRefs} from '../brain/memory.js';
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod/v4';
import {pool,transaction} from '../db/index.js';
import {ToolError,type AuthContext} from '../tools/service.js';

export const projectTypes=['constraint','decision','question','milestone','task','artifact'] as const;
const statuses=['proposed','confirmed','in_progress','blocked','done','superseded'] as const;
const uuid=z.string().uuid();
const audience=z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).min(1).max(32).transform(v=>[...new Set(v)]);
export const sourceRefSchema=z.object({kind:z.enum(['fact','note','snapshot','handoff','job','project_item','url','statement']),id:uuid.optional(),url:z.string().url().max(2048).optional(),label:z.string().max(240).optional(),excerpt:z.string().max(1200).optional()}).strict().superRefine((r,c)=>{
 if(r.kind==='url'){try{const u=new URL(r.url??'');if(u.protocol!=='https:'||u.username||u.password)throw Error();}catch{c.addIssue({code:'custom',message:'A source link must be HTTPS without credentials.'});}}
 else if(r.kind!=='statement'&&!r.id)c.addIssue({code:'custom',message:'Saved evidence needs a record ID.'});
});
export type SourceRef=z.infer<typeof sourceRefSchema>;
const refs=z.array(sourceRefSchema).max(24).default([]);
const mutation={project_id:uuid,expected_version:z.number().int().min(1),request_id:uuid.optional()};
export const createProjectSchema=z.object({title:z.string().trim().min(1).max(160),goal:z.string().max(12000).default(''),allowed_agents:audience.default(['all']),request_id:uuid.optional()}).strict();
export const addItemSchema=z.object({...mutation,type:z.enum(projectTypes),title:z.string().trim().min(1).max(200),content:z.string().max(32000).default(''),status:z.enum(statuses).default('proposed'),source_type:z.enum(['user_statement','assistant_summary','inference','tool_result']).default('assistant_summary'),source_refs:refs,depends_on:z.array(uuid).max(30).default([])}).strict();
export const updateItemSchema=z.object({...mutation,item_id:uuid,title:z.string().trim().min(1).max(200).optional(),content:z.string().max(32000).optional(),status:z.enum(statuses).optional(),reason:z.string().trim().min(1).max(2000),source_refs:z.array(sourceRefSchema).max(24).optional(),depends_on:z.array(uuid).max(30).optional()}).strict();
export const approveItemSchema=z.object({...mutation,item_id:uuid,decision:z.enum(['approve','dispute']),reason:z.string().max(2000).default('')}).strict();
export const updateProjectSchema=z.object({...mutation,title:z.string().trim().min(1).max(160).optional(),goal:z.string().max(12000).optional(),status:z.enum(['active','paused','completed','archived']).optional(),allowed_agents:audience.optional(),reason:z.string().trim().min(1).max(2000)}).strict();
export type ProjectIdentity=AuthContext;
export interface Project {id:string;user_id:string;brain_id:string;title:string;goal:string;summary:string;status:string;version:number;allowed_agents:string[];created_by:string;created_at:Date;updated_at:Date;needs_review_count:number;item_counts:Record<string,number>;}
export interface ProjectItem {id:string;project_id:string;type:typeof projectTypes[number];title:string;content:string;status:typeof statuses[number];confirmation:'proposed'|'confirmed'|'disputed';revision:number;needs_review:boolean;source_type:string;source_refs:SourceRef[];pending_change:Record<string,unknown>|null;created_by:string;updated_by:string;created_at:Date;updated_at:Date;}
export interface ProjectLink {from_item_id:string;to_item_id:string;kind:'depends_on';}
export interface ProjectEvent {id:string;version:number;kind:string;actor_agent:string;summary:string;created_at:Date;item_id:string|null;source_refs:SourceRef[];before:unknown;after:unknown;}
export interface ProjectSnapshot {project:Project;items:ProjectItem[];links:ProjectLink[];events:ProjectEvent[];receipts:{agent_label:string;last_seen_version:number;last_seen_at:Date}[];receipt:{last_seen_version:number;current_version:number;agent_label:string;received_at:Date|null};changed:boolean;}
const owner=(a:AuthContext)=>a.client_id==='dashboard'&&Boolean(a.browser_session_id)||(a as AuthContext&{owner_access?:boolean}).owner_access===true;
function subset(narrow:string[],wide:string[]){return wide.includes('all')||!narrow.includes('all')&&narrow.every(label=>wide.includes(label));}
async function authorize(db:pg.PoolClient,a:AuthContext,write:boolean){
 if(!a.scopes.includes('brain:read')||write&&!a.scopes.includes('brain:write'))throw new ToolError('insufficient_scope',403);
 if(!(await db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[a.user_id])).rowCount)throw new ToolError('Account not available.',401);
 const b=(await db.query('SELECT content_epoch FROM brains WHERE id=$1 AND user_id=$2 '+(write?'FOR UPDATE':'FOR SHARE'),[a.brain_id,a.user_id])).rows[0];if(!b)throw new ToolError('Brain not found.',404);
 if(a.expected_content_epoch!==undefined&&Number(b.content_epoch)!==a.expected_content_epoch)throw new ToolError('Brain reset; work stopped.',409);
 if(a.client_id==='dashboard'&&a.browser_session_id){
  if((await db.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>now()',[a.browser_session_id,a.user_id])).rowCount)return;
 }else if(a.client_id==='brain-worker'&&a.token_hash.startsWith('job:')){
  const j=(await db.query("SELECT j.owner_requested,j.request_grant_id,g.revoked_at,g.scope FROM jobs j LEFT JOIN grants g ON g.id=j.request_grant_id WHERE j.id=$1 AND j.user_id=$2 AND j.brain_id=$3 AND j.state='running' AND j.content_epoch=$4 AND j.requested_by_agent=$5",[a.token_hash.slice(4),a.user_id,a.brain_id,b.content_epoch,a.agent_label])).rows[0];
  if(j&&(j.owner_requested&&owner(a)||j.request_grant_id&&!j.revoked_at&&!owner(a)&&String(j.scope).split(/\s+/).includes(write?'brain:write':'brain:read')))return;
 }else{
  const g=(await db.query('SELECT scope FROM grants WHERE id=$1 AND user_id=$2 AND brain_id=$3 AND agent_label=$4 AND revoked_at IS NULL',[a.grant_id,a.user_id,a.brain_id,a.agent_label])).rows[0];
  if(g&&!owner(a)&&String(g.scope).split(/\s+/).includes(write?'brain:write':'brain:read'))return;
 }
 throw new ToolError('This connection is no longer authorized.',401);
}
async function load(db:pg.PoolClient,a:AuthContext,id:string,write=false):Promise<Project>{
 uuid.parse(id);await authorize(db,a,write);
 const row=(await db.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2 AND brain_id=$3'+(write?' FOR UPDATE':''),[id,a.user_id,a.brain_id])).rows[0];
 if(!row||!owner(a)&&!row.allowed_agents.includes('all')&&(a.agent_label==='you'||!row.allowed_agents.includes(a.agent_label)))throw new ToolError('Project not found.',404);return row;
}
const eventColumns='id,version,kind,actor_agent,summary,created_at,item_id,source_refs,before,after';
async function snapshot(db:pg.PoolClient,a:AuthContext,p:Project,sinceVersion?:number,acknowledge=false):Promise<ProjectSnapshot>{
 const params=[p.id,a.user_id,a.brain_id];
 const items=(await db.query('SELECT * FROM project_items WHERE project_id=$1 AND user_id=$2 AND brain_id=$3 ORDER BY created_at,id',params)).rows as ProjectItem[];
 const links=(await db.query('SELECT from_item_id,to_item_id,kind FROM project_links WHERE project_id=$1 AND user_id=$2 AND brain_id=$3',params)).rows as ProjectLink[];
 const events=(await db.query('SELECT '+eventColumns+' FROM project_events WHERE project_id=$1 AND user_id=$2 AND brain_id=$3 AND version>$4 ORDER BY version DESC LIMIT 200',[...params,sinceVersion??0])).rows as ProjectEvent[];
 const key=owner(a)?'owner':a.grant_id||a.agent_label;
 const old=(await db.query('SELECT last_seen_version,received_at FROM project_receipts WHERE project_id=$1 AND user_id=$2 AND brain_id=$3 AND grant_key=$4',[...params,key])).rows[0];
 if(acknowledge)await db.query('INSERT INTO project_receipts(project_id,user_id,brain_id,grant_key,agent_label,last_seen_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,grant_key) DO UPDATE SET last_seen_version=EXCLUDED.last_seen_version,received_at=now(),agent_label=EXCLUDED.agent_label',[...params,key,a.agent_label,p.version]);
 const receipts=(await db.query('SELECT DISTINCT ON(agent_label) agent_label,last_seen_version,received_at AS last_seen_at FROM project_receipts WHERE project_id=$1 ORDER BY agent_label,last_seen_version DESC,received_at DESC',[p.id])).rows;
 const counts:Record<string,number>={};for(const item of items)counts[item.type]=(counts[item.type]??0)+1;
 return{project:{...p,needs_review_count:items.filter(i=>i.needs_review||i.confirmation==='disputed').length,item_counts:counts},items,links,events,receipts,receipt:{last_seen_version:Number(old?.last_seen_version??0),current_version:p.version,agent_label:a.agent_label,received_at:old?.received_at??null},changed:sinceVersion===undefined||p.version>sinceVersion};
}
export async function listProjects(a:AuthContext):Promise<Project[]>{
 return transaction(async db=>{await authorize(db,a,false);const rows=(await db.query("SELECT p.*,count(i.id) FILTER(WHERE i.needs_review OR i.confirmation='disputed')::int AS needs_review_count FROM projects p LEFT JOIN project_items i ON i.project_id=p.id AND i.user_id=p.user_id AND i.brain_id=p.brain_id WHERE p.user_id=$1 AND p.brain_id=$2 AND ($4::boolean OR 'all'=ANY(p.allowed_agents) OR ($3<>'you' AND $3=ANY(p.allowed_agents))) GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 100",[a.user_id,a.brain_id,a.agent_label,owner(a)])).rows;return rows.map(row=>({...row,item_counts:{}}));});
}
export async function getProject(a:AuthContext,id:string,options:{sinceVersion?:number;acknowledge?:boolean}={}):Promise<ProjectSnapshot>{
 return transaction(async db=>snapshot(db,a,await load(db,a,id,Boolean(options.acknowledge)),options.sinceVersion,options.acknowledge));
}
async function event(db:pg.PoolClient,a:AuthContext,p:Project,kind:string,summary:string,o:{item_id?:string;source_refs?:SourceRef[];before?:unknown;after?:unknown;request_id?:string;request_hash?:string}={}){
 await db.query('INSERT INTO project_events(project_id,user_id,brain_id,version,kind,actor_agent,summary,item_id,source_refs,before,after,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[p.id,a.user_id,a.brain_id,p.version,kind,a.agent_label,summary,o.item_id??null,JSON.stringify(o.source_refs??[]),o.before===undefined?null:JSON.stringify(o.before),o.after===undefined?null:JSON.stringify(o.after),o.request_id??null,o.request_hash??null]);
 await db.query("INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id,metadata) VALUES($1,$2,$3,'project_changed',$4,$5)",[a.user_id,a.brain_id,a.agent_label,p.id,{project_id:p.id,project_version:p.version,kind}]);
 await db.query('UPDATE brains SET memory_version=memory_version+1 WHERE id=$1 AND user_id=$2',[a.brain_id,a.user_id]);
}
async function bump(db:pg.PoolClient,p:Project):Promise<Project>{return(await db.query('UPDATE projects SET version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2 AND brain_id=$3 RETURNING *',[p.id,p.user_id,p.brain_id])).rows[0];}
function requestHash(action:string,input:unknown){return createHash('sha256').update(action+'\n'+JSON.stringify(input)).digest('hex');}
async function replay(db:pg.PoolClient,p:Project,id:string|undefined,hash:string){
 if(!id)return false;const row=(await db.query('SELECT request_hash FROM project_events WHERE project_id=$1 AND request_id=$2',[p.id,id])).rows[0];
 if(row&&row.request_hash!==hash)throw new ToolError('This retry ID was used for a different change. Use a new request ID.',409);return Boolean(row);
}
function expectVersion(p:Project,v:number){if(p.version!==v)throw new ToolError('This project changed. Refresh it and review the newer version before saving.',409);}
async function validateSources(db:pg.PoolClient,a:AuthContext,p:Project,sourceRefs:SourceRef[]){
 for(const ref of sourceRefs){
  if(ref.kind==='url'||ref.kind==='statement')continue;
  const table={fact:'facts',note:'notes',snapshot:'snapshots',handoff:'handoffs',job:'jobs',project_item:'project_items'}[ref.kind]!;
  const row=(await db.query('SELECT * FROM '+table+' WHERE id=$1 AND user_id=$2 AND brain_id=$3',[ref.id,a.user_id,a.brain_id])).rows[0];
  if(!row)throw new ToolError('One of the evidence records is unavailable.',404);
  let allowed:string[];
  try{const evidence=await validateSourceRefs(db,a,[{collection:table,id:ref.id}]);allowed=evidence.audience;}
  catch{throw new ToolError('One of the evidence records is unavailable.',404);}
  if(!subset(p.allowed_agents,allowed))throw new ToolError('This evidence has a narrower audience. Restrict the project before attaching it.',409);
  if(ref.excerpt&&!String(row.value??row.text??row.content??row.context??row.result_text??'').includes(ref.excerpt))throw new ToolError('The excerpt must match the saved source exactly.',400);
 }
}
async function dependencies(db:pg.PoolClient,a:AuthContext,p:Project,itemId:string,ids:string[]){
 for(const id of [...new Set(ids)]){
  if(id===itemId)throw new ToolError('An item cannot depend on itself.',400);
  if(!(await db.query('SELECT id FROM project_items WHERE id=$1 AND project_id=$2 AND user_id=$3 AND brain_id=$4',[id,p.id,a.user_id,a.brain_id])).rowCount)throw new ToolError('Dependency not found in this project.',404);
  const cycle=await db.query('WITH RECURSIVE route(id) AS (SELECT to_item_id FROM project_links WHERE from_item_id=$1 AND project_id=$2 UNION SELECT l.to_item_id FROM project_links l JOIN route r ON l.from_item_id=r.id WHERE l.project_id=$2) SELECT id FROM route WHERE id=$3',[id,p.id,itemId]);
  if(cycle.rowCount)throw new ToolError('Dependencies must not contain a cycle.',400);
 }
 await db.query('DELETE FROM project_links WHERE project_id=$1 AND from_item_id=$2',[p.id,itemId]);
 for(const id of [...new Set(ids)])await db.query('INSERT INTO project_links(project_id,user_id,brain_id,from_item_id,to_item_id) VALUES($1,$2,$3,$4,$5)',[p.id,a.user_id,a.brain_id,itemId,id]);
}
async function invalidate(db:pg.PoolClient,p:Project,itemId:string){
 return(await db.query("WITH RECURSIVE affected(id) AS (SELECT from_item_id FROM project_links WHERE project_id=$1 AND to_item_id=$2 UNION SELECT l.from_item_id FROM project_links l JOIN affected a ON l.to_item_id=a.id WHERE l.project_id=$1) UPDATE project_items SET needs_review=true,updated_at=now() WHERE project_id=$1 AND id IN(SELECT id FROM affected) AND status<>'superseded' RETURNING id,title",[p.id,itemId])).rows;
}

export async function createProject(a:AuthContext,input:z.input<typeof createProjectSchema>):Promise<Project>{
 const v=createProjectSchema.parse(input);
 return transaction(async db=>{
  await authorize(db,a,true);
  if(!owner(a)&&!v.allowed_agents.includes('all')&&!v.allowed_agents.includes(a.agent_label))throw new ToolError('Include your assistant in the project audience.',400);
  const sourceAudience=(a as AuthContext&{source_audience?:string[]}).source_audience;
  if(sourceAudience&&!subset(v.allowed_agents,sourceAudience))throw new ToolError('The project audience must respect the supplied memory audience.',403);
  if(v.request_id){const old=(await db.query("SELECT p.*,e.request_hash FROM project_events e JOIN projects p ON p.id=e.project_id WHERE e.user_id=$1 AND e.brain_id=$2 AND e.request_id=$3 AND e.kind='project_created'",[a.user_id,a.brain_id,v.request_id])).rows[0];if(old){if(old.request_hash!==requestHash('createProject',v))throw new ToolError('This retry ID was used for a different project. Use a new request ID.',409);return await load(db,a,old.id);}}
  if(Number((await db.query('SELECT count(*) AS n FROM projects WHERE user_id=$1 AND brain_id=$2',[a.user_id,a.brain_id])).rows[0].n)>=100)throw new ToolError('This brain has reached its 100-project limit.',429);
  const p=(await db.query('INSERT INTO projects(user_id,brain_id,title,goal,allowed_agents,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.user_id,a.brain_id,v.title,v.goal,v.allowed_agents,a.agent_label])).rows[0] as Project;
  await event(db,a,p,'project_created','Started '+p.title,{after:{title:p.title,goal:p.goal,allowed_agents:p.allowed_agents},request_id:v.request_id,request_hash:requestHash('createProject',v)});
  return{...p,needs_review_count:0,item_counts:{}};
 });
}
export async function addItem(a:AuthContext,input:z.input<typeof addItemSchema>):Promise<ProjectSnapshot>{
 const v=addItemSchema.parse(input);
 return transaction(async db=>{
  let p=await load(db,a,v.project_id,true);if(await replay(db,p,v.request_id,requestHash('addItem',v)))return snapshot(db,a,p);expectVersion(p,v.expected_version);
  if(p.status==='archived')throw new ToolError('Reopen the project before changing it.',409);
  if(Number((await db.query('SELECT count(*) AS n FROM project_items WHERE project_id=$1',[p.id])).rows[0].n)>=300)throw new ToolError('This project has reached its 300-item limit.',429);
  await validateSources(db,a,p,v.source_refs);
  const sourceAudience=(a as AuthContext&{source_audience?:string[]}).source_audience;if(sourceAudience&&!subset(p.allowed_agents,sourceAudience))throw new ToolError('This project is shared more widely than the source memory.',403);
  const status=v.status==='confirmed'&&!owner(a)?'proposed':v.status;
  const confirmed=owner(a)&&status==='confirmed';
  const row=(await db.query('INSERT INTO project_items(project_id,user_id,brain_id,type,title,content,status,confirmation,source_type,source_refs,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *',[p.id,a.user_id,a.brain_id,v.type,v.title,v.content,status,confirmed?'confirmed':'proposed',owner(a)&&v.source_type==='assistant_summary'?'user_statement':v.source_type,JSON.stringify(v.source_refs),a.agent_label])).rows[0];
  await dependencies(db,a,p,row.id,v.depends_on);p=await bump(db,p);
  await event(db,a,p,'item_added','Added '+v.type+': '+v.title,{item_id:row.id,after:{...row,depends_on:v.depends_on},source_refs:v.source_refs,request_id:v.request_id,request_hash:requestHash('addItem',v)});return snapshot(db,a,p);
 });
}
export async function updateItem(a:AuthContext,input:z.input<typeof updateItemSchema>):Promise<ProjectSnapshot>{
 const v=updateItemSchema.parse(input);
 return transaction(async db=>{
  let p=await load(db,a,v.project_id,true);if(await replay(db,p,v.request_id,requestHash('updateItem',v)))return snapshot(db,a,p);expectVersion(p,v.expected_version);
  if(p.status==='archived')throw new ToolError('Reopen the project before changing it.',409);
  const old=(await db.query('SELECT * FROM project_items WHERE id=$1 AND project_id=$2 FOR UPDATE',[v.item_id,p.id])).rows[0];if(!old)throw new ToolError('Project item not found.',404);
  const sourceRefs=v.source_refs??old.source_refs;await validateSources(db,a,p,sourceRefs);
  const sourceAudience=(a as AuthContext&{source_audience?:string[]}).source_audience;if(sourceAudience&&!subset(p.allowed_agents,sourceAudience))throw new ToolError('This project is shared more widely than the source memory.',403);
  const substantive=v.content!==undefined&&v.content!==old.content||v.title!==undefined&&v.title!==old.title||v.status!==undefined&&v.status!==old.status||v.source_refs!==undefined&&JSON.stringify(v.source_refs)!==JSON.stringify(old.source_refs)||v.depends_on!==undefined;
  if(substantive&&old.confirmation==='confirmed'&&!owner(a)){
   const pending={title:v.title??old.title,content:v.content??old.content,status:v.status??old.status,source_refs:sourceRefs,reason:v.reason,proposed_by:a.agent_label,proposed_at:new Date().toISOString(),depends_on:v.depends_on};
   await db.query('UPDATE project_items SET pending_change=$3,needs_review=true,updated_at=now() WHERE id=$1 AND project_id=$2',[v.item_id,p.id,JSON.stringify(pending)]);
   p=await bump(db,p);await event(db,a,p,'change_proposed',v.reason,{item_id:v.item_id,before:old,after:{...old,pending_change:pending,needs_review:true},source_refs:sourceRefs,request_id:v.request_id,request_hash:requestHash('updateItem',v)});return snapshot(db,a,p);
  }
  const status=v.status??old.status;if(status==='confirmed'&&!owner(a)&&old.confirmation!=='confirmed')throw new ToolError('Only the owner can confirm a proposal.',403);
  const confirmation=substantive?'proposed':old.confirmation;
  const row=(await db.query('UPDATE project_items SET title=$3,content=$4,status=$5,confirmation=$6,source_refs=$7,revision=revision+1,updated_by=$8,updated_at=now(),needs_review=$9 WHERE id=$1 AND project_id=$2 RETURNING *',[v.item_id,p.id,v.title??old.title,v.content??old.content,status,confirmation,JSON.stringify(sourceRefs),a.agent_label,substantive?true:old.needs_review])).rows[0];
  if(v.depends_on)await dependencies(db,a,p,v.item_id,v.depends_on);
  const affected=substantive||v.depends_on!==undefined||v.status==='superseded'?await invalidate(db,p,v.item_id):[];p=await bump(db,p);
  await event(db,a,p,'item_updated',v.reason,{item_id:v.item_id,before:old,after:{...row,affected_items:affected},source_refs:sourceRefs,request_id:v.request_id,request_hash:requestHash('updateItem',v)});return snapshot(db,a,p);
 });
}
export async function approveItem(a:AuthContext,input:z.input<typeof approveItemSchema>):Promise<ProjectSnapshot>{
 const v=approveItemSchema.parse(input);
 return transaction(async db=>{
  let p=await load(db,a,v.project_id,true);if(p.status==='archived')throw new ToolError('Reopen the project before reviewing it.',409);if(!owner(a))throw new ToolError('Only the project owner can confirm or dispute information.',403);
  if(await replay(db,p,v.request_id,requestHash('approveItem',v)))return snapshot(db,a,p);expectVersion(p,v.expected_version);
  const old=(await db.query('SELECT * FROM project_items WHERE id=$1 AND project_id=$2',[v.item_id,p.id])).rows[0];if(!old)throw new ToolError('Project item not found.',404);
  if(old.pending_change){
   const change=old.pending_change;const accepted=v.decision==='approve';
   await validateSources(db,a,p,accepted?change.source_refs:old.source_refs);
   const changed=(await db.query('UPDATE project_items SET title=$3,content=$4,source_refs=$5,pending_change=NULL,confirmation=$6,status=$8,needs_review=false,revision=revision+1,updated_by=$7,updated_at=now() WHERE id=$1 AND project_id=$2 RETURNING *',[v.item_id,p.id,accepted?change.title:old.title,accepted?change.content:old.content,JSON.stringify(accepted?change.source_refs:old.source_refs),old.confirmation,a.agent_label,accepted?(change.status??old.status):old.status])).rows[0];
   if(accepted&&change.depends_on)await dependencies(db,a,p,v.item_id,change.depends_on);
   const affected=accepted?await invalidate(db,p,v.item_id):[];p=await bump(db,p);
   await event(db,a,p,accepted?'change_approved':'change_rejected',v.reason||(accepted?'Owner accepted change: ':'Owner rejected change: ')+old.title,{item_id:v.item_id,before:old,after:{...changed,affected_items:affected},source_refs:changed.source_refs,request_id:v.request_id,request_hash:requestHash('approveItem',v)});return snapshot(db,a,p);
  }
  const row=(await db.query("UPDATE project_items SET confirmation=$3,status=CASE WHEN $3='confirmed' AND status='proposed' THEN 'confirmed' ELSE status END,needs_review=$4,revision=revision+1,updated_by=$5,updated_at=now() WHERE id=$1 AND project_id=$2 RETURNING *",[v.item_id,p.id,v.decision==='approve'?'confirmed':'disputed',v.decision!=='approve',a.agent_label])).rows[0];
  const affected=v.decision==='dispute'?await invalidate(db,p,v.item_id):[];p=await bump(db,p);
  await event(db,a,p,v.decision==='approve'?'item_confirmed':'item_disputed',v.reason||(v.decision==='approve'?'Owner confirmed: ':'Owner disputed: ')+old.title,{item_id:v.item_id,before:old,after:{...row,affected_items:affected},source_refs:row.source_refs,request_id:v.request_id,request_hash:requestHash('approveItem',v)});return snapshot(db,a,p);
 });
}
export async function updateProject(a:AuthContext,input:z.input<typeof updateProjectSchema>):Promise<ProjectSnapshot>{
 const v=updateProjectSchema.parse(input);
 return transaction(async db=>{
  let p=await load(db,a,v.project_id,true);if(await replay(db,p,v.request_id,requestHash('updateProject',v)))return snapshot(db,a,p);expectVersion(p,v.expected_version);
  if(a.source_audience&&!subset(p.allowed_agents,a.source_audience))throw new ToolError('This project is shared more widely than the source memory.',403);
  if(v.allowed_agents&&!owner(a))throw new ToolError('Only the owner can change project access.',403);
  if(v.allowed_agents&&!subset(v.allowed_agents,p.allowed_agents))throw new ToolError('This project history has a narrower audience. Create a new shared project with reviewed information instead.',409);
  const before={...p};p=(await db.query('UPDATE projects SET title=$2,goal=$3,status=$4,allowed_agents=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[p.id,v.title??p.title,v.goal??p.goal,v.status??p.status,v.allowed_agents??p.allowed_agents])).rows[0];
  if(v.goal!==undefined&&v.goal!==before.goal)await db.query("UPDATE project_items SET needs_review=true WHERE project_id=$1 AND status<>'superseded'",[p.id]);
  if(v.status==='archived')await db.query("UPDATE jobs SET state='failed',finished_at=now(),error='The project was archived.' WHERE project_id=$1 AND state IN ('queued','running')",[p.id]);
  await event(db,a,p,'project_updated',v.reason,{before,after:p,request_id:v.request_id,request_hash:requestHash('updateProject',v)});return snapshot(db,a,p);
 });
}
export async function projectHistory(a:AuthContext,id:string,beforeVersion?:number):Promise<ProjectEvent[]>{
 return transaction(async db=>{const p=await load(db,a,id);return(await db.query('SELECT '+eventColumns+' FROM project_events WHERE project_id=$1 AND version<$2 ORDER BY version DESC LIMIT 100',[p.id,beforeVersion??p.version+1])).rows;});
}

/** Internal job completion hook. Runs in the same locked transaction as the result. */
export async function attachProjectArtifact(db:pg.PoolClient,a:AuthContext,input:{project_id:string;job_id:string;project_version:number|null;project_item_id?:string|null;title:string;content:string;audience:string[]}){
 let p=await load(db,a,input.project_id,true);
 if(p.status==='archived')throw new ToolError('The project was archived while this task ran.',409);
 if(!subset(p.allowed_agents,input.audience))throw new ToolError('The result is more private than the project.',409);
 if(Number((await db.query('SELECT count(*) AS n FROM project_items WHERE project_id=$1',[p.id])).rows[0].n)>=300)throw new ToolError('This project has reached its 300-item limit.',429);
 const changed=input.project_version!==null&&p.version!==input.project_version;
 const source_refs:SourceRef[]=[{kind:'job',id:input.job_id,label:'Background work completed by Brain'}];
 const content=input.content.length>32000?input.content.slice(0,31900)+'\n[Long result shortened here. Open the linked job for the full result.]':input.content;
 const row=(await db.query("INSERT INTO project_items(project_id,user_id,brain_id,type,title,content,status,confirmation,needs_review,source_type,source_refs,created_by,updated_by) VALUES($1,$2,$3,'artifact',$4,$5,'done','proposed',$6,'tool_result',$7,$8,$8) RETURNING *",[p.id,a.user_id,a.brain_id,input.title.slice(0,200),content,changed,JSON.stringify(source_refs),a.agent_label])).rows[0];
 const dependenciesIds=(await db.query("SELECT id FROM project_items WHERE project_id=$1 AND id<>$2 AND (type IN ('constraint','decision') AND confirmation='confirmed' OR id=$3) AND status<>'superseded' ORDER BY created_at LIMIT 30",[p.id,row.id,input.project_item_id??null])).rows.map(r=>r.id);
 await dependencies(db,a,p,row.id,dependenciesIds);
 p=await bump(db,p);
 await event(db,a,p,'artifact_ready',changed?'Work finished against an earlier project version. Review the changed assumptions.':'Background work is ready: '+input.title,{item_id:row.id,source_refs,after:{...row,depends_on:dependenciesIds,worked_from_version:input.project_version},request_id:input.job_id});
 return {artifact_id:row.id,needs_review:changed,project_version:p.version};
}
