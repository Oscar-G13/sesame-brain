import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {app} from '../src/app.js';
import {pool} from '../src/db/index.js';
import {config} from '../src/config.js';
import {migrate} from '../scripts/migrate.js';
import {hashToken} from '../src/oauth/security.js';
import type {AuthContext} from '../src/tools/service.js';
import {asWebAuth} from '../src/brain/engine.js';
import {addItem,updateItem,approveItem,createProject,updateProject} from '../src/projects/service.js';
import {setModelTransportForTests} from '../src/brain/provider.js';

let base='',server:ReturnType<typeof app.listen>,providerCalls=0;
const users:string[]=[],clients:Client[]=[],clientId='continuity-mcp-'+randomUUID();
before(async()=>{
 await migrate();await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr',$2)",[clientId,{client_name:'Continuity fixture',redirect_uris:['https://fixture.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}]);
 setModelTransportForTests(async()=>{providerCalls++;throw new Error('Deterministic continuity must not call a model.');});
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');base='http://127.0.0.1:'+address.port;
});
after(async()=>{
 await Promise.allSettled(clients.map(client=>client.close()));if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
 setModelTransportForTests(undefined);for(const id of users)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);await pool.end();
});
async function fixture(label='maya'){
 const user=randomUUID(),brain=randomUUID(),grant=randomUUID(),token=randomBytes(32).toString('base64url'),refresh=randomBytes(32).toString('base64url');users.push(user);
 await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,'fixture','pending')",[user,'continuity-'+user+'@example.invalid']);await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[brain,user]);
 await pool.query("INSERT INTO grants(id,user_id,brain_id,client_id,agent_label,scope,resource) VALUES($1,$2,$3,$4,$5,'brain:read brain:write',$6)",[grant,user,brain,clientId,label,config.resource]);
 await pool.query("INSERT INTO access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),grant]);await pool.query("INSERT INTO refresh_tokens(token_hash,grant_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[hashToken(refresh),grant,randomUUID()]);
 const browser=(await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[user,randomBytes(32).toString('hex')])).rows[0].id;
 const auth:AuthContext={user_id:user,brain_id:brain,agent_label:label,grant_id:grant,client_id:clientId,token_hash:hashToken(token),scopes:['brain:read','brain:write']};
 return{user,brain,grant,token,refresh,auth,owner:await asWebAuth(user,brain,browser)};
}
async function connect(token:string){
 const client=new Client({name:'Same-assistant continuity fixture',version:'1.0.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));return client;
}
async function call(client:Client,name:string,args:Record<string,unknown>={}){
 const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,'MCP operation must succeed: '+name);const text=result.content.find(value=>value.type==='text');assert.ok(text&&text.type==='text');return JSON.parse(text.text);
}
function firstContinuity(result:any){assert.ok(result.continuity,'The first tool response must include structured saved continuity.');assert.ok(typeof result.briefing==='string'&&result.briefing.length>0,'The first response must include a spoken continuity briefing.');return result.continuity;}
async function seedConversation(f:Awaited<ReturnType<typeof fixture>>){
 const a=await connect(f.token),project=await call(a,'project_create',{title:'Same voice notebook',goal:'Continue drafting the notebook welcome on the next call.',allowed_agents:['maya'],request_id:randomUUID()});
 const confirmed=await addItem(f.owner,{project_id:project.id,expected_version:project.version,type:'constraint',title:'Current length limit',content:'The welcome must contain at most 50 words.',status:'confirmed',source_type:'user_statement'});
 const constraint=confirmed.items.find(item=>item.type==='constraint')!;
 const question=await call(a,'project_add_item',{project_id:project.id,expected_version:confirmed.project.version,type:'question',title:'Unresolved tone',content:'Should the welcome sound formal or casual?',request_id:randomUUID()});
 const task=await call(a,'project_add_item',{project_id:project.id,expected_version:question.project.version,type:'task',title:'Next step: draft the welcome',content:'Next call, draft the welcome after the tone question is resolved.',depends_on:[constraint.id],request_id:randomUUID()});
 const snapshot=await call(a,'save_snapshot',{title:'Same assistant saved note',content:'SAME-VOICE-SNAPSHOT: continue the welcome without asking for the project ID.'});
 return{a,project,version:task.project.version,constraint,snapshot};
}
test('same assistant, same grant and fresh MCP client resume unchanged saved work without an ID or AI',async()=>{
 const f=await fixture(),saved=await seedConversation(f),closed=await call(saved.a,'end_session');assert.equal(closed.closed,true,'Memory-only goodbye must close/bookmark the call.');
 await saved.a.close();const b=await connect(f.token),continuity=firstContinuity(await call(b,'whoami'));
 assert.equal(continuity.project.id,saved.project.id);assert.equal(continuity.project.version,saved.version);
 assert.match(JSON.stringify(continuity.project.confirmed_constraints),/50 words/);assert.match(JSON.stringify(continuity.project.open_questions),/formal or casual/);assert.match(JSON.stringify(continuity.project.unfinished_tasks),/draft the welcome/i);
 assert.ok(continuity.previous_session,'Previous call evidence must be available without intervening changes.');assert.ok(JSON.stringify(continuity).includes('SAME-VOICE-SNAPSHOT')||(continuity.source_refs??[]).some((ref:any)=>ref.collection==='snapshots'&&ref.id===saved.snapshot.id),'Same-assistant saved snapshot must remain recoverable.');
 assert.equal(providerCalls,0);assert.equal((await pool.query('SELECT id FROM usage WHERE user_id=$1',[f.user])).rowCount,0);
});
test('explicit resume works inside an active session and latest confirmed corrections take precedence',async()=>{
 const f=await fixture(),saved=await seedConversation(f);
 let updated=await updateItem(f.owner,{project_id:saved.project.id,expected_version:saved.version,item_id:saved.constraint.id,content:'The welcome must contain at most 30 words.',reason:'Owner correction: make the welcome shorter.'});
 updated=await approveItem(f.owner,{project_id:saved.project.id,expected_version:updated.project.version,item_id:saved.constraint.id,decision:'approve'});
 const resumed=await call(saved.a,'resume');assert.equal(resumed.project.id,saved.project.id);assert.equal(resumed.project.version,updated.project.version);
 const constraints=JSON.stringify(resumed.project.confirmed_constraints);assert.match(constraints,/30 words/);assert.ok(!constraints.includes('50 words'),'Current confirmed constraints must not be replaced by stale call prose.');
 const again=await call(saved.a,'resume');assert.equal(again.project.id,saved.project.id);assert.ok(again.resume_count>=resumed.resume_count);assert.equal(providerCalls,0);
});
test('token refresh and idle expiry retain same-grant project continuity',async()=>{
 const f=await fixture(),saved=await seedConversation(f);
 await pool.query("UPDATE brain_sessions SET last_activity_at=now()-interval '31 minutes' WHERE user_id=$1 AND brain_id=$2 AND closed_at IS NULL",[f.user,f.brain]);
 const response=await fetch(base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:f.refresh,resource:config.resource})});assert.equal(response.status,200);
 const refreshed=await response.json() as {access_token:string};const b=await connect(refreshed.access_token),continuity=firstContinuity(await call(b,'whoami'));assert.equal(continuity.project.id,saved.project.id);assert.match(JSON.stringify(continuity.project.unfinished_tasks),/draft the welcome/i);assert.equal(providerCalls,0);
});
test('continuity does not reveal restricted or foreign projects, snapshots, or guessed source IDs',async()=>{
 const f=await fixture(),saved=await seedConversation(f),foreign=await fixture();
 const hidden=await createProject(f.owner,{title:'HIDDEN-OTHER-VOICE',goal:'SECRET-OTHER-VOICE',allowed_agents:['charlie']});
 const other=await createProject(foreign.owner,{title:'HIDDEN-FOREIGN-ACCOUNT',goal:'SECRET-FOREIGN-ACCOUNT',allowed_agents:['all']});
 await pool.query("INSERT INTO snapshots(user_id,brain_id,agent_label,title,content,visibility,to_agents) VALUES($1,$2,'you','Owner only','SECRET-OWNER-SNAPSHOT','owner_only','{you}')",[f.user,f.brain]);
 const resumed=await call(saved.a,'resume');const payload=JSON.stringify(resumed);for(const marker of [hidden.id,other.id,'SECRET-OTHER-VOICE','SECRET-FOREIGN-ACCOUNT','SECRET-OWNER-SNAPSHOT'])assert.ok(!payload.includes(marker),'Resume must preserve source tenancy and audience.');
 for(const project_id of [hidden.id,other.id]){const result=await saved.a.callTool({name:'resume',arguments:{project_id}});assert.equal(result.isError,true,'Explicit foreign/restricted resume must fail closed.');}
 assert.equal(providerCalls,0);
});
test('read-only grants can resume saved context, while revoked grants cannot',async()=>{
 const f=await fixture(),saved=await seedConversation(f);await pool.query("UPDATE grants SET scope='brain:read' WHERE id=$1",[f.grant]);
 const result=await call(saved.a,'resume');assert.equal(result.project.id,saved.project.id);
 await pool.query('UPDATE grants SET revoked_at=now() WHERE id=$1',[f.grant]);
 const rejected=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'resume',arguments:{}}})});assert.equal(rejected.status,401);assert.equal(providerCalls,0);
});

