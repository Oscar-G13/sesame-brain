import type {Request,Response,NextFunction} from 'express';
import {pool} from '../db/index.js';
import {config} from '../config.js';
import {hashToken,validAudience} from './security.js';
import type {AuthContext} from '../auth/session.js';
import {consumeRate} from '../auth/rate-limit.js';
import {READ_TOOLS,WRITE_TOOLS} from '../tools/definitions.js';
export const bearerChallenge='Bearer resource_metadata="'+config.baseUrl+'/.well-known/oauth-protected-resource", scope="brain:read brain:write"';
function reject(res:Response){res.set('WWW-Authenticate',bearerChallenge).status(401).json({error:'invalid_token'});}
export async function authenticateToken(token:string):Promise<AuthContext|null>{if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;const tokenHash=hashToken(token);const result=await pool.query('SELECT g.*,a.token_hash,a.expires_at FROM access_tokens a JOIN grants g ON g.id=a.grant_id JOIN users u ON u.id=g.user_id WHERE a.token_hash=$1 AND a.expires_at>now() AND g.revoked_at IS NULL AND u.deleted_at IS NULL',[tokenHash]);const row=result.rows[0];if(!row||!validAudience(row.resource))return null;return{user_id:row.user_id,brain_id:row.brain_id,agent_label:row.agent_label,client_id:row.client_id,scopes:String(row.scope).split(/\s+/),grant_id:row.id,token_hash:tokenHash};}
export async function bearerAuth(req:Request,res:Response,next:NextFunction){
 try{
 const header=req.get('authorization');if(!header||!/^Bearer [A-Za-z0-9_-]{43}$/i.test(header)){reject(res);return;}
 const tokenHash=hashToken(header.slice(7));
 const auth=await authenticateToken(header.slice(7));if(!auth){reject(res);return;}
 const limit=consumeRate('mcp:'+tokenHash,120,60000);if(!limit.allowed){res.set('Retry-After',String(limit.retry)).status(429).json({error:'rate_limit_exceeded'});return;}
 const scopes=auth.scopes;req.auth=auth;
 const requested=req.body?.method==='tools/call'?req.body?.params?.name:undefined;
 const needed=typeof requested==='string'?(READ_TOOLS.includes(requested)?'brain:read':WRITE_TOOLS.includes(requested)?'brain:write':undefined):undefined;
 if(needed&&!scopes.includes(needed)){insufficientScope(res,needed);return;}
 await pool.query('UPDATE grants SET last_used_at=now() WHERE id=$1 AND user_id=$2 AND brain_id=$3',[auth.grant_id,auth.user_id,auth.brain_id]);next();
 }catch(error){next(error);}
}
export function insufficientScope(res:Response,scope:string){res.set('WWW-Authenticate','Bearer error="insufficient_scope", scope="'+scope+'", resource_metadata="'+config.baseUrl+'/.well-known/oauth-protected-resource"').status(403).json({error:'insufficient_scope'});}
export function requireScope(scope:string){return(req:Request,res:Response,next:NextFunction)=>{if(!req.auth){reject(res);return;}if(!req.auth.scopes.includes(scope)){insufficientScope(res,scope);return;}next();};}
