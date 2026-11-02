import {before,after,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool} from '../src/db/index.js';
import {config} from '../src/config.js';
import {executeBrainTool} from '../src/brain/lifecycle.js';
import {executeTool,type AuthContext} from '../src/tools/service.js';
import {touchSession} from '../src/brain/sessions.js';
import {createProject,addItem} from '../src/projects/service.js';
import {aiConfig} from '../src/brain/config.js';
import {setModelTransportForTests,type ModelResult} from '../src/brain/provider.js';
const users:string[]=[],client='lifecycle-privacy-'+randomUUID();
before(async()=>{await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr','{}')",[client]);});
afterEach(()=>setModelTransportForTests(undefined));
after(async()=>{for(const id of users)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[client]);await pool.end();});
async function fixture():Promise<AuthContext>{
 const user=randomUUID(),brain=randomUUID(),grant=randomUUID();users.push(user);
 await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,'fixture','approved')",[user,'lifecycle-'+user+'@example.invalid']);
 await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[brain,user]);
 await pool.query('INSERT INTO grants(id,user_id,brain_id,client_id,agent_label,scope,resource) VALUES($1,$2,$3,$4,$5,$6,$7)',[grant,user,brain,client,'maya','brain:read brain:write',config.resource]);
 return{user_id:user,brain_id:brain,agent_label:'maya',client_id:client,scopes:['brain:read','brain:write'],grant_id:grant,token_hash:randomBytes(32).toString('hex')};
}
const tenant=(a:AuthContext)=>[a.user_id,a.brain_id];
const response=(text:string):ModelResult=>({text,inputTokens:20,outputTokens:10,model:aiConfig.quickModel,content:[{type:'text',text}],stopReason:'end_turn',incomplete:false});
async function session(a:AuthContext){return(await pool.query('SELECT * FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 ORDER BY started_at DESC LIMIT 1',tenant(a))).rows[0];}
async function privateProject(a:AuthContext){
 const project=await createProject(a,{title:'Restricted launch',goal:'Private Zephyr launch route.',allowed_agents:['maya','charlie']});
 const state=await addItem(a,{project_id:project.id,expected_version:project.version,type:'decision',title:'Private timetable',content:'Use the private Zephyr route.'});return state;
}
test('delivered private inbox records beyond the receipt cap still narrow later plain remember',async()=>{
 const a=await fixture();
 for(let i=0;i<41;i++)await pool.query("INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text,created_at) VALUES($1,$2,'charlie','{all}',$3,$4)",[...tenant(a),'Public note '+i,new Date(Date.now()+i*1000)]);
 const secret=(await pool.query("INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text,created_at) VALUES($1,$2,'charlie','{maya}','Private route information.','2020-01-01') RETURNING id",tenant(a))).rows[0].id;
 const inbox=await executeBrainTool(a,'inbox',{limit:100});assert.ok((inbox.notes as any[]).some(row=>row.id===secret));
 assert.deepEqual((await session(a)).to_agents,['charlie','maya']);
 const saved=await executeBrainTool(a,'remember',{key:'from-inbox',value:'Private route information.'});assert.equal(saved.visibility,'restricted');
 assert.deepEqual(await executeTool({...a,agent_label:'miles'},'recall',{key:'from-inbox'}),[]);
 assert.equal(Number((await session(a)).write_count),1);
});
test('project reads preserve real item receipts, block broader mutations and count each successful write once',async()=>{
 const a=await fixture(),privateState=await privateProject(a),shared=await createProject(a,{title:'Shared work'});
 const brief=await executeBrainTool(a,'project_brief',{project_id:privateState.project.id});assert.ok((brief.items as any[]).length);
 const saved=await executeBrainTool(a,'remember',{key:'project-route',value:'Use the private Zephyr route.'});assert.equal(saved.visibility,'restricted');
 assert.ok((saved.source_refs as any[]).some(ref=>ref.collection==='project_items'&&ref.id===privateState.items[0].id));
 assert.equal(Number((await session(a)).write_count),1);
 await assert.rejects(executeBrainTool(a,'project_update',{project_id:shared.id,expected_version:shared.version,title:'A leaked private route',reason:'Reusing private context'}),/shared more widely/);
 const updated=await executeBrainTool(a,'project_add_item',{project_id:privateState.project.id,expected_version:privateState.project.version,type:'task',title:'Check train'});
 assert.equal(Number((await session(a)).write_count),2);
 await executeBrainTool(a,'project_history',{project_id:privateState.project.id});
 assert.equal(Number((await session(a)).write_count),2);
 assert.equal((updated.project as any).allowed_agents.includes('maya'),true);
});
test('new project creation is a saved session write and its restricted audience survives subsequent memory writes',async()=>{
 const a=await fixture();
 const project=await executeBrainTool(a,'project_create',{title:'A private plan',goal:'Private route',allowed_agents:['maya','charlie']});
 assert.equal(Number((await session(a)).write_count),1);
 await executeBrainTool(a,'project_brief',{project_id:project.id});
 assert.equal(Number((await session(a)).write_count),1);
 const saved=await executeBrainTool(a,'remember',{key:'project-followup',value:'Follow the private plan.'});assert.equal(saved.visibility,'restricted');
 assert.equal(Number((await session(a)).write_count),2);
});
test('private project read audience carries into foreground reasoning, internal writes and queued work',async()=>{
 const a=await fixture(),project=await privateProject(a);
 await executeBrainTool(a,'project_brief',{project_id:project.project.id});
 let calls=0;setModelTransportForTests(async()=>{if(calls++===0)return{...response(''),content:[{type:'tool_use',id:'save_1',name:'brain_write_fact',input:{key:'reasoned-route',value:'Zephyr private plan.'}}],stopReason:'tool_use'};return response('The private plan is ready.');});
 const answer=await executeBrainTool(a,'think',{text:'Save the route I just read.'});assert.deepEqual(answer.source_audience,['charlie','maya']);
 assert.deepEqual(await executeTool({...a,agent_label:'miles'},'recall',{key:'reasoned-route'}),[]);
 const job=await executeBrainTool(a,'do',{task:'Continue the private route analysis.'});
 const stored=(await pool.query('SELECT source_audience,visibility FROM jobs WHERE id=$1',[job.job_id])).rows[0];assert.deepEqual(stored.source_audience,['charlie','maya']);assert.equal(stored.visibility,'restricted');
 assert.equal(Number((await session(a)).write_count),1); // Internal fact write only; wrapper does not count it twice.
});
test('first-touch private briefing narrows the session before any later memory write',async()=>{
 const a=await fixture();
 await pool.query("INSERT INTO handoffs(user_id,brain_id,from_agent,to_agent,title,context) VALUES($1,$2,'charlie','maya','Restricted route','Private Zephyr routing')",tenant(a));
 const first=await touchSession(a,{summarizer:async()=> 'The private route is ready.'});
 assert.ok(first.briefing);assert.deepEqual(first.session.to_agents,['charlie','maya']);
 const saved=await executeBrainTool(a,'remember',{key:'briefing-followup',value:'The private route is ready.'});assert.equal(saved.visibility,'restricted');
 assert.ok((saved.source_refs as any[]).some(ref=>ref.collection==='handoffs'));
});
async function waitForTouchedSession(a:AuthContext){
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){if(await session(a))return;await new Promise(resolve=>setTimeout(resolve,5));}
 throw new Error('Session did not finish touching before the write.');
}
test('grant revoked after session touch is checked inside the legacy write transaction',async()=>{
 const a=await fixture(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[a.user_id]);
 const pending=executeBrainTool(a,'remember',{key:'late',value:'Must not be saved.'}).then(value=>({value}),error=>({error}));
 try{await waitForTouchedSession(a);await lock.query('UPDATE grants SET revoked_at=now() WHERE id=$1',[a.grant_id]);await lock.query('COMMIT');}
 catch(error){await lock.query('ROLLBACK');throw error;}finally{lock.release();}
 const result=await pending;assert.ok('error' in result);assert.match(String((result as {error:Error}).error.message),/authorized/);
 assert.equal((await pool.query('SELECT 1 FROM facts WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
});
test('purge after session touch rejects legacy content writes using the captured session epoch',async()=>{
 const a=await fixture(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[a.user_id]);
 const pending=executeBrainTool(a,'save_snapshot',{content:'Must not survive memory reset.'}).then(value=>({value}),error=>({error}));
 try{await waitForTouchedSession(a);await lock.query('UPDATE brains SET content_epoch=content_epoch+1,memory_version=memory_version+1 WHERE user_id=$1 AND id=$2',tenant(a));await lock.query('DELETE FROM brain_sessions WHERE user_id=$1 AND brain_id=$2',tenant(a));await lock.query('COMMIT');}
 catch(error){await lock.query('ROLLBACK');throw error;}finally{lock.release();}
 const result=await pending;assert.ok('error' in result);assert.match(String((result as {error:Error}).error.message),/reset/);
 for(const table of ['snapshots','brain_sessions','activity'])assert.equal((await pool.query('SELECT 1 FROM '+table+' WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
});
test('purge after session touch rejects late project creation using the same captured epoch',async()=>{
 const a=await fixture(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[a.user_id]);
 const pending=executeBrainTool(a,'project_create',{title:'A project from the old call'}).then(value=>({value}),error=>({error}));
 try{await waitForTouchedSession(a);await lock.query('UPDATE brains SET content_epoch=content_epoch+1,memory_version=memory_version+1 WHERE user_id=$1 AND id=$2',tenant(a));await lock.query('DELETE FROM brain_sessions WHERE user_id=$1 AND brain_id=$2',tenant(a));await lock.query('COMMIT');}
 catch(error){await lock.query('ROLLBACK');throw error;}finally{lock.release();}
 const result=await pending;assert.ok('error' in result);assert.match(String((result as {error:Error}).error.message),/reset/);
 for(const table of ['projects','project_events','brain_sessions','activity'])assert.equal((await pool.query('SELECT 1 FROM '+table+' WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
});
