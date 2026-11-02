import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {writeFile,mkdir} from 'node:fs/promises';
import argon2 from 'argon2';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {app} from '../src/app.js';
import {pool} from '../src/db/index.js';
import {migrate} from './migrate.js';
import {config} from '../src/config.js';
import {aiConfig} from '../src/brain/config.js';
import {hashToken} from '../src/oauth/security.js';
import {validateModels} from '../src/brain/provider.js';
import {runNextJob,asWebAuth} from '../src/brain/engine.js';
import {getProject} from '../src/projects/service.js';
import {removeUserWorkspaces} from '../src/brain/purge.js';

// This script is deliberately unable to target the production database.
const database=new URL(process.env.DATABASE_URL??'postgres://invalid/invalid');
if(process.env.NODE_ENV!=='test'||database.hostname!=='testdb'||database.pathname!=='/brain_test')throw new Error('Use only the isolated testdb/brain_test database.');
if(!process.argv.includes('--confirm-paid'))throw new Error('Pass --confirm-paid to authorize bounded real-provider verification using a disposable account.');
if(!aiConfig.ready)throw new Error('Configured Anthropic access is required.');
const user=randomUUID(),brain=randomUUID(),clientId='v3-live-'+randomUUID(),email='v3-live-'+user+'@example.invalid',password=randomBytes(32).toString('base64url');
const tokens=new Map(['maya','charlie'].map(label=>[label,{grant:randomUUID(),token:randomBytes(32).toString('base64url')}]));
const evidence:Record<string,unknown>={at:new Date().toISOString(),database:'isolated testdb/brain_test',synthetic_only:true,native_iphone_test:'pending',backups:'deferred by owner; no backup performed',checks:[]};
const clients:Client[]=[];let server:ReturnType<typeof app.listen>|undefined,base='',seeded=false,stage='setup';
function record(check:string,data:Record<string,unknown>={}){const result={check,...data};(evidence.checks as unknown[]).push(result);console.log(JSON.stringify(result));}
class Browser{
 cookies=new Map<string,string>();
 async request(path:string,init:RequestInit={}){
  const headers=new Headers(init.headers);if(this.cookies.size)headers.set('cookie',[...this.cookies].map(([k,v])=>k+'='+v).join('; '));
  const response=await fetch(base+path,{...init,headers,redirect:'manual',signal:AbortSignal.timeout(20000)});
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');if(/max-age=0/i.test(cookie))this.cookies.delete(pair.slice(0,at));else this.cookies.set(pair.slice(0,at),pair.slice(at+1));}
  return response;
 }
 form(path:string,data:Record<string,string>){return this.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:config.baseUrl},body:new URLSearchParams(data)});}
}
function csrf(html:string){const value=html.match(/name="_csrf" value="([^"]+)"/);assert.ok(value,'Owner form must include a CSRF token.');return value[1].replaceAll('&amp;','&');}
async function call(client:Client,name:string,args:Record<string,unknown>={}){
 const start=Date.now(),result=await client.callTool({name,arguments:args},{timeout:60000});
 assert.ok(!result.isError,'MCP operation must succeed: '+name);const part=result.content.find(c=>c.type==='text');assert.ok(part&&part.type==='text','MCP response must include JSON.');
 const data=JSON.parse(part.text);assert.equal(typeof data.trailer,'string','MCP response must include its trailer.');return{data,ms:Date.now()-start};
}
try{
 await migrate();const models=await validateModels();evidence.models=models;assert.ok(models.models.length>0&&models.models.every(model=>model.available),'Configured provider models must be available.');
 await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,$3,'approved')",[user,email,await argon2.hash(password)]);seeded=true;
 await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[brain,user]);await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr','{}')",[clientId]);
 for(const [label,entry] of tokens){await pool.query("INSERT INTO grants(id,user_id,brain_id,client_id,agent_label,scope,resource) VALUES($1,$2,$3,$4,$5,'brain:read brain:write',$6)",[entry.grant,user,brain,clientId,label,config.resource]);await pool.query("INSERT INTO access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(entry.token),entry.grant]);}
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');base='http://127.0.0.1:'+address.port;
 for(const [,entry] of tokens){const client=new Client({name:'Brain v3 isolated verification',version:'3.0.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+entry.token}}}));}
 const [maya,charlie]=clients;assert.equal((await maya.listTools()).tools.length,29);record('public MCP discovery',{tools:28});
 const browser=new Browser(),login=await browser.request('/login');assert.equal(login.status,200);
 assert.equal((await browser.form('/login',{_csrf:csrf(await login.text()),email,password})).status,303,'Owner login must succeed.');
 const session=(await pool.query('SELECT id FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[user])).rows[0];assert.ok(session,'Owner session must exist.');
 const owner=await asWebAuth(user,brain,session.id);
 stage='project creation and owner confirmation';const created=(await call(maya,'project_create',{title:'Synthetic welcome project',goal:'Create a short welcome for a new shared notebook. Use only synthetic information.',allowed_agents:['maya','charlie'],request_id:randomUUID()})).data;
 let current=await getProject(owner,created.id);const path='/dashboard/projects/'+created.id+'?brain='+brain;
 const page=await browser.request(path);assert.equal(page.status,200);let formCsrf=csrf(await page.text());
 assert.equal((await browser.form('/dashboard/projects/'+created.id+'/items?brain='+brain,{_csrf:formCsrf,expected_version:String(current.project.version),type:'constraint',title:'Welcome draft length',content:'The welcome draft must contain at most 50 words.',confirm:'yes',request_id:randomUUID()})).status,303,'Owner must be able to confirm a constraint.');
 current=await getProject(owner,created.id);const constraint=current.items.find(item=>item.type==='constraint');assert.ok(constraint&&constraint.confirmation==='confirmed','Constraint must be owner-confirmed.');
 const added=(await call(maya,'project_add_item',{project_id:created.id,expected_version:current.project.version,type:'task',title:'Draft the welcome',content:'Write a two-sentence welcome within the confirmed length limit.',depends_on:[constraint.id],source_type:'assistant_summary',source_refs:[{kind:'statement',label:'Synthetic acceptance scenario'}],request_id:randomUUID()})).data;
 const task=added.items.find((item:any)=>item.type==='task');assert.ok(task,'Dependent task must exist.');
 const before=(await call(charlie,'project_brief',{project_id:created.id})).data;assert.ok(before.items.some((item:any)=>item.id===constraint.id),'Charlie must retrieve the owner-confirmed constraint.');
 stage='proposal and owner approval';const proposed=(await call(maya,'project_update_item',{project_id:created.id,expected_version:added.project.version,item_id:constraint.id,content:'The welcome draft must contain at most 30 words.',reason:'Synthetic user requests a shorter welcome; owner must review this proposed correction.',source_refs:[{kind:'statement',label:'Synthetic correction; not a transcript quote'}],request_id:randomUUID()})).data;
 const pending=proposed.items.find((item:any)=>item.id===constraint.id);assert.equal(pending.content,constraint.content,'An assistant must not overwrite confirmed content.');assert.ok(pending.pending_change,'An assistant correction must await owner review.');
 const review=await browser.request(path);assert.equal(review.status,200);formCsrf=csrf(await review.text());
 assert.equal((await browser.form('/dashboard/projects/'+created.id+'/items/'+constraint.id+'/review?brain='+brain,{_csrf:formCsrf,expected_version:String(proposed.project.version),decision:'approve',reason:'Approve the synthetic correction.',request_id:randomUUID()})).status,303,'Owner must approve the proposed correction.');
 current=await getProject(owner,created.id);assert.equal(current.items.find(item=>item.id===constraint.id)?.content,'The welcome draft must contain at most 30 words.');assert.equal(current.items.find(item=>item.id===task.id)?.needs_review,true,'Dependent work must be flagged after a constraint changes.');
 const updated=(await call(charlie,'project_brief',{project_id:created.id,since_version:before.project.version})).data;assert.ok(updated.changed&&updated.items.some((item:any)=>item.id===task.id&&item.needs_review),'Charlie must receive the changed constraint and dependency review flag.');
 const history=(await call(charlie,'project_history',{project_id:created.id})).data;for(const kind of ['change_proposed','change_approved'])assert.ok(history.events.some((event:any)=>event.kind===kind),'Project history must retain proposal and approval evidence.');
 record('confirmed constraint, proposed correction, owner approval and dependent review',{cross_assistant:true});
 stage='real provider project work';const job=(await call(maya,'do',{task:'Write a warm two-sentence welcome for a new shared notebook. Follow the current confirmed project constraints; the whole final answer must be at most 30 words. Use synthetic information only. Do not browse, execute code, create files, store extra memory, or contact anyone. Return only the welcome draft.',deliver:'brain',project_id:created.id,project_item_id:task.id})).data;
 assert.ok(job.job_id,'Project work must be acknowledged immediately.');assert.ok(await runNextJob({user_id:user,brain_id:brain}),'The isolated worker must claim the synthetic job.');
 const status=(await call(maya,'job_status',{job_id:job.job_id})).data;assert.equal(status.state,'done','Real provider project work must complete.');assert.ok(status.result_note_id,'Completed work must leave a result note.');
 current=await getProject(owner,created.id);const artifact=current.items.find(item=>item.type==='artifact'&&item.source_refs.some(ref=>ref.kind==='job'&&ref.id===job.job_id));assert.ok(artifact,'Completion must atomically attach a project artifact.');assert.equal(artifact.source_type,'tool_result');assert.equal(artifact.confirmation,'proposed','Model output must not become owner-confirmed fact.');assert.ok(current.links.some(link=>link.from_item_id===artifact.id&&link.to_item_id===constraint.id),'Artifact must depend on the confirmed constraint.');assert.ok(current.links.some(link=>link.from_item_id===artifact.id&&link.to_item_id===task.id),'Artifact must remain linked to the requested task.');
 const words=artifact.content.trim().split(/\s+/).length;assert.ok(words<=30,'The real draft must respect the confirmed word limit.');
 stage='artifact receipts';for(const client of [maya,charlie])await call(client,'project_brief',{project_id:created.id,item_ids:[constraint.id,task.id,artifact.id]});
 current=await getProject(owner,created.id);for(const label of ['maya','charlie'])assert.ok(current.receipts.some(receipt=>receipt.agent_label===label&&receipt.last_seen_version===current.project.version),'Both assistants must have retrieval receipts for the current project version.');
 const rows=(await pool.query('SELECT audience,source_audience,visibility FROM jobs WHERE id=$1 AND user_id=$2 AND brain_id=$3',[job.job_id,user,brain])).rows[0];assert.ok(!rows.audience.includes('all')&&rows.audience.every((label:string)=>['maya','charlie'].includes(label)),'Project output must retain its restricted audience.');
 record('real provider project artifact and Maya/Charlie retrieval receipts',{draft_words:words,artifact_proposed:true,audience_restricted:true});
 evidence.usage=(await pool.query('SELECT model,sum(input_tokens)::bigint AS input_tokens,sum(output_tokens)::bigint AS output_tokens FROM usage WHERE user_id=$1 AND brain_id=$2 GROUP BY model',[user,brain])).rows;evidence.passed=true;
}catch{evidence.passed=false;evidence.failure='A v3 synthetic acceptance assertion failed. No credentials or content are included in this receipt.';evidence.failed_stage=stage;process.exitCode=1;record('failure');}
finally{
 await Promise.allSettled(clients.map(client=>client.close()));if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
 if(seeded){await removeUserWorkspaces(user);await pool.query('DELETE FROM users WHERE id=$1',[user]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);evidence.disposable_account_deleted=!(await pool.query('SELECT id FROM users WHERE id=$1',[user])).rowCount;}
 await mkdir('evidence',{recursive:true});await writeFile('evidence/v3-live-models.json',JSON.stringify(evidence,null,2)+'\n');await pool.end();
}
