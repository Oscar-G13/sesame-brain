import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import pg from 'pg';
const base=(process.env.BASE_URL??'https://brain.arxsable.ai').replace(/\/$/,''),resource=base+'/mcp',redirect=base+'/e2e/continuity-callback';
if(!process.env.DATABASE_URL)throw new Error('Run remotely with scoped fixture database verification available.');
const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const email='continuity-live-'+randomUUID()+'@example.invalid',password=randomBytes(32).toString('base64url'),clients:Client[]=[];
const receipt:Record<string,unknown>={at:new Date().toISOString(),scenario:'same assistant across calls',native_app_verified:false,provider_calls:0,backup_performed:false,checks:[]};
let created=false,deleted=false,userId='',clientId='',stage='signup';
function check(name:string){(receipt.checks as unknown[]).push(name);console.log('PASS '+name);}
class Browser{
 cookies=new Map<string,string>();
 async request(path:string,init:RequestInit={}){
  const headers=new Headers(init.headers);if(this.cookies.size)headers.set('cookie',[...this.cookies].map(([k,v])=>k+'='+v).join('; '));
  const response=await fetch(new URL(path,base),{...init,headers,redirect:'manual',signal:AbortSignal.timeout(20000)});
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');if(/max-age=0/i.test(cookie))this.cookies.delete(pair.slice(0,at));else this.cookies.set(pair.slice(0,at),pair.slice(at+1));}return response;
 }
 form(path:string,data:Record<string,string>){return this.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:base},body:new URLSearchParams(data)});}
}
const browser=new Browser();
function csrf(html:string){const match=html.match(/name="_csrf" value="([^"]+)"/);assert.ok(match,'Form CSRF token required.');return match[1].replaceAll('&amp;','&');}
async function json(response:Response,status=200){assert.equal(response.status,status,'Expected HTTP response.');return response.json() as Promise<any>;}
async function connect(token:string){const client=new Client({name:'Same-voice public continuity acceptance',version:'1.0.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{authorization:'Bearer '+token}}}));return client;}
async function call(client:Client,name:string,args:Record<string,unknown>={}){const result=await client.callTool({name,arguments:args},{timeout:30000});assert.ok(!result.isError,'MCP operation required: '+name);const part=result.content.find(value=>value.type==='text');assert.ok(part&&part.type==='text');return JSON.parse(part.text);}
async function token(body:Record<string,string>){return json(await fetch(base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body),signal:AbortSignal.timeout(15000)}));}
async function deleteFixture(){const page=await browser.request('/account/delete');if(page.status!==200)return false;return(await browser.form('/account/delete',{_csrf:csrf(await page.text()),confirm:'DELETE'})).status===303;}
try{
 const health=await json(await fetch(base+'/health',{signal:AbortSignal.timeout(15000)}));assert.equal(health.version,process.env.BRAIN_EXPECTED_VERSION??'3.1.1','Deploy the current continuity release before public acceptance.');receipt.server_version=health.version;
 const page=await browser.request('/signup');assert.equal(page.status,200);assert.equal((await browser.form('/signup',{_csrf:csrf(await page.text()),email,password,age_confirm:'yes'})).status,303);created=true;
 const initial=await json(await browser.request('/account/export'));assert.equal(initial.ai_access.state,'pending');userId=initial.account.id;assert.match(userId,/^[0-9a-f-]{36}$/i);const brain=initial.brains[0].id;
 const registered=await json(await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Synthetic same-voice continuity acceptance',redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})}),201);clientId=registered.client_id;
 const verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url'),state=randomBytes(24).toString('base64url');
 const params={client_id:clientId,redirect_uri:redirect,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'brain:read brain:write',resource,state};
 const consent=await browser.request('/authorize?'+new URLSearchParams(params));assert.equal(consent.status,200);const approved=await browser.form('/authorize',{...params,_csrf:csrf(await consent.text()),agent_label:'maya',decision:'approve'});assert.equal(approved.status,303);
 const location=new URL(approved.headers.get('location')!);assert.equal(location.searchParams.get('state'),state);const issued=await token({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirect,code:location.searchParams.get('code')!,code_verifier:verifier,resource});
 const a=await connect(issued.access_token);assert.equal((await a.listTools()).tools.length,29);
 stage='saved conversation';
 const project=await call(a,'project_create',{title:'Same voice continuity verification',goal:'Continue the synthetic welcome draft on the next call.',allowed_agents:['maya'],request_id:randomUUID()});
 const projectPath='/dashboard/projects/'+project.id+'?brain='+brain,ownerPage=await browser.request(projectPath);assert.equal(ownerPage.status,200);
 assert.equal((await browser.form('/dashboard/projects/'+project.id+'/items?brain='+brain,{_csrf:csrf(await ownerPage.text()),expected_version:String(project.version),type:'constraint',title:'Welcome length limit',content:'The welcome must contain at most 50 words.',confirm:'yes',request_id:randomUUID()})).status,303);
 const brief=await call(a,'project_brief',{project_id:project.id}),constraint=brief.items.find((item:any)=>item.type==='constraint');assert.ok(constraint&&constraint.confirmation==='confirmed');
 const question=await call(a,'project_add_item',{project_id:project.id,expected_version:brief.project.version,type:'question',title:'Welcome tone',content:'Should the welcome be formal or casual?',request_id:randomUUID()});
 const task=await call(a,'project_add_item',{project_id:project.id,expected_version:question.project.version,type:'task',title:'Next step: write the welcome',content:'Continue the welcome draft next call after resolving the tone question.',depends_on:[constraint.id],request_id:randomUUID()});
 const goodbye=await call(a,'end_session');assert.equal(goodbye.closed,true);await a.close();
 const probe=await connect(issued.access_token),failed=await probe.callTool({name:'job_status',arguments:{job_id:randomUUID()}},{timeout:30000});assert.ok(failed.isError);
 const probeSession=(await db.query('SELECT id,resume_count FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND closed_at IS NULL ORDER BY started_at DESC LIMIT 1',[userId,brain])).rows[0];assert.equal(Number(probeSession.resume_count),0);
 const recovered=await call(probe,'resume');assert.equal(recovered.resume_count,1);assert.equal(recovered.project.id,project.id);await call(probe,'end_session');await probe.close();
 check('failed first tool call records no delivery; successful explicit resume records exactly one');
 const nightlySummary='The overnight review found one new theme. This is a synthetic saved review, not a confirmed fact.';
 await db.query("INSERT INTO snapshots(user_id,brain_id,agent_label,title,content,kind,visibility,to_agents,source_refs) VALUES($1,$2,'brain-nightly','Synthetic overnight changes',$3,'diff','restricted',ARRAY['maya'],$4)",[userId,brain,JSON.stringify({schema:'brain_formulation_diff',schema_version:'1.0',generated_at:new Date().toISOString(),spoken_summary:nightlySummary}),JSON.stringify([{collection:'projects',id:project.id}])]);

 stage='fresh client without IDs';
 const b=await connect(issued.access_token),first=await call(b,'whoami');assert.ok(first.continuity&&first.briefing);const continuity=first.continuity;assert.equal(continuity.project.id,project.id);assert.equal(continuity.project.version,task.project.version);assert.match(JSON.stringify(continuity.project.confirmed_constraints),/50 words/);assert.match(JSON.stringify(continuity.project.open_questions),/formal or casual/);assert.match(JSON.stringify(continuity.project.unfinished_tasks),/write the welcome/);assert.ok(continuity.previous_session);
 check('same voice and same grant reconnect recover unchanged saved work without a project ID');
 assert.equal(continuity.nightly_update?.summary,nightlySummary);assert.match(first.briefing,/overnight/i);check('first touch includes the authorized saved overnight diff as a labeled review');
 const repeated=await call(b,'resume');assert.equal(repeated.project.id,project.id);assert.ok(repeated.saved_context);assert.equal(repeated.nightly_update?.summary,nightlySummary);check('explicit resume restores saved context within an active session');
 stage='latest correction';
 const proposed=await call(b,'project_update_item',{project_id:project.id,expected_version:repeated.project.version,item_id:constraint.id,content:'The welcome must contain at most 30 words.',reason:'Synthetic owner asks for a shorter welcome.',request_id:randomUUID()});
 const review=await browser.request(projectPath);assert.equal(review.status,200);assert.equal((await browser.form('/dashboard/projects/'+project.id+'/items/'+constraint.id+'/review?brain='+brain,{_csrf:csrf(await review.text()),expected_version:String(proposed.project.version),decision:'approve',reason:'Approve the synthetic correction.',request_id:randomUUID()})).status,303);
 const corrected=await call(b,'resume');assert.match(JSON.stringify(corrected.project.confirmed_constraints),/30 words/);assert.ok(!JSON.stringify(corrected.project.confirmed_constraints).includes('50 words'));check('latest owner-confirmed correction takes precedence over prior call context');
 stage='refresh and idle continuity';
 // Touch only this disposable account's current session; never alter real accounts.
 await db.query("UPDATE brain_sessions SET last_activity_at=now()-interval '31 minutes' WHERE user_id=$1 AND brain_id=$2 AND closed_at IS NULL",[userId,brain]);
 const refreshed=await token({grant_type:'refresh_token',client_id:clientId,refresh_token:issued.refresh_token,resource});const c=await connect(refreshed.access_token),afterRefresh=await call(c,'whoami');assert.equal(afterRefresh.continuity.project.id,project.id);assert.match(JSON.stringify(afterRefresh.continuity.project.confirmed_constraints),/30 words/);check('same-grant refresh and idle gap retain continuity');
 const exported=await json(await browser.request('/account/export'));for(const key of ['usage','usage_reservations','jobs'])assert.equal(exported[key].length,0,'Memory-only continuity must not incur AI work or usage.');
 const current=(await db.query("SELECT ai_access_state FROM users WHERE id=$1 AND email=$2",[userId,email])).rows[0];assert.equal(current.ai_access_state,'pending');
 deleted=await deleteFixture();assert.equal(deleted,true);assert.equal((await db.query('SELECT id FROM users WHERE id=$1',[userId])).rowCount,0);check('memory-only fixture deleted with zero provider usage');
 receipt.passed=true;
}catch{receipt.passed=false;receipt.failed_stage=stage;process.exitCode=1;console.log('FAIL continuity acceptance at '+stage);}
finally{
 await Promise.allSettled(clients.map(client=>client.close()));
 if(created&&!deleted)deleted=await deleteFixture().catch(()=>false);
 receipt.fixture_cleanup_verified=created?deleted&&(await db.query('SELECT id FROM users WHERE email=$1',[email])).rowCount===0:true;
 if(clientId)await db.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);
 await db.end();console.log(JSON.stringify({event:'continuity_verification_receipt',...receipt}));
 if(process.env.CONTINUITY_RECEIPT_PATH){await mkdir(dirname(process.env.CONTINUITY_RECEIPT_PATH),{recursive:true});await writeFile(process.env.CONTINUITY_RECEIPT_PATH,JSON.stringify(receipt,null,2)+'\n');}
}
