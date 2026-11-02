import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {config} from '../config.js';
export class OAuthError extends Error { constructor(public code:string, public status=400, message=code){super(message);} }
export function randomToken(){return randomBytes(32).toString('base64url');}
export function hashToken(value:string){return createHash('sha256').update(value).digest('hex');}
export function hashSecret(value:string){return hashToken(config.tokenPepper+':'+value);}
export function constantEqual(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function pkceChallenge(verifier:string){return createHash('sha256').update(verifier).digest('base64url');}
export function verifyPkce(verifier:string,challenge:string){return /^[A-Za-z0-9._~-]{43,128}$/.test(verifier)&&constantEqual(pkceChallenge(verifier),challenge);}
export function validChallenge(challenge:string){return /^[A-Za-z0-9_-]{43}$/.test(challenge);}
export function isLoopback(url:URL){return url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);}
export function validateRedirectUri(value:string){try{const u=new URL(value);return !u.username&&!u.password&&!u.hash&&(u.protocol==='https:'||isLoopback(u));}catch{return false;}}
export function redirectMatches(requested:string,registered:string,loopbackPort=true){
 if(requested===registered)return true;
 if(!loopbackPort)return false;
 try{const a=new URL(requested),b=new URL(registered);if(!isLoopback(a)||!isLoopback(b))return false;const stripPort=(v:string)=>v.replace(/^(http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::[0-9]+)?(?=\/|\?|$)/,'$1');return stripPort(requested)===stripPort(registered);}catch{return false;}
}
export function canonicalResource(value:unknown,required=false){
 if(value===undefined||value===''){if(required)throw new OAuthError('invalid_target');return config.resource;}
 if(typeof value!=='string'||![config.resource,config.baseUrl,config.baseUrl+'/'].includes(value))throw new OAuthError('invalid_target');
 return config.resource;
}
export function validAudience(value:string){return value===config.resource;}
export function normalizeScopes(value:unknown){const scope=value===undefined||value===''?'brain:read brain:write':value;if(typeof scope!=='string')throw new OAuthError('invalid_scope');const scopes=[...new Set(scope.split(/\s+/).filter(Boolean))];if(scopes.length===0||scopes.some(s=>!['brain:read','brain:write'].includes(s)))throw new OAuthError('invalid_scope');return scopes.join(' ');}
export function agentSlug(value:unknown){return typeof value==='string'&&/^[a-z0-9-]{1,32}$/.test(value)&&value!=='all';}
export function stringParam(value:unknown,name:string,required=true){if(typeof value==='string'&&value.length<=4096)return value;if(!required&&value===undefined)return '';throw new OAuthError('invalid_request',400,'Invalid '+name);}
