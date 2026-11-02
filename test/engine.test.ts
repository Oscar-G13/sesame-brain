import { before,after,afterEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/index.js';
import { migrate } from '../scripts/migrate.js';
import { executeTool,type AuthContext } from '../src/tools/service.js';
import { think,enqueueJob,runNextJob,recoverInterruptedJobs,jobStatus,listJobs,runAgent,asWebAuth } from '../src/brain/engine.js';
import { setModelTransportForTests,type ModelResult } from '../src/brain/provider.js';
import { purgeBrainContent } from '../src/brain/purge.js';
import { aiConfig,RESTING } from '../src/brain/config.js';
import {buildModelMemory} from '../src/brain/model-context.js';
import {touchSession} from '../src/brain/sessions.js';
import {createProject,addItem} from '../src/projects/service.js';
import { localDay,BudgetError } from '../src/brain/usage.js';
const users:string[]=[],client='engine-'+randomUUID();
before(async()=>{await migrate();await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr','{}')",[client]);});
afterEach(()=>setModelTransportForTests(undefined));
after(async()=>{for(const id of users)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[client]);await pool.end();});
async function fixture(label='maya'):Promise<AuthContext>{
 const user=randomUUID(),brain=randomUUID(),grant=randomUUID();users.push(user);
 await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,'fixture','approved')",[user,user+'@engine.invalid']);
 await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[brain,user]);
 await pool.query("INSERT INTO grants(id,user_id,brain_id,client_id,agent_label,scope) VALUES($1,$2,$3,$4,$5,'brain:read brain:write')",[grant,user,brain,client,label]);
 return {user_id:user,brain_id:brain,grant_id:grant,agent_label:label,client_id:client,token_hash:'fixture-'+randomUUID(),scopes:['brain:read','brain:write']};
}
const response=(text:string):ModelResult=>({text,inputTokens:50,outputTokens:20,model:aiConfig.quickModel,content:[{type:'text',text}],stopReason:'end_turn',incomplete:false});
test('think uses scoped longitudinal context, writes a requested fact, records usage and final answer',async()=>{
 const a=await fixture(),b=await fixture();await executeTool(a,'remember',{key:'preferred drink',value:'tea'});await executeTool(b,'remember',{key:'private',value:'FOREIGN_RECORD'});
 let calls=0;setModelTransportForTests(async request=>{assert.ok(!JSON.stringify(request).includes('FOREIGN_RECORD'));if(calls++===0){assert.ok(JSON.stringify(request.messages).includes('tea'));return {...response(''),content:[{type:'tool_use',id:'call_1',name:'brain_write_fact',input:{key:'travel',value:'Train'}}],stopReason:'tool_use'};}return response('I remember that you prefer tea. I saved that you travel by train.');});
 const result=await think(a,{text:'Remember I travel by train. What do I drink?'});assert.match(result.answer,/tea/);assert.equal(result.job_id,null);
 assert.equal((await pool.query("SELECT value FROM facts WHERE user_id=$1 AND brain_id=$2 AND key='travel'",[a.user_id,a.brain_id])).rows[0].value,'Train');
 const usage=(await pool.query('SELECT sum(input_tokens+output_tokens)::int AS n FROM usage WHERE user_id=$1 AND brain_id=$2',[a.user_id,a.brain_id])).rows[0].n;assert.equal(usage,140);
 const activity=(await pool.query("SELECT metadata FROM activity WHERE user_id=$1 AND brain_id=$2 AND kind='think'",[a.user_id,a.brain_id])).rows[0].metadata;assert.equal(activity.input_tokens,100);assert.equal(activity.output_tokens,40);
});
test('do acknowledges quickly, persists completion note/handoff, exposes only own jobs',async()=>{
 const a=await fixture(),b=await fixture();setModelTransportForTests(async()=>response('The comparison is ready.\n\nDetailed result: Option A fits the stated criteria.'));
 const start=Date.now(),queued=await enqueueJob(a,{task:'Compare options',deliver:'brain+email'});assert.ok(Date.now()-start<1000);assert.ok(queued.job_id);assert.match(queued.ack,/Email delivery is not configured/);
 assert.equal((await jobStatus(a,queued.job_id!) as {state:string}).state,'queued');await assert.rejects(jobStatus(b,queued.job_id!),/not found/);
 await runNextJob(a);
 const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[queued.job_id])).rows[0];assert.equal(job.state,'done');assert.ok(job.result_note_id);assert.ok(job.handoff_id);assert.deepEqual(job.surfaced_to,[]);
 assert.equal((await pool.query('SELECT kind,to_agents FROM notes WHERE id=$1',[job.result_note_id])).rows[0].kind,'job_result');
 assert.equal((await listJobs(b) as unknown[]).length,0);const inbox=await executeTool({...a,agent_label:'miles'},'inbox') as {notes:{id:string;note_kind:string}[];handoffs:{id:string}[]};assert.ok(inbox.notes.some(n=>n.id===job.result_note_id&&n.note_kind==='job_result'));assert.ok(inbox.handoffs.some(h=>h.id===job.handoff_id));
});
test('quick timeout returns partial speech and queues persistent continuation',async()=>{
 const a=await fixture();setModelTransportForTests(async request=>{request.onText?.('I have started checking.');await new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}));return {...response('I have started checking.'),incomplete:true};});
 const start=Date.now(),answer=await think(a,{text:'Investigate this slowly'});assert.ok(Date.now()-start<aiConfig.quickTimeout+1000);assert.ok(answer.job_id);assert.match(answer.answer,/I have started checking/);assert.match(answer.answer,/next time/);
 setModelTransportForTests(async()=>response('I finished checking. Here is the result.'));await runNextJob(a);assert.equal((await jobStatus(a,answer.job_id!) as {state:string}).state,'done');
});
test('tiny remaining daily budget refuses think and do without calling provider',async()=>{
 const a=await fixture();await pool.query('INSERT INTO usage(user_id,brain_id,local_date,model,input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,0)',[a.user_id,a.brain_id,localDay(),aiConfig.quickModel,aiConfig.dailyTokens]);
 let called=false;setModelTransportForTests(async()=>{called=true;return response('bad');});
 assert.equal((await think(a,{text:'Hello'})).answer,RESTING);assert.equal((await enqueueJob(a,{task:'Hello'})).ack,RESTING);assert.equal(called,false);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM activity WHERE user_id=$1 AND kind='budget_refused'",[a.user_id])).rows[0].n,2);
});
test('read-only and mismatched brain contexts cannot reason or queue work',async()=>{
 const a=await fixture(),b=await fixture();await assert.rejects(think({...a,scopes:['brain:read']},{text:'hi'}),/insufficient_scope/);await assert.rejects(enqueueJob({...a,brain_id:b.brain_id},{task:'hi'}),/not found/);
});
test('interrupted job is marked failed, never left running',async()=>{
 const a=await fixture();const job=await enqueueJob(a,{task:'Work'});await pool.query("UPDATE jobs SET state='running',started_at=now() WHERE id=$1",[job.job_id]);await recoverInterruptedJobs(a);assert.equal((await jobStatus(a,job.job_id!) as {state:string}).state,'failed');
});
test('purge while model is running cancels late memory and job-result writes',async()=>{
 const a=await fixture();const job=await enqueueJob(a,{task:'Work'});
 let started!:()=>void,finish!:()=>void;const underway=new Promise<void>(resolve=>{started=resolve;}),release=new Promise<void>(resolve=>{finish=resolve;});
 setModelTransportForTests(async()=>{started();await release;return response('A result that must not survive reset.');});const running=runNextJob(a);await underway;await purgeBrainContent(a.user_id,a.brain_id);finish();await running;
 for(const table of ['jobs','notes','handoffs','facts','snapshots','activity','usage','usage_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table+' WHERE user_id=$1 AND brain_id=$2',[a.user_id,a.brain_id])).rows[0].n,0,table);
 assert.ok((await pool.query('SELECT id FROM grants WHERE id=$1',[a.grant_id])).rowCount);assert.ok(job.job_id);
});

test('background context and budget refusal do not consume waiting results; successful foreground reasoning does',async()=>{
 const a=await fixture(),waiting=randomUUID();
 await pool.query("INSERT INTO jobs(id,user_id,brain_id,requested_by_agent,task,title,state,content_epoch,result_text,result_summary,finished_at) VALUES($1,$2,$3,'maya','Earlier task','Earlier task','done',0,'The earlier result is ready.','Earlier result',now())",[waiting,a.user_id,a.brain_id]);
 setModelTransportForTests(async()=>response('The requested answer is ready.'));
 await enqueueJob(a,{task:'Another task'});await runNextJob(a);
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[waiting])).rows[0].surfaced_to,[]);
 await pool.query('INSERT INTO usage(user_id,brain_id,local_date,model,input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT(user_id,brain_id,local_date,model) DO UPDATE SET input_tokens=$5,output_tokens=0',[a.user_id,a.brain_id,localDay(),aiConfig.quickModel,aiConfig.dailyTokens]);
 assert.equal((await think(a,{text:'Anything new?'})).answer,RESTING);
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[waiting])).rows[0].surfaced_to,[]);
 await pool.query('UPDATE usage SET input_tokens=0,output_tokens=0 WHERE user_id=$1 AND brain_id=$2',[a.user_id,a.brain_id]);
 await think(a,{text:'Anything new?'});assert.ok((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[waiting])).rows[0].surfaced_to.includes('maya'));
});
test('request deadline includes earlier work and stale-epoch continuation cannot recreate a cleared job',async()=>{
 const a=await fixture();setModelTransportForTests(async request=>{await new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}));return {...response(''),incomplete:true};});
 const start=Date.now(),result=await think(a,{text:'Slow work'},undefined,start+40);assert.ok(Date.now()-start<500);assert.ok(result.job_id);
 await purgeBrainContent(a.user_id,a.brain_id);await assert.rejects(enqueueJob(a,{task:'Old continuation'},0),/reset/);
 assert.equal((await pool.query('SELECT id FROM jobs WHERE user_id=$1',[a.user_id])).rowCount,0);
});