test('withdrawn source access cannot be recovered from an older session bookmark or summary',async()=>{
 const f=await fixture(),a=await connect(f.token),project=await createProject(f.owner,{title:'WITHDRAWN-PROJECT',goal:'WITHDRAWN-PRIVATE-CONTEXT',allowed_agents:['maya','charlie']});
 const state=await addItem(f.owner,{project_id:project.id,expected_version:project.version,type:'constraint',title:'Withdrawn rule',content:'WITHDRAWN-PRIVATE-RULE',status:'confirmed'});
 await call(a,'project_brief',{project_id:project.id});
 await updateProject(f.owner,{project_id:project.id,expected_version:state.project.version,allowed_agents:['charlie'],reason:'Owner withdraws Maya access.'});
 const resumed=await call(a,'resume'),text=JSON.stringify(resumed);for(const marker of [project.id,'WITHDRAWN-PRIVATE-CONTEXT','WITHDRAWN-PRIVATE-RULE'])assert.ok(!text.includes(marker),'Current ACL must override historical session receipts.');
 assert.equal(providerCalls,0);
});

test('first explicit resume records one delivered retrieval rather than a hidden first-touch duplicate',async()=>{
 const f=await fixture();await createProject(f.owner,{title:'One retrieval',goal:'Resume this saved project once.',allowed_agents:['maya']});
 const a=await connect(f.token),resumed=await call(a,'resume');assert.equal(resumed.resume_count,1);assert.equal(resumed.saved_context,true);
 const row=(await pool.query('SELECT resume_count FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND closed_at IS NULL',[f.user,f.brain])).rows[0];assert.equal(Number(row.resume_count),1);assert.equal(providerCalls,0);
});
