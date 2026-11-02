import { Router, type Request, type Response, type NextFunction } from 'express';
import { constants } from 'node:fs';
import { lstat,readdir,open } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pool,transaction } from '../db/index.js';
import { asWebAuth,think,enqueueJob,cancelJob } from '../brain/engine.js';
import { aiConfig } from '../brain/config.js';
import { executeTool } from '../tools/service.js';
import { purgeBrainContent } from '../brain/purge.js';
import { csrf } from '../auth/session.js';
import { requireUser } from '../auth/session.js';
export const dashboardRouter=Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const collectionNames=['notes','facts','snapshots','handoffs'] as const;
type Collection=typeof collectionNames[number];
type Brain={id:string;name:string;created_at:Date;content_epoch:string};
const dayKey=(value:Date|string)=>new Date(value).toISOString().slice(0,10);
export const formatNumber=(value:unknown)=>Number(value??0).toLocaleString('en-US');
export const formatDate=(value:Date|string|null|undefined)=>value?new Date(value).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/Los_Angeles'}):'Not yet';
export const relativeTime=(value:Date|string|null|undefined)=>{if(!value)return 'Not yet';const minutes=Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/60000));return minutes<1?'Just now':minutes<60?minutes+'m ago':minutes<1440?Math.floor(minutes/60)+'h ago':minutes<43200?Math.floor(minutes/1440)+'d ago':formatDate(value);};
const collectionSql=`SELECT id,'notes' AS collection,left(text,96) AS title,left(text,220) AS preview,from_agent AS agent,created_at,kind,text AS search_text FROM notes WHERE user_id=$1 AND brain_id=$2
UNION ALL SELECT id,'facts',key,left(value,220),updated_by,updated_at,'fact',key||' '||value FROM facts WHERE user_id=$1 AND brain_id=$2
UNION ALL SELECT id,'snapshots',coalesce(title,'Untitled snapshot'),left(content,220),agent_label,created_at,kind,coalesce(title,'')||' '||content FROM snapshots WHERE user_id=$1 AND brain_id=$2
UNION ALL SELECT id,'handoffs',title,left(context,220),from_agent,created_at,status,title||' '||context||' '||coalesce(next_steps,'')||' '||coalesce(summary,'') FROM handoffs WHERE user_id=$1 AND brain_id=$2`;
async function loadBrain(req:Request,res:Response,next:NextFunction){
 const brains=(await pool.query<Brain>('SELECT id,name,created_at,content_epoch::text FROM brains WHERE user_id=$1 ORDER BY created_at,id',[req.user!.id])).rows;
 if(req.query.brain!==undefined&&typeof req.query.brain!=='string'){res.status(404).send('Brain not found.');return;}
 const requested=typeof req.query.brain==='string'?req.query.brain:undefined;
 const brain=requested?brains.find(item=>item.id===requested):brains.find(item=>item.name==='default')??brains[0];
 if(!brain){res.status(404).send('Brain not found.');return;}
 res.locals.aiReady=aiConfig.ready;res.locals.brains=brains;res.locals.brain=brain;res.locals.section='overview';
 res.locals.formatNumber=formatNumber;res.locals.formatDate=formatDate;res.locals.relativeTime=relativeTime;
 res.locals.brainLink=(path:string,extra:Record<string,string>={})=>path+'?'+new URLSearchParams({brain:brain.id,...extra});
 res.locals.activityLabel=(kind:string)=>({note_left:'Left a note',notes_read:'Read notes',handoff_created:'Handed off a task',handoff_accepted:'Picked up a handoff',handoff_completed:'Finished a handoff',fact_stored:'Saved a fact',fact_forgotten:'Removed a fact',snapshot_saved:'Saved a snapshot',think:'Thought something through',think_completed:'Thought something through',job_queued:'Started a task',job_completed:'Finished a task',job_stopped:'Stopped a task',session_closed:'Closed a conversation',nightly_completed:'Updated overnight insights'}[kind]??kind.replaceAll('_',' '));
 next();
}
dashboardRouter.use(requireUser,loadBrain);
dashboardRouter.get('/',async(req,res)=>{
 const user=req.user!.id,brain=res.locals.brain as Brain;
 const [counts,agents,activity,recent,jobs,insights,usage,sessions]=await Promise.all([
  pool.query(`SELECT (SELECT count(*) FROM notes WHERE user_id=$1 AND brain_id=$2)::int AS notes,(SELECT count(*) FROM facts WHERE user_id=$1 AND brain_id=$2)::int AS facts,(SELECT count(*) FROM snapshots WHERE user_id=$1 AND brain_id=$2)::int AS snapshots,(SELECT count(*) FROM handoffs WHERE user_id=$1 AND brain_id=$2)::int AS handoffs`,[user,brain.id]),
  pool.query(`SELECT g.agent_label,count(*)::int AS connections,max(g.last_used_at) AS last_used_at,array_agg(DISTINCT coalesce(c.metadata->>'client_name','Connected app')) AS clients FROM grants g LEFT JOIN oauth_clients c ON c.client_id=g.client_id WHERE g.user_id=$1 AND g.brain_id=$2 AND g.revoked_at IS NULL GROUP BY g.agent_label ORDER BY min(g.created_at),g.agent_label`,[user,brain.id]),
  pool.query(`SELECT id,actor_agent,kind,ref_id,created_at FROM activity WHERE user_id=$1 AND brain_id=$2 ORDER BY created_at DESC,id DESC LIMIT 8`,[user,brain.id]),
  pool.query('SELECT id,collection,title,preview,agent,created_at,kind FROM ('+collectionSql+') memory ORDER BY created_at DESC,id DESC LIMIT 5',[user,brain.id]),
  pool.query('SELECT id,title,task,state,requested_by_agent,created_at,finished_at,result_summary FROM jobs WHERE user_id=$1 AND brain_id=$2 ORDER BY created_at DESC,id DESC LIMIT 4',[user,brain.id]),
  pool.query("SELECT id,title,kind,left(content,240) AS preview,created_at FROM snapshots WHERE user_id=$1 AND brain_id=$2 AND kind IN ('formulation','audit','diff') ORDER BY created_at DESC LIMIT 3",[user,brain.id]),
  pool.query("SELECT local_date::text,sum(input_tokens+output_tokens)::bigint AS tokens FROM usage WHERE user_id=$1 AND brain_id=$2 AND local_date>=((now() AT TIME ZONE 'America/Los_Angeles')::date-13) GROUP BY local_date ORDER BY local_date",[user,brain.id]),
  pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE closed_at IS NULL AND last_activity_at>now()-interval '30 minutes')::int AS active FROM brain_sessions WHERE user_id=$1 AND brain_id=$2",[user,brain.id])
 ]);
 const dailyActivity=(await pool.query("SELECT (created_at AT TIME ZONE 'America/Los_Angeles')::date::text AS day,count(*)::int AS n FROM activity WHERE user_id=$1 AND brain_id=$2 AND created_at>=now()-interval '14 days' GROUP BY day ORDER BY day",[user,brain.id])).rows;
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
 const days=Array.from({length:14},(_,index)=>{const date=new Date(today+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-13+index);const key=dayKey(date);return{key,label:date.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}),count:Number(dailyActivity.find(row=>row.day===key)?.n??0)};});
 const totals=counts.rows[0];const total=Object.values(totals).reduce((sum:number,value)=>sum+Number(value),0);
 const dailyBudget=aiConfig.dailyTokens;
 const tokensToday=Number(usage.rows.find(row=>row.local_date===today)?.tokens??0);
 const jobStats=(await pool.query("SELECT count(*) FILTER(WHERE state IN ('queued','running'))::int AS pending,count(*) FILTER(WHERE state IN ('done','partial'))::int AS finished FROM jobs WHERE user_id=$1 AND brain_id=$2",[user,brain.id])).rows[0];
 res.render('dashboard',{notice:req.query.cleared==='1'?'Your brain is clear. Your account and assistant connections are still here.':undefined,title:'Overview',section:'overview',counts:totals,total,agents:agents.rows,activity:activity.rows,recent:recent.rows,jobs:jobs.rows,jobStats,insights:insights.rows,usage:usage.rows,sessions:sessions.rows[0],days,activityMax:Math.max(1,...days.map(day=>day.count)),activityTotal:days.reduce((sum,day)=>sum+day.count,0),tokensToday,dailyBudget,usagePercent:Math.min(100,tokensToday/dailyBudget*100)});
});
dashboardRouter.get('/memory',async(req,res)=>{
 const brain=res.locals.brain as Brain,q=typeof req.query.q==='string'?req.query.q.trim().slice(0,160):'',type=collectionNames.includes(req.query.type as Collection)?req.query.type as Collection:'all';
 const agent=typeof req.query.agent==='string'?req.query.agent.slice(0,32):'';
 const page=Math.max(1,Math.min(100000,Number.parseInt(String(req.query.page??1),10)||1));
 const filter=` WHERE ($3='' OR search_text ILIKE '%'||$3||'%') AND ($4='all' OR collection=$4) AND ($5='' OR agent=$5)`;
 const params=[req.user!.id,brain.id,q,type,agent];
 const [rows,total,agents]=await Promise.all([pool.query('SELECT id,collection,title,preview,agent,created_at,kind FROM ('+collectionSql+') memory'+filter+' ORDER BY created_at DESC,id DESC LIMIT 36 OFFSET $6',[...params,(page-1)*36]),pool.query('SELECT count(*)::int AS n FROM ('+collectionSql+') memory'+filter,params),pool.query('SELECT DISTINCT agent FROM ('+collectionSql+') memory ORDER BY agent',[req.user!.id,brain.id])]);
 res.render('memory',{title:'Memory',section:'memory',rows:rows.rows,count:total.rows[0].n,q,type,agent,agents:agents.rows,page,pages:Math.max(1,Math.ceil(total.rows[0].n/36))});
});
dashboardRouter.get('/memory/:collection/:id',async(req,res)=>{
 const collection=req.params.collection as Collection,id=req.params.id;
 if(!collectionNames.includes(collection)||typeof id!=='string'||!UUID.test(id)){res.status(404).send('Memory not found.');return;}
 const brain=res.locals.brain as Brain;
 const item=(await pool.query(`SELECT * FROM ${collection} WHERE user_id=$1 AND brain_id=$2 AND id=$3`,[req.user!.id,brain.id,id])).rows[0];
 if(!item){res.status(404).send('Memory not found.');return;}
 const title=collection==='facts'?item.key:collection==='notes'?item.text.slice(0,96):item.title??'Untitled snapshot';
 let content=collection==='facts'?item.value:collection==='notes'?item.text:collection==='handoffs'?item.context:item.content;
 if(collection==='snapshots'&&['formulation','audit','diff'].includes(item.kind)){try{content=JSON.stringify(JSON.parse(content),null,2);}catch{/* Plain text remains readable and escaped. */}}
 res.render('memory-detail',{title,section:'memory',item,collection,content,heading:title});
});
dashboardRouter.get('/jobs',async(req,res)=>{
 const brain=res.locals.brain as Brain,state=['queued','running','done','partial','failed'].includes(String(req.query.state))?String(req.query.state):'all';
 const rows=await pool.query("SELECT id,title,task,state,requested_by_agent,created_at,started_at,finished_at,tokens_used,result_summary FROM jobs WHERE user_id=$1 AND brain_id=$2 AND ($3='all' OR state=$3) ORDER BY created_at DESC,id DESC LIMIT 60",[req.user!.id,brain.id,state]);
 res.render('jobs',{title:'Background work',section:'jobs',jobs:rows.rows,state});
});

