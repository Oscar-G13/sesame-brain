import {createHash} from 'node:crypto';
import type pg from 'pg';
import {pool,transaction} from '../db/index.js';
import type {AuthContext} from '../tools/service.js';
import {intersectAudiences,normalizeAudience,ownerContext,memoryAccessSql,routedAudience,audienceOf,type SourceRef} from './memory.js';
export interface ContextBlock{kind:string;text:string;sourceIds:string[];}
export interface ContextPack{blocks:ContextBlock[];estimatedTokens:number;bytes:number;memoryVersion:string;truncated:boolean;includedJobIds:string[];audience:string[];sourceRefs:SourceRef[];}
export interface ContextOptions{sessionId?:string;query?:string;tokenBudget?:number;markJobsSurfaced?:boolean;now?:Date;sharedOnly?:boolean;audience?:string[];}
type Candidate=ContextBlock&{jobId?:string;audience?:string[];refs?:SourceRef[];score?:number};
const cache=new Map<string,{version:string;pack:ContextPack}>();
export function clearContextCache(scope?:{userId:string;brainId:string}):void{if(!scope){cache.clear();return;}const prefix=scope.userId+':'+scope.brainId+':';for(const key of cache.keys())if(key.startsWith(prefix))cache.delete(key);}
export function contextTokenBudget(value?:number):number{const n=value??Number(process.env.BRAIN_CONTEXT_TOKEN_BUDGET??20000);return Number.isFinite(n)?Math.max(64,Math.min(1_000_000,Math.floor(n))):20000;}
export function trimUtf8(text:string,maxBytes:number):string{if(maxBytes<=0)return '';const b=Buffer.from(text);return b.length<=maxBytes?text:b.subarray(0,maxBytes).toString('utf8').replace(/\uFFFD+$/u,'');}
const iso=(value:unknown)=>value instanceof Date?value.toISOString():String(value??'');
export function boundContext(candidates:Candidate[],budget:number,memoryVersion:string):ContextPack{
 const blocks:ContextBlock[]=[],includedJobIds:string[]=[],sourceRefs:SourceRef[]=[];let bytes=0,truncated=false,audience=['all'];
 for(const candidate of candidates){
  const separator=blocks.length?2:0,remaining=budget-bytes-separator,full=Buffer.byteLength(candidate.text);
  if(remaining<=0){truncated=true;break;}
  let text=candidate.text,complete=true;
  if(full>remaining){const suffix='\n[Context truncated at its allocated budget.]';text=remaining>Buffer.byteLength(suffix)?trimUtf8(text,remaining-Buffer.byteLength(suffix))+suffix:trimUtf8(text,remaining);complete=false;truncated=true;}
  if(text){
   blocks.push({kind:candidate.kind,text,sourceIds:candidate.sourceIds});bytes+=separator+Buffer.byteLength(text);
   audience=intersectAudiences(audience,candidate.audience);
   sourceRefs.push(...(candidate.refs??[]));
   if(complete&&candidate.jobId&&!includedJobIds.includes(candidate.jobId))includedJobIds.push(candidate.jobId);
  }
  if(!complete)break;
 }
 return{blocks,bytes,estimatedTokens:bytes,memoryVersion,truncated,includedJobIds,audience,sourceRefs:[...new Map(sourceRefs.map(r=>[r.collection+':'+r.id,r])).values()].slice(0,40)};
}
const stop=new Set(['what','when','where','which','that','this','with','from','have','does','about','could','would','should','please','tell','know','remember','user','your','their','there','they','them','some','the','and','for','are','was','how','why','you','can','did','has','our']);
function terms(query:string):string[]{return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,63}/gu)??[]).filter(term=>!stop.has(term)))].slice(0,12);}
function matches(text:string,words:string[]):number{const lower=text.toLowerCase();return words.reduce((count,word)=>count+(lower.includes(word)?1:0),0);}
function excerpt(text:string,words:string[],length=1400):string{
 const lower=text.toLowerCase(),positions=words.map(w=>lower.indexOf(w)).filter(n=>n>=0),start=positions.length?Math.max(0,Math.min(...positions)-180):0;
 return(start?'[Excerpt] ':'')+text.slice(start,start+length)+(start+length<text.length?' [More stored material omitted.]':'');
}
function ref(collection:SourceRef['collection'],id:string):SourceRef{return{collection,id};}
function visible(table:string,alias:string,a:AuthContext,params:unknown[],sharedOnly:boolean,target?:string[]):string{
 const column=['notes','handoffs','jobs'].includes(table)?'source_audience':'to_agents';
 let sql=memoryAccessSql(table,alias,a,params);
 if(sharedOnly){
  sql+=' AND '+alias+".visibility='shared' AND 'all'=ANY("+alias+'.'+column+')';
  if(table==='notes')sql+=" AND 'all'=ANY("+alias+'.to_agents)';
  if(table==='handoffs')sql+=' AND ('+alias+".to_agent='all' OR EXISTS(SELECT 1 FROM jobs shared_job WHERE shared_job.user_id="+alias+'.user_id AND shared_job.brain_id='+alias+'.brain_id AND shared_job.handoff_id='+alias+".id AND shared_job.visibility='shared' AND 'all'=ANY(shared_job.source_audience)))";
 }
 if(target&&!target.includes('all')&&!(target.length===1&&target[0]==='you'&&ownerContext(a))){
  const index=params.push(target);
  sql+=' AND '+alias+".visibility<>'owner_only' AND ('all'=ANY("+alias+'.'+column+') OR $'+index+'::text[]<@'+alias+'.'+column+')';
  if(table==='notes')sql+=" AND ('all'=ANY("+alias+'.to_agents) OR $'+index+'::text[]<@(ARRAY['+alias+'.from_agent] || '+alias+'.to_agents))';
  if(table==='handoffs')sql+=' AND ('+alias+".to_agent='all' OR $"+index+'::text[]<@ARRAY['+alias+'.from_agent,'+alias+'.to_agent] OR EXISTS(SELECT 1 FROM jobs target_job WHERE target_job.user_id='+alias+'.user_id AND target_job.brain_id='+alias+'.brain_id AND target_job.handoff_id='+alias+'.id))';
 }
 return sql;
}
async function assemble(db:pg.PoolClient,a:AuthContext,options:ContextOptions,version:string):Promise<ContextPack>{
 const budget=contextTokenBudget(options.tokenBudget),tenant=[a.user_id,a.brain_id],words=terms(options.query??''),target=options.audience?normalizeAudience(options.audience):undefined,shared=Boolean(options.sharedOnly||a.client_id==='brain-nightly'||target?.includes('all'));
 const session:Candidate[]=[],urgent:Candidate[]=[],relevant:Candidate[]=[],background:Candidate[]=[];
 if(options.sessionId){
  const found=await db.query('SELECT id,started_at FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[...tenant,a.agent_label,options.sessionId]);
  if(!found.rowCount)throw new Error('Session not found for this brain and assistant.');
  const events=await db.query("SELECT id,metadata,created_at FROM activity WHERE user_id=$1 AND brain_id=$2 AND actor_agent=$3 AND metadata->>'session_id'=$4 ORDER BY created_at DESC,id DESC LIMIT 20",[...tenant,a.agent_label,options.sessionId]);
  for(const row of events.rows){
   const audience=row.metadata?.audience??[a.agent_label];
   if(shared&&!audience.includes('all'))continue;if(target&&!target.includes('all')&&!(target.length===1&&target[0]==='you'&&ownerContext(a))&&!audience.includes('all')&&!target.every(label=>audience.includes(label)))continue;
   session.push({kind:'session_write',sourceIds:[row.id],refs:row.metadata?.source_refs??[],audience,text:'CURRENT SESSION '+iso(row.created_at)+' '+String(row.metadata?.tool??'saved change')+'\n'+excerpt(String(row.metadata?.summary??'A change was saved.'),words,1200)});
  }
 }
 const hp:unknown[]=[...tenant],hv=visible('handoffs','h',a,hp,shared,target);
 const handoffs=await db.query("SELECT h.*,(SELECT j.id FROM jobs j WHERE j.user_id=h.user_id AND j.brain_id=h.brain_id AND j.handoff_id=h.id AND j.state IN ('done','partial') ORDER BY j.finished_at DESC LIMIT 1) AS job_id FROM handoffs h WHERE h.user_id=$1 AND h.brain_id=$2 AND h.status IN ('pending','accepted') AND "+hv+' ORDER BY h.created_at DESC,h.id DESC LIMIT 20',hp);
 for(const row of handoffs.rows)urgent.push({kind:'handoff',sourceIds:[row.id],refs:[ref('handoffs',row.id)],jobId:row.job_id??undefined,audience:row.job_id?audienceOf(row,'source_audience'):intersectAudiences(audienceOf(row,'source_audience'),[row.from_agent,row.to_agent]),text:'OPEN HANDOFF '+row.id+' ['+row.from_agent+' to '+row.to_agent+'; '+row.status+'] '+row.title+'\n'+excerpt(row.context,words,1600)+(row.next_steps?'\nNext: '+excerpt(row.next_steps,words,400):'')});
 const jp:unknown[]=[...tenant,a.agent_label],jv=visible('jobs','j',a,jp,shared,target);
 const jobs=await db.query("SELECT j.id,j.title,j.result_summary,left(j.result_text,2000) AS result_text,j.visibility,j.source_audience,j.finished_at FROM jobs j WHERE j.user_id=$1 AND j.brain_id=$2 AND j.state IN ('done','partial') AND NOT $3=ANY(j.surfaced_to) AND "+jv+' ORDER BY j.finished_at DESC NULLS LAST,j.id DESC LIMIT 20',jp);
 for(const row of jobs.rows)urgent.push({kind:'job_result',sourceIds:[row.id],refs:[ref('jobs',row.id)],jobId:row.id,audience:audienceOf(row,'source_audience'),text:'COMPLETED JOB '+row.id+' '+row.title+'\n'+excerpt(row.result_summary??row.result_text??'The result is ready.',words,1200)+'\nFull result remains in the job record.'});
 const fp:unknown[]=[...tenant,words],fv=visible('facts','f',a,fp,shared,target);
 const facts=await db.query("SELECT f.*,(SELECT count(*) FROM unnest($3::text[]) AS q(term) WHERE strpos(lower(f.key || ' ' || f.value),q.term)>0)::int AS relevance FROM facts f WHERE f.user_id=$1 AND f.brain_id=$2 AND "+fv+" ORDER BY relevance DESC,(f.confirmation='user_confirmed') DESC,f.updated_at DESC,f.id DESC LIMIT 60",fp);
 for(const row of facts.rows){
  const candidate:Candidate={kind:'fact',sourceIds:[row.id],refs:[ref('facts',row.id)],audience:audienceOf(row),score:row.relevance,text:'FACT '+row.id+' ['+row.source_type+'; '+row.confirmation+'; confidence '+row.confidence+'; '+row.updated_by+'; '+iso(row.updated_at)+'] '+row.key+'\n'+excerpt(row.value,words,1800)};
  if(!words.length||row.relevance>0)relevant.push(candidate);else background.push(candidate);
 }
 const np:unknown[]=[...tenant,words],nv=visible('notes','n',a,np,shared,target);
 const notes=await db.query("SELECT n.*,(SELECT count(*) FROM unnest($3::text[]) AS q(term) WHERE strpos(lower(n.text),q.term)>0)::int AS relevance FROM notes n WHERE n.user_id=$1 AND n.brain_id=$2 AND "+nv+" AND (cardinality($3::text[])>0 OR n.created_at>=now()-interval '14 days') ORDER BY relevance DESC,n.created_at DESC,n.id DESC LIMIT 50",np);
 for(const row of notes.rows){
  const candidate:Candidate={kind:'note',sourceIds:[row.id],refs:[ref('notes',row.id)],audience:routedAudience('notes',row),score:row.relevance,text:'SOURCE NOTE '+row.id+' ['+row.from_agent+'; '+iso(row.created_at)+']\n'+excerpt(row.text,words,1600)};
  if(words.length&&row.relevance>0)relevant.push(candidate);else background.push(candidate);
 }
 const sp:unknown[]=[...tenant,words],sv=visible('snapshots','s',a,sp,shared,target);
 const snapshots=await db.query("SELECT s.id,s.agent_label,s.title,s.kind,s.visibility,s.to_agents,s.created_at,left(s.content,20000) AS content,(SELECT count(*) FROM unnest($3::text[]) AS q(term) WHERE strpos(lower(s.content),q.term)>0)::int AS relevance FROM snapshots s WHERE s.user_id=$1 AND s.brain_id=$2 AND "+sv+" AND s.kind IN ('manual','auto') ORDER BY relevance DESC,s.created_at DESC,s.id DESC LIMIT 11",sp);
 for(let i=0;i<snapshots.rows.length;i++){
  const row=snapshots.rows[i],candidate:Candidate={kind:i===0?'latest_snapshot':'snapshot_headline',sourceIds:[row.id],refs:[ref('snapshots',row.id)],audience:audienceOf(row),score:row.relevance,text:'SNAPSHOT '+row.id+' ['+row.kind+'; '+row.agent_label+'; '+iso(row.created_at)+'] '+(row.title??'Untitled')+'\n'+excerpt(row.content,words,i===0||row.relevance>0?1800:300)};
  if(words.length&&row.relevance>0)relevant.push(candidate);else background.push(candidate);
 }
 // Derived profiles are separate hypotheses, never the primary latest memory.
 if(words.some(w=>['profile','formulation','overnight','psychological','themes','audit','changes'].includes(w))){
  const dp:unknown[]=[...tenant],dv=visible('snapshots','s',a,dp,shared,target);
  const row=(await db.query("SELECT s.* FROM snapshots s WHERE user_id=$1 AND brain_id=$2 AND kind='formulation' AND "+dv+' ORDER BY created_at DESC,id DESC LIMIT 1',dp)).rows[0];
  if(row)background.push({kind:'derived_formulation',sourceIds:[row.id],refs:[ref('snapshots',row.id)],audience:audienceOf(row),text:'DERIVED HYPOTHESES, NOT VERIFIED FACTS '+row.id+'\n'+excerpt(row.content,words,1600)});
 }
 relevant.sort((x,y)=>(y.score??0)-(x.score??0));
 const selected:Candidate[]=[],jobIds:string[]=[],allRefs:SourceRef[]=[];let used=0,truncated=false,audience=target??['all'];
 const consume=(items:Candidate[],cap:number)=>{
  if(!items.length||cap<=0)return;
  const pack=boundContext(items,cap,version);truncated ||= pack.truncated;used+=(selected.length&&pack.blocks.length?2:0)+pack.bytes;
  selected.push(...pack.blocks.map(block=>({kind:block.kind,text:block.text,sourceIds:block.sourceIds})));
  audience=intersectAudiences(audience,pack.audience);allRefs.push(...pack.sourceRefs);
  for(const id of pack.includedJobIds)if(!jobIds.includes(id))jobIds.push(id);
 };
 consume(session,Math.min(Math.floor(budget*0.25),budget));
 consume(urgent,Math.min(Math.floor(budget*0.30),Math.max(0,budget-used-2)));
 consume([...relevant,...background],Math.max(0,budget-used-(selected.length?2:0)));
 const text=selected.map(block=>block.text).join('\n\n'),bytes=Buffer.byteLength(text);
 return{blocks:selected.map(({kind,text,sourceIds})=>({kind,text,sourceIds})),bytes,estimatedTokens:bytes,memoryVersion:version,truncated,includedJobIds:jobIds,audience,sourceRefs:[...new Map(allRefs.map(r=>[r.collection+':'+r.id,r])).values()].slice(0,40)};
}
export async function buildContextPack(a:AuthContext,options:ContextOptions={}):Promise<ContextPack>{
 if(!a.scopes.includes('brain:read'))throw new Error('brain:read is required for context.');
 const budget=contextTokenBudget(options.tokenBudget),queryHash=createHash('sha256').update(options.query??'').digest('hex');
 const key=options.sessionId?[a.user_id,a.brain_id,a.agent_label,options.sessionId,budget,queryHash,Boolean(options.sharedOnly),ownerContext(a),JSON.stringify(options.audience??null)].join(':'):undefined;
 const brain=(await pool.query('SELECT memory_version FROM brains WHERE user_id=$1 AND id=$2',[a.user_id,a.brain_id])).rows[0];if(!brain)throw new Error('Brain not found.');
 const version=String(brain.memory_version),saved=key?cache.get(key):undefined;
 let pack=saved?.version===version?structuredClone(saved.pack):await transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  const row=(await db.query('SELECT memory_version FROM brains WHERE user_id=$1 AND id=$2',[a.user_id,a.brain_id])).rows[0];if(!row)throw new Error('Brain not found.');
  return assemble(db,a,{...options,tokenBudget:budget},String(row.memory_version));
 });
 if(options.markJobsSurfaced&&pack.includedJobIds.length){await pool.query('UPDATE jobs SET surfaced_to=array_append(surfaced_to,$3) WHERE user_id=$1 AND brain_id=$2 AND id=ANY($4::uuid[]) AND NOT $3=ANY(surfaced_to)',[a.user_id,a.brain_id,a.agent_label,pack.includedJobIds]);if(key)cache.delete(key);}
 else if(key){if(cache.size>=128)cache.delete(cache.keys().next().value!);cache.set(key,{version:pack.memoryVersion,pack:structuredClone(pack)});}
 return pack;
}
