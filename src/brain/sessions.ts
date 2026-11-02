import {buildContinuity,type ContinuityPacket} from './continuity.js';
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {pool,transaction} from '../db/index.js';
import type {AuthContext} from '../tools/service.js';
import {trimUtf8} from './context.js';
import {intersectAudiences,normalizeAudience,visibilityFor,memoryAccessSql,audienceOf,validateSourceRefs,type SourceRef} from './memory.js';

export interface BrainSession {
 id:string;user_id:string;brain_id:string;agent_label:string;session_key:string;transport_session_id:string|null;
 request_grant_id:string|null;browser_session_id:string|null;source:'oauth'|'dashboard';writable:boolean;content_epoch:string;started_at:Date;last_activity_at:Date;closed_at:Date|null;
 write_count:number;activity_count:number;think_count:number;do_count:number;rolled_up_snapshot_id:string|null;
 briefing:string|null;briefing_at:Date|null;last_snapshot_at:Date|null;rollup_claimed_at:Date|null;rollup_error:string|null;to_agents:string[];source_refs:SourceRef[];last_project_id:string|null;resume_count:string|number;resumed_at:Date|null;
}
export type SummaryResult=string|{text:string;surfacedJobIds?:string[]};
export type SessionSummarizer=(purpose:'briefing'|'rollup',text:string,auth:AuthContext)=>Promise<SummaryResult>;
export interface SessionOptions {skipContinuity?:boolean;projectId?:string;closeOnUnavailable?:boolean;now?:Date;transportSessionId?:string;summarizer?:SessionSummarizer;idleMinutes?:number;rollupMinutes?:number;userId?:string;brainId?:string;}
export interface SessionTouch {session:BrainSession;firstTouch:boolean;briefing?:string;continuity?:ContinuityPacket;}
export interface SessionEvent {tool:string;write:boolean;summary?:string;refId?:string;collection?:string;now?:Date;sourceAudience?:string[];sourceRefs?:SourceRef[];}
export interface RollupResult {closed:boolean;snapshotId:string|null;disabled?:boolean;inProgress?:boolean;stale?:boolean;missing?:boolean;message:string;}
function minutes(value:number|undefined,env:string,fallback:number):number{
 const parsed=value??Number(process.env[env]??fallback);return Number.isFinite(parsed)&&parsed>0?parsed:fallback;
}
function rowSession(row:Record<string,unknown>):BrainSession{
 return {...row,content_epoch:String(row.content_epoch),write_count:Number(row.write_count),activity_count:Number(row.activity_count),think_count:Number(row.think_count),do_count:Number(row.do_count)} as unknown as BrainSession;
}
function sessionKey(a:AuthContext,transportSessionId?:string):string{
 return createHash('sha256').update(transportSessionId?'transport:'+transportSessionId+':'+a.agent_label:isDashboard(a)?'browser:'+a.browser_session_id+':'+a.agent_label:'token:'+a.token_hash+':'+a.agent_label).digest('hex');
}
function isDashboard(a:AuthContext):boolean{return a.client_id==='dashboard'&&!a.grant_id;}
async function currentGrant(db:pg.PoolClient,a:AuthContext,write=false):Promise<boolean>{
 if(isDashboard(a)){
  if(!a.browser_session_id||(write&&!a.scopes.includes('brain:write')))return false;
  const browser=await db.query('SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.expires_at>now() AND u.deleted_at IS NULL FOR SHARE OF s',[a.browser_session_id,a.user_id]);
  return Boolean(browser.rowCount);
 }
 const found=await db.query('SELECT agent_label,scope FROM grants WHERE id=$1 AND user_id=$2 AND brain_id=$3 AND revoked_at IS NULL FOR SHARE',[a.grant_id,a.user_id,a.brain_id]);
 const row=found.rows[0];return Boolean(row&&row.agent_label===a.agent_label&&(!write||String(row.scope).split(/\s+/).includes('brain:write')));
}
function summaryText(result:SummaryResult):string{return typeof result==='string'?result:result.text;}
function spokenWords(text:string,max=150):string{return text.trim().split(/\s+/u).slice(0,max).join(' ');}
export async function touchSession(a:AuthContext,options:SessionOptions={}):Promise<SessionTouch>{
 const now=options.now??new Date(),key=sessionKey(a,options.transportSessionId);
 const idle=minutes(options.idleMinutes,'BRAIN_SESSION_IDLE_MIN',30)*60000;
 const touch=await transaction(async db=>{
  const brain=await db.query('SELECT content_epoch FROM brains WHERE user_id=$1 AND id=$2 FOR UPDATE',[a.user_id,a.brain_id]);
  if(!brain.rowCount||!await currentGrant(db,a))throw new Error('Brain or connection not available.');
  const existing=await db.query('SELECT * FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND session_key=$4 AND closed_at IS NULL ORDER BY last_activity_at DESC,id DESC LIMIT 1 FOR UPDATE',[a.user_id,a.brain_id,a.agent_label,key]);
  const row=existing.rows[0];
  if(row&&String(row.content_epoch)===String(brain.rows[0].content_epoch)&&now.getTime()-new Date(row.last_activity_at).getTime()<idle){
   const updated=await db.query('UPDATE brain_sessions SET last_activity_at=$5,request_grant_id=$6,writable=$7,browser_session_id=$8 WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 RETURNING *',[a.user_id,a.brain_id,a.agent_label,row.id,now,isDashboard(a)?null:a.grant_id,a.scopes.includes('brain:write'),isDashboard(a)?a.browser_session_id??null:null]);
   return{session:rowSession(updated.rows[0]),firstTouch:false};
  }
  // Keep an unsummarized writing session intact when an AI provider is unavailable.
  if(row&&Number(row.write_count)===0&&Number(row.think_count)===0&&Number(row.do_count)===0)await db.query('UPDATE brain_sessions SET closed_at=$5 WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[a.user_id,a.brain_id,a.agent_label,row.id,now]);
  const inserted=await db.query('INSERT INTO brain_sessions(user_id,brain_id,agent_label,session_key,transport_session_id,request_grant_id,writable,content_epoch,started_at,last_activity_at,browser_session_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11) RETURNING *',[a.user_id,a.brain_id,a.agent_label,key,options.transportSessionId??null,isDashboard(a)?null:a.grant_id,a.scopes.includes('brain:write'),brain.rows[0].content_epoch,now,isDashboard(a)?a.browser_session_id??null:null,isDashboard(a)?'dashboard':'oauth']);
  return{session:rowSession(inserted.rows[0]),firstTouch:true};
 });
 if(!touch.firstTouch||options.skipContinuity)return touch;
 const continuity=await buildContinuity({...a,expected_content_epoch:Number(touch.session.content_epoch)},{sessionId:touch.session.id,projectId:options.projectId});
 touch.session.to_agents=intersectAudiences(touch.session.to_agents,continuity.source_audience);
 touch.session.source_refs=[...new Map([...(touch.session.source_refs??[]),...continuity.source_refs].map(ref=>[ref.collection+':'+ref.id,ref])).values()].slice(-40);
 touch.session.last_project_id=continuity.project?.id??touch.session.last_project_id;
 touch.session.resume_count=continuity.resume_count??touch.session.resume_count;
 return{...touch,continuity,...(continuity.saved_context?{briefing:continuity.briefing}:{})};
}

export async function recordSessionActivity(a:AuthContext,sessionId:string,event:SessionEvent):Promise<void>{
 if(event.write&&!a.scopes.includes('brain:write'))throw new Error('brain:write is required.');
 const now=event.now??new Date();
 await transaction(async db=>{
  const brain=await db.query('SELECT content_epoch FROM brains WHERE user_id=$1 AND id=$2 FOR UPDATE',[a.user_id,a.brain_id]);
  if(!brain.rowCount||!await currentGrant(db,a))return;
  const current=(await db.query('SELECT to_agents,source_refs FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 AND closed_at IS NULL FOR UPDATE',[a.user_id,a.brain_id,a.agent_label,sessionId])).rows[0];if(!current)return;
  const audience=intersectAudiences(event.sourceAudience??[a.agent_label],a.source_audience);
  const sourceRefs=[...new Map([...(current.source_refs??[]),...(event.sourceRefs??[])].map((r:SourceRef)=>[r.collection+':'+r.id,r])).values()].slice(0,100);
  if(event.write||event.tool==='think'||event.tool==='do')await db.query('UPDATE brain_sessions SET to_agents=$5,source_refs=$6 WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[a.user_id,a.brain_id,a.agent_label,sessionId,intersectAudiences(current.to_agents,audience),JSON.stringify(sourceRefs)]);
  const updated=await db.query('UPDATE brain_sessions SET last_activity_at=$5,activity_count=activity_count+1,write_count=write_count+$6,think_count=think_count+$7,do_count=do_count+$8 WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 AND closed_at IS NULL AND content_epoch=$9 RETURNING id',[a.user_id,a.brain_id,a.agent_label,sessionId,now,event.write?1:0,event.tool==='think'?1:0,event.tool==='do'?1:0,brain.rows[0].content_epoch]);
  if(!updated.rowCount)return;
  if(a.scopes.includes('brain:write')&&(event.write||event.tool==='think'||event.tool==='do')){
   const metadata={session_id:sessionId,tool:event.tool,write:event.write,summary:trimUtf8(event.summary??(event.tool+' completed.'),8000),audience,source_refs:event.sourceRefs??[],...(event.refId?{ref_id:event.refId}:{}),...(event.collection?{collection:event.collection}:{})};
   await db.query('INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[a.user_id,a.brain_id,a.agent_label,'session_tool',event.refId??null,metadata,now]);
  }
 });
}
export async function sessionTrailer(a:AuthContext,sessionId?:string,now=new Date()):Promise<string>{
 const params:unknown[]=[a.user_id,a.brain_id,a.agent_label],visible=memoryAccessSql('jobs','j',a,params);
 const jobs=await pool.query("SELECT count(*) FILTER(WHERE state IN ('queued','running'))::int AS pending,count(*) FILTER(WHERE state IN ('done','partial') AND NOT $3=ANY(surfaced_to))::int AS waiting FROM jobs j WHERE user_id=$1 AND brain_id=$2 AND "+visible,params);
 const parts:string[]=[],row=jobs.rows[0];
 if(row.pending)parts.push(row.pending+' '+(row.pending===1?'job running.':'jobs running.'));
 if(row.waiting)parts.push(row.waiting+' '+(row.waiting===1?'result waiting.':'results waiting.'));
 if(sessionId){
  const sessions=await pool.query('SELECT started_at,write_count FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 AND closed_at IS NULL',[a.user_id,a.brain_id,a.agent_label,sessionId]);
  const session=sessions.rows[0];if(session&&Number(session.write_count)===0&&now.getTime()-new Date(session.started_at).getTime()>=5*60000)parts.push('No notes saved yet this call.');
 }
 return parts.join(' ').trim().split(/\s+/u).slice(0,19).join(' ');
}
async function sessionMaterial(a:AuthContext,session:BrainSession):Promise<string>{
 const parts=['Session '+session.started_at.toISOString()+' through '+session.last_activity_at.toISOString()+'. Assistant: '+a.agent_label+'.'];
 let bytes=Buffer.byteLength(parts[0],'utf8');
 for(let offset=0;;offset+=32){
  const events=await pool.query("SELECT kind,metadata->>'tool' AS tool,left(metadata->>'summary',8000) AS summary,created_at FROM activity WHERE user_id=$1 AND brain_id=$2 AND actor_agent=$3 AND metadata->>'session_id'=$4 AND created_at>=$5 ORDER BY created_at,id LIMIT 32 OFFSET $6",[a.user_id,a.brain_id,a.agent_label,session.id,session.started_at,offset]);
  for(const row of events.rows){
   const text=new Date(row.created_at).toISOString()+' '+String(row.tool??row.kind)+': '+String(row.summary??'A change was saved.');
   bytes+=2+Buffer.byteLength(text,'utf8');parts.push(text);
   if(bytes>20000)return trimUtf8(parts.join('\n\n'),19940)+'\n[Some session records omitted at the context budget.]';
  }
  if(events.rows.length<32)return parts.join('\n\n');
 }
}
export async function rollupSession(a:AuthContext,sessionId:string,options:SessionOptions={}):Promise<RollupResult>{
 const now=options.now??new Date();
 const claim=await transaction(async db=>{
  const brain=await db.query('SELECT content_epoch FROM brains WHERE user_id=$1 AND id=$2 FOR UPDATE',[a.user_id,a.brain_id]);
  if(!brain.rowCount)return{result:{closed:false,snapshotId:null,missing:true,message:'This session is no longer available.'} as RollupResult};
  const found=await db.query('SELECT * FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 FOR UPDATE',[a.user_id,a.brain_id,a.agent_label,sessionId]);
  if(!found.rowCount)return{result:{closed:false,snapshotId:null,missing:true,message:'This session is no longer available.'} as RollupResult};
  const session=rowSession(found.rows[0]);
  if(session.closed_at)return{result:{closed:true,snapshotId:session.rolled_up_snapshot_id,message:session.rolled_up_snapshot_id?'Your call was saved.':'Your session is closed.'} as RollupResult};
  const active=await currentGrant(db,a,true),meaningful=session.write_count>0||session.think_count>0||session.do_count>0;
  if(!active||!session.writable||!a.scopes.includes('brain:write')||!meaningful){
   await db.query('UPDATE brain_sessions SET closed_at=$5,rollup_claimed_at=NULL WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[a.user_id,a.brain_id,a.agent_label,sessionId,now]);
   return{result:{closed:true,snapshotId:null,message:'Your session is closed.'} as RollupResult};
  }
  if(session.content_epoch!==String(brain.rows[0].content_epoch))return{result:{closed:false,snapshotId:null,missing:true,message:'This session predates a memory purge.'} as RollupResult};
  if(options.closeOnUnavailable&&(!options.summarizer||!(await db.query("SELECT 1 FROM users WHERE id=$1 AND ai_access_state='approved'",[a.user_id])).rowCount)){
   await db.query('UPDATE brain_sessions SET closed_at=$5,rollup_claimed_at=NULL WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[a.user_id,a.brain_id,a.agent_label,sessionId,now]);
   return{result:{closed:true,snapshotId:null,disabled:true,message:'This call is closed. Your saved records remain available; no automatic summary was generated.'} as RollupResult};
  }
  if(!(await db.query("SELECT 1 FROM users WHERE id=$1 AND ai_access_state='approved'",[a.user_id])).rowCount)return{result:{closed:false,snapshotId:null,disabled:true,message:'Automatic summaries are not enabled for this account.'} as RollupResult};
  if(!options.summarizer)return{result:{closed:false,snapshotId:null,disabled:true,message:'Automatic snapshots are unavailable until the AI provider is configured. Your saved notes remain available.'} as RollupResult};
  if(session.rollup_claimed_at&&now.getTime()-session.rollup_claimed_at.getTime()<120000)return{result:{closed:false,snapshotId:null,inProgress:true,message:'Your call is already being saved.'} as RollupResult};
  await db.query('UPDATE brain_sessions SET rollup_claimed_at=$5,rollup_error=NULL WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[a.user_id,a.brain_id,a.agent_label,sessionId,now]);
  return{session};
 });
 if(claim.result)return claim.result;
 const claimed=claim.session!;
 let generated:string;
 try{generated=summaryText(await options.summarizer!('rollup',await sessionMaterial(a,claimed),a)).trim();if(!generated)throw new Error('Empty summary');}
 catch{
  if(options.closeOnUnavailable){
   const closed=await pool.query("UPDATE brain_sessions SET closed_at=$5,rollup_claimed_at=NULL,rollup_error=$6 WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 AND content_epoch=$7 AND closed_at IS NULL AND activity_count=$8 AND date_trunc('milliseconds',last_activity_at)=$9 RETURNING id",[a.user_id,a.brain_id,a.agent_label,sessionId,now,'summary_unavailable',claimed.content_epoch,claimed.activity_count,claimed.last_activity_at]);
   if(!closed.rowCount){
    const current=(await pool.query('SELECT closed_at,rolled_up_snapshot_id FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[a.user_id,a.brain_id,a.agent_label,sessionId])).rows[0];
    if(!current)return{closed:false,snapshotId:null,missing:true,message:'This session is no longer available.'};
    if(current.closed_at)return{closed:true,snapshotId:current.rolled_up_snapshot_id,message:'This session is closed.'};
    await pool.query('UPDATE brain_sessions SET rollup_claimed_at=NULL WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 AND closed_at IS NULL',[a.user_id,a.brain_id,a.agent_label,sessionId]);
    return{closed:false,snapshotId:null,stale:true,message:'The conversation continued, so this session remains open.'};
   }
   return{closed:true,snapshotId:null,disabled:true,message:'This call is closed. Your saved records remain available; no automatic summary was generated.'};
  }
  await pool.query('UPDATE brain_sessions SET rollup_claimed_at=NULL,rollup_error=$5 WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 AND closed_at IS NULL',[a.user_id,a.brain_id,a.agent_label,sessionId,'summary_unavailable']);
  return{closed:false,snapshotId:null,disabled:true,message:'Your notes are saved, but the call summary is unavailable right now.'};
 }
 return transaction(async db=>{
  const brain=await db.query('SELECT content_epoch FROM brains WHERE user_id=$1 AND id=$2 FOR UPDATE',[a.user_id,a.brain_id]);
  const found=await db.query('SELECT * FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 FOR UPDATE',[a.user_id,a.brain_id,a.agent_label,sessionId]);
  if(!brain.rowCount||!found.rowCount||String(brain.rows[0].content_epoch)!==claimed.content_epoch||!await currentGrant(db,a,true))return{closed:false,snapshotId:null,missing:true,message:'This session is no longer available.'};
  const current=rowSession(found.rows[0]);if(current.closed_at)return{closed:true,snapshotId:current.rolled_up_snapshot_id,message:'Your session is closed.'};
  if(current.activity_count!==claimed.activity_count||current.last_activity_at.getTime()!==claimed.last_activity_at.getTime()){
   await db.query('UPDATE brain_sessions SET rollup_claimed_at=NULL WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[a.user_id,a.brain_id,a.agent_label,sessionId]);
   return{closed:false,snapshotId:null,stale:true,message:'The conversation continued, so I will save its summary after the next quiet period.'};
  }
  const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
  const audience=claimed.to_agents??[a.agent_label];
  const snapshot=await db.query("INSERT INTO snapshots(user_id,brain_id,agent_label,title,content,kind,created_at,visibility,to_agents,source_refs) VALUES($1,$2,$3,$4,$5,'auto',$6,$7,$8,$9) RETURNING id",[a.user_id,a.brain_id,a.agent_label,'Auto snapshot '+stamp+' ('+a.agent_label+')',Array.from(generated).slice(0,200000).join(''),now,visibilityFor(audience),audience,JSON.stringify(claimed.source_refs??[])]);
  const id=snapshot.rows[0].id as string;
  await db.query('INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[a.user_id,a.brain_id,a.agent_label,'auto_snapshot',id,{session_id:sessionId},now]);
  await db.query('UPDATE brain_sessions SET closed_at=$5,last_snapshot_at=$5,rolled_up_snapshot_id=$6,rollup_claimed_at=NULL,rollup_error=NULL WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[a.user_id,a.brain_id,a.agent_label,sessionId,now,id]);
  return{closed:true,snapshotId:id,message:'Your call is saved. Talk to you next time.'};
 });
}
export async function sweepSessions(options:SessionOptions={}):Promise<{checked:number;rolledUp:number;closed:number;disabled:number}>{
 const now=options.now??new Date(),cutoff=new Date(now.getTime()-minutes(options.rollupMinutes,'BRAIN_IDLE_ROLLUP_MIN',10)*60000);
 const found=await pool.query('SELECT s.*,g.scope,g.client_id,g.revoked_at AS grant_revoked_at FROM brain_sessions s LEFT JOIN grants g ON g.id=s.request_grant_id AND g.user_id=s.user_id AND g.brain_id=s.brain_id WHERE s.closed_at IS NULL AND s.last_activity_at<=$1 AND ($2::uuid IS NULL OR s.user_id=$2) AND ($3::uuid IS NULL OR s.brain_id=$3) ORDER BY s.last_activity_at LIMIT 100',[cutoff,options.userId??null,options.brainId??null]);
 const stats={checked:found.rowCount??0,rolledUp:0,closed:0,disabled:0};
 for(const row of found.rows){
  const auth:AuthContext={user_id:row.user_id,brain_id:row.brain_id,agent_label:row.agent_label,client_id:row.source==='dashboard'?'dashboard':row.client_id??'session-rollup',grant_id:row.source==='dashboard'?'':row.request_grant_id??'00000000-0000-0000-0000-000000000000',scopes:row.source==='dashboard'?(row.writable?['brain:read','brain:write']:['brain:read']):row.grant_revoked_at?[]:String(row.scope??'').split(/\s+/).filter(Boolean),token_hash:'session-rollup',...(row.browser_session_id?{browser_session_id:row.browser_session_id}:{})};
  const result=await rollupSession(auth,row.id,{...options,now});
  if(result.snapshotId)stats.rolledUp++;if(result.closed)stats.closed++;if(result.disabled)stats.disabled++;
 }
 return stats;
}

/** Record only the audience and real receipts delivered during a read; this is not a memory write. */
export async function narrowSessionAudience(a:AuthContext,sessionId:string,audience:string[],sourceRefs:SourceRef[]=[]):Promise<void>{
 await transaction(async db=>{
  if(!(await db.query('SELECT id FROM brains WHERE user_id=$1 AND id=$2 FOR UPDATE',[a.user_id,a.brain_id])).rowCount||!await currentGrant(db,a))return;
  const row=(await db.query('SELECT to_agents,source_refs FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4 AND closed_at IS NULL FOR UPDATE',[a.user_id,a.brain_id,a.agent_label,sessionId])).rows[0];if(!row)return;
  const evidence=await validateSourceRefs(db,a,sourceRefs.slice(0,40));
  const refs=[...new Map([...(row.source_refs??[]),...evidence.refs].map((r:SourceRef)=>[r.collection+':'+r.id,r])).values()].slice(-40);
  await db.query('UPDATE brain_sessions SET to_agents=$5,source_refs=$6 WHERE user_id=$1 AND brain_id=$2 AND agent_label=$3 AND id=$4',[a.user_id,a.brain_id,a.agent_label,sessionId,intersectAudiences(row.to_agents,audience,evidence.audience),JSON.stringify(refs)]);
 });
}
