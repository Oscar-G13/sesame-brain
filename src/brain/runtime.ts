import {reportSubsystem} from '../ops/readiness.js';
import {getAiAccess} from '../auth/access.js';
import { buildContextPack } from './context.js';
import { aiConfig } from './config.js';
import { validateModels,generateBudgeted } from './provider.js';
import { recoverGlobalReservations } from './usage.js';
import { runNextJob,recoverInterruptedJobs } from './engine.js';
import { sweepSessions } from './sessions.js';
import { sessionSummarizer } from './lifecycle.js';
import { runDueNightlies,recoverInterruptedNightlies,type NightlyDependencies } from './nightly.js';
export async function startBrainRuntime():Promise<()=>void>{
 await recoverGlobalReservations();await recoverInterruptedJobs();await recoverInterruptedNightlies();
 let stopped=false,ready=false,validating=false,sweeping=false,nightly=false,lastValidated=0;
 const deps:NightlyDependencies={generate:generateBudgeted,context:async identity=>{const pack=await buildContextPack({...identity,agent_label:'brain-nightly',scopes:['brain:read','brain:write'],client_id:'brain-nightly',grant_id:'',token_hash:'nightly'},{tokenBudget:aiConfig.contextTokens,markJobsSurfaced:false});return pack.blocks.map(block=>block.text).join('\n\n');},enabled:()=>ready&&!stopped,options:{deepModel:aiConfig.deepModel,auditorModel:aiConfig.auditorModel,openaiConfigured:Boolean(aiConfig.openaiKey&&aiConfig.auditorModel),nightlyHour:aiConfig.nightlyHour,nightlyTokenBudget:aiConfig.nightlyTokens}};
 const validate=async()=>{if(!aiConfig.ready||validating||stopped||ready&&Date.now()-lastValidated<10*60000)return;validating=true;try{const result=await validateModels();ready=result.models.length>0&&result.models.every(model=>model.available);lastValidated=Date.now();await reportSubsystem('provider',ready,ready?'ready':'validation_failed');console.log(JSON.stringify({event:ready?'brain_models_ready':'brain_models_unavailable',models:result.models}));}catch{ready=false;await reportSubsystem('provider',false,'unavailable').catch(()=>{});console.error(JSON.stringify({event:'brain_model_validation_retry'}));}finally{validating=false;}};
 const sweep=async()=>{if(sweeping||stopped)return;sweeping=true;try{await sweepSessions({summarizer:ready?async(purpose,text,auth)=>{if(!(await getAiAccess(auth.user_id)).approved)return '';return sessionSummarizer(purpose,text,auth);}:undefined});}catch{console.error(JSON.stringify({event:'brain_session_sweeper_error'}));}finally{sweeping=false;}};
 const overnight=async()=>{if(!ready||nightly||stopped)return;nightly=true;try{await runDueNightlies(deps,new Date());await reportSubsystem('scheduler',true,'ready');}catch{await reportSubsystem('scheduler',false,'scheduler_error').catch(()=>{});console.error(JSON.stringify({event:'brain_nightly_error'}));}finally{nightly=false;}};
 await validate();
 const jobs=setInterval(()=>{if(ready&&!stopped)void runNextJob().catch(()=>console.error(JSON.stringify({event:'job_worker_error'})));},1000);jobs.unref();
 const ticker=setInterval(()=>{void validate();void sweep();void overnight();},60000);ticker.unref();void sweep();void overnight();
 if(!aiConfig.ready)console.log(JSON.stringify({event:'brain_ai_unconfigured'}));
 return ()=>{stopped=true;clearInterval(jobs);clearInterval(ticker);};
}
