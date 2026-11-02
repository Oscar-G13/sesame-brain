import type pg from 'pg';
import {transaction} from '../db/index.js';
import {ToolError,type AuthContext} from '../tools/service.js';
import {checkBrainAuthority} from './model-tools.js';
import {MemoryError,ownerContext,rowVisible,routedAudience,audienceOf,intersectAudiences,memoryAccessSql,validateSourceRefs,type SourceRef} from './memory.js';
export interface ContinuityOptions{sessionId?:string;projectId?:string;query?:string;recordReceipt?:boolean;maxBytes?:number;}
export interface ContinuityItem{id:string;title:string;content:string;status:string;confirmation:string;revision:number;needs_review:boolean;pending_change?:unknown;pending_change_withheld?:boolean;}
export interface ContinuityProject{id:string;title:string;goal:string;version:number;status:string;confirmed_constraints:ContinuityItem[];confirmed_decisions:ContinuityItem[];proposed_items:ContinuityItem[];open_questions:ContinuityItem[];unfinished_tasks:ContinuityItem[];review_flags:ContinuityItem[];}
export interface ContinuityPacket{
 briefing:string;project?:ContinuityProject;current_session?:{id:string;last_activity_at:string;summary:string;summary_source:'saved_tool_activity'};previous_session?:{id:string;last_activity_at:string;snapshot_id?:string;summary:string;summary_source:'auto_snapshot'|'manual_snapshot'|'saved_tool_activity'};
 recent_notes:Record<string,unknown>[];saved_snapshot?:{id:string;title:string;kind:string;agent_label:string;created_at:string;content:string};facts:Record<string,unknown>[];open_work:Record<string,unknown>[];waiting_results:Record<string,unknown>[];
 nightly_update?:{id:string;created_at:string;generated_at?:string;kind:'diff';summary:string};source_refs:SourceRef[];source_audience:string[];saved_context:boolean;bytes:number;truncated:boolean;resume_count?:number;resumed_at?:string;
}
const packetBudgets=new WeakMap<ContinuityPacket,number>();
const stamp=(value:unknown)=>value instanceof Date?value.toISOString():String(value??'');
const clip=(value:unknown,n:number)=>Array.from(String(value??'')).slice(0,n).join('');
function utf8(text:string,bytes:number){const source=Buffer.from(text);return source.length<=bytes?text:source.subarray(0,Math.max(0,bytes)).toString('utf8').replace(/\uFFFD+$/u,'');}
function uuid(value:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new ToolError('Invalid saved context ID.');return value;}
function projectVisible(row:Record<string,any>,a:AuthContext){return ownerContext(a)||row.allowed_agents.includes('all')||(a.agent_label!=='you'&&row.allowed_agents.includes(a.agent_label));}
function suitable(audience:string[],target:string[]|undefined,a:AuthContext){return !target||target.length===1&&target[0]==='you'&&ownerContext(a)||audience.includes('all')||!target.includes('all')&&target.every(label=>audience.includes(label));}
const sourceTables=new Set(['notes','facts','snapshots','handoffs','jobs','fact_revisions','brain_sessions','project_items','project_events']);
function normalizedRefs(refs:any[]):SourceRef[]{
 const kinds:Record<string,SourceRef['collection']>={note:'notes',fact:'facts',snapshot:'snapshots',handoff:'handoffs',job:'jobs',project_item:'project_items'};
 return refs.flatMap(ref=>ref?.collection?[ref]:ref?.id&&kinds[ref.kind]?[{collection:kinds[ref.kind],id:ref.id}]:[]);
}
/** Withdrawn provenance invalidates old derived summaries; never reconstruct it from stale text. */
async function sourcesAvailable(db:pg.PoolClient,a:AuthContext,input:any[],seen=new Set<string>(),depth=0):Promise<boolean>{
 const refs=normalizedRefs(input??[]);if(depth>8||seen.size+refs.length>200)return false;
 try{
  for(let at=0;at<refs.length;at+=40)await validateSourceRefs(db,a,refs.slice(at,at+40));
  for(const ref of refs){
   const key=ref.collection+':'+ref.id;if(seen.has(key))continue;seen.add(key);
   if(sourceTables.has(ref.collection)){
    const row=(await db.query('SELECT source_refs'+(ref.collection==='project_items'?',pending_change':'')+' FROM '+ref.collection+' WHERE user_id=$1 AND brain_id=$2 AND id=$3',[a.user_id,a.brain_id,ref.id])).rows[0];
    if(!row||!await sourcesAvailable(db,a,row.source_refs??[],seen,depth+1)||ref.collection==='project_items'&&!await sourcesAvailable(db,a,row.pending_change?.source_refs??[],seen,depth+1))return false;
   }
  }
  return true;
 }catch(error){if(error instanceof MemoryError||(error as {name?:string}).name==='ZodError')return false;throw error;}
}
async function authorizedBrain(db:pg.PoolClient,a:AuthContext){
 if(!a.scopes.includes('brain:read'))throw new ToolError('insufficient_scope',403);
 await db.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[a.user_id]);
 const brain=(await db.query('SELECT content_epoch FROM brains WHERE user_id=$1 AND id=$2 FOR UPDATE',[a.user_id,a.brain_id])).rows[0];
 if(!brain)throw new ToolError('Brain not found.',404);
 if(a.expected_content_epoch!==undefined&&a.expected_content_epoch!==Number(brain.content_epoch))throw new ToolError('Brain reset; work stopped.',409);
 await checkBrainAuthority(a,Number(brain.content_epoch),false,db);return brain;
}
function boundPacket(packet:ContinuityPacket,maxBytes:number):ContinuityPacket{
 for(;;){
  packet.bytes=Buffer.byteLength(JSON.stringify(packet));const actual=Buffer.byteLength(JSON.stringify(packet));
  if(actual<=maxBytes){packet.bytes=actual;if(Buffer.byteLength(JSON.stringify(packet))===actual)return packet;continue;}
  if(!packet.briefing)throw new ToolError('The saved context cannot fit this response budget.');
  packet.briefing=utf8(packet.briefing,Math.max(0,Buffer.byteLength(packet.briefing)-128));packet.truncated=true;
 }
}
async function packetSourcesAvailable(db:pg.PoolClient,a:AuthContext,packet:ContinuityPacket):Promise<boolean>{
 const returnedItems=packet.project?Object.values(packet.project).flatMap(value=>Array.isArray(value)?value:[]):[];
 for(const ref of packet.source_refs){
  // A withheld proposal must not invalidate the separately returned current confirmed value.
  const withheld=ref.collection==='project_items'&&returnedItems.some((item:ContinuityItem)=>item.id===ref.id&&item.pending_change_withheld&&!item.pending_change);
  if(withheld){
   try{await validateSourceRefs(db,a,[ref]);}catch(error){if(error instanceof MemoryError)return false;throw error;}
   const item=(await db.query('SELECT source_refs FROM project_items WHERE user_id=$1 AND brain_id=$2 AND id=$3',[a.user_id,a.brain_id,ref.id])).rows[0];
   if(!item||!await sourcesAvailable(db,a,item.source_refs??[]))return false;
  }else if(!await sourcesAvailable(db,a,[ref]))return false;
 }
 return true;
}
async function writeReceipt(db:pg.PoolClient,a:AuthContext,sessionId:string,packet:ContinuityPacket,epoch:string|number):Promise<ContinuityPacket>{
 if(!packet.saved_context||!packet.source_refs.length)return packet;
 const current=(await db.query('SELECT id,to_agents,source_refs FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND agent_label=$4 AND content_epoch=$5',[a.user_id,a.brain_id,sessionId,a.agent_label,epoch])).rows[0];
 if(!current)throw new ToolError('This session is no longer available.',409);
 if(!await packetSourcesAvailable(db,a,packet))throw new ToolError('Some saved context is no longer available. Resume again.',409);
 const evidence=await validateSourceRefs(db,a,packet.source_refs);
 packet.source_audience=intersectAudiences(packet.source_audience,evidence.audience,current.to_agents);
 const refs=[...new Map([...(current.source_refs??[]),...packet.source_refs].map((ref:SourceRef)=>[ref.collection+':'+ref.id,ref])).values()].slice(-40);
 const saved=(await db.query('UPDATE brain_sessions SET resume_count=resume_count+1,resumed_at=now(),last_project_id=COALESCE($5,last_project_id),to_agents=$6,source_refs=$7 WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND agent_label=$4 RETURNING resume_count,resumed_at',[a.user_id,a.brain_id,sessionId,a.agent_label,packet.project?.id??null,packet.source_audience,JSON.stringify(refs)])).rows[0];
 packet.resume_count=Number(saved.resume_count);packet.resumed_at=stamp(saved.resumed_at);
 return boundPacket(packet,packetBudgets.get(packet)??16000);
}
/** Final successful-delivery receipt, separate from preparing a continuity packet. */
export async function recordContinuityReceipt(a:AuthContext,sessionId:string,packet:ContinuityPacket):Promise<ContinuityPacket>{
 uuid(sessionId);
 return transaction(async db=>{const brain=await authorizedBrain(db,a);return writeReceipt(db,a,sessionId,packet,brain.content_epoch);});
}
export async function bookmarkProject(a:AuthContext,sessionId:string,projectId:string):Promise<void>{
 uuid(sessionId);uuid(projectId);
 await transaction(async db=>{
  const brain=await authorizedBrain(db,a);
  const project=(await db.query('SELECT id,allowed_agents,status FROM projects WHERE user_id=$1 AND brain_id=$2 AND id=$3',[a.user_id,a.brain_id,projectId])).rows[0];
  if(!project||!projectVisible(project,a)||project.status==='archived')return;
  const session=(await db.query('SELECT id,to_agents,source_refs FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND agent_label=$4 AND content_epoch=$5 AND closed_at IS NULL',[a.user_id,a.brain_id,sessionId,a.agent_label,brain.content_epoch])).rows[0];
  if(!session)throw new ToolError('This session is no longer available.',409);
  const refs=[...new Map([...(session.source_refs??[]),{collection:'projects',id:projectId}].map((ref:SourceRef)=>[ref.collection+':'+ref.id,ref])).values()].slice(-40);
  await db.query('UPDATE brain_sessions SET last_project_id=$5,to_agents=$6,source_refs=$7 WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND agent_label=$4',[a.user_id,a.brain_id,sessionId,a.agent_label,projectId,intersectAudiences(session.to_agents,project.allowed_agents),JSON.stringify(refs)]);
 });
}
export async function buildContinuity(a:AuthContext,options:ContinuityOptions={}):Promise<ContinuityPacket>{
 if(options.sessionId)uuid(options.sessionId);if(options.projectId)uuid(options.projectId);
 const maxBytes=Math.max(2048,Math.min(32000,Math.floor(options.maxBytes??16000)));
 return transaction(async db=>{
  const brain=await authorizedBrain(db,a),tenant=[a.user_id,a.brain_id];
  const current=options.sessionId?(await db.query('SELECT * FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND agent_label=$4 AND content_epoch=$5 AND closed_at IS NULL',[...tenant,options.sessionId,a.agent_label,brain.content_epoch])).rows[0]:undefined;
  if(options.sessionId&&!current)throw new ToolError('This session is no longer available.',409);
  const previous=(await db.query('SELECT * FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND ($4::uuid IS NULL OR id<>$4) AND content_epoch=$5 ORDER BY last_activity_at DESC,id DESC LIMIT 12',[...tenant,a.agent_label,options.sessionId??null,brain.content_epoch])).rows.filter(row=>rowVisible(row,a));
  let selected:Record<string,any>|undefined;
  const requested=[options.projectId,current?.last_project_id,...previous.map(row=>row.last_project_id)].filter(Boolean);
  for(const id of [...new Set(requested)]){
   const project=(await db.query('SELECT id,title,goal,version,status,allowed_agents FROM projects WHERE user_id=$1 AND brain_id=$2 AND id=$3',[...tenant,id])).rows[0];
   if(project&&projectVisible(project,a)&&project.status!=='archived'){selected=project;break;}
   if(id===options.projectId)throw new ToolError('Project not found or unavailable.',404);
  }
  if(!selected&&!requested.length){
   const rows=(await db.query("SELECT id,title,goal,version,status,allowed_agents FROM projects WHERE user_id=$1 AND brain_id=$2 AND status IN ('active','paused') ORDER BY updated_at DESC LIMIT 20",tenant)).rows.filter(row=>projectVisible(row,a));
   if(rows.length===1)selected=rows[0];
  }
  const packet:ContinuityPacket={briefing:'',recent_notes:[],facts:[],open_work:[],waiting_results:[],source_refs:[],source_audience:intersectAudiences(a.source_audience),saved_context:false,bytes:0,truncated:false};
  packetBudgets.set(packet,maxBytes);
  const include=(mutate:()=>void,undo:()=>void,refs:SourceRef[],audience:string[])=>{
   const oldRefs=packet.source_refs,oldAudience=packet.source_audience,nextRefs=[...new Map([...packet.source_refs,...refs].map(ref=>[ref.collection+':'+ref.id,ref])).values()];
   if(nextRefs.length>40){packet.truncated=true;return false;}
   mutate();packet.source_refs=nextRefs;packet.source_audience=intersectAudiences(oldAudience,audience);
   if(Buffer.byteLength(JSON.stringify(packet))>maxBytes-1200){undo();packet.source_refs=oldRefs;packet.source_audience=oldAudience;packet.truncated=true;return false;}packet.saved_context=true;return true;
  };
  const append=(array:Record<string,unknown>[],value:Record<string,unknown>,ref:SourceRef,audience:string[])=>include(()=>array.push(value),()=>{array.pop();},[ref],audience);
  if(selected){
   packet.project={id:selected.id,title:utf8(clip(selected.title,160),Math.min(320,Math.floor(maxBytes/10))),goal:utf8(clip(selected.goal,1000),Math.min(1000,Math.floor(maxBytes/5))),version:Number(selected.version),status:selected.status,confirmed_constraints:[],confirmed_decisions:[],proposed_items:[],open_questions:[],unfinished_tasks:[],review_flags:[]};
   packet.source_refs.push({collection:'projects',id:selected.id});packet.source_audience=intersectAudiences(packet.source_audience,selected.allowed_agents);packet.saved_context=true;
   const items=(await db.query("SELECT id,type,title,content,status,confirmation,revision,needs_review,pending_change,source_refs FROM project_items WHERE user_id=$1 AND brain_id=$2 AND project_id=$3 AND status<>'superseded' ORDER BY needs_review DESC,(confirmation='confirmed') DESC,updated_at DESC,id DESC",[...tenant,selected.id])).rows;
   const groups:[keyof Pick<ContinuityProject,'confirmed_constraints'|'confirmed_decisions'|'proposed_items'|'open_questions'|'unfinished_tasks'|'review_flags'>,(row:any)=>boolean][]=[
    ['confirmed_constraints',row=>row.type==='constraint'&&row.confirmation==='confirmed'],
    ['confirmed_decisions',row=>row.type==='decision'&&row.confirmation==='confirmed'],
    ['proposed_items',row=>['constraint','decision'].includes(row.type)&&row.confirmation!=='confirmed'],
    ['review_flags',row=>row.needs_review||row.confirmation==='disputed'||row.pending_change!==null],
    ['open_questions',row=>row.type==='question'&&!['done','superseded'].includes(row.status)],
    ['unfinished_tasks',row=>['task','milestone'].includes(row.type)&&!['done','superseded'].includes(row.status)]
   ];
   for(let index=0;index<4;index++)for(const [key,predicate] of groups){
    const row=items.filter(predicate)[index];if(!row)continue;
    if(!await sourcesAvailable(db,a,row.source_refs??[]))continue;
    const pendingVisible=await sourcesAvailable(db,a,row.pending_change?.source_refs??[]);
    const value:ContinuityItem={id:row.id,title:utf8(clip(row.title,160),160),content:utf8(clip(row.content,400),400),status:row.status,confirmation:row.confirmation,revision:Number(row.revision),needs_review:row.needs_review,...(row.pending_change&&pendingVisible?{pending_change:{title:clip(row.pending_change.title,160),content:clip(row.pending_change.content,300),status:row.pending_change.status}}:row.pending_change?{pending_change_withheld:true}:{})};
    const array=packet.project[key];include(()=>array.push(value),()=>{array.pop();},[{collection:'project_items',id:row.id}],selected.allowed_agents);
   }
  }
  const target=selected?.allowed_agents;
  const jp:unknown[]=[...tenant],jv=memoryAccessSql('jobs','j',a,jp);
  const jobs=(await db.query("SELECT j.id,j.title,j.state,j.project_id,j.result_summary,left(j.result_text,600) AS result_text,j.source_refs,j.source_audience,j.visibility,j.surfaced_to FROM jobs j WHERE j.user_id=$1 AND j.brain_id=$2 AND j.state IN ('queued','running','done','partial') AND "+jv+' ORDER BY j.created_at DESC LIMIT 20',jp)).rows;
  for(const row of jobs){
   const audience=audienceOf(row,'source_audience');if(!suitable(audience,target,a)||!await sourcesAvailable(db,a,row.source_refs??[]))continue;
   if(['done','partial'].includes(row.state)&&!row.surfaced_to.includes(a.agent_label)&&packet.waiting_results.length<3)append(packet.waiting_results,{id:row.id,title:clip(row.title,120),state:row.state,summary:clip(row.result_summary||row.result_text,400)}, {collection:'jobs',id:row.id},audience);
   else if(['queued','running'].includes(row.state)&&packet.open_work.length<3)append(packet.open_work,{id:row.id,title:clip(row.title,120),state:row.state,kind:'job'}, {collection:'jobs',id:row.id},audience);
  }
  const hp:unknown[]=[...tenant],hv=memoryAccessSql('handoffs','h',a,hp);
  const handoffs=(await db.query("SELECT h.id,h.title,h.context,h.from_agent,h.to_agent,h.source_audience,h.visibility,h.source_refs,h.status FROM handoffs h WHERE h.user_id=$1 AND h.brain_id=$2 AND h.status IN ('pending','accepted') AND "+hv+' ORDER BY h.created_at DESC LIMIT 10',hp)).rows;
  for(const row of handoffs){const audience=routedAudience('handoffs',row);if(packet.open_work.length>=5||!suitable(audience,target,a)||!await sourcesAvailable(db,a,row.source_refs??[]))continue;append(packet.open_work,{id:row.id,title:clip(row.title,120),context:clip(row.context,300),state:row.status,kind:'handoff'},{collection:'handoffs',id:row.id},audience);}
  for(const prior of previous){
   if(prior.last_project_id){
    const priorProject=(await db.query('SELECT status,allowed_agents FROM projects WHERE user_id=$1 AND brain_id=$2 AND id=$3',[...tenant,prior.last_project_id])).rows[0];
    if(!priorProject||priorProject.status==='archived'||!projectVisible(priorProject,a))continue;
   }
   if(!suitable(prior.to_agents,target,a)||selected&&prior.last_project_id&&prior.last_project_id!==selected.id||!await sourcesAvailable(db,a,prior.source_refs??[]))continue;
   const sp:unknown[]=[...tenant,prior.rolled_up_snapshot_id??null,a.agent_label,prior.started_at,prior.last_activity_at],sv=memoryAccessSql('snapshots','s',a,sp);
   const snapshot=(await db.query("SELECT s.id,s.kind,s.content,s.to_agents,s.visibility,s.source_refs FROM snapshots s WHERE s.user_id=$1 AND s.brain_id=$2 AND (s.id=$3::uuid OR (s.agent_label=$4 AND s.kind='manual' AND s.created_at>=$5 AND s.created_at<$6::timestamptz+interval '1 millisecond')) AND "+sv+' ORDER BY (s.id=$3::uuid) DESC,s.created_at DESC LIMIT 1',sp)).rows[0];
   let summary='',summary_source:'auto_snapshot'|'manual_snapshot'|'saved_tool_activity'='saved_tool_activity',snapshotId:string|undefined,audience=prior.to_agents;
   const refs:SourceRef[]=[{collection:'brain_sessions',id:prior.id}];
   if(snapshot&&suitable(audienceOf(snapshot),target,a)&&await sourcesAvailable(db,a,snapshot.source_refs??[])){summary=clip(snapshot.content,1000);snapshotId=snapshot.id;summary_source=snapshot.kind==='manual'?'manual_snapshot':'auto_snapshot';audience=intersectAudiences(audience,audienceOf(snapshot));refs.push({collection:'snapshots',id:snapshot.id});}
   if(!summary){
    const events=(await db.query("SELECT metadata FROM activity WHERE user_id=$1 AND brain_id=$2 AND actor_agent=$3 AND metadata->>'session_id'=$4 AND metadata ? 'summary' ORDER BY created_at DESC,id DESC LIMIT 5",[...tenant,a.agent_label,prior.id])).rows;
    const material:string[]=[];
    for(const event of events){
     const eventAudience=event.metadata.audience??prior.to_agents;
     if(!rowVisible({to_agents:eventAudience},a)||!suitable(eventAudience,target,a)||!await sourcesAvailable(db,a,event.metadata.source_refs??[]))continue;
     material.push(String(event.metadata.tool??'Saved tool record')+': '+String(event.metadata.summary??''));audience=intersectAudiences(audience,eventAudience);
    }
    summary=clip(material.join('\n'),1000);
   }
   if(!summary)continue;
   const value={id:prior.id,last_activity_at:stamp(prior.last_activity_at),...(snapshotId?{snapshot_id:snapshotId}:{}),summary,summary_source};
   include(()=>{packet.previous_session=value;},()=>{delete packet.previous_session;},refs,audience);break;
  }
  if(current&&suitable(current.to_agents,target,a)&&await sourcesAvailable(db,a,current.source_refs??[])){
   const events=(await db.query("SELECT metadata FROM activity WHERE user_id=$1 AND brain_id=$2 AND actor_agent=$3 AND metadata->>'session_id'=$4 AND metadata ? 'summary' ORDER BY created_at DESC,id DESC LIMIT 5",[...tenant,a.agent_label,current.id])).rows;
   const material:string[]=[];let audience=current.to_agents;
   for(const event of events){
    const eventAudience=event.metadata.audience??current.to_agents;
    if(!rowVisible({to_agents:eventAudience},a)||!suitable(eventAudience,target,a)||!await sourcesAvailable(db,a,event.metadata.source_refs??[]))continue;
    material.push(String(event.metadata.tool??'Saved tool record')+': '+String(event.metadata.summary??''));audience=intersectAudiences(audience,eventAudience);
   }
   if(material.length){
    const value={id:current.id,last_activity_at:stamp(current.last_activity_at),summary:clip(material.join('\n'),1000),summary_source:'saved_tool_activity' as const};
    include(()=>{packet.current_session=value;},()=>{delete packet.current_session;},[{collection:'brain_sessions',id:current.id}],audience);
   }
  }
  const words=(options.query??selected?.goal??'').toLowerCase().match(/[\p{L}\p{N}]{3,40}/gu)?.slice(0,8)??[];
  const fp:unknown[]=[...tenant,words],fv=memoryAccessSql('facts','f',a,fp);
  const facts=(await db.query("SELECT f.id,f.key,f.value,f.confirmation,f.confidence,f.source_type,f.to_agents,f.visibility,f.source_refs FROM facts f WHERE f.user_id=$1 AND f.brain_id=$2 AND "+fv+" ORDER BY (SELECT count(*) FROM unnest($3::text[]) q(word) WHERE strpos(lower(f.key||' '||f.value),q.word)>0) DESC,(f.confirmation='user_confirmed') DESC,f.updated_at DESC LIMIT 8",fp)).rows;
  for(const row of facts){const audience=audienceOf(row);if(packet.facts.length>=4||!suitable(audience,target,a)||!await sourcesAvailable(db,a,row.source_refs??[]))continue;append(packet.facts,{id:row.id,key:row.key,value:clip(row.value,400),confirmation:row.confirmation,confidence:row.confidence,source_type:row.source_type},{collection:'facts',id:row.id},audience);}
  const np:unknown[]=[...tenant,words],nv=memoryAccessSql('notes','n',a,np);
  const notes=(await db.query("SELECT n.id,n.text,n.from_agent,n.to_agents,n.source_audience,n.visibility,n.source_refs,n.created_at FROM notes n WHERE n.user_id=$1 AND n.brain_id=$2 AND "+nv+" ORDER BY (SELECT count(*) FROM unnest($3::text[]) q(word) WHERE strpos(lower(n.text),q.word)>0) DESC,n.created_at DESC LIMIT 10",np)).rows;
  for(const row of notes){
   const audience=routedAudience('notes',row);if(packet.recent_notes.length>=3||!suitable(audience,target,a)||!await sourcesAvailable(db,a,row.source_refs??[]))continue;
   append(packet.recent_notes,{id:row.id,text:utf8(clip(row.text,600),600),from_agent:row.from_agent,to_agents:row.to_agents,created_at:stamp(row.created_at)},{collection:'notes',id:row.id},audience);
  }
  if(!packet.previous_session?.snapshot_id){
   const sp:unknown[]=[...tenant],sv=memoryAccessSql('snapshots','s',a,sp);
   const rows=(await db.query("SELECT s.id,s.title,s.kind,s.agent_label,s.created_at,s.content,s.visibility,s.to_agents,s.source_refs FROM snapshots s WHERE s.user_id=$1 AND s.brain_id=$2 AND s.kind IN ('manual','auto') AND "+sv+' ORDER BY s.created_at DESC LIMIT 5',sp)).rows;
   for(const row of rows){
    const audience=audienceOf(row);if(!suitable(audience,target,a)||!await sourcesAvailable(db,a,row.source_refs??[]))continue;
    const value={id:row.id,title:clip(row.title,160),kind:row.kind,agent_label:row.agent_label,created_at:stamp(row.created_at),content:utf8(clip(row.content,800),800)};
    include(()=>{packet.saved_snapshot=value;},()=>{delete packet.saved_snapshot;},[{collection:'snapshots',id:row.id}],audience);break;
   }
  }
  const dp:unknown[]=[...tenant],dv=memoryAccessSql('snapshots','d',a,dp);
  const updates=(await db.query("SELECT d.id,d.created_at,d.content,d.visibility,d.to_agents,d.source_refs FROM snapshots d WHERE d.user_id=$1 AND d.brain_id=$2 AND d.kind='diff' AND d.agent_label='brain-nightly' AND "+dv+' ORDER BY d.created_at DESC,d.id DESC LIMIT 5',dp)).rows;
  for(const row of updates){
   const audience=audienceOf(row);if(!suitable(audience,target,a)||!await sourcesAvailable(db,a,row.source_refs??[]))continue;
   let diff:any;try{diff=JSON.parse(row.content);}catch{continue;}
   if(diff.schema!=='brain_formulation_diff'||diff.schema_version!=='1.0'||typeof diff.spoken_summary!=='string'||!diff.spoken_summary.trim())continue;
   const value={id:row.id,created_at:stamp(row.created_at),...(typeof diff.generated_at==='string'?{generated_at:diff.generated_at}:{}),kind:'diff' as const,summary:utf8(diff.spoken_summary.trim().split(/\s+/).slice(0,100).join(' '),Math.min(1600,Math.max(200,Math.floor(maxBytes/4))))};
   include(()=>{packet.nightly_update=value;},()=>{delete packet.nightly_update;},[{collection:'snapshots',id:row.id}],audience);break;
  }
  const spoken:string[]=[];
  if(packet.project){spoken.push('Your saved project is '+packet.project.title+'.');if(packet.project.goal)spoken.push('The current goal is '+clip(packet.project.goal,170)+'.');const constraint=packet.project.confirmed_constraints[0],decision=packet.project.confirmed_decisions[0],task=packet.project.unfinished_tasks[0],question=packet.project.open_questions[0];if(constraint)spoken.push('Confirmed constraint: '+clip(constraint.content||constraint.title,120)+'.');else if(packet.project.proposed_items[0]){const proposal=packet.project.proposed_items[0];spoken.push((proposal.confirmation==='disputed'?'Disputed saved item: ':'Previously recorded, not yet confirmed: ')+clip(proposal.content||proposal.title,120)+'.');}if(decision)spoken.push('Confirmed decision: '+clip(decision.content||decision.title,100)+'.');if(task)spoken.push('Next unfinished task: '+clip(task.title,100)+'.');if(question)spoken.push('Open question: '+clip(question.title,100)+'.');if(packet.project.review_flags.length)spoken.push(packet.project.review_flags.length+' saved items need review; proposed corrections are not confirmed.');}
  else if(packet.current_session)spoken.push('Recent saved conversation context: '+clip(packet.current_session.summary,260));
  else if(packet.previous_session)spoken.push('From your last saved session: '+clip(packet.previous_session.summary,260));
  else if(packet.facts.length)spoken.push('Saved context: '+clip(packet.facts[0].key,80)+' — '+clip(packet.facts[0].value,160)+'.');
  else if(packet.recent_notes.length)spoken.push('A saved note says: '+clip(packet.recent_notes[0].text,240));
  else if(packet.saved_snapshot)spoken.push('Saved snapshot: '+clip(packet.saved_snapshot.content,240));
  if(packet.waiting_results.length)spoken.push(packet.waiting_results.length+' completed results are ready: '+packet.waiting_results.map(row=>row.title).join(', ')+'.');
  if(!packet.project&&packet.open_work.length)spoken.push('Still open: '+packet.open_work.map(row=>row.title).join(', ')+'.');
  if(packet.nightly_update){
   const update=packet.nightly_update,words=spoken.join(' ').split(/\s+/).filter(Boolean).slice(0,95);
   words.push('Latest overnight interpretation from '+(update.generated_at??update.created_at).slice(0,10)+': '+update.summary.split(/\s+/).slice(0,35).join(' ')+' Generated hypotheses; current confirmed facts take precedence.');
   packet.briefing=words.join(' ').split(/\s+/).slice(0,150).join(' ');
  }else packet.briefing=packet.saved_context?spoken.join(' ').split(/\s+/).slice(0,150).join(' '):'There is no saved context to resume yet. Save the goal and useful details as we go.';
  if(current&&options.recordReceipt!==false&&packet.saved_context)await writeReceipt(db,a,current.id,packet,brain.content_epoch);
  return boundPacket(packet,maxBytes);
 });
}
