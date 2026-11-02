import type pg from 'pg';
import {pool,transaction} from '../db/index.js';
import type {AuthContext} from '../tools/service.js';

export interface ContextBlock {kind:string;text:string;sourceIds:string[];}
export interface ContextPack {blocks:ContextBlock[];estimatedTokens:number;bytes:number;memoryVersion:string;truncated:boolean;includedJobIds:string[];}
export interface ContextOptions {sessionId?:string;tokenBudget?:number;markJobsSurfaced?:boolean;now?:Date;}
type Candidate=ContextBlock & {jobId?:string};
const cache=new Map<string,{version:string;pack:ContextPack}>();
export function clearContextCache(scope?:{userId:string;brainId:string}):void{
 if(!scope){cache.clear();return;}
 const prefix=scope.userId+':'+scope.brainId+':';for(const key of cache.keys())if(key.startsWith(prefix))cache.delete(key);
}
export function contextTokenBudget(value?:number):number{
 const n=value??Number(process.env.BRAIN_CONTEXT_TOKEN_BUDGET??20000);
 return Number.isFinite(n)?Math.max(64,Math.min(1_000_000,Math.floor(n))):20000;
}
export function trimUtf8(text:string,maxBytes:number):string {
 if(maxBytes<=0)return '';
 const buffer=Buffer.from(text,'utf8');if(buffer.length<=maxBytes)return text;
 return buffer.subarray(0,maxBytes).toString('utf8').replace(/�+$/u,'');
}
function iso(value:unknown):string{return value instanceof Date?value.toISOString():String(value??'');}
function compactMeta(value:unknown):string{
 if(!value||typeof value!=='object'||Array.isArray(value))return '';
 const input=value as Record<string,unknown>,output:Record<string,unknown>={};
 for(const key of ['model','input_tokens','output_tokens','latency_ms','job_id'])if(['string','number','boolean'].includes(typeof input[key]))output[key]=input[key];
 return Object.keys(output).length?' '+JSON.stringify(output):'';
}
export function boundContext(candidates:Candidate[],budget:number,memoryVersion:string):ContextPack{
 const blocks:ContextBlock[]=[],includedJobIds:string[]=[];let bytes=0,truncated=false;
 for(const candidate of candidates){
  const separator=blocks.length?2:0,remaining=budget-bytes-separator,full=Buffer.byteLength(candidate.text,'utf8');
  if(remaining<=0){truncated=true;break;}
  if(full<=remaining){blocks.push({kind:candidate.kind,text:candidate.text,sourceIds:candidate.sourceIds});bytes+=separator+full;if(candidate.jobId&&!includedJobIds.includes(candidate.jobId))includedJobIds.push(candidate.jobId);}
  else{
   const suffix='\n[Context truncated at the configured budget.]';
   const suffixBytes=Buffer.byteLength(suffix,'utf8');
   const text=remaining>suffixBytes?trimUtf8(candidate.text,remaining-suffixBytes)+suffix:trimUtf8(candidate.text,remaining);
   if(text){blocks.push({kind:candidate.kind,text,sourceIds:candidate.sourceIds});bytes+=separator+Buffer.byteLength(text,'utf8');}
   truncated=true;break;
  }
 }
 return {blocks,estimatedTokens:bytes,bytes,memoryVersion,truncated,includedJobIds};
}
async function candidatesFor(db:pg.PoolClient,a:AuthContext,options:ContextOptions):Promise<Candidate[]>{
 const tenant=[a.user_id,a.brain_id],agent=a.agent_label,result:Candidate[]=[],budget=contextTokenBudget(options.tokenBudget);
 let sessionStart:Date|undefined,selectedBytes=0;
 const push=(candidate:Candidate):boolean=>{selectedBytes+=(result.length?2:0)+Buffer.byteLength(candidate.text,'utf8');result.push(candidate);return selectedBytes<=budget;};
 // Page through collections so a large longitudinal archive is never materialized in Node.
 const page=async(sql:string,params:unknown[],mapper:(row:Record<string,any>)=>Candidate,size=32):Promise<boolean>=>{
  for(let offset=0;;offset+=size){
   const rows=await db.query(sql+' LIMIT $'+(params.length+1)+' OFFSET $'+(params.length+2),[...params,size,offset]);
   for(const row of rows.rows)if(!push(mapper(row)))return false;
   if(rows.rows.length<size)return true;
  }
 };
 if(options.sessionId){
  const found=await db.query('SELECT started_at FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[...tenant,agent,options.sessionId]);
  if(!found.rowCount)throw new Error('Session not found for this brain and assistant.');
  sessionStart=found.rows[0].started_at as Date;
 }
 if(!await page('SELECT id,key,value,tags,updated_by,updated_at FROM facts WHERE user_id=$1 AND brain_id=$2 ORDER BY updated_at DESC,id DESC',tenant,row=>({kind:'fact',sourceIds:[row.id],text:'FACT '+row.key+' ['+row.updated_by+'; '+iso(row.updated_at)+']\n'+row.value+(row.tags?.length?'\nTags: '+row.tags.join(', '):'')})))return result;
 const snapshots=await db.query('SELECT id,agent_label,title,kind,content,created_at FROM snapshots WHERE user_id=$1 AND brain_id=$2 ORDER BY created_at DESC,id DESC LIMIT 11',tenant);
 if(snapshots.rows[0]){
  const row=snapshots.rows[0];if(!push({kind:'latest_snapshot',sourceIds:[row.id],text:'LATEST SNAPSHOT ['+row.kind+'; '+row.agent_label+'; '+iso(row.created_at)+'] '+(row.title??'Untitled')+'\n'+row.content}))return result;
 }
 for(const row of snapshots.rows.slice(1))if(!push({kind:'snapshot_headline',sourceIds:[row.id],text:'PREVIOUS SNAPSHOT ['+row.kind+'; '+row.agent_label+'; '+iso(row.created_at)+'] '+(row.title??'Untitled')+'\n'+row.content.slice(0,300)}))return result;
 if(!await page("SELECT id,from_agent,to_agent,title,context,next_steps,status,created_at,(SELECT j.id FROM jobs j WHERE j.user_id=handoffs.user_id AND j.brain_id=handoffs.brain_id AND j.handoff_id=handoffs.id AND j.state IN ('done','partial') ORDER BY j.finished_at DESC LIMIT 1) AS job_id FROM handoffs WHERE user_id=$1 AND brain_id=$2 AND (to_agent=$3 OR to_agent='all' OR EXISTS(SELECT 1 FROM jobs j WHERE j.user_id=handoffs.user_id AND j.brain_id=handoffs.brain_id AND j.handoff_id=handoffs.id)) AND status IN ('pending','accepted') ORDER BY created_at DESC,id DESC",[...tenant,agent],row=>({kind:'handoff',sourceIds:[row.id],jobId:row.job_id??undefined,text:'OPEN HANDOFF ['+row.status+'; '+row.from_agent+' to '+row.to_agent+'; '+iso(row.created_at)+'] '+row.title+'\n'+row.context+(row.next_steps?'\nNext steps: '+row.next_steps:'')})))return result;
 // At least budget+1 characters of an oversized result forces budget truncation,
 // so no partially fetched job can be acknowledged as fully surfaced.
 if(!await page("SELECT j.id,j.title,left(j.result_text,$4) AS result_text,left(j.result_summary,$4) AS result_summary,j.finished_at,n.text AS note_text FROM jobs j LEFT JOIN notes n ON n.id=j.result_note_id AND n.user_id=j.user_id AND n.brain_id=j.brain_id WHERE j.user_id=$1 AND j.brain_id=$2 AND j.state IN ('done','partial') AND NOT $3=ANY(j.surfaced_to) ORDER BY j.finished_at DESC NULLS LAST,j.created_at DESC,j.id DESC",[...tenant,agent,budget+1],row=>({kind:'job_result',sourceIds:[row.id],jobId:row.id,text:'COMPLETED JOB ['+row.id+'; '+iso(row.finished_at)+'] '+row.title+'\n'+(row.result_text??row.note_text??row.result_summary??'A result is available in job_status.')}),8))return result;
 const since=new Date((options.now??new Date()).getTime()-14*86400000);
 if(!await page("SELECT id,from_agent,to_agents,text,tags,kind,created_at FROM notes WHERE user_id=$1 AND brain_id=$2 AND ($3=ANY(to_agents) OR 'all'=ANY(to_agents) OR from_agent=$3) AND created_at>=$4 ORDER BY created_at DESC,id DESC",[...tenant,agent,since],row=>({kind:'note',sourceIds:[row.id],text:'NOTE ['+row.kind+'; '+row.from_agent+' to '+row.to_agents.join(',')+'; '+iso(row.created_at)+']\n'+row.text+(row.tags?.length?'\nTags: '+row.tags.join(', '):'')})))return result;
 const activity=await db.query("SELECT id,actor_agent,kind,ref_id,jsonb_build_object('model',metadata->'model','input_tokens',metadata->'input_tokens','output_tokens',metadata->'output_tokens','latency_ms',metadata->'latency_ms','job_id',metadata->'job_id') AS metadata,created_at FROM activity WHERE user_id=$1 AND brain_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50",tenant);
 if(activity.rowCount&&!push({kind:'activity',sourceIds:activity.rows.map(r=>r.id as string),text:'RECENT ACTIVITY\n'+activity.rows.map(row=>iso(row.created_at)+' '+row.actor_agent+' '+row.kind+(row.ref_id?' '+row.ref_id:'')+compactMeta(row.metadata)).join('\n')}))return result;
 if(options.sessionId&&sessionStart)await page("SELECT id,metadata->>'tool' AS tool,left(metadata->>'summary',8000) AS summary,created_at FROM activity WHERE user_id=$1 AND brain_id=$2 AND actor_agent=$3 AND metadata->>'session_id'=$4 AND created_at>=$5 ORDER BY created_at,id",[...tenant,agent,options.sessionId,sessionStart],row=>({kind:'session_write',sourceIds:[row.id],text:'THIS SESSION ['+iso(row.created_at)+'] '+String(row.tool??'write')+'\n'+String(row.summary??'A change was saved to this brain.')}));
 return result;
}
export async function buildContextPack(a:AuthContext,options:ContextOptions={}):Promise<ContextPack>{
 if(!a.scopes.includes('brain:read'))throw new Error('brain:read is required for context.');
 const budget=contextTokenBudget(options.tokenBudget),key=options.sessionId?[a.user_id,a.brain_id,a.agent_label,options.sessionId,budget].join(':'):undefined;
 const brain=await pool.query('SELECT memory_version FROM brains WHERE user_id=$1 AND id=$2',[a.user_id,a.brain_id]);
 if(!brain.rowCount)throw new Error('Brain not found.');
 const version=String(brain.rows[0].memory_version),saved=key?cache.get(key):undefined;
 let pack:ContextPack;
 if(saved?.version===version)pack=structuredClone(saved.pack);
 else pack=await transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  const current=await db.query('SELECT memory_version FROM brains WHERE user_id=$1 AND id=$2',[a.user_id,a.brain_id]);
  if(!current.rowCount)throw new Error('Brain not found.');
  return boundContext(await candidatesFor(db,a,options),budget,String(current.rows[0].memory_version));
 });
 if(options.markJobsSurfaced&&pack.includedJobIds.length){
  // Delivery acknowledgement changes tracking only; no result is marked if truncated or omitted.
  await pool.query('UPDATE jobs SET surfaced_to=array_append(surfaced_to,$3) WHERE user_id=$1 AND brain_id=$2 AND id=ANY($4::uuid[]) AND NOT $3=ANY(surfaced_to)',[a.user_id,a.brain_id,a.agent_label,pack.includedJobIds]);
  const updated=await pool.query('SELECT memory_version FROM brains WHERE user_id=$1 AND id=$2',[a.user_id,a.brain_id]);
  pack.memoryVersion=String(updated.rows[0]?.memory_version??pack.memoryVersion);
  // A delivered result disappears on the next request, so never cache pre-acknowledgement contents.
  if(key)cache.delete(key);
 }else if(key){
  if(cache.size>=128)cache.delete(cache.keys().next().value!);
  cache.set(key,{version:pack.memoryVersion,pack:structuredClone(pack)});
 }
 return pack;
}
