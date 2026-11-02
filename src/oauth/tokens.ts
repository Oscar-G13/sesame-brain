import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {pool,transaction} from '../db/index.js';
import {config} from '../config.js';
import {OAuthError,randomToken,hashToken,verifyPkce,validAudience} from './security.js';
type Grant={id:string;user_id:string;brain_id:string;agent_label:string;client_id:string;scope:string;resource:string;revoked_at:Date|null};
export type TokenResponse={access_token:string;token_type:'Bearer';expires_in:number;refresh_token:string;scope:string};
async function issuePair(db:pg.PoolClient,grant:Grant,familyId=randomUUID()):Promise<TokenResponse>{
 const access=randomToken(),refresh=randomToken();
 await db.query("INSERT INTO access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(access),grant.id]);
 await db.query("INSERT INTO refresh_tokens(token_hash,grant_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '90 days')",[hashToken(refresh),grant.id,familyId]);
 return {access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:grant.scope};
}
export async function revokeGrant(grantId:string,db:pg.PoolClient|pg.Pool=pool){await db.query('UPDATE grants SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1',[grantId]);await db.query('DELETE FROM access_tokens WHERE grant_id=$1',[grantId]);await db.query('UPDATE refresh_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE grant_id=$1',[grantId]);}
export async function redeemAuthorizationCode(input:{code:string;clientId:string;redirectUri:string;verifier:string;resource:string}){
 const result=await transaction(async db=>{
 const owner=(await db.query('SELECT user_id FROM auth_codes WHERE code_hash=$1',[hashToken(input.code)])).rows[0];if(!owner)return null;
 const user=await db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[owner.user_id]);if(!user.rowCount)return null;
 const found=await db.query('SELECT * FROM auth_codes WHERE code_hash=$1 FOR UPDATE',[hashToken(input.code)]);const code=found.rows[0];
 if(!code||code.client_id!==input.clientId||code.redirect_uri!==input.redirectUri||code.resource!==input.resource||!verifyPkce(input.verifier,code.code_challenge))return null;
 if(code.used_at){if(code.grant_id)await revokeGrant(code.grant_id,db);return null;}
 if(new Date(code.expires_at).getTime()<=Date.now()||!validAudience(code.resource))return null;
 const grant=(await db.query<Grant>('INSERT INTO grants(user_id,brain_id,agent_label,client_id,scope,resource) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[code.user_id,code.brain_id,code.agent_label,code.client_id,code.scope,code.resource])).rows[0];
 await db.query('UPDATE auth_codes SET used_at=now(),grant_id=$2 WHERE code_hash=$1',[hashToken(input.code),grant.id]);return issuePair(db,grant);
 });if(!result)throw new OAuthError('invalid_grant');return result;
}
export async function rotateRefreshToken(input:{token:string;clientId:string;resource:string;scope?:string}){
 const result=await transaction(async db=>{
 const owner=(await db.query('SELECT g.id,g.user_id FROM refresh_tokens rt JOIN grants g ON g.id=rt.grant_id WHERE rt.token_hash=$1',[hashToken(input.token)])).rows[0];if(!owner)return null;
 const user=await db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[owner.user_id]);if(!user.rowCount)return null;
 const grant=(await db.query('SELECT * FROM grants WHERE id=$1 FOR UPDATE',[owner.id])).rows[0];if(!grant)return null;
 const refresh=(await db.query('SELECT * FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE',[hashToken(input.token)])).rows[0];if(!refresh)return null;
 const row={...refresh,user_id:grant.user_id,brain_id:grant.brain_id,agent_label:grant.agent_label,client_id:grant.client_id,scope:grant.scope,resource:grant.resource,grant_revoked_at:grant.revoked_at};
 if(!row||row.client_id!==input.clientId||row.resource!==input.resource)return null;
 if(row.used_at){await db.query('UPDATE refresh_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=$1',[row.family_id]);await revokeGrant(row.grant_id,db);return null;}
 if(row.revoked_at||row.grant_revoked_at||new Date(row.expires_at).getTime()<=Date.now()||!validAudience(row.resource))return null;
 if(input.scope&&input.scope.split(/\s+/).sort().join(' ')!==row.scope.split(/\s+/).sort().join(' '))throw new OAuthError('invalid_scope');
 await db.query('UPDATE refresh_tokens SET used_at=now() WHERE token_hash=$1',[hashToken(input.token)]);
 return issuePair(db,{...row,id:row.grant_id},row.family_id);
 });if(!result)throw new OAuthError('invalid_grant');return result;
}
export async function revokeToken(token:string,clientId:string){await transaction(async db=>{const result=await db.query("SELECT g.id FROM grants g WHERE g.client_id=$2 AND (g.id IN (SELECT grant_id FROM access_tokens WHERE token_hash=$1) OR g.id IN (SELECT grant_id FROM refresh_tokens WHERE token_hash=$1)) FOR UPDATE",[hashToken(token),clientId]);for(const row of result.rows)await revokeGrant(row.id,db);});}