dashboardRouter.get('/capture',(_req,res)=>res.render('capture',{title:'Add a memory',section:'memory',type:'note',text:'',key:''}));
dashboardRouter.post('/capture',csrf,async(req,res)=>{
 const type=req.body.type==='fact'?'fact':'note',text=typeof req.body.text==='string'?req.body.text.trim():'',key=typeof req.body.key==='string'?req.body.key.trim():'';
 if(!text||text.length>8000||(type==='fact'&&(!key||key.length>128))){res.status(400).render('capture',{title:'Add a memory',section:'memory',type,text,key,error:'Add a memory of up to 8,000 characters. Shared facts also need a name of up to 128 characters.'});return;}
 const brain=res.locals.brain as Brain,auth=await asWebAuth(req.user!.id,brain.id,req.sessionId);
 const result=await executeTool(auth,type==='fact'?'remember':'leave_note',type==='fact'?{key,value:text}:{to:'all',text}) as {id:string};
 res.redirect(303,res.locals.brainLink('/dashboard/memory/'+(type==='fact'?'facts':'notes')+'/'+result.id));
});
dashboardRouter.get('/think',(_req,res)=>res.render('think',{title:'Think with Brain',section:'think',text:'',depth:'quick',answer:undefined,jobId:undefined,trailer:undefined}));
dashboardRouter.post('/think',csrf,async(req,res)=>{
 const text=typeof req.body.text==='string'?req.body.text.trim():'',depth=req.body.depth==='deep'?'deep':'quick';
 const locals={title:'Think with Brain',section:'think',text,depth,answer:undefined,jobId:undefined,trailer:undefined};
 if(!text||text.length>32000){res.status(400).render('think',{...locals,error:'Ask a question of up to 32,000 characters.'});return;}
 if(!aiConfig.ready){res.status(503).render('think',{...locals,error:'Brain’s thinking is not available yet. Your saved memory still works.'});return;}
 try{const brain=res.locals.brain as Brain,auth=await asWebAuth(req.user!.id,brain.id,req.sessionId);const result=await think(auth,{text,depth,spoken:false},req.sessionId);res.render('think',{...locals,answer:result.answer,jobId:result.job_id,trailer:result.trailer});}
 catch{res.status(503).render('think',{...locals,error:'Brain could not finish this thought. Please try again in a little while.'});}
});
dashboardRouter.get('/jobs/new',(_req,res)=>res.render('new-job',{title:'Start a task',section:'jobs',task:'',deliver:'brain'}));
dashboardRouter.post('/jobs',csrf,async(req,res)=>{
 const task=typeof req.body.task==='string'?req.body.task.trim():'',deliver=req.body.deliver==='brain+email'?'brain+email':'brain';
 const locals={title:'Start a task',section:'jobs',task,deliver};
 if(!task||task.length>32000){res.status(400).render('new-job',{...locals,error:'Describe a task of up to 32,000 characters.'});return;}
 if(!aiConfig.ready){res.status(503).render('new-job',{...locals,error:'Background thinking is not available yet. Your saved memory still works.'});return;}
 try{const brain=res.locals.brain as Brain,auth=await asWebAuth(req.user!.id,brain.id,req.sessionId);const result=await enqueueJob(auth,{task,deliver});if(!result.job_id){res.status(409).render('new-job',{...locals,error:result.ack});return;}res.redirect(303,res.locals.brainLink('/dashboard/jobs/'+result.job_id));}
 catch{res.status(503).render('new-job',{...locals,error:'This task could not be started. Please try again in a little while.'});}
});

