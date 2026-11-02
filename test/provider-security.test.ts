import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter,once} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdir,rm,writeFile,symlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import http from 'node:http';
import type https from 'node:https';
import type {lookup} from 'node:dns/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {pool} from '../src/db/index.js';
import {migrate} from '../scripts/migrate.js';
import type {ModelRequest} from '../src/brain/provider.js';
import type {AuthContext} from '../src/tools/service.js';

const base='/tmp/brain-security-'+randomUUID();
process.env.BRAIN_WORKSPACE_DIR=join(base,'workspaces');
process.env.BRAIN_SANDBOX_URL='unix://'+join(base,'runner.sock');
const {aiConfig}=await import('../src/brain/config.js');
const {requestProviderForTests,readAnthropicStream}=await import('../src/brain/provider.js');
const {reserveUsage,settleUsage,dailyAvailable,localDay,setUsageDateForTests,BudgetError}=await import('../src/brain/usage.js');
const {callModelTool,fetchPublicUrl,assertEpoch,callSandbox}=await import('../src/brain/model-tools.js');
const clientId='provider-security-'+randomUUID(),users:string[]=[],days:string[]=[];
before(async()=>{await migrate();await mkdir(base,{mode:0o700});await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr',$2)",[clientId,{client_name:'Security fixture',redirect_uris:['https://client.example/cb']}]);});
after(async()=>{setUsageDateForTests(undefined);for(const id of users)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);for(const date of days){await pool.query('DELETE FROM provider_budget_reservations WHERE local_date=$1',[date]);await pool.query('DELETE FROM provider_budget_days WHERE local_date=$1',[date]);}await rm(base,{recursive:true,force:true});await pool.end();});
async function fixture(scopes=['brain:read','brain:write']){const user=randomUUID();users.push(user);await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture')",[user,'security-'+user+'@example.invalid']);const brain=(await pool.query('INSERT INTO brains(user_id) VALUES($1) RETURNING id',[user])).rows[0].id;const grant=(await pool.query('INSERT INTO grants(user_id,brain_id,agent_label,client_id,scope) VALUES($1,$2,$3,$4,$5) RETURNING id',[user,brain,'maya',clientId,scopes.join(' ')])).rows[0].id;return {user_id:user,brain_id:brain,agent_label:'maya',client_id:clientId,grant_id:grant,scopes,token_hash:'fixture'} satisfies AuthContext;}
function accountingDay(date:string){days.push(date);setUsageDateForTests(date);}
const request=(signal=new AbortController().signal):ModelRequest=>({model:'test-model',system:'Test system',prompt:'Test request',maxOutputTokens:128,signal});
const event=(value:unknown,crlf=false)=>'event: message\n'+'data: '+JSON.stringify(value)+'\n\n';
function encodedChunks(text:string,step=7){const data=new TextEncoder().encode(text);return new ReadableStream<Uint8Array>({start(controller){for(let index=0;index<data.length;index+=step)controller.enqueue(data.subarray(index,index+step));controller.close();}});}
test('provider SSE parser handles arbitrary CRLF/UTF-8 boundaries, cumulative cached usage and streamed tool JSON',async()=>{
 const values=[{type:'message_start',message:{usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:30,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello 界'}},{type:'content_block_stop',index:0},{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool1',name:'brain_search',input:{}}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"query":'}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'"train"}'}},{type:'content_block_stop',index:1},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{input_tokens:12,output_tokens:8}},{type:'message_delta',usage:{output_tokens:11}},{type:'message_stop'}];
 let text='';const req=request();req.onText=value=>{text+=value;};const response=new Response(encodedChunks(values.map(value=>event(value)).join('').replace(/\n/g,'\r\n'),1));const result=await readAnthropicStream(response,req);
 assert.equal(result.text,'Hello 界');assert.equal(text,result.text);assert.equal(result.inputTokens,62);assert.equal(result.outputTokens,11);assert.equal(result.incomplete,false);assert.equal(result.stopReason,'tool_use');assert.deepEqual(result.content[1].input,{query:'train'});
});
test('aborting a pending provider stream returns partial text and known usage without waiting for a further chunk',async()=>{
 const controller=new AbortController();let cancelled=false;
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(event({type:'message_start',message:{usage:{input_tokens:7}}})+event({type:'content_block_start',index:0,content_block:{type:'text',text:''}})+event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Partial answer'}})));},cancel(){cancelled=true;}});
 const work=readAnthropicStream(new Response(stream),request(controller.signal));await delay(5);controller.abort();const result=await work;assert.equal(result.text,'Partial answer');assert.equal(result.inputTokens,7);assert.equal(result.incomplete,true);assert.equal(cancelled,true);
});
test('provider fetch is mocked: API requests never forward credentials in JSON and forbid redirects',async()=>{
 const original=globalThis.fetch;const captured:RequestInit[]=[];
 globalThis.fetch=(async(_url:unknown,options?:RequestInit)=>{captured.push(options!);return new Response(encodedChunks(event({type:'message_start',message:{usage:{input_tokens:2}}})+event({type:'message_stop'})),{headers:{'content-type':'text/event-stream'}});})as typeof fetch;
 try{await requestProviderForTests(request());assert.equal(captured[0].redirect,'error');const body=String(captured[0].body);assert.ok(!body.includes('x-api-key'));assert.ok(!body.includes('anthropic-workspace-id'));assert.ok(!body.includes('Authorization'));assert.equal(JSON.parse(body).model,'test-model');}finally{globalThis.fetch=original;}
});
test('global daily budget is atomic across brains and survives user-content purge',async()=>{
 accountingDay('2089-01-10');const a=await fixture(),b=await fixture(),c=await fixture();
 const amount=aiConfig.dailyTokens;assert.ok(amount*2>=aiConfig.globalDailyTokens,'fixture expects default 2m/4m limits');
 const results=await Promise.allSettled([reserveUsage(a,'test-model',amount),reserveUsage(b,'test-model',amount),reserveUsage(c,'test-model',amount)]);
 const accepted=results.filter((r):r is PromiseFulfilledResult<string>=>r.status==='fulfilled');assert.equal(accepted.length,2);assert.equal(results.filter(r=>r.status==='rejected'&&(r as PromiseRejectedResult).reason instanceof BudgetError).length,1);
 assert.equal(await dailyAvailable(c),0);
 // User-initiated clear removes tenant accounting, but service spending reservations still bind the cap.
 await pool.query('DELETE FROM usage_reservations WHERE user_id=ANY($1::uuid[])',[[a.user_id,b.user_id,c.user_id]]);
 await assert.rejects(reserveUsage(c,'test-model',1),BudgetError);
 const ledger=(await pool.query('SELECT used_tokens,reserved_tokens FROM provider_budget_days WHERE local_date=$1',['2089-01-10'])).rows[0];assert.equal(Number(ledger.reserved_tokens),amount*2);
 for(const id of accepted)await settleUsage(c,id.value,0,0,true);assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE user_id=$1',[c.user_id])).rows[0].n,0);
});
test('settlement is idempotent, epoch-safe and charges aggregate cost after purge without restoring personal usage',async()=>{
 accountingDay('2089-01-11');const a=await fixture();const id=await reserveUsage({...a,content_epoch:0},'test-model',1000);await pool.query('UPDATE brains SET content_epoch=1 WHERE id=$1 AND user_id=$2',[a.brain_id,a.user_id]);await pool.query('DELETE FROM usage_reservations WHERE user_id=$1 AND brain_id=$2',[a.user_id,a.brain_id]);await settleUsage({...a,content_epoch:0},id,30,20);await settleUsage({...a,content_epoch:0},id,30,20);
 assert.equal((await pool.query('SELECT id FROM usage WHERE user_id=$1 AND brain_id=$2',[a.user_id,a.brain_id])).rowCount,0);
 const row=(await pool.query('SELECT used_tokens,reserved_tokens FROM provider_budget_days WHERE local_date=$1',['2089-01-11'])).rows[0];assert.equal(Number(row.used_tokens),50);assert.equal(Number(row.reserved_tokens),0);await assert.rejects(reserveUsage({...a,content_epoch:0},'test-model',1),/unavailable/);
});
test('usage days use Los Angeles rather than UTC midnight',()=>{assert.equal(localDay(new Date('2026-11-02T07:30:00Z')),'2026-11-01');assert.equal(localDay(new Date('2026-11-02T08:30:00Z')),'2026-11-02');});
test('model tools independently enforce scope, tenant, live grant and private-note visibility',async()=>{
 const read=await fixture(['brain:read']);assert.deepEqual(await callModelTool(read,0,'brain_search',{query:'private'},new AbortController().signal),{notes:[],facts:[],snapshots:[],handoffs:[],jobs:[]});await assert.rejects(callModelTool(read,0,'brain_write_fact',{key:'x',value:'y'},new AbortController().signal),(error:any)=>error.status===403);
 const a=await fixture(),b=await fixture();await assert.rejects(callModelTool({...a,brain_id:b.brain_id},0,'brain_search',{query:''},new AbortController().signal));
 await pool.query("INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text) VALUES($1,$2,'miles',ARRAY['charlie'],'private-only-marker')",[a.user_id,a.brain_id]);const result=await callModelTool(a,0,'brain_search',{query:'private-only-marker',collection:'notes'},new AbortController().signal);assert.deepEqual(result,{notes:[]});
 await pool.query('UPDATE grants SET revoked_at=now() WHERE id=$1',[a.grant_id]);await assert.rejects(assertEpoch(a,0),(error:any)=>error.status===401);
});
function publicMock(payload:Buffer|undefined,status=200){let calls=0,destroyed=false,allReturned=false;const get=((_url:unknown,options:any,callback:any)=>{calls++;const req=new EventEmitter()as any;req.setTimeout=()=>req;req.destroy=()=>{destroyed=true;req.emit('error',new Error('closed'));return req;};options.signal.addEventListener('abort',()=>req.destroy());options.lookup('example.test',{all:true},(_error:unknown,addresses:any)=>{allReturned=Array.isArray(addresses)&&addresses[0].address==='8.8.8.8';});queueMicrotask(()=>{const response=new PassThrough()as any;response.statusCode=status;response.headers={'content-type':'text/plain'};callback(response);if(payload)response.end(payload);});return req;})as typeof https.get;return{get,resolve:(async()=>[{address:'8.8.8.8',family:4}])as unknown as typeof lookup,state:()=>({calls,destroyed,allReturned})};}
test('URL fetch blocks private/mixed DNS, pins public address, refuses redirects and caps streamed bodies',async()=>{
 const signal=new AbortController().signal;for(const ip of ['127.0.0.1','169.254.169.254','::1','10.0.0.1']){const fake=publicMock(Buffer.from('should not fetch'));await assert.rejects(fetchPublicUrl('https://example.test/',signal,{...fake,resolve:(async()=>[{address:'8.8.8.8',family:4},{address:ip,family:ip.includes(':')?6:4}])as unknown as typeof lookup}));assert.equal(fake.state().calls,0);}
 const good=publicMock(Buffer.from('Public text'));assert.equal(await fetchPublicUrl('https://example.test/',signal,good),'Public text');assert.equal(good.state().allReturned,true);
 const redirected=publicMock(undefined,302);await assert.rejects(fetchPublicUrl('https://example.test/',signal,redirected));assert.equal(redirected.state().destroyed,true);
 const oversized=publicMock(Buffer.alloc(262145));await assert.rejects(fetchPublicUrl('https://example.test/',signal,oversized));assert.equal(oversized.state().destroyed,true);
});
test('URL absolute deadline rejects slow DNS before making any request',async()=>{const fake=publicMock(Buffer.from('should not fetch'));await assert.rejects(fetchPublicUrl('https://slow.test/',new AbortController().signal,{...fake,timeoutMs:5,resolve:(async()=>{await delay(30);return[{address:'8.8.8.8',family:4}];})as unknown as typeof lookup}));await delay(35);assert.equal(fake.state().calls,0);});
test('artifact writes reject traversal, symlinks, overlong UTF-8 data and enforce quota while allowing replacement',async()=>{
 const a=await fixture(),signal=new AbortController().signal;
 assert.deepEqual(await callModelTool(a,0,'file_write',{filename:'safe.txt',content:'original'},signal),{filename:'safe.txt',bytes:8});
 const dir=join(aiConfig.workspace,a.user_id,a.brain_id,'0');
 await assert.rejects(callModelTool(a,0,'file_write',{filename:'../outside',content:'bad'},signal));await assert.rejects(callModelTool(a,0,'file_write',{filename:'large.txt',content:'界'.repeat(180000)},signal));
 await symlink(join(base,'outside.txt'),join(dir,'link.txt'));await assert.rejects(callModelTool(a,0,'file_write',{filename:'link.txt',content:'bad'},signal));await rm(join(dir,'link.txt'));
 for(let index=0;index<99;index++)await writeFile(join(dir,'seed-'+index+'.txt'),'x',{mode:0o600});
 await assert.rejects(callModelTool(a,0,'file_write',{filename:'101st.txt',content:'x'},signal),/storage limit/);await callModelTool(a,0,'file_write',{filename:'safe.txt',content:'replaced'},signal);assert.equal(await readFile(join(dir,'safe.txt'),'utf8'),'replaced');
 const b=await fixture();await mkdir(aiConfig.workspace,{recursive:true,mode:0o700});await mkdir(join(base,'outside-directory'),{mode:0o700});await symlink(join(base,'outside-directory'),join(aiConfig.workspace,b.user_id));await assert.rejects(callModelTool(b,0,'file_write',{filename:'escape.txt',content:'bad'},signal));
});
function socketRequest(code:string){return new Promise<{status:number;body:any}>((resolve,reject)=>{const body=JSON.stringify({code}),req=http.request({socketPath:join(base,'runner.sock'),path:'/run',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(text)});}catch(error){reject(error);}});});req.on('error',reject);req.end(body);});}
test('Unix sandbox executes with empty inherited secrets, denies ordinary outside-file/child access, bounds output and serializes jobs',async()=>{
 const runner=spawn(process.execPath,['sandbox/server.mjs'],{cwd:process.cwd(),env:{PATH:process.env.PATH!,BRAIN_SANDBOX_SOCKET:join(base,'runner.sock')},stdio:['ignore','ignore','pipe']});
 try{let ready=false;for(let tries=0;tries<50;tries++){try{await readFile(join(base,'runner.sock'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){ready=true;break;}}await delay(20);}assert.equal(ready,true);
 const result=await callSandbox("console.log(JSON.stringify({secret:process.env.ANTHROPIC_API_KEY??null,db:process.env.DATABASE_URL??null})); try { (await import('node:fs/promises')).readFile('/etc/passwd').catch(e=>console.log(e.code)); }catch(e){console.log(e.code)}; try { (await import('node:child_process')).spawnSync('id'); }catch(e){console.log(e.code)}",new AbortController().signal)as any;
 assert.equal(result.exit_code,0);assert.ok(result.output.includes('"secret":null'));assert.ok(result.output.includes('"db":null'));assert.ok(result.output.includes('ERR_ACCESS_DENIED'));
 const oversized=await socketRequest("console.log('x'.repeat(50000))");assert.equal(oversized.status,200);assert.equal(oversized.body.truncated,true);assert.ok(Buffer.byteLength(oversized.body.output)<=32000);
 const permissions=await socketRequest("import fs from 'node:fs';fs.mkdirSync('locked');fs.writeFileSync('locked/data','test');fs.chmodSync('locked',0);console.log('done');");assert.equal(permissions.status,200);
 for(let i=0;i<5;i++)assert.equal((await socketRequest("console.log('next')")).status,200,'sequential calls must not race cleanup');
 const first=socketRequest("setTimeout(()=>console.log('done'),200)");await delay(40);const second=await socketRequest("console.log('second')");assert.equal(second.status,429);assert.equal((await first).status,200);
 }finally{runner.kill('SIGTERM');await once(runner,'close');}
});
