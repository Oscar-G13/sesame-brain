import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {once} from 'node:events';
import {app} from '../src/app.js';
import {pool} from '../src/db/index.js';
import {migrate} from '../scripts/migrate.js';
import {hashToken} from '../src/oauth/security.js';
import {authenticateToken} from '../src/oauth/bearer.js';
import {config} from '../src/config.js';
const clientId='account-isolation-'+randomUUID(),users:string[]=[];
before(async()=>{await migrate();await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr',$2)",[clientId,{client_name:'Account isolation fixture',redirect_uris:['https://client.example/cb'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}]);});
after(async()=>{for(const id of users)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);await pool.end();});
async function fixture(){
 const uid=randomUUID(),bid=randomUUID(),gid=randomUUID(),token=randomBytes(32).toString('base64url'),session=randomBytes(32).toString('base64url');
 const nonce=randomBytes(32).toString('base64url'),csrf=nonce+'.'+createHmac('sha256',config.sessionSecret).update(nonce).digest('base64url');
 await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-fixture-only')",[uid,'account-'+uid+'@example.invalid']);users.push(uid);
 await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[bid,uid]);
 await pool.query("INSERT INTO grants(id,user_id,brain_id,agent_label,client_id,scope,resource) VALUES($1,$2,$3,'maya',$4,'brain:read brain:write',$5)",[gid,uid,bid,clientId,config.resource]);
 await pool.query("INSERT INTO access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),gid]);
 await pool.query("INSERT INTO refresh_tokens(token_hash,grant_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '90 days')",[hashToken(randomBytes(32).toString('base64url')),gid,randomUUID()]);
 await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",[uid,hashToken(session)]);
 await pool.query("INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text) VALUES($1,$2,'maya',ARRAY['all'],$3)",[uid,bid,'private-account-'+uid]);
 return {uid,bid,gid,token,csrf,cookie:'brain_session='+session+'; brain_csrf='+csrf};
}
async function digest(uid:string){
 const data:Record<string,unknown>={};
 data.users=(await pool.query('SELECT * FROM users WHERE id=$1',[uid])).rows;
 for(const table of ['brains','sessions','grants','notes','handoffs','facts','snapshots','activity'])data[table]=(await pool.query('SELECT * FROM '+table+' WHERE user_id=$1 ORDER BY id',[uid])).rows;
 for(const table of ['access_tokens','refresh_tokens'])data[table]=(await pool.query('SELECT t.* FROM '+table+' t JOIN grants g ON g.id=t.grant_id WHERE g.user_id=$1 ORDER BY t.token_hash',[uid])).rows;
 return JSON.stringify(data);
}
test('real account session cannot rename/revoke/export/delete another user; own actions succeed',async()=>{
 const a=await fixture(),b=await fixture();const beforeB=await digest(b.uid);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const addr=server.address();assert.ok(addr&&typeof addr!=='string');const base='http://127.0.0.1:'+addr.port;
 const post=(path:string,fields:Record<string,string>,csrf=a.csrf)=>fetch(base+path,{method:'POST',redirect:'manual',headers:{Cookie:a.cookie,Origin:config.baseUrl,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf,...fields})});
 try{
  const csrfDenied=await post('/account/grants/'+b.gid+'/revoke',{},'wrong-csrf');assert.equal(csrfDenied.status,403);
  assert.equal((await post('/account/grants/'+b.gid+'/rename',{agent_label:'charlie'})).status,303);
  assert.equal((await post('/account/grants/'+b.gid+'/revoke',{})).status,303);
  assert.equal(await digest(b.uid),beforeB,'foreign account mutation attempts must leave every B row unchanged');
  const exported=await fetch(base+'/account/export',{headers:{Cookie:a.cookie}});assert.equal(exported.status,200);
  const body=await exported.json() as {account:{id:string};notes:{text:string}[];connections:{id:string}[]};
  assert.equal(body.account.id,a.uid);assert.ok(body.notes.some(row=>row.text==='private-account-'+a.uid));
  assert.ok(!JSON.stringify(body).includes(b.uid));assert.ok(!body.connections.some(row=>row.id===b.gid));
  assert.equal((await post('/account/grants/'+a.gid+'/rename',{agent_label:'charlie'})).status,303);
  assert.equal((await authenticateToken(a.token))?.agent_label,'charlie');
  assert.equal((await post('/account/grants/'+a.gid+'/revoke',{})).status,303);assert.equal(await authenticateToken(a.token),null);
  assert.equal((await post('/account/delete',{confirm:'wrong'})).status,400);
  assert.equal((await pool.query('SELECT 1 FROM users WHERE id=$1',[a.uid])).rowCount,1);
  assert.equal((await post('/account/delete',{confirm:'DELETE'})).status,303);
  for(const table of ['users','brains','sessions','grants','notes','handoffs','facts','snapshots','activity']){
   const field=table==='users'?'id':'user_id';
   assert.equal((await pool.query('SELECT 1 FROM '+table+' WHERE '+field+'=$1',[a.uid])).rowCount,0,table+' must cascade after deletion');
  }
  const stale=await fetch(base+'/account',{redirect:'manual',headers:{Cookie:a.cookie}});assert.equal(stale.status,302);assert.ok(stale.headers.get('location')?.startsWith('/login'));
  assert.equal(await digest(b.uid),beforeB,'deleting A must preserve B account, sessions, credentials, grants and content');
  assert.equal((await authenticateToken(b.token))?.user_id,b.uid);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
