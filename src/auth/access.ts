import type pg from 'pg';
import {pool,transaction} from '../db/index.js';
import {ToolError} from '../tools/service.js';
export type AiAccess={approved:boolean;state:'approved'|'pending'|'revoked';reason:string;approvedAt:string|null};
export class AiAccessError extends ToolError {readonly code='ai_access_required';constructor(){super('Hosted AI needs operator approval. Your memory and assistant connections still work.',403);this.name='AiAccessError';}}
export async function getAiAccess(userId:string,db:pg.Pool|pg.PoolClient=pool):Promise<AiAccess>{
 const row=(await db.query('SELECT ai_access_state,ai_access_reason,ai_approved_at FROM users WHERE id=$1 AND deleted_at IS NULL',[userId])).rows[0];
 if(!row)throw new ToolError('Account not found.',404);
 return{approved:row.ai_access_state==='approved',state:row.ai_access_state,reason:row.ai_access_reason,approvedAt:row.ai_approved_at?new Date(row.ai_approved_at).toISOString():null};
}
export async function requireSponsoredAi(identity:{user_id:string;brain_id?:string},db:pg.Pool|pg.PoolClient=pool):Promise<void>{
 const row=(await db.query('SELECT u.ai_access_state FROM users u WHERE u.id=$1 AND u.deleted_at IS NULL AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM brains b WHERE b.user_id=u.id AND b.id=$2))',[identity.user_id,identity.brain_id??null])).rows[0];
 if(!row||row.ai_access_state!=='approved')throw new AiAccessError();
}
export async function setAiAccess(userId:string,approved:boolean,reason:string,changedBy='operator'):Promise<void>{
 const state=approved?'approved':'revoked';
 await transaction(async db=>{
  const row=await db.query("UPDATE users SET ai_access_state=$2,ai_approved_at=CASE WHEN $2='approved' THEN now() ELSE ai_approved_at END,ai_access_reason=$3 WHERE id=$1 AND deleted_at IS NULL RETURNING id",[userId,state,reason.slice(0,300)]);
  if(!row.rowCount)throw new ToolError('Account not found.',404);
  await db.query('INSERT INTO ai_access_audit(user_id,state,changed_by,reason) VALUES($1,$2,$3,$4)',[userId,state,changedBy.slice(0,100),reason.slice(0,300)]);
  if(!approved)await db.query("UPDATE jobs SET state='failed',finished_at=now(),error='Hosted AI access was disabled by the operator.' WHERE user_id=$1 AND state IN ('queued','running')",[userId]);
 });
}

export class RegistrationPausedError extends Error {constructor(){super('New account registration is paused while capacity is reviewed. Existing accounts still work.');this.name='RegistrationPausedError';}}
export function maxAccounts():number {const value=Number(process.env.BRAIN_MAX_ACCOUNTS??100);if(!Number.isSafeInteger(value)||value<1||value>100000)throw new Error('Invalid BRAIN_MAX_ACCOUNTS');return value;}
export async function ensureSignupCapacity(db:pg.PoolClient,limit=maxAccounts()):Promise<void>{
 await db.query('SELECT pg_advisory_xact_lock(7263519806)');
 const total=Number((await db.query('SELECT count(*) AS n FROM users WHERE deleted_at IS NULL')).rows[0].n);
 if(total>=limit)throw new RegistrationPausedError();
}
