import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../src/db/index.js';
import {migrate} from '../scripts/migrate.js';
import {runNightlyBrain,runDueNightlies,validateFormulation,validateAudit,compareFormulations,losAngelesClock,type NightlyDependencies,type Formulation,type FormulationAudit,type NightlyModelRequest} from '../src/brain/nightly.js';
const generated='2026-11-02T11:00:00.000Z';
const statement=()=>({text:'Not established from the available record.',evidence_type:'unknown'});
const hypothesis=()=>({evidence_type:'hypothesis',text:'A tentative interpretation from limited conversation evidence.',alternative_explanations:['The record may be incomplete.'],confidence:'low'});
const section=()=>({observations:[],interpretation:hypothesis(),limitations:['Conversation-derived only.']});
export function formulationFixture():any{return {
 schema:'brain_formulation',schema_version:'1.0',title:'Conversation-derived formulation',generated_at:generated,generated_by:{assistant:'nightly model',brain_agent_id:'brain-nightly'},
 instructions_for_receiving_model:['Separate statements from hypotheses.'],subject:{preferred_name:'Test subject'},
 provenance:{observation_window:{start:'2026-11-01',end:'2026-11-02',approx_months:null},sources_used:['Seeded test conversations.'],sources_not_used:['Private data outside this brain.'],only_one_side_logged:true},
 evidence_labels:{direct_statement:'The subject said it.',summarized_history:'A prior summary says it.',observed_pattern:'Recurs in the observed record.',hypothesis:'Tentative interpretation.',unknown:'Not established.'},
 confidence_scale:{high:'Repeated direct evidence.',moderate:'Some evidence, with alternatives.',low:'Sparse or ambiguous evidence.'},
 methodology:{approach:'Nonclinical conversation summary.',steps:['Review the source and chronology.'],what_this_is_not:['A diagnosis, clinical evaluation, or test score.']},
 executive_summary:'The available record supports a preference for direct communication, with substantial unknowns.',
 timeline_of_psychologically_relevant_events:[{date:'2026-11-01',evidence_type:'direct_statement',event:'Asked for direct answers.'}],
 theme_recurrence_by_month:[{theme:'Directness',months:['2026-11'],confidence:'moderate',evidence_type:'direct_statement'}],
 core_themes:[{id:'directness',theme:'Directness',description:'A stated preference for direct answers.',evidence:[{date:'2026-11-01',evidence_type:'direct_statement',detail:'Asked for direct answers.'}],interpretation:hypothesis(),alternative_explanations:['The preference may be specific to this task.'],confidence:'moderate'}],
 emotional_profile:{frequently_expressed:[],less_often_expressed_directly:[],expression_style:statement(),regulation_strategies_observed:[],affective_range:statement()},
 attachment_and_relational_dynamics:{framework_note:'Descriptive and nonclinical; no attachment category is assigned.',avoidance_indicators:[],anxiety_indicators:[],working_formulation:hypothesis(),recurring_relational_cycle:hypothesis(),boundary_style:statement()},
 relationships_by_person:[{name:'Person A',relation:{text:'A relationship reported by the subject.',evidence_type:'direct_statement'},dated_reports:[{date:'2026-10-01',report:'In contact.',evidence_type:'direct_statement'},{date:'2026-11-01',report:'No longer in contact.',evidence_type:'direct_statement'}],current_status:{date:'2026-11-01',report:'No longer in contact.',evidence_type:'direct_statement'}}],
 identity_and_self_concept:section(),cognitive_style:{observed:[],not_assessable:['Ability and clinical traits.']},coping_and_defenses:[],motivational_structure_and_values:section(),strengths:[],vulnerabilities_and_stressors:[],triggers:[],contradictions_and_tensions:[],communication_and_interaction_patterns:section(),
 trait_language_impressions:{qualitative_only:true,impressions:[],limitations:['Not a personality assessment.']},
 psychiatric_domain_review:{assessment_type:'conversation_observations_only',domains:[],qualified_assessment_note:'Clinical questions require a qualified professional.'},
 roleplay_and_unverified_claims:[{claim:'A story was explicitly framed as role-play.',status:'roleplay',evidence_type:'direct_statement'}],
 guidance_for_interacting:{do:['Use direct language.'],avoid:['Flattery and unsupported certainty.']},open_questions_for_further_exploration:['Does this preference apply beyond this task?'],what_requires_qualified_assessment:['Clinical or diagnostic questions.'],limitations:['One-sided, incomplete conversation record.'],change_log:[{version:'1.0',date:'2026-11-02',note:'Initial conversation-derived formulation.'}]
};}
function auditFixture(formulation:Formulation,provider:'anthropic'|'openai'='anthropic',model='test-deep'):FormulationAudit{return {schema:'brain_formulation_audit',schema_version:'1.0',generated_at:generated,formulation_generated_at:formulation.generated_at,auditor:{provider,model},flags:[],limitations:['No independent corroboration.']};}
test('dossier schema validates all sections and rejects unsupported evidence/confidence, diagnoses and missing hypothesis alternatives',()=>{
 assert.equal(validateFormulation(formulationFixture()).schema,'brain_formulation');
 for(const mutate of [(v:any)=>v.core_themes[0].evidence[0].evidence_type='diagnosis',(v:any)=>v.core_themes[0].confidence='certain',(v:any)=>delete v.core_themes[0].interpretation.alternative_explanations,(v:any)=>v.psychiatric_domain_review.diagnosis='invented',(v:any)=>v.trait_language_impressions.impressions.push({text:'Trait score: 8',evidence_type:'hypothesis',confidence:'high',alternative_explanations:['Other explanations.']})]){const invalid=formulationFixture();mutate(invalid);assert.throws(()=>validateFormulation(invalid));}
});
test('dated relationship status must exactly preserve the latest dated report',()=>{const f=formulationFixture();f.relationships_by_person[0].current_status={...f.relationships_by_person[0].dated_reports[0]};assert.throws(()=>validateFormulation(f),/validation/);f.relationships_by_person[0].current_status={...f.relationships_by_person[0].dated_reports[1]};assert.ok(validateFormulation(f));});
test('diff is deterministic and tracks themes, confidence, relationships and audit flags with exactly 100 spoken words',()=>{
 const previous=validateFormulation(formulationFixture()),current=structuredClone(previous);current.core_themes[0].confidence='high';current.core_themes.push({...current.core_themes[0],id:'new-theme',theme:'New theme'});current.relationships_by_person[0].dated_reports.push({date:'2026-11-02',report:'Contact resumed.',evidence_type:'direct_statement'});current.relationships_by_person[0].current_status={...current.relationships_by_person[0].dated_reports[2]};
 const oldAudit=auditFixture(previous);oldAudit.flags=[{type:'overreach',item:'old theme',why:'Uncertain.',treatment:'Qualify it.'}];const audit=auditFixture(current);audit.flags=[{type:'unsupported claim',item:'new-theme',why:'Sparse source.',treatment:'Label uncertain.'}];
 const a=compareFormulations(previous,current,oldAudit,audit),b=compareFormulations(previous,current,oldAudit,audit);assert.deepEqual(a,b);assert.equal(a.themes_added.length,1);assert.equal(a.confidence_changes.length,1);assert.equal(a.relationship_status_changes.length,1);assert.equal(a.new_flagged_items.length,1);assert.equal(a.resolved_flagged_items.length,1);assert.equal(a.spoken_summary.split(/\s+/).length,100);assert.equal(compareFormulations(null,current,null,audit).spoken_summary.split(/\s+/).length,100);
});
test('Los Angeles nightly clock follows daylight saving time and repeated hours',()=>{assert.deepEqual(losAngelesClock(new Date('2026-03-08T10:05:00Z')),{date:'2026-03-08',hour:3});assert.deepEqual(losAngelesClock(new Date('2026-11-01T11:05:00Z')),{date:'2026-11-01',hour:3});assert.equal(losAngelesClock(new Date('2026-11-01T08:30:00Z')).hour,1);assert.equal(losAngelesClock(new Date('2026-11-01T09:30:00Z')).hour,1);});
const created:string[]=[];
before(async()=>{await migrate();});
after(async()=>{for(const user of created)await pool.query('DELETE FROM users WHERE id=$1',[user]);await pool.end();});
async function fixture(){const user=randomUUID();created.push(user);await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,'fixture','approved')",[user,'nightly-'+user+'@example.invalid']);const brain=(await pool.query('INSERT INTO brains(user_id) VALUES($1) RETURNING id',[user])).rows[0].id;return {user_id:user,brain_id:brain};}
function dependencies(extra:Partial<NightlyDependencies>={}):NightlyDependencies {return {
 enabled:()=>true,now:()=>new Date(generated),options:{deepModel:'test-deep',auditorModel:'test-auditor',openaiConfigured:false,nightlyHour:3,nightlyTokenBudget:100000},
 context:async()=> 'A seeded subject asked for direct answers.',
 generate:async(_identity,request)=>{const dossier=validateFormulation(formulationFixture());return{text:JSON.stringify(request.system.startsWith('Independently audit')?auditFixture(dossier,request.provider,request.model):dossier),inputTokens:100,outputTokens:100,model:request.model};},...extra
};}
test('nightly retries one invalid evidence label then atomically writes formulation, audit and diff attributed to brain-nightly',async()=>{
 const identity=await fixture();const prompts:NightlyModelRequest[]=[];let formulationCalls=0;
 const deps=dependencies({generate:async(_who,request)=>{prompts.push(request);const dossier=formulationFixture();if(!request.system.startsWith('Independently audit')&&formulationCalls++===0)dossier.core_themes[0].evidence[0].evidence_type='guess';const result=request.system.startsWith('Independently audit')?auditFixture(validateFormulation(formulationFixture()),request.provider,request.model):dossier;return{text:JSON.stringify(result),inputTokens:10,outputTokens:20,model:request.model};}});
 const result=await runNightlyBrain(identity,{},deps);assert.equal(result.state,'done');assert.equal(prompts.length,3);assert.ok(prompts[1].prompt.includes('previous output failed validation'));assert.ok(prompts.every(p=>p.tokenBudget<=100000));assert.equal(result.tokens_used,90);
 const snapshots=await pool.query('SELECT id,kind,agent_label,content FROM snapshots WHERE user_id=$1 AND brain_id=$2 ORDER BY kind',[identity.user_id,identity.brain_id]);assert.equal(snapshots.rowCount,3);assert.deepEqual(snapshots.rows.map(r=>r.kind),['audit','diff','formulation']);assert.ok(snapshots.rows.every(r=>r.agent_label==='brain-nightly'));const formulation=validateFormulation(JSON.parse(snapshots.rows.find(r=>r.kind==='formulation')!.content));validateAudit(JSON.parse(snapshots.rows.find(r=>r.kind==='audit')!.content),formulation,'anthropic','test-deep');assert.equal(JSON.parse(snapshots.rows.find(r=>r.kind==='diff')!.content).spoken_summary.split(/\s+/).length,100);
 assert.equal((await runNightlyBrain(identity,{},deps)).state,'already_run');assert.equal((await pool.query('SELECT count(*)::int AS n FROM snapshots WHERE user_id=$1 AND brain_id=$2',[identity.user_id,identity.brain_id])).rows[0].n,3);
});
test('concurrent nightly claims make exactly one run and configured OpenAI auditor receives separate audit prompt',async()=>{const identity=await fixture();const providers:string[]=[];const deps=dependencies();deps.options.openaiConfigured=true;const fallback=deps.generate;deps.generate=async(who,request)=>{providers.push(request.provider);return fallback(who,request);};const results=await Promise.all([runNightlyBrain(identity,{},deps),runNightlyBrain(identity,{},deps)]);assert.deepEqual(results.map(r=>r.state).sort(),['already_run','done']);assert.deepEqual(providers,['anthropic','openai']);});
test('invalid output twice fails without partial snapshot artifacts',async()=>{const identity=await fixture();let calls=0;const deps=dependencies({generate:async(_who,request)=>{calls++;return{text:'{"evidence_type":"invented"}',inputTokens:1,outputTokens:1,model:request.model};}});assert.equal((await runNightlyBrain(identity,{},deps)).state,'failed');assert.equal(calls,2);assert.equal((await pool.query('SELECT id FROM snapshots WHERE user_id=$1 AND brain_id=$2',[identity.user_id,identity.brain_id])).rowCount,0);});
test('daily or nightly token budget exhaustion skips the run without snapshots',async()=>{const identity=await fixture();const deps=dependencies({generate:async()=>{const error=new Error('The daily budget is exhausted.');error.name='BudgetError';throw error;}});const result=await runNightlyBrain(identity,{},deps);assert.equal(result.state,'skipped');assert.equal(result.error,'budget_exhausted');assert.equal((await pool.query('SELECT id FROM snapshots WHERE user_id=$1 AND brain_id=$2',[identity.user_id,identity.brain_id])).rowCount,0);const second=await fixture();const tiny=dependencies();tiny.options.nightlyTokenBudget=1;assert.equal((await runNightlyBrain(second,{},tiny)).state,'skipped');});
test('purge during generation prevents every late snapshot write',async()=>{const identity=await fixture();const deps=dependencies();const fallback=deps.generate;let cleared=false;deps.generate=async(who,request)=>{if(!cleared){cleared=true;await pool.query('UPDATE brains SET content_epoch=content_epoch+1 WHERE user_id=$1 AND id=$2',[identity.user_id,identity.brain_id]);await pool.query('DELETE FROM nightly_runs WHERE user_id=$1 AND brain_id=$2',[identity.user_id,identity.brain_id]);}return fallback(who,request);};assert.equal((await runNightlyBrain(identity,{},deps)).state,'cancelled');assert.equal((await pool.query('SELECT id FROM snapshots WHERE user_id=$1 AND brain_id=$2',[identity.user_id,identity.brain_id])).rowCount,0);});
test('dry run only previews and never calls a model, claims a run or writes snapshots',async()=>{const identity=await fixture();let called=false;const deps=dependencies({generate:async()=>{called=true;throw new Error('must not call');}});const result=await runNightlyBrain(identity,{dryRun:true},deps);assert.equal(result.state,'preview');assert.ok(result.preview?.formulation_prompt.includes('brain_formulation'));assert.equal(called,false);assert.equal((await pool.query('SELECT id FROM nightly_runs WHERE user_id=$1 AND brain_id=$2',[identity.user_id,identity.brain_id])).rowCount,0);});
test('nightly sources never cross user or brain boundaries',async()=>{const a=await fixture(),b=await fixture();const marker='FOREIGN-'+randomUUID();await pool.query("INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text) VALUES($1,$2,'maya',ARRAY['all'],$3)",[b.user_id,b.brain_id,marker]);const prompts:string[]=[];const deps=dependencies();const fallback=deps.generate;deps.generate=async(who,request)=>{assert.equal(who.user_id,a.user_id);assert.equal(who.brain_id,a.brain_id);prompts.push(request.prompt);return fallback(who,request);};assert.equal((await runNightlyBrain(a,{},deps)).state,'done');assert.ok(prompts.every(p=>!p.includes(marker)));assert.equal((await pool.query('SELECT id FROM snapshots WHERE user_id=$1 AND brain_id=$2',[b.user_id,b.brain_id])).rowCount,0);});
test('disabled providers and pre-schedule hours make scheduler no-op',async()=>{const deps=dependencies({enabled:()=>false});assert.deepEqual(await runDueNightlies(deps,new Date(generated)),[]);deps.enabled=()=>true;assert.deepEqual(await runDueNightlies(deps,new Date('2026-11-02T10:00:00Z')),[]);assert.deepEqual(await runDueNightlies(deps,new Date('2026-11-02T20:00:00Z')),[]);});
test('nightly and automatic-summary activity cannot keep an otherwise idle brain eligible on subsequent days',async()=>{
 const a=await fixture(),base=new Date('2031-01-01T11:00:00Z'),next=new Date('2031-01-02T11:00:00Z');
 await pool.query("INSERT INTO activity(user_id,brain_id,actor_agent,kind,created_at) VALUES($1,$2,'maya','note_left',$3)",[a.user_id,a.brain_id,new Date(base.getTime()-3600000)]);
 const deps=dependencies({now:()=>base});
 const first=await runDueNightlies(deps,base);assert.equal(first.length,1);assert.equal(first[0].state,'done');
 await pool.query("UPDATE activity SET created_at=$3 WHERE user_id=$1 AND brain_id=$2 AND actor_agent='brain-nightly'",[a.user_id,a.brain_id,base]);
 await pool.query("INSERT INTO activity(user_id,brain_id,actor_agent,kind,created_at) VALUES($1,$2,'maya','auto_snapshot',$3)",[a.user_id,a.brain_id,base]);
 deps.now=()=>next;assert.deepEqual(await runDueNightlies(deps,next),[]);
 const manual=(await pool.query("INSERT INTO snapshots(user_id,brain_id,agent_label,content,kind,created_at) VALUES($1,$2,'maya','New explicit user memory','manual',$3) RETURNING id",[a.user_id,a.brain_id,new Date(next.getTime()-3600000)])).rows[0].id;
 await pool.query("INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id,created_at) VALUES($1,$2,'maya','snapshot_saved',$3,$4)",[a.user_id,a.brain_id,manual,new Date(next.getTime()-3600000)]);
 const active=await runDueNightlies(deps,next);assert.equal(active.length,1);assert.equal(active[0].state,'done');
});
test('shared nightly material excludes targeted and owner-only sources and preserves real source IDs',async()=>{
 const a=await fixture(),privateMarker='PRIVATE-'+randomUUID(),publicMarker='PUBLIC-'+randomUUID();
 const shared=(await pool.query("INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text) VALUES($1,$2,'maya','{all}',$3) RETURNING id",[a.user_id,a.brain_id,publicMarker])).rows[0].id;
 await pool.query("INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text) VALUES($1,$2,'charlie','{maya}',$3)",[a.user_id,a.brain_id,privateMarker]);
 await pool.query("INSERT INTO handoffs(user_id,brain_id,from_agent,to_agent,title,context) VALUES($1,$2,'charlie','maya','Private task',$3)",[a.user_id,a.brain_id,privateMarker]);
 await pool.query("INSERT INTO snapshots(user_id,brain_id,agent_label,content,kind,visibility,to_agents) VALUES($1,$2,'maya',$3,'auto','owner_only','{you}')",[a.user_id,a.brain_id,privateMarker]);
 const deps=dependencies();let inspected=0;const generate=deps.generate;deps.generate=async(who,request)=>{assert.ok(!request.prompt.includes(privateMarker));assert.ok(request.prompt.includes(publicMarker));inspected++;return generate(who,request);};
 assert.equal((await runNightlyBrain(a,{},deps)).state,'done');assert.equal(inspected,2);
 const snapshots=await pool.query("SELECT visibility,to_agents,source_refs FROM snapshots WHERE user_id=$1 AND brain_id=$2 AND agent_label='brain-nightly'",[a.user_id,a.brain_id]);
 assert.equal(snapshots.rowCount,3);assert.ok(snapshots.rows.every(row=>row.visibility==='shared'&&row.to_agents.includes('all')&&row.source_refs.some((ref:any)=>ref.collection==='notes'&&ref.id===shared)));
});
test('pending hosted-AI access disables automatic nightly work without claiming or calling a provider',async()=>{
 const a=await fixture();await pool.query("UPDATE users SET ai_access_state='pending' WHERE id=$1",[a.user_id]);
 let called=false;const result=await runNightlyBrain(a,{},dependencies({generate:async()=>{called=true;throw new Error('Unexpected paid work');}}));assert.equal(result.state,'disabled');assert.equal(called,false);
 assert.equal((await pool.query('SELECT 1 FROM nightly_runs WHERE user_id=$1 AND brain_id=$2',[a.user_id,a.brain_id])).rowCount,0);
});
test('nightly includes shared project goals, item evidence and corrections while excluding restricted projects',async()=>{
 const a=await fixture(),shared='PUBLIC-PROJECT-'+randomUUID(),secret='PRIVATE-PROJECT-'+randomUUID();
 const publicProject=(await pool.query("INSERT INTO projects(user_id,brain_id,title,goal,created_by) VALUES($1,$2,'Shared plan',$3,'maya') RETURNING id",[a.user_id,a.brain_id,shared])).rows[0].id;
 const privateProject=(await pool.query("INSERT INTO projects(user_id,brain_id,title,goal,created_by,allowed_agents) VALUES($1,$2,'Private plan',$3,'maya','{maya}') RETURNING id",[a.user_id,a.brain_id,secret])).rows[0].id;
 const item=(await pool.query("INSERT INTO project_items(project_id,user_id,brain_id,type,title,content,confirmation,source_type,created_by,updated_by) VALUES($1,$2,$3,'decision','Timetable',$4,'confirmed','user_statement','you','you') RETURNING id",[publicProject,a.user_id,a.brain_id,shared+' ITEM'])).rows[0].id;
 await pool.query("INSERT INTO project_events(project_id,user_id,brain_id,version,kind,actor_agent,summary,after) VALUES($1,$2,$3,1,'item_corrected','you',$4,$5)",[publicProject,a.user_id,a.brain_id,shared+' CORRECTION',{source_type:'user_statement',content:shared}]);
 await pool.query("INSERT INTO project_items(project_id,user_id,brain_id,type,title,content,created_by,updated_by) VALUES($1,$2,$3,'decision','Private item',$4,'maya','maya')",[privateProject,a.user_id,a.brain_id,secret]);
 const deps=dependencies(),generate=deps.generate;deps.generate=async(who,request)=>{assert.ok(request.prompt.includes(shared+' ITEM'));assert.ok(request.prompt.includes(shared+' CORRECTION'));assert.ok(!request.prompt.includes(secret));return generate(who,request);};
 const result=await runNightlyBrain(a,{},deps);assert.equal(result.state,'done');
 const refs=(await pool.query('SELECT source_refs FROM snapshots WHERE id=$1',[result.snapshot_ids!.formulation])).rows[0].source_refs;
 assert.ok(refs.some((ref:any)=>ref.collection==='project_items'&&ref.id===item));assert.ok(refs.some((ref:any)=>ref.collection==='projects'&&ref.id===publicProject));
});
test('automatic project artifacts alone do not schedule nightly work, but a user-origin project change does',async()=>{
 const a=await fixture(),now=new Date('2033-01-02T11:00:00Z'),created=new Date(now.getTime()-3600000);
 const project=(await pool.query("INSERT INTO projects(user_id,brain_id,title,created_by) VALUES($1,$2,'Future project','maya') RETURNING id",[a.user_id,a.brain_id])).rows[0].id;
 await pool.query("INSERT INTO project_events(project_id,user_id,brain_id,version,kind,actor_agent,summary,after,created_at) VALUES($1,$2,$3,1,'artifact_ready','maya','Automatic completion',$4,$5)",[project,a.user_id,a.brain_id,{source_type:'tool_result'},created]);
 await pool.query("INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id,metadata,created_at) VALUES($1,$2,'maya','project_changed',$3,$4,$5)",[a.user_id,a.brain_id,project,{project_version:1,kind:'artifact_ready'},created]);
 const deps=dependencies({now:()=>now});assert.deepEqual(await runDueNightlies(deps,now),[]);
 await pool.query("INSERT INTO project_events(project_id,user_id,brain_id,version,kind,actor_agent,summary,after,created_at) VALUES($1,$2,$3,2,'item_added','maya','Explicit constraint',$4,$5)",[project,a.user_id,a.brain_id,{source_type:'user_statement'},created]);
 await pool.query("INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id,metadata,created_at) VALUES($1,$2,'maya','project_changed',$3,$4,$5)",[a.user_id,a.brain_id,project,{project_version:2,kind:'item_added'},created]);
 const runs=await runDueNightlies(deps,now);assert.equal(runs.length,1);assert.equal(runs[0].state,'done');
});
