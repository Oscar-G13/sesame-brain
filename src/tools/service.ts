import type pg from 'pg';
import {MemoryError,ownerContext,memoryAccessSql,writeFactRevision,validateSourceRefs,intersectAudiences,visibilityFor,trackSessionWrite,rowVisible,routedAudience,type SourceRef,type MemoryWriteOptions} from '../brain/memory.js';
import { transaction } from '../db/index.js';
import { isToolName, toolDefinitions, toolScope, type ToolName } from './definitions.js';

export interface AuthContext { user_id:string;brain_id:string;agent_label:string;client_id:string;scopes:string[];grant_id:string;token_hash:string;browser_session_id?:string;owner_access?:boolean;source_audience?:string[];expected_content_epoch?:number; }
export class ToolError extends Error { constructor(message:string,public readonly status=400){super(message);} }
type Db=pg.PoolClient;
async function event(db:Db,a:AuthContext,kind:string,ref:string|null,audience?:string[],extra:Record<string,unknown>={}):Promise<void>{
 await db.query('INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[a.user_id,a.brain_id,a.agent_label,kind,ref,{...extra,audience:audience??a.source_audience??['all']}]);
}
/** Metadata follows record ACLs; orphaned events need their actor or explicit shared provenance. */
function activityVisibility(a:AuthContext,params:unknown[]):string{
 const actor='$'+params.push(a.agent_label),owner='$'+params.push(ownerContext(a));
 const allowed:string[]=[],exists:string[]=[];
 for(const table of ['notes','facts','snapshots','handoffs','jobs','fact_revisions']){
  const alias='visible_'+table,tenant=alias+'.user_id=e.user_id AND '+alias+'.brain_id=e.brain_id AND '+alias+'.id=target.ref_id';
  allowed.push("(target.collection='"+table+"' AND EXISTS(SELECT 1 FROM "+table+' '+alias+' WHERE '+tenant+' AND '+memoryAccessSql(table,alias,a,params)+'))');
  exists.push("(target.collection='"+table+"' AND EXISTS(SELECT 1 FROM "+table+' '+alias+' WHERE '+tenant+'))');
 }
 const project="p.user_id=e.user_id AND p.brain_id=e.brain_id AND p.id=target.ref_id";
 allowed.push("(target.collection='projects' AND EXISTS(SELECT 1 FROM projects p WHERE "+project+" AND ('all'=ANY(p.allowed_agents) OR ("+actor+"<>'you' AND "+actor+"=ANY(p.allowed_agents)))))");
 exists.push("(target.collection='projects' AND EXISTS(SELECT 1 FROM projects p WHERE "+project+'))');
 const own="("+actor+"<>'you' AND e.actor_agent="+actor+")";
 const audience="(e.metadata->'audience' IS NULL OR (jsonb_typeof(e.metadata->'audience')='array' AND ((e.metadata->'audience') ? 'all' OR ("+actor+"<>'you' AND (e.metadata->'audience') ? "+actor+"))))";
 const explicitShared="((target.ref_id IS NULL OR NOT ("+exists.join(' OR ')+")) AND jsonb_typeof(e.metadata->'audience')='array' AND (e.metadata->'audience') ? 'all')";
 return '('+owner+'::boolean OR ('+audience+' AND ('+allowed.join(' OR ')+' OR ('+own+' AND NOT ('+exists.join(' OR ')+')) OR '+explicitShared+')))';
}
const activityTargetSql="CROSS JOIN LATERAL (SELECT CASE WHEN e.kind IN ('note_left','notes_read') THEN 'notes' WHEN e.kind IN ('fact_stored','fact_corrected','fact_forgotten') THEN 'facts' WHEN e.kind='fact_proposed' THEN 'fact_revisions' WHEN e.kind IN ('snapshot_saved','auto_snapshot') THEN 'snapshots' WHEN e.kind IN ('handoff_created','handoff_accepted','handoff_completed') THEN 'handoffs' WHEN e.kind IN ('job_queued','job_finished','job_email_sent','job_email_failed','job_stopped','think') THEN 'jobs' WHEN e.kind='project_changed' THEN 'projects' WHEN e.metadata->>'collection' IN ('notes','facts','snapshots','handoffs','jobs','fact_revisions','projects') THEN e.metadata->>'collection' WHEN e.kind='session_write' THEN CASE e.metadata->>'tool' WHEN 'remember' THEN 'facts' WHEN 'forget' THEN 'facts' WHEN 'leave_note' THEN 'notes' WHEN 'mark_notes_read' THEN 'notes' WHEN 'save_snapshot' THEN 'snapshots' WHEN 'handoff' THEN 'handoffs' WHEN 'accept_handoff' THEN 'handoffs' WHEN 'complete_handoff' THEN 'handoffs' END END AS collection,CASE WHEN e.kind='fact_proposed' AND e.metadata->>'revision_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (e.metadata->>'revision_id')::uuid ELSE e.ref_id END AS ref_id) target";

async function autoNote(db:Db,a:AuthContext,to:string,text:string,options:MemoryWriteOptions={}):Promise<void>{
 const audience=options.sourceAudience??['all'];
 const r=await db.query('INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text,tags,visibility,source_audience,source_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[a.user_id,a.brain_id,a.agent_label,[to],text,['handoff'],visibilityFor(audience),audience,JSON.stringify(options.provenance?.source_refs??[])]);
 await event(db,a,'note_left',r.rows[0].id,options.sourceAudience);
}
export async function executeTool(a:AuthContext,name:string,input:unknown={},expectedEpoch?:number,authorize?: (db:Db)=>Promise<void>,options:MemoryWriteOptions={}):Promise<unknown>{
 if(!isToolName(name))throw new ToolError('Unknown tool.');
 if(!a.scopes.includes(toolScope(name)))throw new ToolError('insufficient_scope',403);
 return transaction(async db=>{
  if(expectedEpoch!==undefined)await db.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[a.user_id]);
  // A locked, tenant-checked parent makes deletion and concurrent snapshot pruning atomic.
  const brain=await db.query('SELECT id,name,content_epoch FROM brains WHERE user_id=$1 AND id=$2 '+(toolScope(name)==='brain:write'?'FOR UPDATE':'FOR SHARE'),[a.user_id,a.brain_id]);
  if(!brain.rowCount)throw new ToolError('Brain not found.',404);
  if(expectedEpoch!==undefined&&Number(brain.rows[0].content_epoch)!==expectedEpoch)throw new ToolError('Brain reset; work stopped.',409);
  if(authorize)await authorize(db);
  const writing=toolScope(name)==='brain:write';
  const inherited=writing&&options.sessionId?(await db.query('SELECT to_agents,source_refs FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND agent_label=$4 AND closed_at IS NULL',[a.user_id,a.brain_id,options.sessionId,a.agent_label])).rows[0]:undefined;
  const explicit=writing?await validateSourceRefs(db,a,options.provenance?.source_refs??[]):{refs:[],audience:['all']};
  const historical:{refs:SourceRef[];audience:string[]}={refs:[],audience:['all']};
  for(const source of (inherited?.source_refs??[]).slice(0,40)){
   try{const known=await validateSourceRefs(db,a,[source]);historical.refs.push(...known.refs);historical.audience=intersectAudiences(historical.audience,known.audience);}
   catch(error){if(!(error instanceof MemoryError))throw error;} // Deleted or withdrawn receipts are not reused.
  }
  const evidence={refs:[...new Map([...explicit.refs,...historical.refs].map(ref=>[ref.collection+':'+ref.id,ref])).values()].slice(0,40),audience:intersectAudiences(explicit.audience,historical.audience)};
  const scopedOptions:MemoryWriteOptions={...options,sourceAudience:intersectAudiences(options.sourceAudience,a.source_audience,evidence.audience,inherited?.to_agents),provenance:{...options.provenance,source_refs:evidence.refs}};
  const result=await run(db,a,name,input,brain.rows[0].name as string,scopedOptions);
  if(writing)await trackSessionWrite(db,a,options.sessionId,name,typeof (result as {id?:unknown})?.id==='string'?(result as {id:string}).id:null,scopedOptions.sourceAudience??['all'],JSON.stringify(input),evidence.refs);
  return result;
 }).catch(error=>{
  if(error instanceof MemoryError)throw new ToolError(error.message,error.status);
  if((error as {constraint?:string})?.constraint==='brain_content_quota')throw new ToolError('Brain content quota reached; remove content or contact the owner.',413);
  throw error;
 });
}
async function run(db:Db,a:AuthContext,name:ToolName,input:unknown,brainName:string,options:MemoryWriteOptions):Promise<unknown>{
 const tenant=[a.user_id,a.brain_id];
 const who=a.agent_label;
 switch(name){
 case 'whoami':{
  toolDefinitions.whoami.inputSchema.parse(input);
  const agents=await db.query('SELECT agent_label AS agent,max(last_used_at) AS last_seen FROM grants WHERE user_id=$1 AND brain_id=$2 AND revoked_at IS NULL GROUP BY agent_label ORDER BY agent_label',tenant);
  const np:unknown[]=[...tenant,who],nv=memoryAccessSql('notes','n',a,np);
  const notes=await db.query('SELECT count(*)::int AS n FROM notes n WHERE user_id=$1 AND brain_id=$2 AND NOT $3=ANY(read_by) AND '+nv,np);
  const hp:unknown[]=[...tenant],hv=memoryAccessSql('handoffs','h',a,hp);
  const handoffs=await db.query("SELECT count(*)::int AS n FROM handoffs h WHERE user_id=$1 AND brain_id=$2 AND status IN ('pending','accepted') AND "+hv,hp);
  return{agent:who,brain:brainName,connected_agents:agents.rows,unread_notes:notes.rows[0].n,pending_handoffs:handoffs.rows[0].n,server_time:new Date().toISOString()};
 }
 case 'inbox':{
  const p=toolDefinitions.inbox.inputSchema.parse(input),np:unknown[]=[...tenant,who,p.limit],nv=memoryAccessSql('notes','n',a,np);
  const notes=await db.query('SELECT n.* FROM notes n WHERE user_id=$1 AND brain_id=$2 AND NOT $3=ANY(read_by) AND '+nv+' ORDER BY created_at DESC,id DESC LIMIT $4',np);
  const hp:unknown[]=[...tenant,p.limit],hv=memoryAccessSql('handoffs','h',a,hp);
  const handoffs=await db.query("SELECT h.* FROM handoffs h WHERE user_id=$1 AND brain_id=$2 AND status IN ('pending','accepted') AND "+hv+' ORDER BY created_at DESC,id DESC LIMIT $3',hp);
  const items=[...notes.rows.map(n=>({...n,note_kind:n.kind,kind:'note'})),...handoffs.rows.map(h=>({...h,kind:'handoff'}))].sort((x,y)=>new Date(y.created_at).getTime()-new Date(x.created_at).getTime()).slice(0,p.limit);
  return{items,notes:items.filter(i=>i.kind==='note'),handoffs:items.filter(i=>i.kind==='handoff')};
 }
 case 'read_notes':{
  const p=toolDefinitions.read_notes.inputSchema.parse(input),params:unknown[]=[...tenant,who,p.from??null,p.to??null,p.unread_only,p.since??null,p.tag??null,p.limit],visible=memoryAccessSql('notes','n',a,params);
  return(await db.query("SELECT n.* FROM notes n WHERE user_id=$1 AND brain_id=$2 AND ($4::text IS NULL OR from_agent=$4) AND ($5::text IS NULL OR $5=ANY(to_agents)) AND (NOT $6::boolean OR NOT $3=ANY(read_by)) AND ($7::timestamptz IS NULL OR created_at >= $7) AND ($8::text IS NULL OR $8=ANY(tags)) AND "+visible+' ORDER BY created_at DESC,id DESC LIMIT $9',params)).rows;
 }
 case 'recall':{
  const p=toolDefinitions.recall.inputSchema.parse(input),params:unknown[]=[...tenant,p.key??null,p.query??null,p.tag??null,p.limit],visible=memoryAccessSql('facts','f',a,params);
  return(await db.query("SELECT f.* FROM facts f WHERE user_id=$1 AND brain_id=$2 AND ($3::text IS NULL OR key=$3) AND ($4::text IS NULL OR to_tsvector('simple',key || ' ' || value) @@ plainto_tsquery('simple',$4) OR (key || ' ' || value) % $4 OR strpos(lower(key || ' ' || value),lower($4)) > 0) AND ($5::text IS NULL OR $5=ANY(tags)) AND "+visible+' ORDER BY updated_at DESC,id DESC LIMIT $6',params)).rows;
 }
 case 'list_snapshots':{
  const p=toolDefinitions.list_snapshots.inputSchema.parse(input),params:unknown[]=[...tenant,p.agent??null,p.limit],visible=memoryAccessSql('snapshots','s',a,params);
  return(await db.query('SELECT id,agent_label AS agent,title,kind,visibility,to_agents,source_refs,created_at,octet_length(content) AS bytes FROM snapshots s WHERE user_id=$1 AND brain_id=$2 AND ($3::text IS NULL OR agent_label=$3) AND '+visible+' ORDER BY created_at DESC,id DESC LIMIT $4',params)).rows;
 }
 case 'get_snapshot':{
  const p=toolDefinitions.get_snapshot.inputSchema.parse(input),params:unknown[]=[...tenant,p.id],visible=memoryAccessSql('snapshots','s',a,params);
  const r=await db.query('SELECT id,agent_label AS agent,title,kind,visibility,to_agents,source_refs,content,created_at FROM snapshots s WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND '+visible,params);
  if(!r.rowCount)throw new ToolError('Snapshot not found.',404);return r.rows[0];
 }
 case 'activity':{
  const p=toolDefinitions.activity.inputSchema.parse(input),params:unknown[]=[...tenant,p.limit],visible=activityVisibility(a,params);
  return(await db.query('SELECT e.id,e.actor_agent,e.kind,e.ref_id,e.created_at FROM activity e '+activityTargetSql+' WHERE e.user_id=$1 AND e.brain_id=$2 AND '+visible+' ORDER BY e.created_at DESC,e.id DESC LIMIT $3',params)).rows;
 }
 case 'leave_note':{
  const p=toolDefinitions.leave_note.inputSchema.parse(input);
  const to=[...new Set(Array.isArray(p.to)?p.to:[p.to])];
  const audience=options.sourceAudience??['all'];
  if(!audience.includes('all')&&to.some(label=>label!=='all'&&!audience.includes(label)))throw new ToolError('The source is not shared with that recipient.',403);
  options.sourceAudience=intersectAudiences(audience,to.includes('all')?['all']:[who,...to]);
  const r=await db.query('INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text,tags,visibility,source_audience,source_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[...tenant,who,to,p.text,p.tags??[],visibilityFor(audience),audience,JSON.stringify(options.provenance?.source_refs??[])]);
  await event(db,a,'note_left',r.rows[0].id,options.sourceAudience);
  return {id:r.rows[0].id};
 }
 case 'mark_notes_read':{
  const p=toolDefinitions.mark_notes_read.inputSchema.parse(input);
  const params:unknown[]=[...tenant,who,p.all===true,p.ids??[]],visible=memoryAccessSql('notes','n',a,params);
  const r=await db.query("UPDATE notes n SET read_by=array_append(read_by,$3) WHERE user_id=$1 AND brain_id=$2 AND ($3=ANY(to_agents) OR 'all'=ANY(to_agents)) AND NOT $3=ANY(read_by) AND ($4::boolean OR id=ANY($5::uuid[])) AND "+visible+' RETURNING n.*',params);
  for(const row of r.rows)options.sourceAudience=intersectAudiences(options.sourceAudience,routedAudience('notes',row));
  await event(db,a,'notes_read',r.rows[0]?.id??null,options.sourceAudience);
  return {marked:r.rowCount};
 }
 case 'handoff':{
  const p=toolDefinitions.handoff.inputSchema.parse(input);
  const audience=options.sourceAudience??['all'];if(!audience.includes('all')&&!audience.includes(p.to))throw new ToolError('The source is not shared with that recipient.',403);
  options.sourceAudience=intersectAudiences(audience,[who,p.to]);
  const r=await db.query('INSERT INTO handoffs(user_id,brain_id,from_agent,to_agent,title,context,next_steps,visibility,source_audience,source_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[...tenant,who,p.to,p.title,p.context,p.next_steps??null,visibilityFor(audience),audience,JSON.stringify(options.provenance?.source_refs??[])]);
  await event(db,a,'handoff_created',r.rows[0].id,options.sourceAudience);
  return {id:r.rows[0].id};
 }
 case 'accept_handoff':{
  const p=toolDefinitions.accept_handoff.inputSchema.parse(input);
  const prior=(await db.query('SELECT * FROM handoffs WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND to_agent=$4 FOR UPDATE',[...tenant,p.id,who])).rows[0];
  if(!prior||!rowVisible(prior,a,'source_audience'))throw new ToolError('Handoff not found for this assistant.',404);
  options.sourceAudience=intersectAudiences(options.sourceAudience,prior.source_audience,[prior.from_agent,prior.to_agent]);
  const r=await db.query("UPDATE handoffs SET status='accepted',accepted_at=now() WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND to_agent=$4 AND status='pending' RETURNING id,from_agent,title",[...tenant,p.id,who]);
  if(!r.rowCount)throw new ToolError('Pending handoff not found for this assistant.',404);
  await autoNote(db,a,r.rows[0].from_agent,'Accepted handoff: '+r.rows[0].title,options);
  await event(db,a,'handoff_accepted',p.id,options.sourceAudience);
  return {id:p.id,status:'accepted'};
 }
 case 'complete_handoff':{
  const p=toolDefinitions.complete_handoff.inputSchema.parse(input);
  const prior=(await db.query('SELECT * FROM handoffs WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND to_agent=$4 FOR UPDATE',[...tenant,p.id,who])).rows[0];
  if(!prior||!rowVisible(prior,a,'source_audience'))throw new ToolError('Handoff not found for this assistant.',404);
  options.sourceAudience=intersectAudiences(options.sourceAudience,prior.source_audience,[prior.from_agent,prior.to_agent]);
  const r=await db.query("UPDATE handoffs SET status='completed',summary=$5,accepted_at=COALESCE(accepted_at,now()),completed_at=now(),visibility=$6,source_audience=$7,source_refs=$8 WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND to_agent=$4 AND status IN ('pending','accepted') RETURNING id,from_agent,title",[...tenant,p.id,who,p.summary,visibilityFor(options.sourceAudience??['all']),options.sourceAudience??['all'],JSON.stringify([...new Map([...(prior.source_refs??[]),...(options.provenance?.source_refs??[])].map((ref:SourceRef)=>[ref.collection+':'+ref.id,ref])).values()].slice(0,100))]);
  if(!r.rowCount)throw new ToolError('Open handoff not found for this assistant.',404);
  await autoNote(db,a,r.rows[0].from_agent,'Completed handoff: '+r.rows[0].title+'\n'+p.summary,options);
  await event(db,a,'handoff_completed',p.id,options.sourceAudience);
  return {id:p.id,status:'completed'};
 }
 case 'remember':{
  const p=toolDefinitions.remember.inputSchema.parse(input);
  const result=await writeFactRevision(db,a,p.key,p.value,p.tags??[],options);
  options.sourceAudience=result.audience;
  await event(db,a,result.proposed?'fact_proposed':'fact_stored',result.id,result.audience,{revision_id:result.revision_id});
  return result;
 }
 case 'forget':{
  const p=toolDefinitions.forget.inputSchema.parse(input);
  const old=(await db.query('SELECT * FROM facts WHERE user_id=$1 AND brain_id=$2 AND key=$3 FOR UPDATE',[...tenant,p.key])).rows[0];
  if(old&&!rowVisible(old,a))return{deleted:false};
  if(old)options.sourceAudience=intersectAudiences(options.sourceAudience,old.to_agents);
  const r=await db.query('DELETE FROM facts WHERE user_id=$1 AND brain_id=$2 AND key=$3 RETURNING id',[...tenant,p.key]);
  await event(db,a,'fact_forgotten',r.rows[0]?.id??null,options.sourceAudience);return{deleted:Boolean(r.rowCount)};
 }
 case 'save_snapshot':{
  const p=toolDefinitions.save_snapshot.inputSchema.parse(input);
  const audience=options.sourceAudience??['all'];
  const r=await db.query('INSERT INTO snapshots(user_id,brain_id,agent_label,title,content,visibility,to_agents,source_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[...tenant,who,p.title??null,p.content,visibilityFor(audience),audience,JSON.stringify(options.provenance?.source_refs??[])]);
  await event(db,a,'snapshot_saved',r.rows[0].id,options.sourceAudience);
  return {id:r.rows[0].id};
 }
 }
}
export function resultSummary(name:string,data:unknown):string {
 if(Array.isArray(data))return name+': '+data.length+' result'+(data.length===1?'':'s')+'.';
 if(name==='whoami')return 'Connected to your shared brain.';
 if(name==='inbox')return 'Inbox checked; nothing marked as read.';
 return name.replaceAll('_',' ')+': done.';
}
