const statement=()=>({text:'Not established from the available record.',evidence_type:'unknown'});
const hypothesis=()=>({evidence_type:'hypothesis',text:'A tentative interpretation from limited conversation evidence.',alternative_explanations:['The record may be incomplete.'],confidence:'low'});
const section=()=>({observations:[],interpretation:hypothesis(),limitations:['Conversation-derived only.']});
const generated='2026-11-02T11:00:00.000Z';
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