test('a running job that reaches a token limit persists a partial result',async()=>{
 const a=await fixture();setModelTransportForTests(async()=>{throw new BudgetError();});
 const queued=await enqueueJob(a,{task:'Bounded work'});await runNextJob(a);
 const status=await jobStatus(a,queued.job_id!) as {state:string;result_note_id:string};assert.equal(status.state,'partial');assert.ok(status.result_note_id);
});

async function ownerFor(a:AuthContext):Promise<AuthContext>{
 const session=(await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[a.user_id,randomUUID()])).rows[0].id;
 return asWebAuth(a.user_id,a.brain_id,session);
}
test('aggregate injected memory obeys its UTF-8 budget and keeps current constraints ahead of oversized older context',async()=>{
 const a=await fixture(),owner=await ownerFor(a);
 const project=await createProject(owner,{title:'Bounded project',goal:'古い巨大目標🙂'.repeat(1200),allowed_agents:['maya']});
 let state=await addItem(owner,{project_id:project.id,expected_version:project.version,type:'artifact',title:'Oversized old proposal',content:'以前の提案🙂'.repeat(3000)});
 state=await addItem(owner,{project_id:project.id,expected_version:state.project.version,type:'constraint',title:'Current owner rule',content:'CANONICAL_CURRENT_LIMIT: at most thirty words.',status:'confirmed',source_type:'user_statement'});
 for(let i=0;i<8;i++)await executeTool(a,'remember',{key:'large-context-'+i,value:'参考資料🙂'.repeat(1000)});
 const waiting=randomUUID();await pool.query("INSERT INTO jobs(id,user_id,brain_id,requested_by_agent,task,title,state,content_epoch,result_text,result_summary,finished_at,source_audience,audience,visibility) VALUES($1,$2,$3,'maya','Earlier result','Oversized waiting result','done',0,$4,$4,now(),'{maya}','{maya}','restricted')",[waiting,a.user_id,a.brain_id,'完了済み🙂'.repeat(1000)]);
 const session=await touchSession(a);
 let injected='';
 setModelTransportForTests(async request=>{
  const message=request.messages?.[0].content;assert.equal(typeof message,'string');const raw=message as string,marker='\n\nCURRENT USER REQUEST\n';
  assert.ok(raw.includes(marker));injected=raw.slice(0,raw.indexOf(marker));
  assert.ok(Buffer.byteLength(injected)<=aiConfig.contextTokens,'Project, continuity, base context and memory wrappers share one byte budget.');
  assert.ok(injected.includes('CANONICAL_CURRENT_LIMIT'));assert.match(injected,/CURRENT OWNER-CONFIRMED CONSTRAINT/);assert.match(injected,/omitted|shortened|context_truncated/);
  assert.ok(!injected.includes('\uFFFD'),'Budgeting must preserve complete UTF-8 characters.');
  return response('I will keep the welcome to thirty words.');
 });
 const answer=await think(a,{text:'Continue the current project.'},session.session.id);assert.match(answer.answer,/thirty/);assert.ok(injected.length);
 assert.deepEqual((await pool.query('SELECT surfaced_to FROM jobs WHERE id=$1',[waiting])).rows[0].surfaced_to,[],'An omitted or truncated waiting result must remain unacknowledged.');
});
test('a full continuation queue preserves partial spoken output and honestly reports that no continuation was queued',async()=>{
 const a=await fixture();for(let i=0;i<10;i++)await enqueueJob(a,{task:'Existing queued task '+i});
 setModelTransportForTests(async request=>{request.onText?.('I have checked the first source.');await new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}));return{...response('I have checked the first source.'),incomplete:true};});
 const answer=await think(a,{text:'Continue checking.'},undefined,Date.now()+100);
 assert.equal(answer.job_id,null);assert.match(answer.answer,/I have checked the first source/);assert.match(answer.answer,/could not queue the rest.*ten tasks/i);assert.ok(!answer.answer.includes('will have more for you next time'));
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE user_id=$1 AND state='queued'",[a.user_id])).rows[0].n,10);
});
test('partial continuation capacity handling never swallows revocation, purge or hosted-AI access errors',async()=>{
 for(const mode of ['grant','purge','access'] as const){
  const a=await fixture();for(let i=0;i<10;i++)await enqueueJob(a,{task:'Existing task '+i});
  setModelTransportForTests(async request=>{
   request.onText?.('Partial information must not bypass authority.');
   if(mode==='grant')await pool.query('UPDATE grants SET revoked_at=now() WHERE id=$1',[a.grant_id]);
   else if(mode==='purge')await purgeBrainContent(a.user_id,a.brain_id);
   else await pool.query("UPDATE users SET ai_access_state='revoked' WHERE id=$1",[a.user_id]);
   return{...response('Partial information must not bypass authority.'),incomplete:true};
  });
  await assert.rejects(think(a,{text:'Work within current authority.'}),(error:unknown)=>[401,403,409].includes(Number((error as {status?:number}).status)),mode);
 }
});

test('the source receipt limit omits an entire base pack and leaves its waiting jobs unacknowledged',async()=>{
 const a=await fixture(),owner=await ownerFor(a),project=await createProject(owner,{title:'Receipt bounded project',allowed_agents:['maya']});
 const state=await addItem(owner,{project_id:project.id,expected_version:project.version,type:'constraint',title:'Current rule',content:'Keep the current confirmed rule.',status:'confirmed'});
 const baseRefs=Array.from({length:40},()=>({collection:'facts' as const,id:randomUUID()})),waiting=randomUUID();
 const memory=await buildModelMemory(state,undefined,aiConfig.contextTokens,async()=>({blocks:[{kind:'job_result',text:'BASE_MUST_BE_OMITTED',sourceIds:[waiting]}],estimatedTokens:20,bytes:20,memoryVersion:'0',truncated:false,includedJobIds:[waiting],audience:['all'],sourceRefs:baseRefs}));
 assert.ok(memory.sourceRefs.length<=40);assert.ok(memory.sourceRefs.some(ref=>ref.collection==='project_items'));assert.ok(!memory.text.includes('BASE_MUST_BE_OMITTED'));assert.match(memory.text,/omitted or shortened/);assert.deepEqual(memory.includedJobIds,[]);
});
