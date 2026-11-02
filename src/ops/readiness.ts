import http from 'node:http';
import {pool} from '../db/index.js';
import {aiConfig} from '../brain/config.js';
import {getAiAccess} from '../auth/access.js';
import {nightlyActivitySql} from '../brain/nightly.js';
type Subsystem='provider'|'sandbox'|'scheduler';
const codes=new Set(['ready','not_configured','credentials_rejected','capacity_limited','unavailable','validation_failed','scheduler_error']);
export async function reportSubsystem(key:Subsystem,ok:boolean,code:string):Promise<void>{
 const safe=codes.has(code)?code:'unavailable';
 await pool.query("INSERT INTO operational_status(key,ok,code) VALUES('monitor_started',true,'ready') ON CONFLICT DO NOTHING");
 await pool.query('INSERT INTO operational_status(key,ok,code,checked_at) VALUES($1,$2,$3,now()) ON CONFLICT(key) DO UPDATE SET ok=EXCLUDED.ok,code=EXCLUDED.code,checked_at=now()',[key,ok,safe]);cached=undefined;
}
export interface Readiness {ok:boolean;db:boolean;provider:{configured:boolean;ok:boolean};sandbox:{configured:boolean;ok:boolean};jobs:{ok:boolean};storage:{ok:boolean};nightly:{ok:boolean};backup:{configured:boolean;deferred:boolean;ok:boolean};restore:{configured:boolean;deferred:boolean;ok:boolean};checked_at:string;issues:string[];}
let cached:{until:number;value:Readiness}|undefined,inflight:Promise<Readiness>|undefined;
async function sandboxHealth():Promise<boolean>{
 if(!aiConfig.sandboxUrl)return true;
 try{const url=new URL(aiConfig.sandboxUrl);if(url.protocol!=='unix:'||url.host)return false;
 return await new Promise<boolean>(resolve=>{const request=http.get({socketPath:decodeURIComponent(url.pathname),path:'/health',signal:AbortSignal.timeout(1200)},response=>{let bytes=0,text='';response.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024)response.destroy();else text+=chunk;});response.on('end',()=>{try{resolve(response.statusCode===200&&JSON.parse(text).ok===true);}catch{resolve(false);}});response.on('error',()=>resolve(false));});request.on('error',()=>resolve(false));});
 }catch{return false;}
}
async function collect():Promise<Readiness>{
 const result:Readiness={ok:false,db:false,provider:{configured:aiConfig.ready,ok:!aiConfig.ready},sandbox:{configured:Boolean(aiConfig.sandboxUrl),ok:!aiConfig.sandboxUrl},jobs:{ok:true},storage:{ok:true},nightly:{ok:true},backup:{configured:false,deferred:true,ok:true},restore:{configured:false,deferred:true,ok:true},checked_at:new Date().toISOString(),issues:[]};
 try{
 const rows=(await pool.query('SELECT key,ok,code,checked_at FROM operational_status')).rows;result.db=true;
 const status=new Map(rows.map(row=>[row.key,row]));
 const fresh=(key:string,ageMs:number)=>{const row=status.get(key);return Boolean(row?.ok&&Date.now()-new Date(row.checked_at).getTime()<ageMs);};
 result.provider.ok=!aiConfig.ready||fresh('provider',20*60000);
 result.sandbox.ok=await sandboxHealth();
 const jobs=(await pool.query("SELECT EXISTS(SELECT 1 FROM jobs WHERE state='running' AND started_at<now()-interval '20 minutes') OR EXISTS(SELECT 1 FROM jobs WHERE state='queued' AND created_at<now()-interval '60 minutes') AS stalled")).rows[0];
 result.jobs.ok=!jobs.stalled;
 result.storage.ok=status.get('disk')?.ok!==false;
 if(aiConfig.ready){
 const nightly=(await pool.query("WITH local_clock AS (SELECT now() AT TIME ZONE 'America/Los_Angeles' AS t), due AS (SELECT ((t::date-CASE WHEN extract(hour from t)<$1+2 THEN 1 ELSE 0 END)+make_interval(hours=>$1)) AT TIME ZONE 'America/Los_Angeles' AS end_at FROM local_clock) SELECT EXISTS(SELECT 1 FROM brains b JOIN users u ON u.id=b.user_id CROSS JOIN due WHERE u.ai_access_state='approved' AND u.deleted_at IS NULL AND due.end_at>=COALESCE((SELECT checked_at FROM operational_status WHERE key='monitor_started'),now()) AND EXISTS(SELECT 1 FROM activity a WHERE a.user_id=b.user_id AND a.brain_id=b.id AND "+nightlyActivitySql('a')+" AND a.created_at>=due.end_at-interval '24 hours' AND a.created_at<due.end_at) AND NOT EXISTS(SELECT 1 FROM nightly_runs n WHERE n.user_id=b.user_id AND n.brain_id=b.id AND n.local_date=(due.end_at AT TIME ZONE 'America/Los_Angeles')::date AND n.state='done')) AS missing",[aiConfig.nightlyHour])).rows[0];
 result.nightly.ok=!nightly.missing&&fresh('scheduler',20*60000);
 }
 // Backup and restore work is explicitly deferred by the owner, not a release gate.
 if(!result.provider.ok)result.issues.push('Hosted AI is unavailable or its readiness check is stale. Saved memory remains available.');
 if(!result.sandbox.ok)result.issues.push('Code execution is unavailable. Other memory tools remain available.');
 if(!result.storage.ok)result.issues.push('Host storage is above the warning threshold. The operator should inspect capacity.');
 if(!result.jobs.ok)result.issues.push('Background work is delayed. The operator should inspect the queue.');
 if(!result.nightly.ok)result.issues.push('An overnight update is overdue or failed. The operator should inspect nightly status.');


 result.ok=result.db&&result.provider.ok&&result.sandbox.ok&&result.jobs.ok&&result.storage.ok&&result.nightly.ok&&result.backup.ok&&result.restore.ok;
 }catch{result.issues=['Service readiness could not be checked.'];result.db=false;}
 return result;
}
export async function getReadiness():Promise<Readiness>{
 if(cached&&cached.until>Date.now())return structuredClone(cached.value);
 if(!inflight)inflight=collect().then(value=>{cached={until:Date.now()+15000,value};return value;}).finally(()=>{inflight=undefined;});
 return structuredClone(await inflight);
}
export async function getAccountOperationalNotices(userId:string):Promise<string[]>{
 const access=await getAiAccess(userId),readiness=await getReadiness();
 const notices=access.approved?[]:[access.reason];
 if(access.approved)notices.push(...readiness.issues);
 const failed=(await pool.query("SELECT EXISTS(SELECT 1 FROM jobs WHERE user_id=$1 AND state='failed' AND finished_at>now()-interval '24 hours') AS failed",[userId])).rows[0].failed;
 if(failed)notices.push('One of your recent background tasks stopped. Its details are available in Tasks.');
 return notices;
}
