import {createHmac} from 'node:crypto';
import type {Request,Response,NextFunction} from 'express';
import {pool} from '../db/index.js';
import {config} from '../config.js';
import {randomToken,hashToken,constantEqual} from '../oauth/security.js';
export type AuthContext={user_id:string;brain_id:string;agent_label:string;client_id:string;scopes:string[];grant_id:string;token_hash:string};
declare global { namespace Express {interface Request {user?:{id:string;email:string}; sessionId?:string; csrfToken?:string; auth?:AuthContext;} } }
const cookieName=config.production?'__Host-brain_session':'brain_session';
const csrfCookie=config.production?'__Host-brain_csrf':'brain_csrf';
function sign(value:string){return createHmac('sha256',config.sessionSecret).update(value).digest('base64url');}
function cookieOptions(){return{httpOnly:true,secure:config.production,sameSite:'lax' as const,path:'/'};}
function validSigned(value:unknown):value is string{if(typeof value!=='string'||value.length>200)return false;const[raw,sig,...extra]=value.split('.');return extra.length===0&&!!raw&&!!sig&&constantEqual(sign(raw),sig);}
export function csrfToken(req:Request){if(!req.csrfToken)throw new Error('sessions middleware is required');return req.csrfToken;}
export async function sessions(req:Request,res:Response,next:NextFunction){
 try{
 const raw=req.cookies?.[cookieName];
 if(typeof raw==='string'&&raw.length<200){const result=await pool.query('SELECT s.id,u.id AS user_id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.deleted_at IS NULL',[hashToken(raw)]);if(result.rows[0]){req.user={id:result.rows[0].user_id,email:result.rows[0].email};req.sessionId=result.rows[0].id;}}
 let value=req.cookies?.[csrfCookie];
 if(!validSigned(value)){const nonce=randomToken();value=nonce+'.'+sign(nonce);res.cookie(csrfCookie,value,{...cookieOptions(),maxAge:86400000});}
 req.csrfToken=value;res.locals.user=req.user;res.locals.csrf=value;next();
 }catch(error){next(error);}
}
export async function createSession(req:Request,res:Response,userId:string){const token=randomToken();if(req.sessionId)await pool.query('DELETE FROM sessions WHERE id=$1',[req.sessionId]);await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at,user_agent) VALUES($1,$2,now()+interval '30 days',$3)",[userId,hashToken(token),String(req.headers['user-agent']??'').slice(0,512)]);res.cookie(cookieName,token,{...cookieOptions(),maxAge:30*86400000});const nonce=randomToken(),csrf=nonce+'.'+sign(nonce);res.cookie(csrfCookie,csrf,{...cookieOptions(),maxAge:86400000});req.csrfToken=csrf;}
export async function destroySession(req:Request,res:Response){if(req.sessionId)await pool.query('DELETE FROM sessions WHERE id=$1',[req.sessionId]);res.clearCookie(cookieName,cookieOptions());}
export function requireUser(req:Request,res:Response,next:NextFunction){if(!req.user){res.redirect('/login?next='+encodeURIComponent(req.originalUrl));return;}next();}
export function csrf(req:Request,res:Response,next:NextFunction){const origin=req.get('origin');const submitted=req.body?._csrf;if((origin&&origin!==config.baseUrl)||typeof submitted!=='string'||!req.csrfToken||!constantEqual(submitted,req.csrfToken)){res.status(403).send('This form expired. Reload the page and try again.');return;}next();}
