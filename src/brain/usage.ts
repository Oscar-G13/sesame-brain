import {requireSponsoredAi} from '../auth/access.js';
import {randomUUID} from 'node:crypto';
import {pool,transaction} from '../db/index.js';
import {aiConfig,RESTING} from './config.js';
export type Identity={user_id:string;brain_id:string;content_epoch?:string|number};
export class BudgetError extends Error{constructor(){super(RESTING);this.name='BudgetError';}}
export function localDay(now=new Date()):string{
 const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const value=(type:string)=>p.find(part=>part.type===type)!.value;
 return value('year')+'-'+value('month')+'-'+value('day');
}
let testDate:string|undefined;
export function setUsageDateForTests(value:string|undefined){if(process.env.NODE_ENV!=='test')throw new Error('Test only.');if(value!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))))throw new Error('Invalid test date');testDate=value;}
const accountingDay=()=>testDate??localDay();
const GLOBAL_BUDGET_LOCK=7263519804;
function nonnegativeInteger(value:number){if(!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER)throw new Error('Invalid token accounting');return Math.ceil(value);}
export async function reserveUsage(a:Identity,model:string,tokens:number):Promise<string>{
 const amount=nonnegativeInteger(tokens);if(!amount||!model||model.length>200)throw new Error('Invalid token reservation');
 return transaction(async db=>{
  // All reservation and settlement transactions use global lock -> brain lock.
  await db.query('SELECT pg_advisory_xact_lock($1)',[GLOBAL_BUDGET_LOCK]);
  if(!(await db.query('SELECT id FROM brains WHERE user_id=$1 AND id=$2 AND ($3::bigint IS NULL OR content_epoch=$3) FOR UPDATE',[a.user_id,a.brain_id,a.content_epoch??null])).rowCount)throw new Error('Brain unavailable.');
  await requireSponsoredAi(a,db);
  const day=accountingDay();
  await db.query('INSERT INTO provider_budget_days(local_date) VALUES($1) ON CONFLICT DO NOTHING',[day]);
  const global=(await db.query('SELECT used_tokens+reserved_tokens AS used FROM provider_budget_days WHERE local_date=$1',[day])).rows[0];
  const used=await db.query('SELECT COALESCE((SELECT sum(input_tokens+output_tokens) FROM usage WHERE user_id=$1 AND brain_id=$2 AND local_date=$3),0)+COALESCE((SELECT sum(reserved_tokens) FROM usage_reservations WHERE user_id=$1 AND brain_id=$2 AND local_date=$3),0) AS used',[a.user_id,a.brain_id,day]);
  if(Number(used.rows[0].used)+amount>aiConfig.dailyTokens||Number(global.used)+amount>aiConfig.globalDailyTokens)throw new BudgetError();
  const id=randomUUID();
  await db.query('INSERT INTO usage_reservations(id,user_id,brain_id,local_date,model,reserved_tokens) VALUES($1,$2,$3,$4,$5,$6)',[id,a.user_id,a.brain_id,day,model,amount]);
  await db.query('INSERT INTO provider_budget_reservations(id,local_date,reserved_tokens) VALUES($1,$2,$3)',[id,day,amount]);
  await db.query('UPDATE provider_budget_days SET reserved_tokens=reserved_tokens+$2 WHERE local_date=$1',[day,amount]);
  return id;
 });
}
export async function settleUsage(a:Identity,id:string,input:number,output:number,uncertain=false):Promise<void>{
 const actualIn=nonnegativeInteger(input),actualOut=nonnegativeInteger(output);
 await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock($1)',[GLOBAL_BUDGET_LOCK]);
  const global=(await db.query('DELETE FROM provider_budget_reservations WHERE id=$1 RETURNING local_date,reserved_tokens',[id])).rows[0];
  // A second settlement cannot charge twice, including after a crash or a purge.
  if(!global)return;
  const charge=uncertain?Math.max(actualIn+actualOut,Number(global.reserved_tokens)):actualIn+actualOut;
  await db.query('UPDATE provider_budget_days SET reserved_tokens=greatest(0,reserved_tokens-$2),used_tokens=used_tokens+$3 WHERE local_date=$1',[global.local_date,global.reserved_tokens,charge]);
  const brain=(await db.query('SELECT id FROM brains WHERE user_id=$1 AND id=$2 AND ($3::bigint IS NULL OR content_epoch=$3) FOR UPDATE',[a.user_id,a.brain_id,a.content_epoch??null])).rows[0];
  // A removed/stale tenant reservation never recreates cleared personal usage.
  if(!brain)return;
  const row=(await db.query('DELETE FROM usage_reservations WHERE id=$1 AND user_id=$2 AND brain_id=$3 RETURNING local_date,model,reserved_tokens',[id,a.user_id,a.brain_id])).rows[0];
  if(!row)return;
  const chargedIn=uncertain?Math.max(actualIn,Number(row.reserved_tokens)-actualOut):actualIn;
  await db.query('INSERT INTO usage(user_id,brain_id,local_date,model,input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,brain_id,local_date,model) DO UPDATE SET input_tokens=usage.input_tokens+EXCLUDED.input_tokens,output_tokens=usage.output_tokens+EXCLUDED.output_tokens',[a.user_id,a.brain_id,row.local_date,row.model,chargedIn,actualOut]);
 });
}
export async function dailyAvailable(a:Identity):Promise<number>{
 const day=accountingDay();
 const row=(await pool.query('SELECT COALESCE((SELECT sum(input_tokens+output_tokens) FROM usage WHERE user_id=$1 AND brain_id=$2 AND local_date=$3),0)+COALESCE((SELECT sum(reserved_tokens) FROM usage_reservations WHERE user_id=$1 AND brain_id=$2 AND local_date=$3),0) AS used,COALESCE((SELECT used_tokens+reserved_tokens FROM provider_budget_days WHERE local_date=$3),0) AS global_used',[a.user_id,a.brain_id,day])).rows[0];
 return Math.max(0,Math.min(aiConfig.dailyTokens-Number(row.used),aiConfig.globalDailyTokens-Number(row.global_used)));
}
export async function recoverGlobalReservations():Promise<number>{
 // Startup only: an interrupted request may have reached the provider, so retain its full charge.
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock($1)',[GLOBAL_BUDGET_LOCK]);
  const rows=(await db.query('DELETE FROM provider_budget_reservations RETURNING id,local_date,reserved_tokens')).rows;
  for(const row of rows)await db.query('UPDATE provider_budget_days SET reserved_tokens=greatest(0,reserved_tokens-$2),used_tokens=used_tokens+$2 WHERE local_date=$1',[row.local_date,row.reserved_tokens]);
  // Leave tenant reservations charged too: they are not refunded or resurrected on restart.
  return rows.length;
 });
}
