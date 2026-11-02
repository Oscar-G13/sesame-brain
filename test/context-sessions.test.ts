import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pool,transaction} from '../src/db/index.js';
import {config} from '../src/config.js';
import {buildContextPack,clearContextCache} from '../src/brain/context.js';
import {touchSession,recordSessionActivity,sessionTrailer,rollupSession,sweepSessions,type SessionSummarizer} from '../src/brain/sessions.js';
import type {AuthContext} from '../src/tools/service.js';
const users:string[]=[],client='context-session-test-'+randomUUID();
before(async()=>{
 const schema=await pool.query("SELECT to_regclass('public.brain_sessions') AS relation");assert.ok(schema.rows[0].relation,'Root must apply migration0002 to testdb before this test.');
 await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr',$2)",[client,{client_name:'Context sessions fixture',redirect_uris:['https://client.example/callback']}]);
});
after(async()=>{clearContextCache();for(const id of users)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[client]);await pool.end();});
async function fixture(agent='maya',scopes=['brain:read','brain:write'],userId?:string):Promise<AuthContext>{
 const uid=userId??randomUUID(),bid=randomUUID(),gid=randomUUID();
 if(!userId){await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,'fixture-only','approved')",[uid,'context-'+uid+'@example.invalid']);users.push(uid);}
 await pool.query('INSERT INTO brains(id,user_id,name) VALUES($1,$2,$3)',[bid,uid,'brain-'+bid]);
 await pool.query('INSERT INTO grants(id,user_id,brain_id,agent_label,client_id,scope,resource) VALUES($1,$2,$3,$4,$5,$6,$7)',[gid,uid,bid,agent,client,scopes.join(' '),config.resource]);
 return{user_id:uid,brain_id:bid,agent_label:agent,client_id:client,scopes,grant_id:gid,token_hash:randomBytes(32).toString('hex')};
}
const tenant=(a:AuthContext)=>[a.user_id,a.brain_id];
async function fact(a:AuthContext,key:string,value:string){return(await pool.query('INSERT INTO facts(user_id,brain_id,key,value,updated_by) VALUES($1,$2,$3,$4,$5) RETURNING id',[...tenant(a),key,value,a.agent_label])).rows[0].id as string;}
async function note(a:AuthContext,text:string,to=['all'],from=a.agent_label){return(await pool.query('INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text) VALUES($1,$2,$3,$4,$5) RETURNING id',[...tenant(a),from,to,text])).rows[0].id as string;}
async function job(a:AuthContext,title:string,result:string,finished=new Date()){
 const brain=await pool.query('SELECT content_epoch FROM brains WHERE user_id=$1 AND id=$2',tenant(a));
 return(await pool.query("INSERT INTO jobs(user_id,brain_id,requested_by_agent,task,title,state,content_epoch,result_text,result_summary,finished_at) VALUES($1,$2,$3,$4,$4,'done',$5,$6,$7,$8) RETURNING id",[...tenant(a),a.agent_label,title,brain.rows[0].content_epoch,result,result.slice(0,100),finished])).rows[0].id as string;
}
async function digest(a:AuthContext){
 const data:Record<string,unknown>={};
 for(const table of ['notes','facts','handoffs','snapshots','activity','brain_sessions','jobs','usage','usage_reservations','nightly_runs'])data[table]=(await pool.query('SELECT * FROM '+table+' WHERE user_id=$1 AND brain_id=$2 ORDER BY id',tenant(a))).rows;
 return JSON.stringify(data);
}
test('context uses strict user+brain and agent visibility while honoring every priority',async()=>{
 const a=await fixture(),b=await fixture('maya',undefined,a.user_id),secret='B-'+randomUUID();
 await fact(a,'known','A fact');await fact(b,'secret',secret);
 await note(a,'visible broadcast');await note(a,'private for Miles',['miles'],'charlie');await note(a,'own authored note',['charlie'],'maya');
 await note(b,secret);await job(b,secret,secret);
 for(let i=0;i<12;i++)await pool.query("INSERT INTO snapshots(user_id,brain_id,agent_label,title,content,kind,created_at) VALUES($1,$2,'charlie',$3,$4,'manual',$5)",[...tenant(a),'Snapshot '+i,'Memory '+i,new Date(1_700_000_000_000+i*1000)]);
 await pool.query("INSERT INTO handoffs(user_id,brain_id,from_agent,to_agent,title,context) VALUES($1,$2,'charlie','all','Shared task','shared context')",tenant(a));
 await pool.query("INSERT INTO handoffs(user_id,brain_id,from_agent,to_agent,title,context) VALUES($1,$2,'charlie','miles','private task','private context')",tenant(a));
 const sharedHandoff=(await pool.query("INSERT INTO handoffs(user_id,brain_id,from_agent,to_agent,title,context) VALUES($1,$2,'charlie','miles','Job result handoff','visible completed job handoff') RETURNING id",tenant(a))).rows[0].id;
 const linkedJob=await job(a,'Shared job','Shared result');await pool.query('UPDATE jobs SET handoff_id=$3 WHERE user_id=$1 AND brain_id=$2 AND id=$4',[...tenant(a),sharedHandoff,linkedJob]);
 const pack=await buildContextPack(a,{tokenBudget:20000});
 const text=pack.blocks.map(x=>x.text).join('\n\n');
 assert.ok(text.includes('A fact'));assert.ok(text.includes('Memory 11'));assert.equal(pack.blocks.filter(x=>x.kind==='snapshot_headline').length,10);
 assert.ok(text.includes('shared context'));assert.ok(text.includes('visible completed job handoff'));assert.ok(pack.includedJobIds.includes(linkedJob));assert.equal(pack.includedJobIds.filter(id=>id===linkedJob).length,1);assert.ok(text.includes('visible broadcast'));assert.ok(text.includes('own authored note'));
 assert.ok(!text.includes('private for Miles'));assert.ok(!text.includes('private context'));assert.ok(!text.includes(secret));
 assert.equal(pack.blocks[0].kind,'handoff'); // Pending work is reserved before background memory.
 assert.ok(pack.sourceRefs.some(ref=>ref.collection==='facts'));
});
test('oversized Unicode context is bounded conservatively and truncates from the bottom',async()=>{
 const a=await fixture();await fact(a,'important','Facts come first.');
 await pool.query("INSERT INTO snapshots(user_id,brain_id,agent_label,title,content) VALUES($1,$2,'maya','Huge',$3)",[...tenant(a),'記'.repeat(10000)]);
 await note(a,'Lower-priority note that must be omitted.');
 const pack=await buildContextPack(a,{tokenBudget:512});
 const text=pack.blocks.map(x=>x.text).join('\n\n');
 assert.ok(text.includes('Facts come first.'));
 assert.equal(pack.bytes,Buffer.byteLength(text,'utf8'));assert.ok(pack.bytes<=512);assert.equal(pack.estimatedTokens,pack.bytes);assert.equal(pack.truncated,true);assert.ok(!text.includes('\uFFFD'));
});
test('context cache is isolated by session and invalidated by insert/update/delete triggers',async()=>{
 const a=await fixture(),b=await fixture();const session=await touchSession(a);await fact(a,'cached','Original');
 const one=await buildContextPack(a,{sessionId:session.session.id});
 await fact(b,'other','Not this brain');
 const unchanged=await buildContextPack(a,{sessionId:session.session.id});assert.equal(one.memoryVersion,unchanged.memoryVersion);
 await pool.query('UPDATE facts SET value=$3 WHERE user_id=$1 AND brain_id=$2',[...tenant(a),'Updated']);
 const two=await buildContextPack(a,{sessionId:session.session.id});assert.notEqual(two.memoryVersion,one.memoryVersion);assert.ok(two.blocks.some(x=>x.text.includes('Updated')));
 await pool.query('DELETE FROM facts WHERE user_id=$1 AND brain_id=$2',tenant(a));
 const three=await buildContextPack(a,{sessionId:session.session.id});assert.notEqual(three.memoryVersion,two.memoryVersion);assert.ok(!three.blocks.some(x=>x.kind==='fact'));
 const foreign=await touchSession(b);await assert.rejects(buildContextPack(a,{sessionId:foreign.session.id}),/Session not found/);
});
test('dry-run never surfaces jobs and delivery acknowledges only fully included results for this assistant',async()=>{
 const a=await fixture(),b=await fixture();
 const small=await job(a,'Small finished task','A short result.',new Date('2026-11-02T10:02:00Z'));
 const big=await job(a,'Large finished task','長'.repeat(10000),new Date('2026-11-02T10:01:00Z'));
 const foreign=await job(b,'Private B task','Private B result');
 const dry=await buildContextPack(a,{tokenBudget:1000});assert.ok(dry.includedJobIds.includes(small));assert.ok(!dry.includedJobIds.includes(big));
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[small])).rows[0].surfaced_to,[]);
 await buildContextPack(a,{tokenBudget:1000,markJobsSurfaced:true});
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[small])).rows[0].surfaced_to,['maya']);
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[big])).rows[0].surfaced_to,[]);
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[foreign])).rows[0].surfaced_to,[]);
});
test('sessions derive identity from token+agent, reuse before30minutes, and renew after idle',async()=>{
 const a=await fixture(),now=new Date('2026-11-02T10:00:00Z');
 const first=await touchSession(a,{now});assert.equal(first.firstTouch,true);
 const same=await touchSession(a,{now:new Date(now.getTime()+29*60000)});assert.equal(same.firstTouch,false);assert.equal(same.session.id,first.session.id);
 const renewed=await touchSession(a,{now:new Date(now.getTime()+60*60000)});assert.equal(renewed.firstTouch,true);assert.notEqual(renewed.session.id,first.session.id);
 const otherToken=await touchSession({...a,token_hash:'another-issued-token-hash'},{now:new Date(now.getTime()+61*60000)});assert.notEqual(otherToken.session.id,renewed.session.id);
});
test('first touch briefings are cached, scoped, word-bounded and acknowledge explicit delivered jobs only',async()=>{
 const a=await fixture(),b=await fixture();await fact(a,'train','Take the 7:40 train.');const completed=await job(a,'Train comparison','Take the earlier train.'),foreign=await job(b,'B comparison','Private');
 let calls=0;
 const summarizer:SessionSummarizer=async(purpose,text)=>{calls++;assert.equal(purpose,'briefing');assert.ok(text.includes('7:40'));assert.ok(!text.includes('Private'));return{text:'Train comparison is finished. '+('word '.repeat(180)),surfacedJobIds:[completed,foreign]};};
 const first=await touchSession(a,{summarizer});assert.ok(first.briefing);assert.ok(first.briefing.split(/\s+/).length<=150);
 const second=await touchSession(a,{summarizer});assert.equal(second.firstTouch,false);assert.equal(second.briefing,undefined);assert.equal(calls,1);
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[completed])).rows[0].surfaced_to,['maya']);
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[foreign])).rows[0].surfaced_to,[]);
});
test('trailers count only own jobs and remind about zero writes after five minutes under20words',async()=>{
 const a=await fixture(),b=await fixture(),now=new Date('2026-11-02T10:00:00Z'),session=await touchSession(a,{now});
 await job(a,'Done','Finished');await job(b,'Foreign done','Secret');
 await pool.query("INSERT INTO jobs(user_id,brain_id,requested_by_agent,task,title,content_epoch) VALUES($1,$2,'maya','Pending','Pending',0)",tenant(a));
 const trailer=await sessionTrailer(a,session.session.id,new Date(now.getTime()+6*60000));
 assert.equal(trailer,'1 job running. 1 result waiting. No notes saved yet this call.');assert.ok(trailer.split(/\s+/).length<20);
 await recordSessionActivity(a,session.session.id,{tool:'remember',write:true,summary:'Saved commute',now:new Date(now.getTime()+7*60000)});
 assert.ok(!(await sessionTrailer(a,session.session.id,new Date(now.getTime()+8*60000))).includes('No notes'));
});
test('read-only and empty sessions close silently without model work or content writes',async()=>{
 const read=await fixture('maya',['brain:read']),session=await touchSession(read);await recordSessionActivity(read,session.session.id,{tool:'whoami',write:false});
 let calls=0;const summarizer:SessionSummarizer=async()=>{calls++;return'Not allowed';};
 const result=await rollupSession(read,session.session.id,{summarizer});assert.equal(result.closed,true);assert.equal(result.snapshotId,null);assert.equal(calls,0);
 assert.equal((await pool.query('SELECT 1 FROM snapshots WHERE user_id=$1 AND brain_id=$2',tenant(read))).rowCount,0);
 assert.equal((await pool.query('SELECT 1 FROM activity WHERE user_id=$1 AND brain_id=$2',tenant(read))).rowCount,0);
});
test('missing AI provider honestly leaves a writing session pending without fabricating a snapshot',async()=>{
 const a=await fixture(),session=await touchSession(a);await recordSessionActivity(a,session.session.id,{tool:'remember',write:true,summary:'Remembered commute'});
 const result=await rollupSession(a,session.session.id);assert.equal(result.disabled,true);assert.equal(result.closed,false);assert.equal(result.snapshotId,null);
 assert.equal((await pool.query('SELECT closed_at FROM brain_sessions WHERE id=$1',[session.session.id])).rows[0].closed_at,null);
 assert.equal((await pool.query('SELECT 1 FROM snapshots WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
});
test('idle sweeper and explicit rollup save attributed auto snapshots without pruning existing data',async()=>{
 const a=await fixture(),now=new Date('2026-11-02T10:00:00Z'),session=await touchSession(a,{now});
 await recordSessionActivity(a,session.session.id,{tool:'remember',write:true,summary:'The user asked to remember the 7:40 train.',now});
 const summarizer:SessionSummarizer=async(purpose,text)=>{assert.equal(purpose,'rollup');assert.ok(text.includes('7:40 train'));return'Commute: take the 7:40 train. Open loop: buy the pass.';};
 const stats=await sweepSessions({now:new Date(now.getTime()+11*60000),summarizer,userId:a.user_id,brainId:a.brain_id});assert.ok(stats.rolledUp>=1);
 const rows=await pool.query('SELECT kind,agent_label,content FROM snapshots WHERE user_id=$1 AND brain_id=$2',tenant(a));assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].kind,'auto');assert.equal(rows.rows[0].agent_label,'maya');
 const again=await rollupSession(a,session.session.id,{summarizer});assert.equal(again.closed,true);assert.ok(again.snapshotId);
 assert.equal((await pool.query('SELECT 1 FROM snapshots WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,1);
 const b=await fixture(),other=await touchSession(b);const before=await digest(b);
 const denied=await rollupSession(a,other.session.id,{summarizer});assert.equal(denied.missing,true);await recordSessionActivity(a,other.session.id,{tool:'remember',write:true,summary:'Wrong brain'});assert.equal(await digest(b),before);
});
test('purge during in-flight summarization cannot recreate memory or sessions',async()=>{
 const a=await fixture(),session=await touchSession(a);await recordSessionActivity(a,session.session.id,{tool:'remember',write:true,summary:'Pre-purge memory'});
 let release!:(value:string)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const summarizer:SessionSummarizer=async()=>{entered();return new Promise<string>(resolve=>{release=resolve;});};
 const pending=rollupSession(a,session.session.id,{summarizer});await started;
 await transaction(async db=>{await db.query('UPDATE brains SET content_epoch=content_epoch+1,memory_version=memory_version+1 WHERE user_id=$1 AND id=$2',tenant(a));await db.query('DELETE FROM brain_sessions WHERE user_id=$1 AND brain_id=$2',tenant(a));await db.query('DELETE FROM activity WHERE user_id=$1 AND brain_id=$2',tenant(a));});
 release('This must never be saved.');const result=await pending;assert.equal(result.missing,true);assert.equal(result.snapshotId,null);
 assert.equal((await pool.query('SELECT 1 FROM snapshots WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
 assert.equal((await pool.query('SELECT 1 FROM brain_sessions WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
});
test('a resumed conversation invalidates an in-flight quiet rollup and stays open',async()=>{
 const a=await fixture(),now=new Date('2026-11-02T10:00:00Z'),session=await touchSession(a,{now});
 await recordSessionActivity(a,session.session.id,{tool:'remember',write:true,summary:'First half',now});
 let release!:(value:string)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const pending=rollupSession(a,session.session.id,{summarizer:async()=>{entered();return new Promise<string>(resolve=>{release=resolve;});},now:new Date(now.getTime()+11*60000)});
 await started;await recordSessionActivity(a,session.session.id,{tool:'inbox',write:false,now:new Date(now.getTime()+12*60000)});
 release('Incomplete old conversation.');const result=await pending;assert.equal(result.stale,true);assert.equal(result.closed,false);
 assert.equal((await pool.query('SELECT 1 FROM snapshots WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
 const saved=await rollupSession(a,session.session.id,{summarizer:async()=> 'The whole call is now saved.',now:new Date(now.getTime()+25*60000)});assert.equal(saved.closed,true);assert.ok(saved.snapshotId);
});

test('operator dry-run CLI prints a scoped seeded pack within budget without surfacing results',async()=>{
 const a=await fixture();await fact(a,'operator-test','This is a synthetic context fixture.');const done=await job(a,'Dry-run task','Do not acknowledge this job.');
 const run=promisify(execFile);
 const output=await run(process.execPath,['--import','tsx','scripts/context-pack.ts','--user',a.user_id,'--brain',a.brain_id,'--agent','maya','--budget','512'],{env:{PATH:process.env.PATH,DATABASE_URL:process.env.DATABASE_URL,NODE_ENV:'test',BASE_URL:config.baseUrl},maxBuffer:1_000_000});
 const pack=JSON.parse(output.stdout);assert.ok(pack.bytes<=512);assert.ok(pack.blocks.some((b:{text:string})=>b.text.includes('synthetic context fixture')));
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[done])).rows[0].surfaced_to,[]);
});
test('dashboard sessions retain browser-session authorization and stop summarizing after signout',async()=>{
 const base=await fixture();const browser=(await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id",[base.user_id,randomBytes(32).toString('hex')])).rows[0].id as string;
 const dashboard:AuthContext={...base,client_id:'dashboard',grant_id:'',browser_session_id:browser};
 const session=await touchSession(dashboard);assert.equal(session.session.source,'dashboard');assert.equal(session.session.request_grant_id,null);assert.equal(session.session.browser_session_id,browser);
 await recordSessionActivity(dashboard,session.session.id,{tool:'think',write:false,summary:'The dashboard discussed the commute.'});
 const saved=await rollupSession(dashboard,session.session.id,{summarizer:async()=> 'The dashboard reviewed the commute.'});assert.ok(saved.snapshotId);
 const next=await touchSession(dashboard);await recordSessionActivity(dashboard,next.session.id,{tool:'remember',write:true,summary:'Pending dashboard summary'});
 await pool.query('DELETE FROM sessions WHERE id=$1 AND user_id=$2',[browser,base.user_id]);
 let called=false;const closed=await rollupSession(dashboard,next.session.id,{summarizer:async()=>{called=true;return'Forbidden after signout';}});
 assert.equal(called,false);assert.equal(closed.snapshotId,null);assert.equal(closed.closed,true);
 await assert.rejects(touchSession(dashboard),/connection not available/);
});
test('revoked grants and read-only contexts cannot create delayed snapshots',async()=>{
 const a=await fixture(),session=await touchSession(a);await recordSessionActivity(a,session.session.id,{tool:'think',write:false,summary:'A reasoned answer'});
 let release!:(value:string)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const pending=rollupSession(a,session.session.id,{summarizer:async()=>{entered();return new Promise<string>(resolve=>{release=resolve;});}});
 await started;await pool.query('UPDATE grants SET revoked_at=now() WHERE id=$1',[a.grant_id]);release('Never persist after revocation.');
 const denied=await pending;assert.equal(denied.snapshotId,null);assert.equal(denied.missing,true);
 assert.equal((await pool.query('SELECT 1 FROM snapshots WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
});
test('automatic snapshot creation never prunes the existing snapshot collection',async()=>{
 const a=await fixture();for(let i=0;i<55;i++)await pool.query("INSERT INTO snapshots(user_id,brain_id,agent_label,content) VALUES($1,$2,'maya',$3)",[...tenant(a),'Retained snapshot '+i]);
 const session=await touchSession(a);await recordSessionActivity(a,session.session.id,{tool:'remember',write:true,summary:'One more fact'});
 const saved=await rollupSession(a,session.session.id,{summarizer:async()=> 'One more snapshot, with all previous snapshots retained.'});assert.ok(saved.snapshotId);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM snapshots WHERE user_id=$1 AND brain_id=$2',tenant(a))).rows[0].n,56);
});

test('context includes only this assistant session writes, and tracking writes invalidate cached packs',async()=>{
 const a=await fixture(),b=await fixture(),first=await touchSession(a),other=await touchSession(b);
 const before=await buildContextPack(a,{sessionId:first.session.id});
 await recordSessionActivity(a,first.session.id,{tool:'remember',write:true,summary:'Current-session request to remember the earlier train.'});
 await recordSessionActivity(b,other.session.id,{tool:'remember',write:true,summary:'Private foreign-session summary'});
 const after=await buildContextPack(a,{sessionId:first.session.id});
 assert.notEqual(after.memoryVersion,before.memoryVersion);
 assert.ok(after.blocks.some(block=>block.kind==='session_write'&&block.text.includes('earlier train')));
 assert.ok(!after.blocks.some(block=>block.text.includes('Private foreign-session')));
 clearContextCache({userId:a.user_id,brainId:a.brain_id});
});

test('a fully included completed-job handoff acknowledges delivery even when its detailed result is over budget',async()=>{
 const a=await fixture();const done=await job(a,'A finished comparison','Long result '.repeat(1000));
 const handoff=(await pool.query("INSERT INTO handoffs(user_id,brain_id,from_agent,to_agent,title,context) VALUES($1,$2,'charlie','miles','Finished','A concise completed result.') RETURNING id",tenant(a))).rows[0].id;
 await pool.query('UPDATE jobs SET handoff_id=$3 WHERE user_id=$1 AND brain_id=$2 AND id=$4',[...tenant(a),handoff,done]);
 const pack=await buildContextPack(a,{tokenBudget:1000,markJobsSurfaced:true});
 assert.ok(pack.blocks.some(block=>block.kind==='handoff'&&block.text.includes('concise completed result')));
 assert.ok(pack.truncated);assert.ok(pack.includedJobIds.includes(done));
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[done])).rows[0].surfaced_to,['maya']);
});