dashboardRouter.get('/jobs/:id',async(req,res)=>{
 const brain=res.locals.brain as Brain,id=req.params.id;
 if(typeof id!=='string'||!UUID.test(id)){res.status(404).send('Task not found.');return;}
 const job=(await pool.query('SELECT id,title,task,state,requested_by_agent,created_at,started_at,finished_at,tokens_used,result_summary,result_note_id,handoff_id,error,deliver FROM jobs WHERE user_id=$1 AND brain_id=$2 AND id=$3',[req.user!.id,brain.id,id])).rows[0];
 if(!job){res.status(404).send('Task not found.');return;}
 res.render('job-detail',{title:job.title??'Background work',section:'jobs',job});
});
dashboardRouter.get('/insights',async(req,res)=>{
 const brain=res.locals.brain as Brain;
 const rows=await pool.query("SELECT id,title,kind,left(content,450) AS preview,created_at,agent_label FROM snapshots WHERE user_id=$1 AND brain_id=$2 AND kind IN ('formulation','audit','diff') ORDER BY created_at DESC,id DESC LIMIT 45",[req.user!.id,brain.id]);
 res.render('insights',{title:'Overnight insights',section:'insights',insights:rows.rows});
});
dashboardRouter.get('/usage',async(req,res)=>{
 const brain=res.locals.brain as Brain;
 const rows=await pool.query("SELECT local_date::text,model,input_tokens,output_tokens FROM usage WHERE user_id=$1 AND brain_id=$2 AND local_date>=((now() AT TIME ZONE 'America/Los_Angeles')::date-29) ORDER BY local_date DESC,model",[req.user!.id,brain.id]);
 const totals=rows.rows.reduce((sum,row)=>({input:sum.input+Number(row.input_tokens),output:sum.output+Number(row.output_tokens)}),{input:0,output:0});
 const dailyBudget=aiConfig.dailyTokens;
 res.render('usage',{title:'Usage',section:'usage',rows:rows.rows,totals,dailyBudget});
});

