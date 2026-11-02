import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {readFile} from 'node:fs/promises';
import ipaddr from 'ipaddr.js';
import {pool} from '../db/index.js';
import {OAuthError,validateRedirectUri,hashSecret,constantEqual} from './security.js';
export type ClientMetadata={client_id?:string;client_name:string;redirect_uris:string[];token_endpoint_auth_method:'none'|'client_secret_basic'|'client_secret_post';grant_types:string[];response_types:string[];[key:string]:unknown};
export type ClientRecord={client_id:string;kind:string;metadata:ClientMetadata;secret_hash:string|null};
const cache=new Map<string,{metadata:ClientMetadata;until:number}>();
export function isPublicAddress(address:string){try{return ipaddr.process(address).range()==='unicast';}catch{return false;}}
export function validCimdUrl(value:string){try{const u=new URL(value),rawPath=value.replace(/^https:\/\/[^/]+/,'').split(/[?#]/)[0];return value.length<=2048&&u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&u.pathname!=='/'&&rawPath.split('/').every(p=>{let s=p;try{s=decodeURIComponent(p);}catch{return false;}return s!=='.'&&s!=='..';});}catch{return false;}}
export function validateClientMetadata(value:unknown,cimdId?:string):ClientMetadata{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new OAuthError('invalid_client_metadata');
 const d=value as Record<string,unknown>;
 if(cimdId&&d.client_id!==cimdId)throw new OAuthError('invalid_client_metadata');
 const name=d.client_name??(cimdId?undefined:'MCP client');
 if(typeof name!=='string'||name.length<1||name.length>200)throw new OAuthError('invalid_client_metadata');
 if(!Array.isArray(d.redirect_uris)||d.redirect_uris.length<1||d.redirect_uris.length>20||d.redirect_uris.some(u=>typeof u!=='string'||u.length>2048||!validateRedirectUri(u)))throw new OAuthError('invalid_redirect_uri');
 const method=d.token_endpoint_auth_method??'none';
 if(!['none','client_secret_basic','client_secret_post'].includes(String(method))||(cimdId&&method!=='none'))throw new OAuthError('invalid_client_metadata');
 if(cimdId&&(d.client_secret!==undefined||d.client_secret_expires_at!==undefined))throw new OAuthError('invalid_client_metadata');
 const grants=d.grant_types??['authorization_code','refresh_token'],responses=d.response_types??['code'];
 if(!Array.isArray(grants)||!grants.includes('authorization_code')||grants.some(v=>!['authorization_code','refresh_token'].includes(v))||!Array.isArray(responses)||responses.length!==1||responses[0]!=='code')throw new OAuthError('invalid_client_metadata');
 return{...(cimdId?{client_id:cimdId}:{}),client_name:name,redirect_uris:d.redirect_uris as string[],token_endpoint_auth_method:method as ClientMetadata['token_endpoint_auth_method'],grant_types:grants as string[],response_types:responses as string[],...(typeof d.client_uri==='string'&&validateRedirectUri(d.client_uri)?{client_uri:d.client_uri}:{})};
}
export function parseCimdBody(body:Buffer,id:string){if(body.length>65536)throw new OAuthError('invalid_client_metadata',400,'Metadata exceeds 64 KiB');try{return validateClientMetadata(JSON.parse(body.toString('utf8')),id);}catch(error){throw error instanceof OAuthError?error:new OAuthError('invalid_client_metadata');}}
export async function fetchCimd(id:string,deps:{resolve?:typeof lookup;get?:typeof https.get;timeoutMs?:number}={}):Promise<ClientMetadata>{
 if(!validCimdUrl(id))throw new OAuthError('invalid_client');
 const saved=cache.get(id);if(saved&&saved.until>Date.now())return saved.metadata;
 const url=new URL(id),controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
 return await Promise.race([new Promise<ClientMetadata>(async(resolve,reject)=>{
 try{
 const answers=await (deps.resolve??lookup)(url.hostname,{all:true,verbatim:true});
 if(!answers.length||answers.some(a=>!isPublicAddress(a.address)))throw new OAuthError('invalid_client',400,'Private metadata addresses are blocked');
 if(controller.signal.aborted)throw new OAuthError('invalid_client');const answer=answers[0];
 const request=(deps.get??https.get)(url,{signal:controller.signal,headers:{Accept:'application/json'},lookup:(_host,_options,callback)=>callback(null,answer.address,answer.family),servername:url.hostname},response=>{
 if(response.statusCode!==200){response.resume();reject(new OAuthError('invalid_client',400,'Metadata fetch failed'));return;}
 const contentType=String(response.headers['content-type']??'').split(';')[0].trim();
 if(!/^application\/(?:[a-zA-Z0-9!#$&^_.+-]+\+)?json$/.test(contentType)){response.resume();reject(new OAuthError('invalid_client_metadata'));return;}
 if(Number(response.headers['content-length']??0)>65536){response.destroy();reject(new OAuthError('invalid_client_metadata',400,'Metadata exceeds 64 KiB'));return;}
 const chunks:Buffer[]=[];let bytes=0;response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>65536){response.destroy();request.destroy();reject(new OAuthError('invalid_client_metadata',400,'Metadata exceeds 64 KiB'));}else chunks.push(chunk);});
 response.on('error',()=>reject(new OAuthError('invalid_client')));response.on('end',()=>{try{const metadata=parseCimdBody(Buffer.concat(chunks),id);if(cache.size>=1000)cache.delete(cache.keys().next().value!);cache.set(id,{metadata,until:Date.now()+86400000});resolve(metadata);}catch(error){reject(error instanceof OAuthError?error:new OAuthError('invalid_client_metadata'));}});
 });request.setTimeout(5000,()=>request.destroy(new Error('Timeout')));request.on('error',()=>reject(new OAuthError('invalid_client')));
 }catch(error){reject(error instanceof OAuthError?error:new OAuthError('invalid_client'));}
 }),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new OAuthError('invalid_client',400,'Metadata timeout'));},deps.timeoutMs??5000);})]);
 }finally{if(timer)clearTimeout(timer);}
}
export async function getClient(id:string):Promise<ClientRecord>{
 if(id.length>2048)throw new OAuthError('invalid_client');
 const existing=await pool.query<ClientRecord>('SELECT client_id,kind,metadata,secret_hash FROM oauth_clients WHERE client_id=$1',[id]);
 if(existing.rows[0]?.kind==='preregistered'||(!id.startsWith('https:')&&existing.rows[0]))return existing.rows[0];
 if(id.startsWith('https:')){const metadata=await fetchCimd(id);await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata,last_seen_at) VALUES($1,'cimd',$2,now()) ON CONFLICT(client_id) DO UPDATE SET metadata=EXCLUDED.metadata,last_seen_at=now()",[id,metadata]);return{client_id:id,kind:'cimd',metadata,secret_hash:null};}
 throw new OAuthError('invalid_client',401);
}
export async function loadPreRegisteredClients(){
 let data:unknown;try{data=JSON.parse(await readFile('config/clients.json','utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(!Array.isArray(data))throw new Error('config/clients.json must be an array');
 for(const item of data){if(!item||typeof item!=='object'||typeof item.client_id!=='string')throw new Error('Invalid preregistered client');const metadata=validateClientMetadata(item.metadata??item);let secretHash:string|null=typeof item.secret_hash==='string'?item.secret_hash:null;if(typeof item.client_secret==='string')secretHash=hashSecret(item.client_secret);if(metadata.token_endpoint_auth_method!=='none'&&!secretHash)throw new Error('Confidential pre-registered client needs a secret');await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata,secret_hash) VALUES($1,'preregistered',$2,$3) ON CONFLICT(client_id) DO UPDATE SET kind='preregistered',metadata=EXCLUDED.metadata,secret_hash=EXCLUDED.secret_hash",[item.client_id,metadata,secretHash]);}
}
export function verifyClientSecret(client:ClientRecord,provided:string|undefined){return !!provided&&!!client.secret_hash&&constantEqual(hashSecret(provided),client.secret_hash);}
