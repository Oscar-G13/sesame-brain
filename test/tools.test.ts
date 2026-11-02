import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import express from 'express';
import {once} from 'node:events';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {mcpRouter} from '../src/mcp/routes.js';
import type {Request,Response,NextFunction} from 'express';
import {pool} from '../src/db/index.js';
import {migrate} from '../scripts/migrate.js';
import {executeTool,type AuthContext,ToolError} from '../src/tools/service.js';
import {toolDefinitions,type ToolName} from '../src/tools/definitions.js';
import {bearerAuth} from '../src/oauth/bearer.js';
import {hashToken} from '../src/oauth/security.js';
import {config} from '../src/config.js';

const createdUsers:string[]=[];
const clientId='test-tools-'+randomUUID();
before(async()=>{await migrate();await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr',$2)",[clientId,{client_name:'Isolation fixture',redirect_uris:['https://client.example/callback']}]);});
after(async()=>{for(const id of createdUsers)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);await pool.end();});
async function fixture(agent='maya',scopes=['brain:read','brain:write']){
 const user=await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id',['test-'+randomUUID()+'@example.invalid','fixture-only-not-a-password']);
 const uid=user.rows[0].id as string;createdUsers.push(uid);
 const brain=await pool.query("INSERT INTO brains(user_id,name) VALUES($1,'default') RETURNING id",[uid]);
 const bid=brain.rows[0].id as string;
 const grant=await pool.query('INSERT INTO grants(user_id,brain_id,agent_label,client_id,scope,resource) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[uid,bid,agent,clientId,scopes.join(' '),config.resource]);
 const token=randomBytes(32).toString('base64url');
 await pool.query("INSERT INTO access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),grant.rows[0].id]);
 return {token,context:{user_id:uid,brain_id:bid,agent_label:agent,client_id:clientId,scopes,grant_id:grant.rows[0].id,token_hash:hashToken(token)} satisfies AuthContext};
}
async function authenticate(token:string,name:ToolName){
 const req={get:(key:string)=>key==='authorization'?'Bearer '+token:undefined,body:{method:'tools/call',params:{name}},auth:undefined as AuthContext|undefined};
 let status=200,called=false,error:unknown;
 const res={set(){return res;},status(value:number){status=value;return res;},json(){return res;}};
 await bearerAuth(req as unknown as Request,res as unknown as Response,((err:unknown)=>{error=err;called=true;}) as NextFunction);
 if(error)throw error;
 return {status,called,context:req.auth};
}
const sample:Record<ToolName,unknown>={
 whoami:{},inbox:{},read_notes:{},recall:{},list_snapshots:{},get_snapshot:{id:randomUUID()},activity:{},
 leave_note:{to:'maya',text:'Own note'},mark_notes_read:{all:true},handoff:{to:'charlie',title:'Own task',context:'Own context'},accept_handoff:{id:randomUUID()},complete_handoff:{id:randomUUID(),summary:'Own summary'},remember:{key:'own',value:'Own value'},forget:{key:'own'},save_snapshot:{content:'Own memory'}
};
test('every tool rejects a token identity combined with another user brain',async()=>{
 const a=await fixture(),b=await fixture();
 for(const name of Object.keys(toolDefinitions) as ToolName[]){
  const authenticated=await authenticate(a.token,name);assert.equal(authenticated.status,200);assert.ok(authenticated.context);
  await assert.rejects(executeTool({...authenticated.context,brain_id:b.context.brain_id},name,sample[name]),(e:unknown)=>e instanceof ToolError&&e.status===404,name);
 }
 for(const table of ['notes','handoffs','facts','snapshots','activity']){
  const rows=await pool.query('SELECT count(*)::int AS n FROM '+table+' WHERE user_id=$1 AND brain_id=$2',[b.context.user_id,b.context.brain_id]);assert.equal(rows.rows[0].n,0);
 }
});
test('real token A cannot discover or mutate user B data through any tool or guessed ids',async()=>{
 const a=await fixture(),b=await fixture();const marker='B-SECRET-'+randomUUID();
 const bn=await executeTool(b.context,'leave_note',{to:'maya',text:marker}) as {id:string};
 const bh=await executeTool(b.context,'handoff',{to:'maya',title:marker,context:marker}) as {id:string};
 const bs=await executeTool(b.context,'save_snapshot',{content:marker,title:marker}) as {id:string};
 await executeTool(b.context,'remember',{key:'only-b',value:marker,tags:['hidden']});
 const beforeB=await dump(b.context);
 const reads=['whoami','inbox','read_notes','recall','list_snapshots','activity'] as const;
 for(const name of reads){
  const auth=await authenticate(a.token,name);assert.equal(auth.status,200);assert.ok(auth.context);
  const result=await executeTool(auth.context,name,{query:marker,from:'maya',to:'maya',tag:'hidden',user_id:b.context.user_id,brain_id:b.context.brain_id});
  assert.ok(!JSON.stringify(result).includes(marker),name+' must not expose B');
 }
 const auth=await authenticate(a.token,'get_snapshot');assert.ok(auth.context);
 await assert.rejects(executeTool(auth.context,'get_snapshot',{id:bs.id}),/Snapshot not found/);
 assert.deepEqual(await executeTool(a.context,'mark_notes_read',{ids:[bn.id]}),{marked:0});
 await assert.rejects(executeTool(a.context,'accept_handoff',{id:bh.id}),/not found/);
 await assert.rejects(executeTool(a.context,'complete_handoff',{id:bh.id,summary:'Hacked'}),/not found/);
 assert.deepEqual(await executeTool(a.context,'forget',{key:'only-b'}),{deleted:false});
 await executeTool(a.context,'remember',{key:'only-b',value:'A own fact',brain_id:b.context.brain_id});
 await executeTool(a.context,'leave_note',{to:'maya',text:'A own note',user_id:b.context.user_id});
 await executeTool(a.context,'handoff',{to:'maya',title:'A own task',context:'A own context',brain_id:b.context.brain_id});
 await executeTool(a.context,'save_snapshot',{content:'A own backup',user_id:b.context.user_id});
 assert.equal(await dump(b.context),beforeB,'every B content row must remain byte-for-byte unchanged');
});
async function dump(a:AuthContext){
 const result:Record<string,unknown>={};
 for(const table of ['notes','handoffs','facts','snapshots','activity'])result[table]=(await pool.query('SELECT * FROM '+table+' WHERE user_id=$1 AND brain_id=$2 ORDER BY id',[a.user_id,a.brain_id])).rows;
 return JSON.stringify(result);
}
test('broadcast notes track reading per assistant and targeted notes stay private',async()=>{
 const a=await fixture();const charlie={...a.context,agent_label:'charlie'},miles={...a.context,agent_label:'miles'};
 const broadcast=await executeTool(a.context,'leave_note',{to:'all',text:'Shared message'}) as {id:string};
 const direct=await executeTool(a.context,'leave_note',{to:'charlie',text:'For Charlie only'}) as {id:string};
 let inbox=await executeTool(charlie,'inbox',{}) as {notes:{id:string}[]};assert.equal(inbox.notes.length,2);
 assert.deepEqual(await executeTool(charlie,'mark_notes_read',{ids:[broadcast.id]}),{marked:1});
 assert.deepEqual(await executeTool(charlie,'mark_notes_read',{ids:[broadcast.id]}),{marked:0});
 const m=await executeTool(miles,'read_notes',{}) as {id:string}[];assert.equal(m.length,1);assert.equal(m[0].id,broadcast.id);
 assert.deepEqual(await executeTool(miles,'mark_notes_read',{ids:[direct.id]}),{marked:0});
 const mi=await executeTool(miles,'inbox',{}) as {notes:{id:string}[]};assert.equal(mi.notes.length,1);
 inbox=await executeTool(charlie,'inbox',{}) as {notes:{id:string}[]};assert.equal(inbox.notes.length,1);assert.equal(inbox.notes[0].id,direct.id);
});
test('handoffs transition only for the recipient, with automatic notes and all write activity',async()=>{
 const a=await fixture();const c={...a.context,agent_label:'charlie'};
 const h=await executeTool(a.context,'handoff',{to:'charlie',title:'Research',context:'All the context',next_steps:'Finish it'}) as {id:string};
 await assert.rejects(executeTool(a.context,'accept_handoff',{id:h.id}),/not found/);
 assert.deepEqual(await executeTool(c,'accept_handoff',{id:h.id}),{id:h.id,status:'accepted'});
 await assert.rejects(executeTool(c,'accept_handoff',{id:h.id}),/not found/);
 await executeTool(c,'complete_handoff',{id:h.id,summary:'All done'});
 const notes=await executeTool(a.context,'inbox',{}) as {notes:{text:string}[]};assert.equal(notes.notes.length,2);assert.ok(notes.notes.some(n=>n.text.includes('All done')));
 await executeTool(a.context,'remember',{key:'commute',value:'Take the 7:40 train',tags:['travel']});
 const facts=await executeTool(c,'recall',{query:'train'}) as {value:string}[];assert.equal(facts.length,1);
 await executeTool(c,'forget',{key:'commute'});
 await executeTool(a.context,'mark_notes_read',{all:true});
 await executeTool(c,'save_snapshot',{content:'Backup text'});
 const kinds=(await executeTool(a.context,'activity',{limit:100}) as {kind:string}[]).map(e=>e.kind);
 for(const kind of ['handoff_created','handoff_accepted','handoff_completed','note_left','fact_stored','fact_forgotten','notes_read','snapshot_saved'])assert.ok(kinds.includes(kind),kind);
});
test('snapshot retention keeps 50 per agent and never prunes another assistant',async()=>{
 const a=await fixture();const c={...a.context,agent_label:'charlie'};
 const other=await executeTool(c,'save_snapshot',{content:'Charlie preserved'}) as {id:string};
 for(let i=0;i<52;i++)await executeTool(a.context,'save_snapshot',{content:'Memory '+i});
 const list=await executeTool(a.context,'list_snapshots',{agent:'maya',limit:100}) as unknown[];assert.equal(list.length,50);
 assert.ok((await executeTool(a.context,'get_snapshot',{id:other.id}) as {content:string}).content.includes('Charlie'));
});
test('bearer rejects invalid audience, expired and revoked grants, and enforces tool scopes',async()=>{
 const a=await fixture('maya',['brain:read']);
 assert.equal((await authenticate(a.token,'whoami')).status,200);
 assert.equal((await authenticate(a.token,'remember')).status,403);
 await assert.rejects(executeTool(a.context,'remember',{key:'x',value:'y'}),(e:unknown)=>e instanceof ToolError&&e.status===403);
 await pool.query('UPDATE grants SET resource=$1 WHERE id=$2',['https://other.example/mcp',a.context.grant_id]);assert.equal((await authenticate(a.token,'whoami')).status,401);
 await pool.query('UPDATE grants SET resource=$1 WHERE id=$2',[config.resource,a.context.grant_id]);
 await pool.query("UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hashToken(a.token)]);assert.equal((await authenticate(a.token,'whoami')).status,401);
 const b=await fixture();await pool.query('UPDATE grants SET revoked_at=now() WHERE id=$1',[b.context.grant_id]);assert.equal((await authenticate(b.token,'whoami')).status,401);
});
test('database rejects content rows assigned to a mismatched user and brain',async()=>{
 const a=await fixture(),b=await fixture();
 await assert.rejects(pool.query('INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text) VALUES($1,$2,$3,$4,$5)',[a.context.user_id,b.context.brain_id,'maya',['all'],'Bad tenant']),(error:unknown)=>(error as {code?:string}).code==='23503');
});

test('HTTP transport serves modern SDK and legacy requests with bearer, CORS, 403 scopes and 405 session methods',async()=>{
 const a=await fixture(),b=await fixture(),readOnly=await fixture('miles',['brain:read']);
 const foreign=await executeTool(b.context,'save_snapshot',{content:'Foreign private backup'}) as {id:string};
 const app=express();app.use(express.json({limit:'1mb'}));app.use(mcpRouter);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url=new URL('http://127.0.0.1:'+address.port+'/mcp');
 const client=new Client({name:'Brain protocol integration',version:'1.0.0'});
 try {
  const initial=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(initial.status,401);assert.equal(initial.headers.get('www-authenticate'),'Bearer resource_metadata="'+config.baseUrl+'/.well-known/oauth-protected-resource", scope="brain:read brain:write"');
  const preflight=await fetch(url,{method:'OPTIONS',headers:{origin:'https://example-client.test','access-control-request-headers':'authorization,content-type'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'*');
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+a.token}}}));
  const tools=await client.listTools();assert.equal(tools.tools.length,15);
  const me=await client.callTool({name:'whoami',arguments:{}});assert.ok(Array.isArray(me.content));assert.equal(JSON.parse((me.content[0] as {type:string;text:string}).text).agent,'maya');
  const denied=await client.callTool({name:'get_snapshot',arguments:{id:foreign.id}});assert.equal(denied.isError,true);assert.ok(!JSON.stringify(denied).includes('Foreign private backup'));
  const legacy=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+a.token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:5,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Legacy fixture',version:'1.0'}}})});
  assert.equal(legacy.status,200);assert.ok((await legacy.text()).includes('2025-06-18'));
  for(const method of ['GET','DELETE']){
   const response=await fetch(url,{method,headers:{authorization:'Bearer '+a.token,accept:'application/json, text/event-stream','Mcp-Protocol-Version':'2025-06-18'}});
   assert.equal(response.status,405,method);
  }
  const scopeResponse=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+readOnly.token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'remember',arguments:{key:'forbidden',value:'No'}}})});
  assert.equal(scopeResponse.status,403);assert.ok(scopeResponse.headers.get('www-authenticate')?.includes('error="insufficient_scope"'));
 } finally {
  await client.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 }
});