dashboardRouter.get('/clear',(_req,res)=>res.render('clear',{title:'Clear brain content',section:'settings'}));
dashboardRouter.post('/clear',csrf,async(req,res)=>{
 if(req.body.confirm!=='CLEAR'){res.status(400).render('clear',{title:'Clear brain content',section:'settings',error:'Type CLEAR to confirm.'});return;}
 const brain=res.locals.brain as Brain;
 await purgeBrainContent(req.user!.id,brain.id);
 res.redirect(303,res.locals.brainLink('/dashboard',{cleared:'1'}));
});

const fileNameAllowed=(name:string)=>/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)&&!name.includes('..');
async function safeWorkspace(userId:string,brain:Brain):Promise<string|undefined>{
 if(!UUID.test(userId)||!UUID.test(brain.id)||!/^[0-9]+$/.test(brain.content_epoch))return undefined;
 let directory=aiConfig.workspace;
 for(const component of ['',userId,brain.id,brain.content_epoch]){
  if(component)directory=join(directory,component);
  try{const stat=await lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory())return undefined;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
 }
 return directory;
}
dashboardRouter.get('/files',async(req,res)=>{
 const brain=res.locals.brain as Brain;
 const files=await transaction(async db=>{
  if(!(await db.query('SELECT id FROM brains WHERE user_id=$1 AND id=$2 AND content_epoch=$3 FOR SHARE',[req.user!.id,brain.id,brain.content_epoch])).rowCount)return [];
  const directory=await safeWorkspace(req.user!.id,brain);if(!directory)return [];
  const entries=await readdir(directory,{withFileTypes:true}),files=[];
  for(const entry of entries){if(!entry.isFile()||!fileNameAllowed(entry.name))continue;try{const stat=await lstat(join(directory,entry.name));if(stat.isSymbolicLink()||!stat.isFile())continue;files.push({name:entry.name,bytes:stat.size,updated_at:stat.mtime});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  return files.sort((a,b)=>b.updated_at.getTime()-a.updated_at.getTime()).slice(0,100);
 });
 res.render('files',{title:'Your files',section:'files',files});
});
dashboardRouter.get('/files/:name',async(req,res)=>{
 const brain=res.locals.brain as Brain,name=req.params.name;
 if(typeof name!=='string'||!fileNameAllowed(name)){res.status(404).send('File not found.');return;}
 const file=await transaction(async db=>{
  if(!(await db.query('SELECT id FROM brains WHERE user_id=$1 AND id=$2 AND content_epoch=$3 FOR SHARE',[req.user!.id,brain.id,brain.content_epoch])).rowCount)return undefined;
  const directory=await safeWorkspace(req.user!.id,brain);if(!directory)return undefined;
  try{const handle=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();if(!stat.isFile()){await handle.close();return undefined;}return{handle,size:stat.size};}
  catch(error){if(['ENOENT','ELOOP'].includes((error as NodeJS.ErrnoException).code??''))return undefined;throw error;}
 });
 if(!file){res.status(404).send('File not found.');return;}
 res.set({'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="'+name+'"','Content-Length':String(file.size),'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
 await pipeline(file.handle.createReadStream({autoClose:true}),res);
});

dashboardRouter.post('/jobs/:id/cancel',csrf,async(req,res)=>{
 const brain=res.locals.brain as Brain,id=req.params.id;
 if(typeof id!=='string'||!UUID.test(id)){res.status(404).send('Task not found.');return;}
 const auth=await asWebAuth(req.user!.id,brain.id,req.sessionId);
 await cancelJob(auth,id);
 res.redirect(303,res.locals.brainLink('/dashboard/jobs/'+id));
});
