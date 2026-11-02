import {Router,type Request,type Response} from 'express';
import {z} from 'zod/v4';
import {randomUUID} from 'node:crypto';
import {asWebAuth} from '../brain/engine.js';
import {csrf} from '../auth/session.js';
import {ToolError} from '../tools/service.js';
import {projectTypes,listProjects,getProject,createProject,addItem,updateItem,approveItem,updateProject} from '../projects/service.js';
export const projectsRouter=Router();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str=(value:unknown,max=32000)=>{const text=typeof value==='string'?value.trim():'';if(text.length>max)throw new ToolError('Use no more than '+max+' characters for this field.');return text;};
const version=(value:unknown)=>{const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<1)throw new ToolError('Refresh this project and review the latest version before saving.',409);return parsed;};
const auth=(req:Request,res:Response)=>asWebAuth(req.user!.id,res.locals.brain.id,req.sessionId);
const projectLink=(res:Response,id:string)=>res.locals.brainLink('/dashboard/projects/'+id);
function sourceLink(res:Response,reference:any,projectId:string){
 const kind=reference.kind??reference.collection,id=reference.id;
 if(kind==='url'&&typeof reference.url==='string'){try{const parsed=new URL(reference.url);if(['http:','https:'].includes(parsed.protocol))return parsed.href;}catch{}}
 if(typeof id!=='string'||!uuid.test(id))return undefined;
 const collections:Record<string,string>={fact:'facts',note:'notes',snapshot:'snapshots',handoff:'handoffs',facts:'facts',notes:'notes',snapshots:'snapshots',handoffs:'handoffs'};
 if(collections[kind])return res.locals.brainLink('/dashboard/memory/'+collections[kind]+'/'+id);
 if(kind==='job'||kind==='jobs')return res.locals.brainLink('/dashboard/jobs/'+id);
 if(kind==='project_item')return projectLink(res,projectId)+'&item='+id+'#project-item-'+id;
 return undefined;
}
async function view(req:Request,res:Response,locals:Record<string,unknown>={}){
 const id=req.params.id;if(typeof id!=='string'||!uuid.test(id))throw new ToolError('Project not found.',404);
 const snapshot=await getProject(await auth(req,res),id,{acknowledge:true});
 const data=snapshot as any;
 res.render('project-detail',{title:data.project.title,section:'projects',board:data,projectTypes,newRequestId:randomUUID,sourceLink:(reference:unknown)=>sourceLink(res,reference,id),selectedItem:str(req.query.item,36),values:{},editValues:{},editItemId:'',settingsValues:{},...locals});
}
function mutation(fn:(req:Request,res:Response)=>Promise<void>){return async(req:Request,res:Response)=>{try{await fn(req,res);}catch(caught){const error=caught instanceof z.ZodError?new ToolError(caught.issues.map(issue=>issue.path.join('.')+': '+issue.message).slice(0,3).join('; ')):caught;if(error instanceof ToolError&&[400,403,409,422].includes(error.status)){await view(req,res.status(error.status),{error:error.status===409?'This project changed while you were editing. Your draft is kept below. Review the current version before saving again.':error.message,values:req.params.itemId||req.path.endsWith('/settings')?{}:req.body,editValues:req.params.itemId?req.body:{},editItemId:str(req.params.itemId,36),selectedItem:str(req.params.itemId,36),settingsValues:req.path.endsWith('/settings')?req.body:{}});return;}throw error;}};}
projectsRouter.get('/',async(req,res)=>{const projects=await listProjects(await auth(req,res));res.render('projects',{title:'Living projects',section:'projects',projects});});
projectsRouter.get('/new',(_req,res)=>res.render('project-new',{title:'Start a living project',section:'projects',values:{},requestId:randomUUID()}));
projectsRouter.post('/',csrf,async(req,res)=>{
 const values={title:str(req.body.title,160),goal:str(req.body.goal,12000),allowed_agents:str(req.body.allowed_agents,1024)};
 try{if(!values.title)throw new ToolError('Give the project a name.');const allowed=values.allowed_agents?values.allowed_agents.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean):['all'];const project=await createProject(await auth(req,res),{...values,allowed_agents:allowed,request_id:uuid.test(str(req.body.request_id,36))?str(req.body.request_id,36):undefined});res.redirect(303,projectLink(res,project.id));}
 catch(caught){const error=caught instanceof z.ZodError?new ToolError(caught.issues.map(issue=>issue.path.join('.')+': '+issue.message).slice(0,3).join('; ')):caught;if(error instanceof ToolError&&[400,403,409,422].includes(error.status)){res.status(error.status).render('project-new',{title:'Start a living project',section:'projects',values,requestId:str(req.body.request_id,36)||randomUUID(),error:error.message});return;}throw error;}
});
projectsRouter.get('/:id',(req,res)=>view(req,res));
projectsRouter.get('/:id/state',async(req,res)=>{
 const id=req.params.id;if(typeof id!=='string'||!uuid.test(id)){res.status(404).json({error:'Project not found.'});return;}
 const since=Number(req.query.version??0),identity=await auth(req,res),delta=await getProject(identity,id,{sinceVersion:Number.isSafeInteger(since)?since:0,acknowledge:false});
 if(!delta.changed){const receiptsHtml=await new Promise<string>((resolve,reject)=>res.render('project-receipts',{board:delta},(error,html)=>error?reject(error):resolve(html)));res.json({changed:false,version:delta.project.version,receiptsHtml});return;}
 const board=await getProject(identity,id,{acknowledge:false});
 const html=await new Promise<string>((resolve,reject)=>res.render('project-board',{board,sourceLink:(reference:unknown)=>sourceLink(res,reference,id),projectTypes,newRequestId:randomUUID,selectedItem:''},(error,html)=>error?reject(error):resolve(html)));
 res.json({changed:true,version:board.project.version,project:{title:board.project.title,goal:board.project.goal,status:board.project.status},html});
});
projectsRouter.post('/:id/ack',csrf,async(req,res)=>{const id=str(req.params.id,36);if(!uuid.test(id)){res.status(404).json({error:'Project not found.'});return;}const board=await getProject(await auth(req,res),id,{acknowledge:true});res.json({version:board.project.version});});
projectsRouter.post('/:id/items',csrf,mutation(async(req,res)=>{
 const id=str(req.params.id,36),type=str(req.body.type,32);if(!projectTypes.includes(type as any))throw new ToolError('Choose an item type.');
 const snapshot=await addItem(await auth(req,res),{project_id:id,expected_version:version(req.body.expected_version),title:str(req.body.title,200),type:type as any,content:str(req.body.content,16000),status:req.body.confirm==='yes'?'confirmed':'proposed',source_type:'user_statement',source_refs:[{kind:'statement',label:'Entered by you'}],depends_on:Array.isArray(req.body.depends_on)?req.body.depends_on.map(String):req.body.depends_on?[String(req.body.depends_on)]:[],request_id:str(req.body.request_id,36)||undefined});
 res.redirect(303,projectLink(res,snapshot.project.id));
}));
projectsRouter.post('/:id/items/:itemId',csrf,mutation(async(req,res)=>{
 const id=str(req.params.id,36),itemId=str(req.params.itemId,36);if(!uuid.test(id)||!uuid.test(itemId))throw new ToolError('Project item not found.',404);
 const current=await getProject(await auth(req,res),id,{acknowledge:false});const item=current.items.find((item:any)=>item.id===itemId);if(!item)throw new ToolError('Project item not found.',404);
 await updateItem(await auth(req,res),{project_id:id,item_id:itemId,expected_version:version(req.body.expected_version),title:str(req.body.title,200),content:str(req.body.content,16000),status:str(req.body.status,32) as any,reason:str(req.body.reason,2000),request_id:str(req.body.request_id,36)||undefined});
 res.redirect(303,projectLink(res,id)+'&item='+itemId+'#project-item-'+itemId);
}));
projectsRouter.post('/:id/items/:itemId/review',csrf,mutation(async(req,res)=>{
 const id=str(req.params.id,36),itemId=str(req.params.itemId,36),decision=req.body.decision==='approve'?'approve':req.body.decision==='dispute'?'dispute':undefined;if(!uuid.test(id)||!uuid.test(itemId)||!decision)throw new ToolError('Choose approve or dispute.');
 await approveItem(await auth(req,res),{project_id:id,item_id:itemId,expected_version:version(req.body.expected_version),decision,reason:str(req.body.reason,2000)||undefined,request_id:str(req.body.request_id,36)||undefined});res.redirect(303,projectLink(res,id));
}));
projectsRouter.post('/:id/settings',csrf,mutation(async(req,res)=>{
 const id=str(req.params.id,36);if(!uuid.test(id))throw new ToolError('Project not found.',404);const labels=str(req.body.allowed_agents,1024);
 await updateProject(await auth(req,res),{project_id:id,expected_version:version(req.body.expected_version),title:str(req.body.title,160),goal:str(req.body.goal,12000),status:str(req.body.status,32) as any,allowed_agents:labels?labels.split(',').map(label=>label.trim().toLowerCase()).filter(Boolean):['all'],reason:str(req.body.reason,2000),request_id:str(req.body.request_id,36)||undefined});res.redirect(303,projectLink(res,id));
}));
