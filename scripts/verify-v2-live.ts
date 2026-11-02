import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { writeFile,mkdir } from 'node:fs/promises';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { app } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { migrate } from './migrate.js';
import { config } from '../src/config.js';
import { aiConfig } from '../src/brain/config.js';
import { hashToken } from '../src/oauth/security.js';
import { executeTool,type AuthContext } from '../src/tools/service.js';
import { validateModels,generateBudgeted } from '../src/brain/provider.js';
import { runNextJob,recoverInterruptedJobs } from '../src/brain/engine.js';
import { buildContextPack } from '../src/brain/context.js';
import { sessionSummarizer } from '../src/brain/lifecycle.js';
import { sweepSessions } from '../src/brain/sessions.js';
import { runNightlyBrain,type NightlyDependencies } from '../src/brain/nightly.js';
if(process.env.NODE_ENV!=='test'||!new URL(process.env.DATABASE_URL!).hostname.includes('testdb'))throw new Error('Live verification must use the isolated testdb.');
const user=randomUUID(),brain=randomUUID(),clientId='v2-live-'+randomUUID(),grant=randomUUID(),token=randomBytes(32).toString('base64url');
const a:AuthContext={user_id:user,brain_id:brain,grant_id:grant,agent_label:'maya',client_id:clientId,scopes:['brain:read','brain:write'],token_hash:hashToken(token)};
const evidence:Record<string,unknown>={at:new Date().toISOString(),database:'isolated testdb',modelTests:[]};
let server:ReturnType<typeof app.listen>|undefined,client:Client|undefined;
const record=(name:string,data:Record<string,unknown>={})=>{console.log(JSON.stringify({check:name,...data}));(evidence.modelTests as unknown[]).push({check:name,...data});};
try{
 await migrate();evidence.models=await validateModels();assert.ok(aiConfig.ready);
 await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'live-fixture-no-login')",[user,user+'@verify.invalid']);
 await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[brain,user]);
 await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr','{}')",[clientId]);
 await pool.query("INSERT INTO grants(id,user_id,brain_id,client_id,agent_label,scope,resource) VALUES($1,$2,$3,$4,'maya','brain:read brain:write',$5)",[grant,user,brain,clientId,config.resource]);
 await pool.query("INSERT INTO access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[a.token_hash,grant]);
 await executeTool(a,'remember',{key:'preferred_name',value:'Test Reader'});await executeTool(a,'remember',{key:'interaction',value:'Be direct. Avoid flattery. Distinguish evidence from interpretation.'});
 server=app.listen(0,'0.0.0.0');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 client=new Client({name:'Brain v2 live verification',version:'2.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+address.port+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 async function call(name:string,args:Record<string,unknown>={}){const start=Date.now();const result=await client!.callTool({name,arguments:args},{timeout:45000});assert.ok(!result.isError,name+' failed');const part=result.content.find(c=>c.type==='text');assert.ok(part&&part.type==='text');const data=JSON.parse(part.text);assert.equal(typeof data.trailer,'string');return {data,ms:Date.now()-start};}
 const tools=await client.listTools();assert.equal(tools.tools.length,20);record('MCP discovery',{tools:tools.tools.length});
 await call('whoami');
 const quick=await call('think',{text:'What name do you remember for me? Answer in one short sentence.',depth:'quick',spoken:true});assert.match(quick.data.answer,/Test Reader/i);assert.equal(quick.data.job_id,null);assert.ok(quick.ms<aiConfig.quickTimeout+1500);record('live quick reasoning',{latency_ms:quick.ms});
 const job=await call('do',{task:'Write a two-sentence welcome for someone starting a fresh shared memory. No research needed.',deliver:'brain'});assert.ok(job.data.job_id);assert.ok(job.ms<1000);record('immediate job acknowledgement',{latency_ms:job.ms});
 await runNextJob(a);const status=await call('job_status',{job_id:job.data.job_id});assert.equal(status.data.state,'done');assert.ok(status.data.result_note_id);record('live background completion');
 const forced=await call('think',{text:'Research the current official Anthropic documentation for web search and streaming. Read the relevant public documentation using web search, compare at least three documented features, and explain the differences with links.',depth:'quick',spoken:true});
 assert.ok(forced.ms<aiConfig.quickTimeout+1500);assert.ok(forced.data.job_id,'research should exceed the deliberately short voice deadline');record('live deadline continuation',{latency_ms:forced.ms});
 await runNextJob(a);const continued=await call('job_status',{job_id:forced.data.job_id});assert.ok(['done','partial'].includes(continued.data.state));record('continued job result',{state:continued.data.state});
 await pool.query("UPDATE brain_sessions SET closed_at=now() WHERE user_id=$1 AND brain_id=$2",[user,brain]);
 const next=await call('whoami');assert.ok(next.data.briefing);assert.ok(next.data.briefing.split(/\s+/).length<=150);assert.equal((await call('whoami')).data.briefing,undefined);record('first touch live briefing');
 await call('remember',{key:'reading',value:'I prefer short explanations with evidence.'});
 const goodbye=await call('end_session');assert.equal(goodbye.data.closed,true);assert.ok(goodbye.data.snapshotId);record('explicit live call summary');
 await call('leave_note',{to:'all',text:'Synthetic verification: follow up on the welcome draft.'});
 await pool.query("UPDATE brain_sessions SET last_activity_at=now()-interval '11 minutes' WHERE user_id=$1 AND brain_id=$2 AND closed_at IS NULL",[user,brain]);
 const swept=await sweepSessions({summarizer:sessionSummarizer});assert.ok(swept.rolledUp>=1);record('idle live call summary',{rolled_up:swept.rolledUp});
 if(process.argv.includes('--nightly')){
  const deps:NightlyDependencies={generate:generateBudgeted,context:async identity=>{const p=await buildContextPack({...a,...identity,agent_label:'brain-nightly'},{markJobsSurfaced:false});return p.blocks.map(b=>b.text).join('\n\n');},enabled:()=>true,options:{deepModel:aiConfig.deepModel,auditorModel:aiConfig.auditorModel,openaiConfigured:Boolean(aiConfig.openaiKey&&aiConfig.auditorModel),nightlyHour:3,nightlyTokenBudget:aiConfig.nightlyTokens}};
  const nightly=await runNightlyBrain({user_id:user,brain_id:brain},{},deps);assert.equal(nightly.state,'done',nightly.error);assert.equal(Object.keys(nightly.snapshot_ids??{}).length,3);record('live formulation audit and diff',{state:nightly.state,tokens:nightly.tokens_used});
 }
 const usage=await pool.query('SELECT model,sum(input_tokens)::bigint AS input_tokens,sum(output_tokens)::bigint AS output_tokens FROM usage WHERE user_id=$1 AND brain_id=$2 GROUP BY model',[user,brain]);evidence.usage=usage.rows;
 evidence.passed=true;
} catch(error){evidence.passed=false;evidence.failure=error instanceof assert.AssertionError?error.message:'Live verification failed; check sanitized provider diagnostics.';process.exitCode=1;console.log(JSON.stringify({check:'failure',message:evidence.failure}));}
finally{
 if(client)await client.close().catch(()=>{});if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
 await pool.query('DELETE FROM users WHERE id=$1',[user]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[clientId]);
 evidence.disposable_account_deleted=true;await mkdir('evidence',{recursive:true});await writeFile('evidence/v2-live-models.json',JSON.stringify(evidence,null,2)+'\n');await pool.end();
}
