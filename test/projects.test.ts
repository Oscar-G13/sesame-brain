import {before,after,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../src/db/index.js';
import {migrate} from '../scripts/migrate.js';
import {createProject,getProject,listProjects,addItem,updateItem,approveItem,updateProject,projectHistory} from '../src/projects/service.js';
import {executeTool,type AuthContext} from '../src/tools/service.js';
import {purgeBrainContent} from '../src/brain/purge.js';
import {enqueueJob,runNextJob,jobStatus} from '../src/brain/engine.js';
import {setModelTransportForTests,type ModelResult} from '../src/brain/provider.js';
import {aiConfig} from '../src/brain/config.js';
const users:string[]=[],client='projects-'+randomUUID();
before(async()=>{await migrate();await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr','{}')",[client]);});
afterEach(()=>setModelTransportForTests(undefined));
after(async()=>{for(const id of users)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[client]);await pool.end();});
async function fixture(){
 const user=randomUUID(),brain=randomUUID(),session=randomUUID();users.push(user);
 await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,'fixture','approved')",[user,user+'@projects.invalid']);
 await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[brain,user]);
 await pool.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[session,user,randomUUID()]);
 const owner:AuthContext={user_id:user,brain_id:brain,agent_label:'you',client_id:'dashboard',grant_id:'',token_hash:'web:'+session,browser_session_id:session,scopes:['brain:read','brain:write']};
 const voice=async(label:string)=>{const grant=randomUUID();await pool.query("INSERT INTO grants(id,user_id,brain_id,client_id,agent_label,scope) VALUES($1,$2,$3,$4,$5,'brain:read brain:write')",[grant,user,brain,client,label]);return{...owner,agent_label:label,client_id:client,grant_id:grant,browser_session_id:undefined,token_hash:randomUUID()} satisfies AuthContext;};
 return{owner,maya:await voice('maya'),charlie:await voice('charlie'),miles:await voice('miles')};
}
const response=(text:string):ModelResult=>({text,inputTokens:50,outputTokens:20,model:aiConfig.deepModel,content:[{type:'text',text}],stopReason:'end_turn',incomplete:false});
test('a correction travels between voices with receipts, owner approval, provenance and dependency invalidation',async()=>{
 const {owner,maya,charlie}=await fixture();const p=await createProject(maya,{title:'Launch',goal:'Launch next month',request_id:randomUUID()});
 let state=await addItem(owner,{project_id:p.id,expected_version:1,type:'constraint',title:'Budget',content:'2000',status:'confirmed',source_type:'user_statement',source_refs:[{kind:'statement',label:'Owner entered this constraint'}]});
 const budget=state.items[0].id;
 state=await addItem(owner,{project_id:p.id,expected_version:state.project.version,type:'decision',title:'Supplier A',content:'Fits the original budget',status:'confirmed',depends_on:[budget]});
 const decision=state.items.find(i=>i.type==='decision')!.id;
 state=await getProject(charlie,p.id,{acknowledge:true});assert.ok(state.receipts.some(r=>r.agent_label==='charlie'&&r.last_seen_version===3));
 state=await updateItem(charlie,{project_id:p.id,item_id:budget,expected_version:state.project.version,content:'1200',reason:'User reported a lower budget'});
 assert.equal(state.items.find(i=>i.id===budget)!.content,'2000');assert.equal(state.items.find(i=>i.id===budget)!.pending_change?.content,'1200');
 await assert.rejects(approveItem(maya,{project_id:p.id,item_id:budget,expected_version:state.project.version,decision:'approve'}),/owner/);
 state=await approveItem(owner,{project_id:p.id,item_id:budget,expected_version:state.project.version,decision:'approve'});
 assert.equal(state.items.find(i=>i.id===budget)!.content,'1200');assert.equal(state.items.find(i=>i.id===decision)!.needs_review,true);
 const received=await getProject(maya,p.id,{sinceVersion:3,acknowledge:true});assert.equal(received.project.needs_review_count,1);assert.ok(received.events.some(e=>e.kind==='change_approved'));assert.ok(received.events.some(e=>JSON.stringify(e.before).includes('2000')));
 state=await approveItem(owner,{project_id:p.id,item_id:decision,expected_version:state.project.version,decision:'approve'});assert.equal(state.project.needs_review_count,0);
});
test('optimistic versions and retry identities prevent stale overwrites and duplicate records',async()=>{
 const {maya}=await fixture();const request_id=randomUUID();const a=await createProject(maya,{title:'One',request_id}),b=await createProject(maya,{title:'One',request_id});assert.equal(a.id,b.id);
 const itemRequest={project_id:a.id,expected_version:1,type:'question' as const,title:'What matters?',request_id:randomUUID()};
 await addItem(maya,itemRequest);const again=await addItem(maya,itemRequest);assert.equal(again.items.length,1);assert.equal(again.project.version,2);
 const results=await Promise.allSettled([updateProject(maya,{project_id:a.id,expected_version:2,title:'First',reason:'First change'}),updateProject(maya,{project_id:a.id,expected_version:2,title:'Second',reason:'Second change'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.status,409);
 const history=await projectHistory(maya,a.id);assert.deepEqual(history.map(e=>e.version),[3,2,1]);
});
test('scope and evidence audiences prevent cross-account or cross-assistant disclosure',async()=>{
 const a=await fixture(),other=await fixture();const restricted=await createProject(a.owner,{title:'Private',allowed_agents:['maya']});
 await assert.rejects(getProject(other.maya,restricted.id),/not found/i);await assert.rejects(getProject(a.charlie,restricted.id),/not found/i);assert.equal((await listProjects(a.charlie)).length,0);
 const note=await executeTool(a.maya,'leave_note',{to:'maya',text:'PRIVATE_DETAIL'}) as {id:string};const shared=await createProject(a.maya,{title:'Shared'});
 await assert.rejects(addItem(a.maya,{project_id:shared.id,expected_version:1,type:'decision',title:'Do not leak',source_refs:[{kind:'note',id:note.id}]}),/narrower audience/);
 const accepted=await addItem(a.maya,{project_id:restricted.id,expected_version:1,type:'decision',title:'Private decision',source_refs:[{kind:'note',id:note.id,excerpt:'PRIVATE_DETAIL'}]});assert.equal(accepted.items.length,1);
 await assert.rejects(updateProject(a.owner,{project_id:restricted.id,expected_version:2,allowed_agents:['all'],reason:'Try to widen'}),/narrower audience/);
 await assert.rejects(addItem(a.maya,{project_id:restricted.id,expected_version:2,type:'decision',title:'Fake quotation',source_refs:[{kind:'note',id:note.id,excerpt:'Invented words'}]}),/match.*exactly/);
});
test('dependency cycles and references into another project are rejected atomically',async()=>{
 const {maya}=await fixture();const p=await createProject(maya,{title:'Dependencies'});let s=await addItem(maya,{project_id:p.id,expected_version:1,type:'constraint',title:'A'});const first=s.items[0].id;
 s=await addItem(maya,{project_id:p.id,expected_version:2,type:'task',title:'B',depends_on:[first]});const second=s.items.find(i=>i.title==='B')!.id;
 await assert.rejects(updateItem(maya,{project_id:p.id,item_id:first,expected_version:3,reason:'Cycle',depends_on:[second]}),/cycle/);
 const q=await createProject(maya,{title:'Other'});await assert.rejects(addItem(maya,{project_id:q.id,expected_version:1,type:'task',title:'Foreign dependency',depends_on:[first]}),/not found/);
 assert.equal((await getProject(maya,q.id)).items.length,0);assert.equal((await getProject(maya,p.id)).project.version,3);
});
test('revocation and purge prevent stale project access and late writes',async()=>{
 const a=await fixture();const p=await createProject(a.maya,{title:'Revocation'});await pool.query('UPDATE grants SET revoked_at=now() WHERE id=$1',[a.maya.grant_id]);await assert.rejects(getProject(a.maya,p.id),/authorized/);
 await purgeBrainContent(a.owner.user_id,a.owner.brain_id);
 await assert.rejects(addItem(a.charlie,{project_id:p.id,expected_version:1,type:'task',title:'Late write'}),/not found/);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM projects WHERE user_id=$1',[a.owner.user_id])).rows[0].n,0);assert.ok((await pool.query('SELECT id FROM users WHERE id=$1',[a.owner.user_id])).rowCount);
});
test('a project job uses its constraints and attaches a reviewable artifact when assumptions change',async()=>{
 const a=await fixture();const p=await createProject(a.owner,{title:'Supplier choice',goal:'Prepare a sourced comparison'});await addItem(a.owner,{project_id:p.id,expected_version:1,type:'constraint',title:'Budget',content:'1200 maximum',status:'confirmed'});
 const queued=await enqueueJob(a.owner,{task:'Compare suppliers',project_id:p.id});
 let signal!:()=>void,release!:()=>void;const started=new Promise<void>(r=>signal=r),wait=new Promise<void>(r=>release=r);
 setModelTransportForTests(async request=>{assert.match(JSON.stringify(request.messages),/1200 maximum/);signal();await wait;return response('Supplier B fits the budget.\n\nSource: https://example.com/specification');});
 const work=runNextJob(a.owner);await started;await updateProject(a.owner,{project_id:p.id,expected_version:2,goal:'Prepare comparison for an earlier launch',reason:'The deadline changed'});release();await work;
 const done=await jobStatus(a.owner,queued.job_id!) as {state:string};assert.equal(done.state,'done');
 const state=await getProject(a.owner,p.id),artifact=state.items.find(i=>i.type==='artifact')!;assert.ok(artifact);assert.equal(artifact.needs_review,true);assert.equal(artifact.source_refs[0].id,queued.job_id);assert.ok(state.links.some(l=>l.from_item_id===artifact.id));
});
test('the shared worker runs different accounts concurrently while keeping one active job per account',async()=>{
 const a=await fixture(),b=await fixture();await enqueueJob(a.maya,{task:'A first'});await enqueueJob(a.maya,{task:'A second'});await enqueueJob(b.maya,{task:'B first'});
 const tasks:string[]=[],releases:(()=>void)[]=[];let ready!:()=>void;const both=new Promise<void>(r=>ready=r);
 setModelTransportForTests(async request=>{tasks.push(JSON.stringify(request.messages));await new Promise<void>(r=>{releases.push(r);if(releases.length===2)ready();});return response('Done.');});
 const first=runNextJob(),second=runNextJob();await both;assert.ok(tasks.some(t=>t.includes('A first')));assert.ok(tasks.some(t=>t.includes('B first')));assert.equal(await runNextJob(),false);releases.forEach(r=>r());await Promise.all([first,second]);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE user_id=$1 AND state='queued'",[a.owner.user_id])).rows[0].n,1);
});

test('background work preserves the initiating session audience and does not broaden a private request',async()=>{
 const a=await fixture();
 const queued=await enqueueJob({...a.maya,source_audience:['maya']},{task:'Summarize my private plan'});
 setModelTransportForTests(async()=>response('The private plan is ready.'));
 await runNextJob(a.maya);
 assert.equal((await jobStatus(a.maya,queued.job_id!) as {state:string}).state,'done');
 await assert.rejects(jobStatus(a.charlie,queued.job_id!),/not found/);
 const rows=(await pool.query('SELECT source_audience FROM jobs WHERE id=$1',[queued.job_id])).rows;
 assert.deepEqual(rows[0].source_audience,['maya']);
});
test('queued work cannot retain write authority after its requesting grant is narrowed',async()=>{
 const a=await fixture();
 const queued=await enqueueJob(a.maya,{task:'Never run this after scope loss'});
 await pool.query("UPDATE grants SET scope='brain:read' WHERE id=$1",[a.maya.grant_id]);
 let calls=0;setModelTransportForTests(async()=>{calls++;return response('Unexpected');});
 await runNextJob(a.maya);assert.equal(calls,0);
 assert.equal((await jobStatus({...a.maya,scopes:['brain:read']},queued.job_id!) as {state:string}).state,'failed');
});
