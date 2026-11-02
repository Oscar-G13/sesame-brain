import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir,writeFile,access,symlink,rename,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { app } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { migrate } from '../scripts/migrate.js';
import { hashToken } from '../src/oauth/security.js';
import { config } from '../src/config.js';
import { aiConfig } from '../src/brain/config.js';
let server:Server,base:string;
const uid=randomUUID(),foreignUid=randomUUID(),a=randomUUID(),b=randomUUID(),foreign=randomUUID(),noteA=randomUUID(),noteB=randomUUID(),noteForeign=randomUUID(),jobA=randomUUID(),jobB=randomUUID(),jobForeign=randomUUID(),clientId='dashboard-'+randomUUID(),grant=randomUUID();
class Browser {
 cookies=new Map<string,string>();
 constructor(token?:string){if(token)this.cookies.set(config.production?'__Host-brain_session':'brain_session',token);}
 async get(path:string){return this.request(path);}
 async request(path:string,init:RequestInit={}){const headers=new Headers(init.headers);headers.set('cookie',[...this.cookies].map(([k,v])=>k+'='+v).join('; '));const response=await fetch(base+path,{...init,headers,redirect:'manual'});for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');this.cookies.set(pair.slice(0,at),pair.slice(at+1));}return response;}
 async form(path:string,data:Record<string,string>){return this.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:config.baseUrl},body:new URLSearchParams(data)});}
}
let browser:Browser;
const csrf=(html:string)=>{const found=html.match(/name="_csrf" value="([^"]+)"/);assert.ok(found);return found[1];};
before(async()=>{
 await migrate();
 await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'preserved-fixture-hash'),($3,$4,'foreign-fixture-hash')",[uid,'dashboard-'+uid+'@example.invalid',foreignUid,'dashboard-'+foreignUid+'@example.invalid']);
 await pool.query("INSERT INTO brains(id,user_id,name) VALUES($1,$2,'default'),($3,$2,'Writing'),($4,$5,'default')",[a,uid,b,foreign,foreignUid]);
 await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr',$2)",[clientId,{client_name:'Dashboard fixture',redirect_uris:['https://client.example/callback']}]);
 await pool.query("INSERT INTO grants(id,user_id,brain_id,agent_label,client_id,scope,resource) VALUES($1,$2,$3,'maya',$4,'brain:read brain:write',$5)",[grant,uid,a,clientId,config.resource]);
 const token=randomBytes(32).toString('base64url');await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')",[uid,hashToken(token)]);browser=new Browser(token);
 for(const [id,user,brain,text] of [[noteA,uid,a,'A-private-memory'],[noteB,uid,b,'B-private-memory'],[noteForeign,foreignUid,foreign,'FOREIGN-PRIVATE-MEMORY']])await pool.query("INSERT INTO notes(id,user_id,brain_id,from_agent,to_agents,text) VALUES($1,$2,$3,'maya','{all}',$4)",[id,user,brain,text]);
 await pool.query("INSERT INTO facts(user_id,brain_id,key,value,updated_by) VALUES($1,$2,'commute',$3,'maya')",[uid,a,'x'.repeat(350)+' search-deep-inside-memory']);
 for(const [id,user,brain,title] of [[jobA,uid,a,'A-background-result'],[jobB,uid,b,'B-background-result'],[jobForeign,foreignUid,foreign,'FOREIGN-PRIVATE-JOB']])await pool.query("INSERT INTO jobs(id,user_id,brain_id,requested_by_agent,task,title,state,content_epoch) VALUES($1,$2,$3,'maya',$4,$4,'queued',0)",[id,user,brain,title]);
 await pool.query("INSERT INTO brain_sessions(user_id,brain_id,agent_label,session_key,content_epoch) VALUES($1,$2,'maya','SECRET-SESSION-KEY',0)",[uid,a]);
 await pool.query("INSERT INTO usage(user_id,brain_id,local_date,model,input_tokens,output_tokens) VALUES($1,$2,(now() AT TIME ZONE 'America/Los_Angeles')::date,'fixture-model',100,20)",[uid,a]);
 await pool.query("INSERT INTO usage_reservations(user_id,brain_id,local_date,model,reserved_tokens) VALUES($1,$2,current_date,'fixture-model',50)",[uid,a]);
 await pool.query("INSERT INTO nightly_runs(user_id,brain_id,local_date,state,content_epoch) VALUES($1,$2,current_date,'done',0)",[uid,a]);
 server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[uid,foreignUid]]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);await pool.end();});
