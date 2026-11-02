import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,access as fsAccess } from 'node:fs/promises';
import { join } from 'node:path';
import { aiConfig } from '../src/brain/config.js';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { migrate } from '../scripts/migrate.js';
import { config } from '../src/config.js';
import { hashToken, pkceChallenge } from '../src/oauth/security.js';
import { authenticateToken } from '../src/oauth/bearer.js';
import type { Server } from 'node:http';
let server:Server,base:string;
const users:string[]=[],clientId='web-security-'+randomUUID();
before(async()=>{
 await migrate();
 await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr',$2)",[clientId,{client_name:'Web security fixture',redirect_uris:['https://client.example/cb']}]);
 server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));for(const user of users)await pool.query('DELETE FROM users WHERE id=$1',[user]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);await pool.end();});
class Browser {
 cookies=new Map<string,string>();
 async get(path:string){return this.request(path);}
 async request(path:string,init:RequestInit={}){
  const headers=new Headers(init.headers);headers.set('cookie',[...this.cookies].map(([k,v])=>k+'='+v).join('; '));
  const res=await fetch(base+path,{...init,headers,redirect:'manual'});
  for(const value of res.headers.getSetCookie()){const pair=value.split(';')[0],at=pair.indexOf('=');if(/max-age=0/i.test(value))this.cookies.delete(pair.slice(0,at));else this.cookies.set(pair.slice(0,at),pair.slice(at+1));}return res;
 }
 async form(path:string,data:Record<string,string>){return this.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:config.baseUrl},body:new URLSearchParams(data)});}
}
function csrf(html:string){const found=html.match(/name="_csrf" value="([^"]+)"/);assert.ok(found);return found[1];}
async function pendingCode(uid:string,bid:string){const code=hashToken(randomBytes(32).toString('base64url'));await pool.query("INSERT INTO auth_codes(code_hash,client_id,user_id,brain_id,agent_label,redirect_uri,code_challenge,scope,resource,expires_at) VALUES($1,$2,$3,$4,'maya','https://client.example/cb',$5,'brain:read brain:write',$6,now()+interval '10 minutes')",[code,clientId,uid,bid,pkceChallenge(randomBytes(32).toString('base64url')),config.resource]);return code;}
test('account forms enforce CSRF, update grant identity, invalidate pending codes, revoke sessions, and delete live data',async()=>{
 const browser=new Browser(),email='web-security-'+randomUUID()+'@example.invalid',password='Original private password '+randomUUID(),newPassword='Changed private password '+randomUUID();
 let html=await(await browser.get('/signup')).text();
 assert.equal((await browser.form('/signup',{email,password,age_confirm:'yes'})).status,403);
 assert.equal((await browser.form('/signup',{email,password,age_confirm:'yes',_csrf:csrf(html)})).status,303);
 const user=(await pool.query('SELECT id FROM users WHERE email=$1',[email])).rows[0].id as string;users.push(user);
 const brain=(await pool.query('SELECT id FROM brains WHERE user_id=$1',[user])).rows[0].id as string;
 const grant=(await pool.query("INSERT INTO grants(user_id,brain_id,agent_label,client_id,scope,resource) VALUES($1,$2,'maya',$3,'brain:read brain:write',$4) RETURNING id",[user,brain,clientId,config.resource])).rows[0].id as string;
 const access=randomBytes(32).toString('base64url');await pool.query("INSERT INTO access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(access),grant]);
 html=await(await browser.get('/account')).text();assert.ok(html.includes('maya'));
 assert.equal((await browser.form('/account/grants/'+grant+'/rename',{agent_label:'claude',_csrf:csrf(html)})).status,303);assert.equal((await authenticateToken(access))?.agent_label,'claude');
 const unused=await pendingCode(user,brain);
 html=await(await browser.get('/account/password')).text();
 assert.equal((await browser.form('/account/password',{current_password:password,password:newPassword,_csrf:csrf(html)})).status,303);
 assert.equal((await pool.query('SELECT 1 FROM auth_codes WHERE code_hash=$1',[unused])).rowCount,0,'Password change kills unused codes');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[user])).rows[0].n,1,'Only replacement browser session remains');
 const unusedAfterPassword=await pendingCode(user,brain);
 html=await(await browser.get('/account')).text();
 assert.equal((await browser.form('/account/signout-everywhere',{_csrf:csrf(html)})).status,303);
 assert.equal((await pool.query('SELECT 1 FROM auth_codes WHERE code_hash=$1',[unusedAfterPassword])).rowCount,0);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[user])).rows[0].n,0);assert.equal(await authenticateToken(access),null);
 html=await(await browser.get('/login')).text();assert.equal((await browser.form('/login',{email,password:newPassword,_csrf:csrf(html)})).status,303);
 const exported=await(await browser.get('/account/export')).json() as {account:{email:string},connections:unknown[]};assert.equal(exported.account.email,email);assert.equal(exported.connections.length,1);
 const userWorkspace=join(aiConfig.workspace,user,brain,'0');await mkdir(userWorkspace,{recursive:true});await writeFile(join(userWorkspace,'retained.txt'),'Private workspace test');
 html=await(await browser.get('/account/delete')).text();assert.equal((await browser.form('/account/delete',{confirm:'DELETE'})).status,403);assert.equal((await browser.form('/account/delete',{confirm:'wrong',_csrf:csrf(html)})).status,400);assert.equal((await pool.query('SELECT 1 FROM users WHERE id=$1',[user])).rowCount,1);
 assert.equal((await browser.form('/account/delete',{confirm:'DELETE',_csrf:csrf(html)})).status,303);await assert.rejects(fsAccess(join(aiConfig.workspace,user)));
 for(const table of ['users','brains','sessions','auth_codes','grants','notes','handoffs','facts','snapshots','activity'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${table==='users'?'id':'user_id'}=$1`,[user])).rows[0].n,0,table);
});
