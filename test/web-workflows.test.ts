import {before,after,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {app} from '../src/app.js';
import {pool} from '../src/db/index.js';
import {migrate} from '../scripts/migrate.js';
import {hashToken} from '../src/oauth/security.js';
import {config} from '../src/config.js';
import {aiConfig} from '../src/brain/config.js';
import {setModelTransportForTests,type ModelResult} from '../src/brain/provider.js';
import {runNightlyBrain,validateFormulation,type NightlyDependencies} from '../src/brain/nightly.js';
import {formulationFixture} from './fixtures/web-formulation.js';
import {asWebAuth} from '../src/brain/engine.js';
import {getProject,updateItem} from '../src/projects/service.js';
let server:Server,base:string;const users:string[]=[],clients:string[]=[];
class Browser{
 cookies=new Map<string,string>();constructor(token:string){this.cookies.set(config.production?'__Host-brain_session':'brain_session',token);}
 async request(path:string,init:RequestInit={}){const headers=new Headers(init.headers);headers.set('cookie',[...this.cookies].map(([key,value])=>key+'='+value).join('; '));const response=await fetch(base+path,{...init,headers,redirect:'manual'});for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');this.cookies.set(pair.slice(0,at),pair.slice(at+1));}return response;}
 get(path:string){return this.request(path);}
 form(path:string,data:Record<string,string>){return this.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:config.baseUrl},body:new URLSearchParams(data)});}
}
const csrf=(html:string)=>{const token=html.match(/name="_csrf" value="([^"]+)"/);assert.ok(token);return token[1];};
const response=(text:string):ModelResult=>({text,inputTokens:40,outputTokens:20,model:aiConfig.quickModel,content:[{type:'text',text}],stopReason:'end_turn',incomplete:false});
before(async()=>{await migrate();server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as {port:number}).port;});
afterEach(()=>setModelTransportForTests(undefined));
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));for(const user of users)await pool.query('DELETE FROM users WHERE id=$1',[user]);for(const client of clients)await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[client]);await pool.end();});
async function fixture(approved=true){const user=randomUUID(),brain=randomUUID(),session=randomUUID(),token=randomBytes(32).toString('base64url');users.push(user);await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,'fixture',$3)",[user,user+'@web-workflows.invalid',approved?'approved':'pending']);await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[brain,user]);await pool.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[session,user,hashToken(token)]);return{user,brain,session,browser:new Browser(token)};}
test('authenticated Think form creates a real brain session, calls the model and records this check-in',async()=>{
 const f=await fixture();await pool.query("INSERT INTO facts(user_id,brain_id,key,value,updated_by) VALUES($1,$2,'preferred drink','tea','you')",[f.user,f.brain]);
 let calls=0;setModelTransportForTests(async request=>{calls++;assert.ok(JSON.stringify(request.messages).includes('tea'));return response('I remember that you prefer tea.');});
 const form=await f.browser.get('/dashboard/think?brain='+f.brain);assert.equal(form.status,200);const token=csrf(await form.text());
 assert.equal((await f.browser.form('/dashboard/think?brain='+f.brain,{text:'What drink do I prefer?',depth:'quick'})).status,403);
 const answered=await f.browser.form('/dashboard/think?brain='+f.brain,{_csrf:token,text:'What drink do I prefer?',depth:'quick'});assert.equal(answered.status,200);assert.match(await answered.text(),/I remember that you prefer tea/);assert.ok(calls>0);
 const sessions=(await pool.query("SELECT id,browser_session_id,think_count FROM brain_sessions WHERE user_id=$1 AND brain_id=$2 AND agent_label='you'",[f.user,f.brain])).rows;assert.equal(sessions.length,1);assert.notEqual(sessions[0].id,f.session);assert.equal(sessions[0].browser_session_id,f.session);assert.equal(Number(sessions[0].think_count),1);
 const second=await f.browser.form('/dashboard/think?brain='+f.brain,{_csrf:token,text:'And what do you remember?',depth:'quick'});assert.equal(second.status,200);assert.equal((await pool.query('SELECT count(*)::int AS n FROM brain_sessions WHERE user_id=$1',[f.user])).rows[0].n,1);
});
test('unapproved accounts cannot submit paid forms but can save a normal memory',async()=>{
 const f=await fixture(false);let calls=0;setModelTransportForTests(async()=>{calls++;return response('Must not run');});
 const token=csrf(await(await f.browser.get('/dashboard/capture?brain='+f.brain)).text());
 assert.equal((await f.browser.form('/dashboard/think?brain='+f.brain,{_csrf:token,text:'Think'})).status,403);assert.equal((await f.browser.form('/dashboard/jobs?brain='+f.brain,{_csrf:token,task:'Work'})).status,403);assert.equal(calls,0);
 assert.equal((await f.browser.form('/dashboard/capture?brain='+f.brain,{_csrf:token,type:'note',text:'A memory without hosted AI'})).status,303);
});
test('actual generated nightly schema is shown as evidence, uncertainty and changes before the raw record',async()=>{
 const f=await fixture(),formulation=validateFormulation(formulationFixture());
 const deps:NightlyDependencies={enabled:()=>true,now:()=>new Date(formulation.generated_at),context:async()=> 'The subject asked for direct answers.',options:{deepModel:'web-fixture-deep',openaiConfigured:false,nightlyHour:3,nightlyTokenBudget:100000},generate:async(_identity,request)=>({text:JSON.stringify(request.system.startsWith('Independently audit')?{schema:'brain_formulation_audit',schema_version:'1.0',generated_at:formulation.generated_at,formulation_generated_at:formulation.generated_at,auditor:{provider:request.provider,model:request.model},flags:[{type:'overreach',item:'Communication preference',why:'One statement is not a universal preference.',treatment:'Keep the interpretation tentative.'}],limitations:['Only saved conversation evidence.']}:formulation),inputTokens:10,outputTokens:20,model:request.model})};
 const generated=await runNightlyBrain({user_id:f.user,brain_id:f.brain},{},deps);assert.equal(generated.state,'done');
 const listing=await f.browser.get('/dashboard/insights?brain='+f.brain);assert.equal(listing.status,200);const listHtml=await listing.text();assert.match(listHtml,/preference for direct communication/);assert.ok(!/class="memory-card[^>]*>[\s\S]*?<p>\{/.test(listHtml));
 const details=await f.browser.get('/dashboard/memory/snapshots/'+generated.snapshot_ids!.formulation+'?brain='+f.brain);assert.equal(details.status,200);const html=await details.text();assert.match(html,/Evidence recorded/);assert.match(html,/Other explanations to consider/);assert.match(html,/direct statement/);assert.match(html,/Questions still open/);assert.ok(html.indexOf('insight-summary')<html.indexOf('raw-record'));
 const audit=await f.browser.get('/dashboard/memory/snapshots/'+generated.snapshot_ids!.audit+'?brain='+f.brain);assert.match(await audit.text(),/Keep the interpretation tentative/);
 const diff=await f.browser.get('/dashboard/memory/snapshots/'+generated.snapshot_ids!.diff+'?brain='+f.brain);assert.match(await diff.text(),/New themes/);
});
test('job detail shows full persisted text beyond its short summary',async()=>{
 const f=await fixture(),id=randomUUID();await pool.query("INSERT INTO jobs(id,user_id,brain_id,requested_by_agent,task,title,state,content_epoch,result_summary,result_text) VALUES($1,$2,$3,'you','A result','A result','done',0,'Short summary','Short summary. Full result includes the final detail FINAL_FULL_RESULT.')",[id,f.user,f.brain]);
 const response=await f.browser.get('/dashboard/jobs/'+id+'?brain='+f.brain);assert.equal(response.status,200);assert.match(await response.text(),/FINAL_FULL_RESULT/);
});

test('project HTTP forms keep provenance, stage assistant corrections, preserve stale drafts and expose scoped live state',async()=>{
 const f=await fixture(),other=await fixture();const token=csrf(await(await f.browser.get('/dashboard/projects/new?brain='+f.brain)).text());
 const created=await f.browser.form('/dashboard/projects?brain='+f.brain,{_csrf:token,title:'A shared trip',goal:'A plan that survives a changed budget',request_id:randomUUID()});assert.equal(created.status,303);const id=new URL(created.headers.get('location')!,base).pathname.split('/').pop()!;
 const owner=await asWebAuth(f.user,f.brain,f.session);let board=await getProject(owner,id);assert.equal(board.project.version,1);
 const add=async(values:Record<string,string>)=>f.browser.form('/dashboard/projects/'+id+'/items?brain='+f.brain,{_csrf:token,expected_version:String(board.project.version),request_id:randomUUID(),...values});
 let saved=await add({type:'constraint',title:'Budget',content:'1000',confirm:'yes'});assert.equal(saved.status,303);board=await getProject(owner,id);const constraint=board.items.find(item=>item.type==='constraint')!;
 saved=await add({type:'task',title:'Choose accommodation',content:'Compare rooms within the budget',depends_on:constraint.id});assert.equal(saved.status,303);board=await getProject(owner,id);const task=board.items.find(item=>item.type==='task')!;
 const client='project-ui-'+randomUUID(),grant=randomUUID();clients.push(client);await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr','{}')",[client]);await pool.query("INSERT INTO grants(id,user_id,brain_id,agent_label,client_id,scope) VALUES($1,$2,$3,'charlie',$4,'brain:read brain:write')",[grant,f.user,f.brain,client]);
 const agent={...owner,agent_label:'charlie',client_id:client,grant_id:grant,browser_session_id:undefined,token_hash:'fixture'};
 const versionBefore=board.project.version;await updateItem(agent,{project_id:id,item_id:constraint.id,expected_version:versionBefore,content:'1200',reason:'The user reported a new budget.'});board=await getProject(owner,id);assert.equal(board.items.find(item=>item.id===constraint.id)!.content,'1000');
 const page=await f.browser.get('/dashboard/projects/'+id+'?brain='+f.brain);assert.equal(page.status,200);const text=await page.text();assert.match(text,/Proposed change/);assert.match(text,/1200/);assert.match(text,/The confirmed text above stays in effect/);
 const state=await f.browser.get('/dashboard/projects/'+id+'/state?brain='+f.brain+'&version='+versionBefore);assert.equal(state.status,200);const update=await state.json() as {changed:boolean,html:string};assert.equal(update.changed,true);assert.match(update.html,/Proposed change/);assert.equal((await other.browser.get('/dashboard/projects/'+id+'?brain='+other.brain)).status,404);
 const stale=await f.browser.form('/dashboard/projects/'+id+'/items/'+constraint.id+'?brain='+f.brain,{_csrf:token,expected_version:String(versionBefore),title:'Budget',content:'My unsaved draft',status:'confirmed',reason:'A stale correction',request_id:randomUUID()});assert.equal(stale.status,409);assert.match(await stale.text(),/My unsaved draft/);
 const approved=await f.browser.form('/dashboard/projects/'+id+'/items/'+constraint.id+'/review?brain='+f.brain,{_csrf:token,expected_version:String(board.project.version),decision:'approve',request_id:randomUUID()});assert.equal(approved.status,303);board=await getProject(owner,id);assert.equal(board.items.find(item=>item.id===constraint.id)!.content,'1200');assert.equal(board.items.find(item=>item.id===task.id)!.needs_review,true);
 assert.equal((await f.browser.form('/dashboard/projects/'+id+'/items/'+task.id+'/review?brain='+f.brain,{expected_version:String(board.project.version),decision:'approve'})).status,403);
});
