import type pg from 'pg';
import {pool,transaction} from '../db/index.js';
import type {AuthContext} from '../tools/service.js';
import {z} from 'zod/v4';
export type Audience=string[];
export type SourceType='legacy'|'assistant_record'|'user_report'|'model_derived'|'user_correction';
export type Confidence='unknown'|'low'|'moderate'|'high';
export type Confirmation='unconfirmed'|'user_confirmed'|'disputed';
export interface SourceRef{collection:'notes'|'facts'|'snapshots'|'handoffs'|'jobs'|'fact_revisions'|'projects'|'project_items'|'project_events';id:string;}
export interface MemoryWriteOptions{sessionId?:string;sourceAudience?:Audience;provenance?:{source_type?:SourceType;confidence?:Confidence;confirmation?:Confirmation;source_refs?:SourceRef[];reason?:string};}
type Db=pg.PoolClient;
export class MemoryError extends Error{constructor(message:string,public readonly status=400){super(message);}}
const uuid=z.string().uuid();
const refsSchema=z.array(z.object({collection:z.enum(['notes','facts','snapshots','handoffs','jobs','fact_revisions','projects','project_items','project_events']),id:uuid})).max(40);
export function ownerContext(a:AuthContext):boolean{return Boolean((a.client_id==='dashboard'&&a.browser_session_id)||a.owner_access);}
export function normalizeAudience(value:Audience|undefined):Audience{
 const list=[...new Set(value??['all'])];if(!list.length||list.length>32||list.some(v=>!/^([a-z0-9-]{1,32}|all)$/.test(v)))throw new MemoryError('Invalid source audience.');
 return list.includes('all')?['all']:list.sort();
}
export function intersectAudiences(...values:(Audience|undefined)[]):Audience{
 let result:Audience=['all'];
 for(const value of values){const next=normalizeAudience(value);if(next.includes('all'))continue;result=result.includes('all')?next:result.filter(label=>next.includes(label));}
 return result.length?result:['you'];
}
export function visibilityFor(audience:Audience):'shared'|'restricted'|'owner_only'{return audience.includes('all')?'shared':audience.length===1&&audience[0]==='you'?'owner_only':'restricted';}
export function audienceOf(row:Record<string,any>,column='to_agents'):Audience{return row.visibility==='owner_only'?['you']:normalizeAudience(row[column]??['all']);}
export function rowVisible(row:Record<string,any>,a:AuthContext,column='to_agents'):boolean{
 if(ownerContext(a))return true;if(row.visibility==='owner_only')return false;
 const audience=normalizeAudience(row[column]??['all']);return audience.includes('all')||audience.includes(a.agent_label);
}
export function visibilitySql(alias:string,column:string,a:AuthContext,params:unknown[]):string{
 const index=params.push(ownerContext(a)),agent=params.push(a.agent_label);
 return '($'+index+'::boolean OR ('+alias+".visibility<>'owner_only' AND ('all'=ANY("+alias+'.'+column+') OR $'+agent+'=ANY('+alias+'.'+column+'))))';
}
export async function validateSourceRefs(db:Db,a:AuthContext,input:unknown):Promise<{refs:SourceRef[];audience:Audience}>{
 const refs=refsSchema.parse(input??[]),dedup=[...new Map(refs.map(ref=>[ref.collection+':'+ref.id,ref])).values()];let audience:Audience=['all'];
 for(const ref of dedup){
  const row=(await db.query('SELECT * FROM '+ref.collection+' WHERE user_id=$1 AND brain_id=$2 AND id=$3',[a.user_id,a.brain_id,ref.id])).rows[0];
  if(!row)throw new MemoryError('A source reference is not available in this brain.');
  if(['projects','project_items','project_events'].includes(ref.collection)){
   const project=ref.collection==='projects'?row:(await db.query('SELECT allowed_agents FROM projects WHERE user_id=$1 AND brain_id=$2 AND id=$3',[a.user_id,a.brain_id,row.project_id])).rows[0];
   if(!project)throw new MemoryError('A source project is not available in this brain.');
   const allowed=normalizeAudience(project.allowed_agents);
   if(!ownerContext(a)&&!allowed.includes('all')&&(a.agent_label==='you'||!allowed.includes(a.agent_label)))throw new MemoryError('A source project is not visible to this assistant.');
   audience=intersectAudiences(audience,allowed);continue;
  }
  const column=['notes','handoffs','jobs'].includes(ref.collection)?'source_audience':'to_agents';
  if(!rowVisible(row,a,column))throw new MemoryError('A source reference is not visible to this assistant.');
  let sourceAudience=audienceOf(row,column);
  if(ref.collection==='notes'){
   if(!ownerContext(a)&&!(row.from_agent===a.agent_label||row.to_agents.includes(a.agent_label)||row.to_agents.includes('all')))throw new MemoryError('A note source is not visible to this assistant.');
   sourceAudience=intersectAudiences(sourceAudience,row.to_agents.includes('all')?['all']:[row.from_agent,...row.to_agents]);
  }else if(ref.collection==='handoffs'){
   const shared=row.to_agent==='all'||Boolean((await db.query('SELECT id FROM jobs WHERE user_id=$1 AND brain_id=$2 AND handoff_id=$3',[a.user_id,a.brain_id,row.id])).rowCount);
   if(!ownerContext(a)&&!shared&&row.from_agent!==a.agent_label&&row.to_agent!==a.agent_label)throw new MemoryError('A handoff source is not visible to this assistant.');
   sourceAudience=intersectAudiences(sourceAudience,shared?['all']:[row.from_agent,row.to_agent]);
  }
  audience=intersectAudiences(audience,sourceAudience);
 }
 return{refs:dedup,audience};
}
async function writeMetadata(db:Db,a:AuthContext,options:MemoryWriteOptions,previous?:Record<string,any>,confirmed=false){
 const evidence=await validateSourceRefs(db,a,options.provenance?.source_refs??[]);
 const audience=intersectAudiences(options.sourceAudience,evidence.audience,previous?audienceOf(previous):undefined);
 const source_type=options.provenance?.source_type??'assistant_record';
 const confidence=options.provenance?.confidence??'unknown';
 let confirmation=options.provenance?.confirmation??'unconfirmed';
 if(!['legacy','assistant_record','user_report','model_derived','user_correction'].includes(source_type)||!['unknown','low','moderate','high'].includes(confidence)||!['unconfirmed','user_confirmed','disputed'].includes(confirmation))throw new MemoryError('Invalid fact provenance.');
 if(source_type==='model_derived')confirmation='unconfirmed';
 if(confirmation==='user_confirmed'&&!confirmed)throw new MemoryError('User confirmation requires an explicit owner correction.');
 return{source_type,confidence,confirmation,source_refs:evidence.refs,visibility:visibilityFor(audience),to_agents:audience,reason:options.provenance?.reason?.slice(0,2000)??null};
}
export async function writeFactRevision(db:Db,a:AuthContext,key:string,value:string,tags:string[],options:MemoryWriteOptions={},confirmed=false):Promise<Record<string,any>>{
 let previous=(await db.query('SELECT * FROM facts WHERE user_id=$1 AND brain_id=$2 AND key=$3 FOR UPDATE',[a.user_id,a.brain_id,key])).rows[0];
 if(previous&&!rowVisible(previous,a))throw new MemoryError('Fact not available to this assistant.');
 const meta=await writeMetadata(db,a,options,previous,confirmed);
 if(!previous){
  previous=(await db.query('INSERT INTO facts(user_id,brain_id,key,value,tags,updated_by,source_type,confidence,confirmation,source_refs,visibility,to_agents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[a.user_id,a.brain_id,key,value,tags,a.agent_label,meta.source_type,meta.confidence,meta.confirmation,JSON.stringify(meta.source_refs),meta.visibility,meta.to_agents])).rows[0];
  previous={...previous,current_revision_id:null,value:null};
 }
 const proposed=previous.confirmation==='user_confirmed'&&meta.confirmation!=='user_confirmed'&&previous.current_revision_id!==null;
 const revision=(await db.query('INSERT INTO fact_revisions(user_id,brain_id,fact_id,key,value,previous_value,actor_agent,source_type,confidence,confirmation,source_refs,visibility,to_agents,status,supersedes_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',[a.user_id,a.brain_id,previous.id,key,value,previous.value,a.agent_label,meta.source_type,meta.confidence,meta.confirmation,JSON.stringify(meta.source_refs),meta.visibility,meta.to_agents,proposed?'proposed':'current',previous.current_revision_id,meta.reason])).rows[0];
 if(!proposed){
  if(previous.current_revision_id)await db.query("UPDATE fact_revisions SET status='superseded',superseded_by_id=$4 WHERE user_id=$1 AND brain_id=$2 AND id=$3",[a.user_id,a.brain_id,previous.current_revision_id,revision.id]);
  await db.query('UPDATE facts SET value=$4,tags=$5,updated_by=$6,updated_at=now(),current_revision_id=$7,source_type=$8,confidence=$9,confirmation=$10,source_refs=$11,visibility=$12,to_agents=$13 WHERE user_id=$1 AND brain_id=$2 AND id=$3',[a.user_id,a.brain_id,previous.id,value,tags,a.agent_label,revision.id,meta.source_type,meta.confidence,meta.confirmation,JSON.stringify(meta.source_refs),meta.visibility,meta.to_agents]);
 }
 return{id:previous.id,fact_id:previous.id,key,revision_id:revision.id,previous_value:revision.previous_value,value,source_type:meta.source_type,confidence:meta.confidence,confirmation:meta.confirmation,source_refs:meta.source_refs,audience:meta.to_agents,visibility:meta.visibility,proposed};
}
export async function listFactHistory(a:AuthContext,options:{key?:string;limit?:number}={}):Promise<Record<string,any>[]>{
 if(!a.scopes.includes('brain:read'))throw new MemoryError('brain:read is required.');
 const p=z.object({key:z.string().min(1).max(128).optional(),limit:z.number().int().min(1).max(100).default(50)}).parse(options);
 const params:unknown[]=[a.user_id,a.brain_id,p.key??null,p.limit],visible=visibilitySql('r','to_agents',a,params);
 return(await pool.query('SELECT r.* FROM fact_revisions r WHERE r.user_id=$1 AND r.brain_id=$2 AND ($3::text IS NULL OR r.key=$3) AND '+visible+' ORDER BY r.created_at DESC,r.id DESC LIMIT $4',params)).rows;
}
export const getFactHistory=listFactHistory;
export async function correctFact(a:AuthContext,input:{key:string;value:string;reason?:string;source_refs?:SourceRef[]}):Promise<Record<string,any>>{
 if(a.client_id!=='dashboard'||!a.browser_session_id||!a.scopes.includes('brain:write'))throw new MemoryError('An authenticated owner correction is required.');
 const p=z.object({key:z.string().min(1).max(128),value:z.string().min(1).max(8000),reason:z.string().max(2000).optional(),source_refs:refsSchema.optional()}).parse(input);
 return transaction(async db=>{
  await db.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[a.user_id]);
  const browser=await db.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>now() FOR SHARE',[a.browser_session_id,a.user_id]);if(!browser.rowCount)throw new MemoryError('Sign in again to correct memory.');
  if(!(await db.query('SELECT id FROM brains WHERE user_id=$1 AND id=$2 FOR UPDATE',[a.user_id,a.brain_id])).rowCount)throw new MemoryError('Brain not found.');
  const previous=(await db.query('SELECT tags FROM facts WHERE user_id=$1 AND brain_id=$2 AND key=$3',[a.user_id,a.brain_id,p.key])).rows[0];
  const result=await writeFactRevision(db,a,p.key,p.value,previous?.tags??[],{provenance:{source_type:'user_correction',confidence:'high',confirmation:'user_confirmed',source_refs:p.source_refs,reason:p.reason}},true);
  await db.query("INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id,metadata) VALUES($1,$2,$3,'fact_corrected',$4,$5)",[a.user_id,a.brain_id,a.agent_label,result.id,{revision_id:result.revision_id}]);
  return result;
 });
}
export async function trackSessionWrite(db:Db,a:AuthContext,sessionId:string|undefined,tool:string,refId:string|null,audience:Audience,summary:string,source_refs:SourceRef[]=[]):Promise<void>{
 if(!sessionId)return;
 const row=(await db.query('SELECT to_agents,source_refs FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND agent_label=$4 AND closed_at IS NULL FOR UPDATE',[a.user_id,a.brain_id,sessionId,a.agent_label])).rows[0];
 if(!row)return;
 const narrowed=intersectAudiences(row.to_agents,audience),refs=[...new Map([...(row.source_refs??[]),...source_refs].map((ref:SourceRef)=>[ref.collection+':'+ref.id,ref])).values()].slice(0,100);
 await db.query('UPDATE brain_sessions SET write_count=write_count+1,activity_count=activity_count+1,last_activity_at=now(),to_agents=$5,source_refs=$6 WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND agent_label=$4',[a.user_id,a.brain_id,sessionId,a.agent_label,narrowed,JSON.stringify(refs)]);
 await db.query("INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id,metadata) VALUES($1,$2,$3,'session_write',$4,$5)",[a.user_id,a.brain_id,a.agent_label,refId,{session_id:sessionId,tool,write:true,summary:summary.slice(0,8000),audience,source_refs}]);
}
export function memoryAccessSql(table:string,alias:string,a:AuthContext,params:unknown[]):string{
 const sourceColumn=['notes','handoffs','jobs'].includes(table)?'source_audience':'to_agents';
 const visible=visibilitySql(alias,sourceColumn,a,params),agent='$'+params.length;
 if(ownerContext(a))return visible;
 if(table==='notes')return '('+visible+' AND ('+alias+'.from_agent='+agent+' OR '+agent+'=ANY('+alias+".to_agents) OR 'all'=ANY("+alias+'.to_agents)))';
 if(table==='handoffs')return '('+visible+' AND ('+alias+'.from_agent='+agent+' OR '+alias+'.to_agent='+agent+" OR "+alias+".to_agent='all' OR EXISTS(SELECT 1 FROM jobs j WHERE j.user_id="+alias+'.user_id AND j.brain_id='+alias+'.brain_id AND j.handoff_id='+alias+'.id)))';
 return visible;
}
export function routedAudience(table:string,row:Record<string,any>):Audience{
 const base=audienceOf(row,['notes','handoffs','jobs'].includes(table)?'source_audience':'to_agents');
 if(table==='notes')return intersectAudiences(base,row.to_agents.includes('all')?['all']:[row.from_agent,...row.to_agents]);
 if(table==='handoffs')return intersectAudiences(base,row.to_agent==='all'||row.job_id||row.job_result_visible?['all']:[row.from_agent,row.to_agent]);
 return base;
}

/** Preflight for callers holding the brain lock; database triggers enforce every write. */
export async function assertContentCapacity(db:Db,a:Pick<AuthContext,'user_id'|'brain_id'>,additionalBytes:number,additionalRows=1):Promise<void>{
 if(!Number.isSafeInteger(additionalBytes)||additionalBytes<0||!Number.isSafeInteger(additionalRows)||additionalRows<0)throw new MemoryError('Invalid content capacity estimate.');
 const row=(await db.query('SELECT content_bytes,content_rows,content_limit_bytes,content_limit_rows FROM brains WHERE user_id=$1 AND id=$2 FOR UPDATE',[a.user_id,a.brain_id])).rows[0];
 if(!row)throw new MemoryError('Brain not found.');
 if(Number(row.content_bytes)+additionalBytes>Number(row.content_limit_bytes)||Number(row.content_rows)+additionalRows>Number(row.content_limit_rows))throw Object.assign(new Error('Brain content quota reached; remove content or contact the owner.'),{code:'brain_content_quota',status:413});
}
