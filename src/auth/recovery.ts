import {createHash,randomBytes} from 'node:crypto';
import argon2 from 'argon2';
import {pool,transaction} from '../db/index.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function normalized(value:unknown){if(typeof value!=='string'||value.length>100)return null;const code=value.replace(/[\s-]/g,'').toLowerCase();return /^[0-9a-f]{32}$/.test(code)?code:null;}
const options={type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1} as const;
export async function recoveryCodeCount(userId:string):Promise<number>{return (await pool.query('SELECT count(*)::int AS n FROM account_recovery_codes WHERE user_id=$1 AND used_at IS NULL',[userId])).rows[0].n;}
export async function generateRecoveryCodes(userId:string,currentPassword:string):Promise<string[]|null>{
 if(typeof currentPassword!=='string'||currentPassword.length<1||currentPassword.length>1024)return null;
 return transaction(async db=>{
  const user=(await db.query('SELECT password_hash FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[userId])).rows[0];
  if(!user||!await argon2.verify(user.password_hash,currentPassword).catch(()=>false))return null;
  const codes=Array.from({length:10},()=>randomBytes(16).toString('hex'));
  await db.query('DELETE FROM account_recovery_codes WHERE user_id=$1',[userId]);
  for(const code of codes)await db.query('INSERT INTO account_recovery_codes(user_id,code_hash) VALUES($1,$2)',[userId,hash(code)]);
  return codes.map(code=>code.match(/.{8}/g)!.join('-'));
 });
}
export async function resetWithRecoveryCode(email:string,rawCode:string,newPassword:string):Promise<boolean>{
 const code=normalized(rawCode);if(!code)return false;
 const passwordHash=await argon2.hash(newPassword,options);
 return transaction(async db=>{
  const user=(await db.query('SELECT id FROM users WHERE email=$1 AND deleted_at IS NULL FOR UPDATE',[email.trim().toLowerCase()])).rows[0];if(!user)return false;
  const used=await db.query('UPDATE account_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id',[user.id,hash(code)]);if(!used.rowCount)return false;
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1',[user.id,passwordHash]);
  await db.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);
  await db.query('DELETE FROM auth_codes WHERE user_id=$1',[user.id]);
  await db.query('UPDATE grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[user.id]);
  await db.query('DELETE FROM access_tokens WHERE grant_id IN(SELECT id FROM grants WHERE user_id=$1)',[user.id]);
  await db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE grant_id IN(SELECT id FROM grants WHERE user_id=$1)',[user.id]);
  await db.query("UPDATE jobs SET state='failed',finished_at=now(),error='Stopped after account recovery.' WHERE user_id=$1 AND state IN ('queued','running')",[user.id]);
  await db.query('UPDATE brain_sessions SET closed_at=coalesce(closed_at,now()) WHERE user_id=$1',[user.id]);
  return true;
 });
}
