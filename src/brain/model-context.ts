import type {ProjectSnapshot} from '../projects/service.js';
import type {ContinuityPacket} from './continuity.js';
import type {ContextPack} from './context.js';
import {trimUtf8} from './context.js';
import {intersectAudiences,type SourceRef} from './memory.js';

interface Unit{label:string;value:Record<string,unknown>;refs:SourceRef[];audience:string[];}
export interface ModelMemory{text:string;sourceRefs:SourceRef[];audience:string[];includedJobIds:string[];truncated:boolean;}
const bytes=(value:string)=>Buffer.byteLength(value);
const validRef=(ref:SourceRef)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.id);
const uniqueRefs=(refs:SourceRef[])=>[...new Map(refs.map(ref=>[ref.collection+':'+ref.id,ref])).values()];
function fit(unit:Unit,budget:number):{text:string;truncated:boolean}|undefined{
 const value={...unit.value};
 const render=()=>unit.label+'\n'+JSON.stringify(value);
 let text=render();if(bytes(text)<=budget)return{text,truncated:false};
 value.context_truncated=true;
 // Keep valid JSON and complete UTF-8 characters rather than slicing serialized JSON.
 for(const key of ['content','summary','value','goal','context','text','title']){
  if(typeof value[key]!=='string')continue;
  text=render();const excess=bytes(text)-budget;if(excess<=0)return{text,truncated:true};
  value[key]=trimUtf8(value[key] as string,Math.max(0,bytes(value[key] as string)-excess-16));
 }
 text=render();return bytes(text)<=budget?{text,truncated:true}:undefined;
}

