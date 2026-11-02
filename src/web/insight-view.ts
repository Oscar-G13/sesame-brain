export interface InsightEntry {label?:string;text:string;evidence?:string;confidence?:string;date?:string;alternatives?:string[];}
export interface InsightSection {title:string;entries:InsightEntry[];}
export interface InsightView {title:string;summary:string;sections:InsightSection[];structured:boolean;}
const text=(value:unknown)=>typeof value==='string'?value:'';
const list=(value:unknown):any[]=>Array.isArray(value)?value:[];
const words=(value:unknown)=>text(value).replaceAll('_',' ');
export function insightView(kind:string,content:string):InsightView{
 let data:any;try{data=JSON.parse(content);}catch{return{title:'Saved reflection',summary:content.slice(0,350),sections:[],structured:false};}
 const sections:InsightSection[]=[];
 const add=(title:string,entries:InsightEntry[])=>{if(entries.length)sections.push({title,entries});};
 if(kind==='formulation'){
  add('Themes to consider',list(data.core_themes).map(theme=>({label:text(theme.theme),text:[text(theme.description),text(theme.interpretation?.text)].filter(Boolean).join('\n\n'),evidence:theme.interpretation?'hypothesis':undefined,confidence:text(theme.confidence),alternatives:list(theme.alternative_explanations).map(text).filter(Boolean)})));
  add('Evidence recorded',list(data.core_themes).flatMap(theme=>list(theme.evidence).map(item=>({label:text(theme.theme),text:text(item.detail),evidence:words(item.evidence_type),date:text(item.date)}))));
  add('Dated relationship reports',list(data.relationships_by_person).map(person=>({label:text(person.name),text:text(person.current_status?.report),date:text(person.current_status?.date),evidence:words(person.current_status?.evidence_type)})));
  add('Questions still open',list(data.open_questions_for_further_exploration).map(item=>({text:text(item)})));
  add('Limits of this reflection',list(data.limitations).map(item=>({text:text(item)})));
  return{title:text(data.title)||'A wider view',summary:text(data.executive_summary)||'A conversation-derived interpretation of the record you shared with Brain.',sections,structured:true};
 }
 if(kind==='audit'){
  add('Items worth a second look',list(data.flags).map(flag=>({label:text(flag.type),text:[text(flag.item),text(flag.why),'Suggested treatment: '+text(flag.treatment)].filter(Boolean).join('\n\n')})));
  add('Limits of this review',list(data.limitations).map(item=>({text:text(item)})));
  return{title:'A second look',summary:data.flags?.length?data.flags.length+(data.flags.length===1?' item was':' items were')+' flagged for a closer look. Review the concern and its suggested treatment.':'This review identified no flags. That is not proof that every interpretation is correct.',sections,structured:true};
 }
 if(kind==='diff'){
  add('New themes',list(data.themes_added).map(item=>({text:text(item.theme),confidence:text(item.confidence)})));
  add('Themes no longer present',list(data.themes_dropped).map(item=>({text:text(item.theme),confidence:text(item.confidence)})));
  add('Changes in confidence',list(data.confidence_changes).map(item=>({label:text(item.theme),text:words(item.before)+' → '+words(item.after)})));
  add('Changes in dated reports',list(data.relationship_status_changes).map(item=>({label:text(item.name),text:'Earlier: '+(text(item.before?.report)||'No earlier report')+'\n\nLatest: '+(text(item.after?.report)||'No current report'),date:text(item.after?.date)})));
  add('New concerns',list(data.new_flagged_items).map(flag=>({label:text(flag.type),text:text(flag.item)+'\n\n'+text(flag.why)+'\n\n'+text(flag.treatment)})));
  add('Concerns resolved',list(data.resolved_flagged_items).map(flag=>({label:text(flag.type),text:text(flag.item)+'\n\n'+text(flag.treatment)})));
  return{title:'What changed',summary:text(data.spoken_summary)||'Compare this update with the previous record. Changes describe saved material, not a complete account of your life.',sections,structured:true};
 }
 return{title:'Saved record',summary:content.slice(0,350),sections:[],structured:false};
}
