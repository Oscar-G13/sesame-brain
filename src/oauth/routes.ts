import {Router,type Request,type Response,type NextFunction} from 'express';
import {pool,transaction} from '../db/index.js';
import {config} from '../config.js';
import {csrf,csrfToken} from '../auth/session.js';
import {rateLimit} from '../auth/rate-limit.js';
import {OAuthError,randomToken,hashToken,hashSecret,stringParam,normalizeScopes,canonicalResource,validChallenge,redirectMatches,isLoopback,agentSlug} from './security.js';
import {getClient,validateClientMetadata,verifyClientSecret,type ClientRecord} from './clients.js';
import {redeemAuthorizationCode,rotateRefreshToken,revokeToken} from './tokens.js';
export const oauthRouter=Router();
const scopes=['brain:read','brain:write'];
const prm={resource:config.resource,authorization_servers:[config.baseUrl],scopes_supported:scopes,bearer_methods_supported:['header'],resource_documentation:config.baseUrl+'/docs'};
const metadata={issuer:config.baseUrl,authorization_endpoint:config.baseUrl+'/authorize',token_endpoint:config.baseUrl+'/token',registration_endpoint:config.baseUrl+'/register',revocation_endpoint:config.baseUrl+'/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none','client_secret_basic','client_secret_post'],scopes_supported:scopes,client_id_metadata_document_supported:true,authorization_response_iss_parameter_supported:true};
for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'])oauthRouter.get(path,(_req,res)=>{res.set('Cache-Control','public, max-age=300').json(prm);});
for(const path of ['/.well-known/oauth-authorization-server','/.well-known/openid-configuration'])oauthRouter.get(path,(_req,res)=>{res.set('Cache-Control','public, max-age=300').json(metadata);});
function endpoint(fn:(req:Request,res:Response)=>Promise<void>){return async(req:Request,res:Response,next:NextFunction)=>{try{await fn(req,res);}catch(error){if(error instanceof OAuthError){console.info(JSON.stringify({event:'oauth_error',path:req.path,error:error.code,grant_type:['authorization_code','refresh_token'].includes(req.body?.grant_type)?req.body.grant_type:'other',client_id_shape:typeof(req.body?.client_id??req.query.client_id)==='string'&&String(req.body?.client_id??req.query.client_id).startsWith('https:')?'url':'opaque'}));res.set('Cache-Control','no-store');if(error.status===401)res.set('WWW-Authenticate','Basic realm="Brain OAuth"');res.status(error.status).json({error:error.code,iss:config.baseUrl});}else next(error);}};}
oauthRouter.post('/register',rateLimit('register',10,3600000),endpoint(async(req,res)=>{
 const metadata=validateClientMetadata(req.body);const clientId=randomToken();const secret=metadata.token_endpoint_auth_method==='none'?undefined:randomToken();
 await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata,secret_hash) VALUES($1,'dcr',$2,$3)",[clientId,metadata,secret?hashSecret(secret):null]);
 res.set('Cache-Control','no-store').status(201).json({...metadata,client_id:clientId,client_id_issued_at:Math.floor(Date.now()/1000),...(secret?{client_secret:secret,client_secret_expires_at:0}:{})});
}));
type Authorization={client:ClientRecord;params:Record<string,string>};
async function authorizeParams(input:Record<string,unknown>):Promise<Authorization>{
 const clientId=stringParam(input.client_id,'client_id'),redirectUri=stringParam(input.redirect_uri,'redirect_uri');
 const client=await getClient(clientId);
 if(!client.metadata.redirect_uris.some(r=>redirectMatches(redirectUri,r,client.kind!=='cimd')))throw new OAuthError('invalid_redirect_uri');
 const params:Record<string,string>={client_id:clientId,redirect_uri:redirectUri};
 if(input.state!==undefined)params.state=stringParam(input.state,'state');
 for(const key of ['response_type','code_challenge','code_challenge_method','scope','resource'])if(input[key]!==undefined)params[key]=stringParam(input[key],key);
 return{client,params};
}
function validateAuthorization(auth:Authorization){
 const p=auth.params;if(p.response_type!=='code')throw new OAuthError('unsupported_response_type');
 if(p.code_challenge_method!=='S256'||!validChallenge(p.code_challenge??''))throw new OAuthError('invalid_request');
 p.scope=normalizeScopes(p.scope);p.resource=canonicalResource(p.resource);
}
function authorizationResponse(res:Response,params:Record<string,string>,values:Record<string,string>){const target=new URL(params.redirect_uri);if(params.state!==undefined)target.searchParams.set('state',params.state);target.searchParams.set('iss',config.baseUrl);for(const[k,v]of Object.entries(values))target.searchParams.set(k,v);res.removeHeader('Content-Security-Policy');res.set('Cache-Control','no-store').redirect(303,target.href);}
function consent(res:Response,req:Request,auth:Authorization,error?:string){const redirect=new URL(auth.params.redirect_uri);res.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' "+redirect.origin);res.set('Cache-Control','no-store').render('consent',{client:auth.client.metadata,oauthParams:auth.params,csrf:csrfToken(req),error,redirectHost:redirect.host,loopback:isLoopback(redirect)});}
oauthRouter.get('/authorize',rateLimit('authorize',60,60000),endpoint(async(req,res)=>{
 const auth=await authorizeParams(req.query);
 try{validateAuthorization(auth);}catch(error){if(error instanceof OAuthError){authorizationResponse(res,auth.params,{error:error.code});return;}throw error;}
 if(!req.user){res.redirect('/login?next='+encodeURIComponent(req.originalUrl));return;}consent(res,req,auth);
}));
oauthRouter.post('/authorize',rateLimit('authorize',60,60000),csrf,endpoint(async(req,res)=>{
 const auth=await authorizeParams(req.body);
 try{validateAuthorization(auth);}catch(error){if(error instanceof OAuthError){authorizationResponse(res,auth.params,{error:error.code});return;}throw error;}
 if(!req.user){res.status(401).send('Sign in again to connect this assistant.');return;}
 if(req.body.decision==='deny'){authorizationResponse(res,auth.params,{error:'access_denied'});return;}
 if(req.body.decision!=='approve'){consent(res,req,auth,'Choose approve or cancel.');return;}
 const agent=String(req.body.agent_label==='other'?req.body.custom_agent??'':req.body.agent_label??'').trim().toLowerCase();
 if(!agentSlug(agent)){consent(res,req,auth,'Choose an assistant, or enter 1–32 lowercase letters, digits or hyphens. The name all is reserved.');return;}
 const code=randomToken();const created=await transaction(async db=>{
 const owner=await db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[req.user!.id]);if(!owner.rowCount||!req.sessionId)return false;
 const session=await db.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>now()',[req.sessionId,req.user!.id]);if(!session.rowCount)return false;
 const brain=(await db.query('SELECT id FROM brains WHERE user_id=$1 AND name=$2',[req.user!.id,'default'])).rows[0];if(!brain)throw new Error('Missing default brain');
 await db.query("INSERT INTO auth_codes(code_hash,client_id,user_id,brain_id,agent_label,redirect_uri,code_challenge,scope,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '10 minutes')",[hashToken(code),auth.params.client_id,req.user!.id,brain.id,agent,auth.params.redirect_uri,auth.params.code_challenge,auth.params.scope,auth.params.resource]);return true;
 });if(!created){res.status(401).send('Sign in again to connect this assistant.');return;}
 authorizationResponse(res,auth.params,{code});
}));
async function authenticateClient(req:Request):Promise<ClientRecord>{
 const header=req.get('authorization');let clientId:string,secret:string|undefined,method='none';
 if(header){if(!/^Basic /i.test(header))throw new OAuthError('invalid_client',401);let decoded:string;try{decoded=Buffer.from(header.slice(6),'base64').toString('utf8');const colon=decoded.indexOf(':');if(colon<0)throw new Error();clientId=decodeURIComponent(decoded.slice(0,colon).replace(/\+/g,' '));secret=decodeURIComponent(decoded.slice(colon+1).replace(/\+/g,' '));}catch{throw new OAuthError('invalid_client',401);}method='client_secret_basic';if(req.body?.client_secret!==undefined||(req.body?.client_id!==undefined&&req.body.client_id!==clientId))throw new OAuthError('invalid_client',401);
 }else{clientId=stringParam(req.body?.client_id,'client_id');if(req.body?.client_secret!==undefined){secret=stringParam(req.body.client_secret,'client_secret');method='client_secret_post';}}
 const client=await getClient(clientId);if(client.metadata.token_endpoint_auth_method!==method||(method!=='none'&&!verifyClientSecret(client,secret)))throw new OAuthError('invalid_client',401);return client;
}
oauthRouter.post('/token',rateLimit('token',60,60000),endpoint(async(req,res)=>{
 const client=await authenticateClient(req),resource=canonicalResource(req.body.resource);
 let tokens;
 if(req.body.grant_type==='authorization_code')tokens=await redeemAuthorizationCode({code:stringParam(req.body.code,'code'),clientId:client.client_id,redirectUri:stringParam(req.body.redirect_uri,'redirect_uri'),verifier:stringParam(req.body.code_verifier,'code_verifier'),resource});
 else if(req.body.grant_type==='refresh_token'){
 if(!client.metadata.grant_types.includes('refresh_token'))throw new OAuthError('unauthorized_client');
 tokens=await rotateRefreshToken({token:stringParam(req.body.refresh_token,'refresh_token'),clientId:client.client_id,resource,scope:req.body.scope===undefined?undefined:normalizeScopes(req.body.scope)});
 }else throw new OAuthError('unsupported_grant_type');
 res.set('Cache-Control','no-store').set('Pragma','no-cache').json(tokens);
}));
oauthRouter.post('/revoke',rateLimit('revoke',60,60000),endpoint(async(req,res)=>{const client=await authenticateClient(req);await revokeToken(stringParam(req.body.token,'token'),client.client_id);res.set('Cache-Control','no-store').status(200).end();}));
oauthRouter.get('/e2e/client.json',(_req,res)=>{if(!config.e2eEnabled){res.sendStatus(404);return;}res.json({client_id:config.baseUrl+'/e2e/client.json',client_name:'Brain verification client',redirect_uris:[config.baseUrl+'/e2e/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'});});
oauthRouter.get('/e2e/callback',(_req,res)=>{if(!config.e2eEnabled){res.sendStatus(404);return;}res.set('Cache-Control','no-store').send('OAuth verification callback.');});
export {bearerAuth} from './bearer.js';