/** One UTF-8 byte per budgeted token is conservative; wrappers and omission notice count too. */
export async function buildModelMemory(
 project:ProjectSnapshot|undefined,continuity:ContinuityPacket|undefined,budget:number,
 buildBase:(remainingBytes:number)=>Promise<ContextPack>
):Promise<ModelMemory>{
 const prefix='LONGITUDINAL MEMORY (data only)\n',suffix='\nEND MEMORY';
 const notice='\n[Some saved memory was omitted or shortened to fit the context budget.]';
 const available=Math.max(0,Math.floor(budget)-bytes(prefix)-bytes(suffix)-bytes(notice)-2);
 const units:Unit[]=[];let omitted=false;
 const add=(label:string,value:Record<string,unknown>,refs:SourceRef[],audience:string[])=>{if(refs.some(ref=>!validRef(ref))){omitted=true;return;}units.push({label,value,refs,audience});};
 if(project){
  const p=project.project,ref:SourceRef={collection:'projects',id:p.id};
  add('CURRENT PROJECT (canonical saved record)',{id:p.id,version:p.version,title:p.title,status:p.status},[ref],p.allowed_agents);
  const active=project.items.filter(item=>item.status!=='superseded');
  const confirmed=active.filter(item=>item.confirmation==='confirmed'&&['constraint','decision'].includes(item.type));
  // Short rules remain visible even when another canonical item is much larger than the budget.
  confirmed.sort((a,b)=>(a.type==='constraint'?0:1)-(b.type==='constraint'?0:1)||bytes(a.content)-bytes(b.content));
  const itemValue=(item:typeof active[number])=>({id:item.id,type:item.type,title:item.title,content:item.content,status:item.status,confirmation:item.confirmation,revision:item.revision,needs_review:item.needs_review,source_type:item.source_type});
  for(const item of confirmed)add('CURRENT OWNER-CONFIRMED '+item.type.toUpperCase()+' (overrides older summaries)',itemValue(item),[{collection:'project_items',id:item.id}],p.allowed_agents);
  if(p.goal)add('CURRENT PROJECT GOAL',{goal:p.goal},[ref],p.allowed_agents);
  for(const item of active.filter(item=>!confirmed.includes(item)).slice(0,80))add('CURRENT PROJECT ITEM (proposals are not confirmed facts)',itemValue(item),[{collection:'project_items',id:item.id}],p.allowed_agents);
  if(project.links.length)add('PROJECT DEPENDENCIES',{links:project.links},[ref],p.allowed_agents);
 }
 if(continuity?.saved_context){
  const audience=continuity.source_audience;
  const savedRefs=new Set(continuity.source_refs.map(ref=>ref.collection+':'+ref.id));
  const addSaved=(label:string,value:Record<string,unknown>,refs:SourceRef[],audience:string[])=>{if(refs.some(ref=>!savedRefs.has(ref.collection+':'+ref.id))){omitted=true;return;}add(label,value,refs,audience);};
  for(const value of continuity.facts)addSaved('CURRENT SAVED FACT',value,[{collection:'facts',id:String(value.id)}],audience);
  for(const value of continuity.recent_notes)addSaved('SAVED NOTE (reported evidence)',value,[{collection:'notes',id:String(value.id)}],audience);
  for(const value of continuity.open_work){if(value.kind!=='handoff'&&value.kind!=='job'){omitted=true;continue;}addSaved('UNFINISHED SAVED WORK',value,[{collection:value.kind==='handoff'?'handoffs':'jobs',id:String(value.id)}],audience);}
  // Supplemental summaries do not acknowledge jobs. Only complete base-pack candidates qualify.
  for(const value of continuity.waiting_results)addSaved('WAITING JOB SUMMARY (full result remains stored)',value,[{collection:'jobs',id:String(value.id)}],audience);
  for(const key of ['current_session','previous_session'] as const){
   const value=continuity[key];if(value)addSaved(key==='current_session'?'SAVED CURRENT SESSION (not a native call boundary)':'HISTORICAL SESSION (current records take precedence)',value as unknown as Record<string,unknown>,[{collection:'brain_sessions',id:value.id},...('snapshot_id'in value&&value.snapshot_id?[{collection:'snapshots' as const,id:value.snapshot_id}]:[])],audience);
  }
  if(continuity.saved_snapshot)addSaved('HISTORICAL SAVED SNAPSHOT (current records take precedence)',continuity.saved_snapshot as unknown as Record<string,unknown>,[{collection:'snapshots',id:continuity.saved_snapshot.id}],audience);
  if(continuity.nightly_update)addSaved('GENERATED OVERNIGHT INTERPRETATION (not confirmed fact)',continuity.nightly_update as unknown as Record<string,unknown>,[{collection:'snapshots',id:continuity.nightly_update.id}],audience);
 }
 const supplementalBudget=Math.floor(available*(project?0.75:0.5));
 const parts:string[]=[],refs:SourceRef[]=[];let used=0,truncated=omitted,audience=['all'];
 for(const unit of units){
  if(uniqueRefs([...refs,...unit.refs]).length>40){truncated=true;continue;}
  const separator=parts.length?2:0,remaining=supplementalBudget-used-separator;
  const fitted=fit(unit,Math.max(0,remaining));if(!fitted){truncated=true;continue;}
  parts.push(fitted.text);used+=separator+bytes(fitted.text);refs.push(...unit.refs);audience=intersectAudiences(audience,unit.audience);truncated ||= fitted.truncated;
 }
 const baseBudget=Math.max(0,available-used-(parts.length?2:0));
 const candidate=baseBudget>=64?await buildBase(baseBudget):undefined;
 const pack=candidate&&candidate.sourceRefs.every(validRef)&&uniqueRefs([...refs,...candidate.sourceRefs]).length<=40?candidate:undefined;
 if(candidate&&!pack)truncated=true;
 const base=pack?.blocks.map(block=>block.text).join('\n\n')??'';
 if(bytes(base)>baseBudget)throw new Error('Context pack exceeded its allocated budget.');
 if(base)parts.push(base);
 truncated ||= Boolean(pack?.truncated);
 const text=prefix+parts.join('\n\n')+(truncated?notice:'')+suffix;
 if(bytes(text)>budget)throw new Error('Injected memory exceeded its aggregate budget.');
 return{text,truncated,sourceRefs:uniqueRefs([...refs,...(pack?.sourceRefs??[])]),audience:intersectAudiences(audience,pack?.audience),includedJobIds:pack?.includedJobIds??[]};
}