test('dashboard requires login and the default form returns to the dashboard',async()=>{
 const response=await new Browser().get('/dashboard');assert.equal(response.status,302);assert.ok(response.headers.get('location')?.includes('/login?next='));
 const login=await new Browser().get('/login');assert.ok((await login.text()).includes('name="next" value="/dashboard"'));
});
test('every dashboard collection and detail is scoped to the chosen owned brain',async()=>{
 const overview=await browser.get('/dashboard?brain='+a);assert.equal(overview.status,200);const text=await overview.text();assert.ok(text.includes('A-private-memory'));assert.ok(!text.includes('B-private-memory'));assert.ok(!text.includes('FOREIGN-PRIVATE'));assert.ok(text.includes('Your living projects.'));
 for(const path of ['/dashboard','/dashboard/memory','/dashboard/jobs','/dashboard/insights','/dashboard/usage','/dashboard/think','/dashboard/capture','/dashboard/jobs/new','/dashboard/clear','/dashboard/files'])assert.equal((await browser.get(path+'?brain='+foreign)).status,404,path);
 assert.equal((await browser.get('/dashboard/memory/notes/'+noteB+'?brain='+a)).status,404);assert.equal((await browser.get('/dashboard/memory/notes/'+noteForeign+'?brain='+a)).status,404);
 assert.equal((await browser.get('/dashboard/jobs/'+jobB+'?brain='+a)).status,404);assert.equal((await browser.get('/dashboard/jobs/'+jobForeign+'?brain='+a)).status,404);
 const owned=await browser.get('/dashboard/memory?brain='+b);assert.equal(owned.status,200);const ownedText=await owned.text();assert.ok(ownedText.includes('B-private-memory'));assert.ok(!ownedText.includes('A-private-memory'));
 const search=await browser.get('/dashboard/memory?brain='+a+'&q=search-deep-inside-memory');assert.ok((await search.text()).includes('commute'),'Search includes content beyond preview');
});
test('new export collections omit authentication hashes and internal session keys',async()=>{
 const response=await browser.get('/account/export');assert.equal(response.status,200);const data=await response.json() as Record<string,any>;
 for(const key of ['brain_sessions','jobs','usage','usage_reservations','nightly_runs'])assert.ok(Array.isArray(data[key]),key);
 assert.equal(data.brain_sessions.length,1);assert.ok(!JSON.stringify(data).includes('SECRET-SESSION-KEY'));assert.equal(data.brain_sessions[0].session_key,undefined);assert.equal(data.account.password_hash,undefined);
});
test('capture validates CSRF and saves a real note or fact in only the selected brain',async()=>{
 const response=await browser.get('/dashboard/capture?brain='+b),token=csrf(await response.text());
 assert.equal((await browser.form('/dashboard/capture?brain='+b,{type:'note',text:'A browser note'})).status,403);
 const saved=await browser.form('/dashboard/capture?brain='+b,{type:'fact',key:'browser-fact',text:'A browser detail',_csrf:token});assert.equal(saved.status,303);assert.ok(saved.headers.get('location')?.includes('/dashboard/memory/facts/'));
 assert.equal((await pool.query("SELECT 1 FROM facts WHERE user_id=$1 AND brain_id=$2 AND key='browser-fact'",[uid,b])).rowCount,1);assert.equal((await pool.query("SELECT 1 FROM facts WHERE user_id=$1 AND brain_id=$2 AND key='browser-fact'",[uid,a])).rowCount,0);
});
test('workspace downloads stay inside the selected brain and never follow symbolic links or render HTML',async()=>{
 const directory=join(aiConfig.workspace,uid,a,'0'),otherDirectory=join(aiConfig.workspace,uid,b,'0');await mkdir(directory,{recursive:true});await mkdir(otherDirectory,{recursive:true});
 await writeFile(join(directory,'brief.html'),'<script>unsafe()</script>');await writeFile(join(otherDirectory,'private.txt'),'other brain private file');await symlink(join(otherDirectory,'private.txt'),join(directory,'leak.txt'));
 const list=await browser.get('/dashboard/files?brain='+a);assert.equal(list.status,200);const html=await list.text();assert.ok(html.includes('brief.html'));assert.ok(!html.includes('leak.txt'));
 const file=await browser.get('/dashboard/files/brief.html?brain='+a);assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'application/octet-stream');assert.ok(file.headers.get('content-disposition')?.startsWith('attachment;'));assert.equal(file.headers.get('x-content-type-options'),'nosniff');assert.equal(await file.text(),'<script>unsafe()</script>');
 assert.equal((await browser.get('/dashboard/files/leak.txt?brain='+a)).status,404);assert.equal((await browser.get('/dashboard/files/private.txt?brain='+a)).status,404);assert.equal((await browser.get('/dashboard/files/report..txt?brain='+a)).status,404);assert.equal((await browser.get('/dashboard/files/brief.html?brain='+foreign)).status,404);
 await rename(directory,directory+'-saved');await symlink(otherDirectory,directory);
 try{assert.equal((await browser.get('/dashboard/files/private.txt?brain='+a)).status,404);const empty=await browser.get('/dashboard/files?brain='+a);assert.ok((await empty.text()).includes('Good work can leave something behind.'));}finally{await unlink(directory);await rename(directory+'-saved',directory);}
});

