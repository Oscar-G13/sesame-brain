import {z} from 'zod/v4';
import {createProjectSchema,addItemSchema,updateItemSchema,updateProjectSchema,createProject,addItem,updateItem,updateProject,listProjects,getProject,projectHistory} from './service.js';
import type {AuthContext} from '../tools/service.js';

export const projectToolDefinitions={
 projects_list:{description:'List the living projects visible to this assistant. Start here to find the project the user means; never invent an ID.',inputSchema:z.object({})},
 project_create:{description:'Start a persistent project the user requested. Capture its title and goal. Shared by default; choose specific assistant labels for a restricted project. This does not start work or authorize external actions.',inputSchema:createProjectSchema},
 project_brief:{description:'Pick up a project across conversations. Returns the current goal, constraints, decisions, open questions, review needs, source receipts and recent changes. Check before continuing work. Brain only knows records saved through its tools, not the complete Sesame transcript. The retrieval receipt is not proof of native memory synchronization.',inputSchema:z.object({project_id:z.string().uuid(),since_version:z.number().int().min(0).optional(),item_ids:z.array(z.string().uuid()).max(20).optional()})},
 project_add_item:{description:'Record a project constraint, decision, question, milestone, task or artifact with evidence and dependency IDs. Separate a user statement from your summary, inference or tool result. Your entry is a proposal; only the owner can confirm it. depends_on lists prerequisite item IDs. Reuse request_id on retries.',inputSchema:addItemSchema},
 project_update_item:{description:'Correct or advance a project item using the last expected project version and a reason. Confirmed content becomes a proposed change for the owner to review. Corrections preserve history and flag affected dependent work; never claim old results remain valid after their assumptions change.',inputSchema:updateItemSchema},
 project_update:{description:'Update the project goal, title or status with a reason and expected version. Only the owner can change who may access it. Changes never authorize publishing, payments or contacting anyone.',inputSchema:updateProjectSchema},
 project_history:{description:'Show why a project changed: dated saved records, actor, earlier value, later value and evidence. Never invent transcript quotes. Use before_version to page older history.',inputSchema:z.object({project_id:z.string().uuid(),before_version:z.number().int().min(1).optional()})}
};
export const projectReadTools=['projects_list','project_brief','project_history'];
export async function executeProjectTool(a:AuthContext,name:string,input:unknown){
 switch(name){
  case 'projects_list':return{projects:await listProjects(a)};
  case 'project_create':return createProject(a,createProjectSchema.parse(input));
  case 'project_brief':{const v=projectToolDefinitions.project_brief.inputSchema.parse(input);const state=await getProject(a,v.project_id,{sinceVersion:v.since_version,acknowledge:true});const selected=v.item_ids?state.items.filter(item=>v.item_ids!.includes(item.id)):state.items.filter(item=>item.status!=='superseded').slice(0,80);return{...state,items:selected.map(item=>({...item,content:v.item_ids?item.content:item.content.slice(0,1500),content_truncated:!v.item_ids&&item.content.length>1500})),events:state.events.slice(0,20).map(({before,after,...event})=>event),items_omitted:state.items.length-selected.length};}
  case 'project_add_item':return addItem(a,addItemSchema.parse(input));
  case 'project_update_item':return updateItem(a,updateItemSchema.parse(input));
  case 'project_update':return updateProject(a,updateProjectSchema.parse(input));
  case 'project_history':{const v=projectToolDefinitions.project_history.inputSchema.parse(input);return{events:await projectHistory(a,v.project_id,v.before_version)};}
  default:throw new Error('Unknown project tool.');
 }
}
