import { readFileSync } from 'node:fs';
const defaults=JSON.parse(readFileSync('config/ai-models.json','utf8'));
function integer(name:string,fallback:number,min=1,max=10000000){const n=Number(process.env[name]??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('Invalid '+name);return n;}
export const aiConfig=Object.freeze({
 ready:Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
 anthropicWorkspace:process.env.ANTHROPIC_WORKSPACE_ID??'',anthropicKey:process.env.ANTHROPIC_API_KEY??'',openaiKey:process.env.OPENAI_API_KEY??'',
 quickModel:process.env.BRAIN_MODEL_QUICK||defaults.quick,deepModel:process.env.BRAIN_MODEL_DEEP||defaults.deep,auditorModel:process.env.BRAIN_MODEL_AUDITOR||'',
 anthropicVersion:defaults.anthropicVersion,webSearchType:defaults.webSearchType,
 contextTokens:integer('BRAIN_CONTEXT_TOKEN_BUDGET',20000,500,200000),
 quickTimeout:integer('BRAIN_THINK_TIMEOUT_QUICK_MS',8000,50,60000),deepTimeout:integer('BRAIN_THINK_TIMEOUT_DEEP_MS',25000,100,120000),
 sessionIdle:integer('BRAIN_SESSION_IDLE_MIN',30),rollupIdle:integer('BRAIN_IDLE_ROLLUP_MIN',10),
 jobTokens:integer('BRAIN_JOB_TOKEN_BUDGET',400000),dailyTokens:integer('BRAIN_DAILY_TOKEN_BUDGET',2000000),globalDailyTokens:integer('BRAIN_GLOBAL_DAILY_TOKEN_BUDGET',4000000),
 nightlyHour:integer('BRAIN_NIGHTLY_HOUR',3,0,23),nightlyTokens:integer('BRAIN_NIGHTLY_TOKEN_BUDGET',600000),
 workspace:process.env.BRAIN_WORKSPACE_DIR||'/var/lib/brain/workspaces',
 sandboxUrl:process.env.BRAIN_SANDBOX_URL||'',
 smtpHost:process.env.BRAIN_SMTP_HOST||'',smtpPort:integer('BRAIN_SMTP_PORT',587,1,65535),smtpUser:process.env.BRAIN_SMTP_USER||'',smtpPass:process.env.BRAIN_SMTP_PASS||'',smtpFrom:process.env.BRAIN_SMTP_FROM||'',
});
export const RESTING='Your brain has reached its daily limit and is resting until tomorrow.';
export const NOT_CONFIGURED='Reasoning is not connected yet. Your saved memory and assistant connections are ready.';