test('stopping background work requires CSRF and the correct owned brain',async()=>{
 const page=await browser.get('/dashboard/jobs/'+jobA+'?brain='+a);assert.equal(page.status,200);const token=csrf(await page.text());
 assert.equal((await browser.form('/dashboard/jobs/'+jobA+'/cancel?brain='+a,{})).status,403);
 assert.equal((await browser.form('/dashboard/jobs/'+jobForeign+'/cancel?brain='+a,{_csrf:token})).status,404);
 assert.equal((await browser.form('/dashboard/jobs/'+jobB+'/cancel?brain='+a,{_csrf:token})).status,404);
 assert.equal((await browser.form('/dashboard/jobs/'+jobA+'/cancel?brain='+a,{_csrf:token})).status,303);
 const cancelled=(await pool.query('SELECT state,error FROM jobs WHERE user_id=$1 AND brain_id=$2 AND id=$3',[uid,a,jobA])).rows[0];assert.equal(cancelled.state,'failed');assert.match(cancelled.error,/at your request/);
 assert.equal((await pool.query('SELECT state FROM jobs WHERE id=$1',[jobForeign])).rows[0].state,'queued');
});

test('typed content reset clears selected brain content and workspaces while preserving credentials, sessions and grants',async()=>{
 const directory=join(aiConfig.workspace,uid,a);await mkdir(directory,{recursive:true});await writeFile(join(directory,'saved.txt'),'test workspace content');
 const response=await browser.get('/dashboard/clear?brain='+a),token=csrf(await response.text());
 assert.equal((await browser.form('/dashboard/clear?brain='+a,{confirm:'wrong',_csrf:token})).status,400);assert.equal((await pool.query('SELECT 1 FROM notes WHERE id=$1',[noteA])).rowCount,1);
 assert.equal((await browser.form('/dashboard/clear?brain='+a,{confirm:'CLEAR',_csrf:token})).status,303);
 for(const table of ['notes','facts','snapshots','handoffs','activity','jobs','brain_sessions','usage','usage_reservations','nightly_runs'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table+' WHERE user_id=$1 AND brain_id=$2',[uid,a])).rows[0].n,0,table);
 await assert.rejects(access(directory));assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1',[uid])).rows[0].password_hash,'preserved-fixture-hash');assert.equal((await pool.query('SELECT revoked_at FROM grants WHERE id=$1',[grant])).rows[0].revoked_at,null);assert.equal((await browser.get('/account')).status,200);
 assert.equal((await pool.query('SELECT 1 FROM notes WHERE id=ANY($1::uuid[])',[[noteB,noteForeign]])).rowCount,2,'Other brain and user data survives');
 const empty=await browser.get('/dashboard?brain='+a);assert.equal(empty.status,200);const html=await empty.text();assert.ok(html.includes('What are we moving forward?'));assert.ok(html.includes('Connected'));
});
