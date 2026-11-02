import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import pg from 'pg';

const base = (process.env.BASE_URL ?? 'https://brain.arxsable.ai').replace(/\/$/,'');
const resource = base+'/mcp';
const redirectUri = process.env.E2E_REDIRECT_URI ?? base+'/e2e/callback';
const registrationMethod=process.env.E2E_REGISTRATION_METHOD??'both';
assert.ok(['both','dcr','cimd'].includes(registrationMethod),'Choose E2E_REGISTRATION_METHOD=both,dcr,or cimd');
const expectedTools = ['whoami','inbox','read_notes','recall','list_snapshots','get_snapshot','activity','leave_note','mark_notes_read','handoff','accept_handoff','complete_handoff','remember','forget','save_snapshot','think','do','job_status','jobs_list','end_session'];
type Tokens = {access_token:string;refresh_token:string;token_type:string;expires_in:number;scope:string};
class Browser {
 cookies = new Map<string,string>();
 async request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if(this.cookies.size) headers.set('cookie',[...this.cookies].map(([k,v])=>k+'='+v).join('; '));
  const response=await fetch(new URL(path,base),{...init,headers,redirect:'manual'});
  for(const cookie of response.headers.getSetCookie()) {
   const [pair] = cookie.split(';'); const at=pair.indexOf('='); const name=pair.slice(0,at),value=pair.slice(at+1);
   if(/max-age=0/i.test(cookie)||/expires=Thu, 01 Jan 1970/i.test(cookie))this.cookies.delete(name);else this.cookies.set(name,value);
  }
  return response;
 }
 async form(path:string,data:Record<string,string>) {
  return this.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:base},body:new URLSearchParams(data)});
 }
}
function csrf(html:string) {
 const result=html.match(/name="_csrf" value="([^"]+)"/);assert.ok(result,'CSRF token missing from page');
 return result[1].replaceAll('&amp;','&');
}
async function json<T=Record<string,unknown>>(response:Response,status=200):Promise<T> {
 const body=await response.text();assert.equal(response.status,status,`Unexpected HTTP status ${response.status}: ${body.slice(0,250)}`);return JSON.parse(body) as T;
}
async function authorize(browser:Browser,clientId:string,agent:string):Promise<Tokens> {
 const verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
 const state=randomBytes(24).toString('base64url');
 const parameters={client_id:clientId,redirect_uri:redirectUri,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'brain:read brain:write',resource,state};
 const response=await browser.request('/authorize?'+new URLSearchParams(parameters));
 assert.equal(response.status,200,'Consent page must be available');
 const html=await response.text();assert.ok(html.includes('Which assistant is connecting right now?'));
 const approved=await browser.form('/authorize',{...parameters,_csrf:csrf(html),agent_label:agent,decision:'approve'});
 assert.equal(approved.status,303,'Consent approval must redirect');
 const location=new URL(approved.headers.get('location')!);
 assert.equal(location.origin,new URL(redirectUri).origin);assert.equal(location.pathname,new URL(redirectUri).pathname);assert.equal(location.searchParams.get('state'),state);assert.equal(location.searchParams.get('iss'),base);assert.ok(location.searchParams.get('code'));
 const tokens=await json<Tokens>(await fetch(base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,code:location.searchParams.get('code')!,code_verifier:verifier,resource})}));
 assert.equal(tokens.token_type.toLowerCase(),'bearer');assert.equal(tokens.expires_in,3600);assert.ok(tokens.refresh_token);
 return tokens;
}
async function connect(tokens:Tokens) {
 const client=new Client({name:'brain-e2e',version:'1.0.0'},{capabilities:{}});
 await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:'Bearer '+tokens.access_token}}}));
 return client;
}
async function tool<T=any>(client:Client,name:string,args:Record<string,unknown>={}):Promise<T> {
 const result=await client.callTool({name,arguments:args});
 assert.ok(!result.isError,`Tool failed: ${name}`);
 const text=result.content.find(c=>c.type==='text');assert.ok(text&&text.type==='text');
 const value=JSON.parse(text.text);return (Array.isArray(value.items)&&["read_notes","recall","list_snapshots","activity","jobs_list"].includes(name)?value.items:value) as T;
}
async function verifyDeleted(userId:string,brainIds:string[],grantIds:string[]) {
 if(!process.env.DATABASE_URL) { console.log('INFO Database cascade verification skipped: DATABASE_URL unavailable; HTTP deletion verified.');return; }
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
 try {
  for(const table of ['users','brains','sessions','auth_codes','grants','notes','handoffs','facts','snapshots','activity','brain_sessions','jobs','usage','usage_reservations','nightly_runs']) {
   const column=table==='users'?'id':'user_id';
   const rows=await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,[userId]);
   assert.equal(rows.rows[0].n,0,`Deleted account left rows in ${table}`);
  }
  for(const table of ['access_tokens','refresh_tokens']) {
   const rows=await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE grant_id=ANY($1::uuid[])`,[grantIds]);
   assert.equal(rows.rows[0].n,0,`Deleted account left rows in ${table}`);
  }
  assert.ok(brainIds.length);console.log('PASS account deletion cascades across all 17 user-owned tables');
 } finally {await db.end();}
}
async function scenario(kind:'DCR'|'CIMD') {
 console.log(`BEGIN ${kind} OAuth and shared-memory scenario`);
 const browser=new Browser(); const email='e2e-'+Date.now()+'-'+randomBytes(6).toString('hex')+'@example.invalid';const password=randomBytes(24).toString('base64url');
 let created=false,deleted=false; const clients:Client[]=[];
 try {
  const signup=await browser.request('/signup');assert.equal(signup.status,200);
  const signed=await browser.form('/signup',{_csrf:csrf(await signup.text()),email,password,age_confirm:'yes'});assert.equal(signed.status,303);created=true;
  // Exercise an actual password login after seeding through the public signup flow.
  const account=await browser.request('/account');assert.equal(account.status,200);
  assert.equal((await browser.form('/logout',{_csrf:csrf(await account.text())})).status,303);
  const login=await browser.request('/login');
  assert.equal((await browser.form('/login',{_csrf:csrf(await login.text()),email,password})).status,303);
  let clientId=base+'/e2e/client.json';
  if(kind==='DCR') {
   const registration=await json<{client_id:string}>(await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Brain verification client',redirect_uris:[redirectUri],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})}),201);clientId=registration.client_id;
  } else {assert.equal((await fetch(clientId)).status,200,'Enable E2E_ENABLED for test metadata');}
  const mayaTokens=await authorize(browser,clientId,'maya'),charlieTokens=await authorize(browser,clientId,'charlie');
  const maya=await connect(mayaTokens),charlie=await connect(charlieTokens);clients.push(maya,charlie);
  const listing=await maya.listTools();assert.deepEqual(listing.tools.map(t=>t.name).sort(),expectedTools.sort());console.log(`PASS ${kind} OAuth discovery, registration, login, PKCE, consent and all 20 tools`);
  const identity=await tool(maya,'whoami');assert.equal(identity.agent,'maya');assert.ok(identity.connected_agents.some((a:{agent:string})=>a.agent==='charlie'));
  await tool(maya,'remember',{key:'e2e-train',value:'7:40 train',tags:['verification']});
  const found=await tool<any[]>(charlie,'recall',{query:'train'});assert.ok(found.some(f=>f.key==='e2e-train'));
  const note=await tool(maya,'leave_note',{to:'charlie',text:'E2E private note '+kind,tags:['verification']});
  const inbox=await tool(charlie,'inbox');assert.ok(inbox.notes.some((n:{id:string})=>n.id===note.id));
  await tool(charlie,'mark_notes_read',{ids:[note.id]});
  const snapshot=await tool(maya,'save_snapshot',{content:'E2E private snapshot '+kind,title:'Verification'});
  assert.ok((await tool<any[]>(charlie,'list_snapshots')).some(s=>s.id===snapshot.id));assert.equal((await tool(charlie,'get_snapshot',{id:snapshot.id})).id,snapshot.id);
  const handoff=await tool(charlie,'handoff',{to:'maya',title:'Verify a handoff',context:'E2E private handoff '+kind,next_steps:'Confirm the complete flow'});
  assert.equal((await tool(maya,'accept_handoff',{id:handoff.id})).status,'accepted');
  assert.equal((await tool(maya,'complete_handoff',{id:handoff.id,summary:'E2E handoff complete'})).status,'completed');
  const activity=await tool<any[]>(maya,'activity');for(const kind of ['note_left','handoff_created','handoff_accepted','handoff_completed','fact_stored','snapshot_saved'])assert.ok(activity.some(a=>a.kind===kind),`Missing activity ${kind}`);
  console.log(`PASS ${kind} two-assistant notes, shared facts, snapshots, handoff lifecycle and activity`);
  const refreshed=await json<Tokens>(await fetch(base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:mayaTokens.refresh_token,resource})}));
  assert.notEqual(refreshed.refresh_token,mayaTokens.refresh_token);
  const reused=await fetch(base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:mayaTokens.refresh_token,resource})});
  assert.equal(reused.status,400);assert.equal((await reused.json() as {error:string}).error,'invalid_grant');
  const killed=await fetch(resource,{method:'POST',headers:{Authorization:'Bearer '+refreshed.access_token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/list',params:{}})});assert.equal(killed.status,401);
  console.log(`PASS ${kind} refresh rotates; replay revokes the complete token family`);
  const exported=await json<any>(await browser.request('/account/export'));assert.equal(exported.account.email,email);for(const key of ['brain_sessions','jobs','usage','usage_reservations','nightly_runs'])assert.ok(Array.isArray(exported[key]),'Missing export collection '+key);assert.ok(exported.notes.some((n:{id:string})=>n.id===note.id));assert.ok(exported.handoffs.some((h:{id:string})=>h.id===handoff.id));assert.ok(exported.facts.some((f:{key:string})=>f.key==='e2e-train'));assert.ok(exported.snapshots.some((s:{id:string})=>s.id===snapshot.id));
  const confirmation=await browser.request('/account/delete');assert.equal(confirmation.status,200);
  assert.equal((await browser.form('/account/delete',{_csrf:csrf(await confirmation.text()),confirm:'DELETE'})).status,303);deleted=true;
  assert.equal((await browser.request('/account/export')).status,302);
  await verifyDeleted(exported.account.id,exported.brains.map((b:{id:string})=>b.id),exported.connections.map((g:{id:string})=>g.id));
  const revoked=await fetch(resource,{method:'POST',headers:{Authorization:'Bearer '+charlieTokens.access_token,'content-type':'application/json'},body:'{}'});assert.equal(revoked.status,401);
  console.log(`PASS ${kind} complete JSON export, two-step deletion, and revoked assistant access`);
 } finally {
  await Promise.allSettled(clients.map(c=>c.close()));
  if(created&&!deleted) {
   const confirmation=await browser.request('/account/delete');
   if(confirmation.status===200)await browser.form('/account/delete',{_csrf:csrf(await confirmation.text()),confirm:'DELETE'});
  }
 }
}
async function main() {
 const unauthenticated=await fetch(resource,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauthenticated.status,401);
 const challenge=unauthenticated.headers.get('www-authenticate')!;
 assert.equal(challenge,`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="brain:read brain:write"`);
 const metadataUrl=challenge.match(/resource_metadata="([^"]+)"/)![1];
 const prm=await json<any>(await fetch(metadataUrl));assert.equal(prm.resource,resource);assert.deepEqual(prm.authorization_servers,[base]);
 const as=await json<any>(await fetch(prm.authorization_servers[0]+'/.well-known/oauth-authorization-server'));assert.equal(as.issuer,base);assert.equal(as.authorization_endpoint,base+'/authorize');
 console.log('PASS 401 challenge → protected-resource metadata → authorization-server discovery');
 if(registrationMethod!=='cimd')await scenario('DCR');if(registrationMethod!=='dcr')await scenario('CIMD');
 console.log('PASS ALL OAuth/MCP verification scenarios');
}
main().catch(error=>{console.error('FAIL',error instanceof Error?error.message:'Unknown failure');process.exitCode=1;});
