import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool} from '../src/db/index.js';
import {config} from '../src/config.js';
import {executeTool,type AuthContext} from '../src/tools/service.js';
import {touchSession,recordSessionActivity,rollupSession} from '../src/brain/sessions.js';
import {buildContinuity,bookmarkProject,recordContinuityReceipt} from '../src/brain/continuity.js';
import {setModelTransportForTests} from '../src/brain/provider.js';
const users:string[]=[],client='continuity-core-'+randomUUID();let providerCalls=0;
before(async()=>{setModelTransportForTests(async()=>{providerCalls++;throw new Error('Continuity must not call an AI provider.');});await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr','{}')",[client]);});
after(async()=>{setModelTransportForTests(undefined);for(const id of users)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[client]);await pool.end();});
async function fixture():Promise<AuthContext>{
 const user=randomUUID(),brain=randomUUID(),grant=randomUUID();users.push(user);
 await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,'fixture','pending')",[user,'continuity-'+user+'@example.invalid']);
 await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[brain,user]);
 await pool.query('INSERT INTO grants(id,user_id,brain_id,client_id,agent_label,scope,resource) VALUES($1,$2,$3,$4,$5,$6,$7)',[grant,user,brain,client,'maya','brain:read brain:write',config.resource]);
 return{user_id:user,brain_id:brain,agent_label:'maya',grant_id:grant,client_id:client,scopes:['brain:read','brain:write'],token_hash:randomBytes(32).toString('hex')};
}
const tenant=(a:AuthContext)=>[a.user_id,a.brain_id];
async function project(a:AuthContext,title='Train journey',goal='Plan the trip using the saved budget.'){
 const row=(await pool.query('INSERT INTO projects(user_id,brain_id,title,goal,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[...tenant(a),title,goal,a.agent_label])).rows[0];
 for(const [type,label,content,confirmed] of [['constraint','Travel budget','The budget is 1200 euros.',true],['decision','Travel mode','Use the train.',true],['question','Which departure works?','Choose a morning departure.',false],['task','Book tickets','Check the final timetable.',false]] as const){
  await pool.query("INSERT INTO project_items(project_id,user_id,brain_id,type,title,content,status,confirmation,source_type,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'user_statement','you','you')",[row.id,...tenant(a),type,label,content,confirmed?'confirmed':'proposed',confirmed?'confirmed':'proposed']);
 }return row;
}
test('same voice resumes unchanged canonical project and its own snapshot after explicit close without AI',async()=>{
 const a=await fixture(),first=await touchSession(a);assert.equal(first.continuity?.saved_context,false);
 const focus=await project(a);await bookmarkProject(a,first.session.id,focus.id);
 await executeTool(a,'remember',{key:'travel preference',value:'Prefer a window seat.'},undefined,undefined,{sessionId:first.session.id});
 const snapshot=await executeTool(a,'save_snapshot',{content:'SAME-VOICE-SNAPSHOT: buy the ticket after checking the timetable.'},undefined,undefined,{sessionId:first.session.id}) as any;
 const closed=await rollupSession(a,first.session.id,{closeOnUnavailable:true});assert.equal(closed.closed,true);assert.equal(closed.snapshotId,null);assert.match(closed.message,/no automatic summary/);
 const next=await touchSession(a,{now:new Date(Date.now()+1000)});assert.equal(next.firstTouch,true);assert.notEqual(next.session.id,first.session.id);
 const packet=next.continuity!;assert.equal(packet.project?.id,focus.id);assert.equal(packet.project?.confirmed_constraints[0].content,'The budget is 1200 euros.');assert.equal(packet.project?.confirmed_decisions[0].content,'Use the train.');
 assert.equal(packet.project?.open_questions[0].title,'Which departure works?');assert.equal(packet.project?.unfinished_tasks[0].title,'Book tickets');
 assert.ok(packet.source_refs.some(ref=>ref.collection==='snapshots'&&ref.id===snapshot.id));assert.match(packet.previous_session?.summary??'',/SAME-VOICE-SNAPSHOT/);
 assert.ok(packet.facts.some(row=>row.value==='Prefer a window seat.'));assert.equal(packet.resume_count,undefined);await recordContinuityReceipt(a,next.session.id,packet);assert.ok(packet.resume_count!>=1);assert.equal(providerCalls,0);
});
test('canonical corrections and pending-review flags take precedence over an unchanged previous session summary',async()=>{
 const a=await fixture(),first=await touchSession(a),focus=await project(a);await bookmarkProject(a,first.session.id,focus.id);
 await recordSessionActivity(a,first.session.id,{tool:'think',write:false,sourceAudience:['all'],summary:'The budget is 1200 euros.'});
 await rollupSession(a,first.session.id,{closeOnUnavailable:true});
 await pool.query("UPDATE project_items SET content='The budget is 1800 euros.',revision=2,needs_review=true,pending_change=$4 WHERE user_id=$1 AND brain_id=$2 AND project_id=$3 AND type='constraint'",[...tenant(a),focus.id,{content:'Proposed budget 2000 euros',source_refs:[]}]);
 const current=await touchSession(a),packet=current.continuity!;
 assert.equal(packet.project?.confirmed_constraints[0].content,'The budget is 1800 euros.');assert.ok(packet.project!.review_flags.length);
 assert.match(packet.briefing,/1800/);assert.ok(!packet.briefing.includes('1200'));assert.equal(providerCalls,0);
});
test('read-only pending accounts retrieve saved context and empty retrievals do not complete receipt metadata',async()=>{
 const a=await fixture(),empty=await touchSession(a);assert.equal(empty.continuity?.saved_context,false);
 const meta=(await pool.query('SELECT resume_count,resumed_at FROM brain_sessions WHERE id=$1',[empty.session.id])).rows[0];assert.equal(Number(meta.resume_count),0);assert.equal(meta.resumed_at,null);
 await executeTool(a,'remember',{key:'remembered route',value:'Take the coastal train.'});
 const read={...a,scopes:['brain:read'],token_hash:'refreshed-read-token'},next=await touchSession(read);
 assert.equal(next.continuity?.saved_context,true);assert.ok(next.continuity!.facts.some(row=>row.value==='Take the coastal train.'));
 assert.equal(next.continuity!.resume_count,undefined);await recordContinuityReceipt(read,next.session.id,next.continuity!);assert.equal(Number(next.continuity!.resume_count),1);assert.equal(providerCalls,0);
 assert.equal((await pool.query('SELECT 1 FROM snapshots WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
});
test('capped session receipts cannot expose withdrawn event provenance during saved-tool fallback',async()=>{
 const a=await fixture(),first=await touchSession(a),focus=await project(a,'Withdrawn project','WITHDRAWN-SESSION-SECRET');
 await bookmarkProject(a,first.session.id,focus.id);
 await recordSessionActivity(a,first.session.id,{tool:'think',write:false,summary:'WITHDRAWN-SESSION-SECRET',sourceAudience:['all'],sourceRefs:[{collection:'projects',id:focus.id}]});
 await rollupSession(a,first.session.id,{closeOnUnavailable:true});
 await pool.query("UPDATE brain_sessions SET source_refs='[]',last_project_id=NULL WHERE id=$1",[first.session.id]);
 await pool.query("UPDATE projects SET allowed_agents='{charlie}' WHERE id=$1",[focus.id]);
 const next=await touchSession(a);assert.ok(!JSON.stringify(next.continuity).includes('WITHDRAWN-SESSION-SECRET'));assert.equal(next.continuity?.previous_session,undefined);
});
test('withdrawn pending-change evidence is withheld while the current confirmed constraint remains available',async()=>{
 const a=await fixture(),focus=await project(a);
 const fact=await executeTool(a,'remember',{key:'proposal evidence',value:'WITHDRAWN-PROPOSAL-SECRET'}) as any;
 await pool.query("UPDATE project_items SET needs_review=true,pending_change=$4 WHERE user_id=$1 AND brain_id=$2 AND project_id=$3 AND type='constraint'",[...tenant(a),focus.id,{content:'WITHDRAWN-PROPOSAL-SECRET',source_refs:[{kind:'fact',id:fact.id}]}]);
 await pool.query("UPDATE facts SET visibility='owner_only',to_agents='{you}' WHERE id=$1",[fact.id]);
 const packet=await buildContinuity(a,{projectId:focus.id,recordReceipt:false});
 assert.equal(packet.project?.confirmed_constraints[0].content,'The budget is 1200 euros.');
 assert.equal(packet.project?.review_flags[0].pending_change_withheld,true);assert.ok(!JSON.stringify(packet).includes('WITHDRAWN-PROPOSAL-SECRET'));
});
test('continuity has an exact UTF8 JSON byte bound with large emoji, quotes and source material',async()=>{
 const a=await fixture(),focus=await project(a,'🧠'.repeat(120),('🧠"').repeat(1500));
 await pool.query("UPDATE project_items SET content=$4 WHERE user_id=$1 AND brain_id=$2 AND project_id=$3",[...tenant(a),focus.id,('旅行🧠"').repeat(2000)]);
 for(const maxBytes of [2048,16000]){
  const packet=await buildContinuity(a,{projectId:focus.id,recordReceipt:false,maxBytes});
  assert.ok(packet.bytes<=maxBytes);assert.equal(packet.bytes,Buffer.byteLength(JSON.stringify(packet)));assert.ok(!JSON.stringify(packet).includes('\uFFFD'));assert.equal(providerCalls,0);
 }
});
test('voice-only proposed constraints and decisions resume unchanged without requiring owner confirmation',async()=>{
 const a=await fixture(),first=await touchSession(a);
 const focus=(await pool.query("INSERT INTO projects(user_id,brain_id,title,goal,created_by) VALUES($1,$2,'Voice-only weekend plan','Plan the weekend','maya') RETURNING id",tenant(a))).rows[0].id;
 await pool.query("INSERT INTO project_items(project_id,user_id,brain_id,type,title,content,created_by,updated_by) VALUES($1,$2,$3,'constraint','Budget','The weekend budget is 600 euros.','maya','maya')",[focus,...tenant(a)]);
 await bookmarkProject(a,first.session.id,focus);
 await recordSessionActivity(a,first.session.id,{tool:'project_add_item',write:true,summary:'Weekend budget 600 euros.',sourceAudience:['all'],sourceRefs:[{collection:'projects',id:focus}]});
 await rollupSession(a,first.session.id,{closeOnUnavailable:true});
 const packet=(await touchSession(a)).continuity!;
 assert.equal(packet.project?.confirmed_constraints.length,0);assert.equal(packet.project?.proposed_items[0].confirmation,'proposed');
 assert.match(packet.project!.proposed_items[0].content,/600/);assert.match(packet.briefing,/not yet confirmed/);assert.match(packet.briefing,/600/);assert.equal(providerCalls,0);
});
test('an archived last project cannot return as active through a previous saved-session summary',async()=>{
 const a=await fixture(),first=await touchSession(a),focus=await project(a,'ARCHIVED-PROJECT-MARKER','Old project goal');
 await bookmarkProject(a,first.session.id,focus.id);
 await recordSessionActivity(a,first.session.id,{tool:'think',write:false,summary:'Continue ARCHIVED-PROJECT-MARKER next time.',sourceAudience:['all'],sourceRefs:[{collection:'projects',id:focus.id}]});
 await rollupSession(a,first.session.id,{closeOnUnavailable:true});await pool.query("UPDATE projects SET status='archived' WHERE id=$1",[focus.id]);
 const packet=(await touchSession(a)).continuity!;assert.equal(packet.project,undefined);assert.equal(packet.previous_session,undefined);assert.ok(!packet.briefing.includes('ARCHIVED-PROJECT-MARKER'));
});
test('explicit resume can skip the first-touch packet and record exactly one real retrieval',async()=>{
 const a=await fixture();await executeTool(a,'remember',{key:'resume once',value:'A real saved context item.'});
 const touched=await touchSession(a,{skipContinuity:true});assert.equal(touched.continuity,undefined);
 const packet=await buildContinuity(a,{sessionId:touched.session.id});assert.equal(packet.resume_count,1);assert.equal(packet.saved_context,true);
});
test('an unavailable end-session summary cannot close a conversation that advanced while it was running',async()=>{
 const a=await fixture();await pool.query("UPDATE users SET ai_access_state='approved' WHERE id=$1",[a.user_id]);
 const touched=await touchSession(a);await recordSessionActivity(a,touched.session.id,{tool:'remember',write:true,summary:'Saved before goodbye.'});
 let entered!:()=>void,fail!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const closing=rollupSession(a,touched.session.id,{closeOnUnavailable:true,summarizer:async()=>{entered();await new Promise<void>(resolve=>{fail=resolve;});throw new Error('Provider unavailable.');}});
 await started;await recordSessionActivity(a,touched.session.id,{tool:'whoami',write:false,summary:'The conversation continued.'});fail();
 const result=await closing;assert.equal(result.closed,false);assert.equal(result.stale,true);
 assert.equal((await pool.query('SELECT closed_at FROM brain_sessions WHERE id=$1',[touched.session.id])).rows[0].closed_at,null);
 assert.equal(providerCalls,0);
});
test('a notes-only current session resumes within thirty minutes without pretending a new call boundary',async()=>{
 const a=await fixture(),first=await touchSession(a);
 const note=await executeTool(a,'leave_note',{to:'all',text:'NOTES-ONLY-CONTINUITY: check the train platform.'},undefined,undefined,{sessionId:first.session.id}) as any;
 const same=await touchSession(a);assert.equal(same.firstTouch,false);
 const packet=await buildContinuity(a,{sessionId:first.session.id});
 assert.equal(packet.saved_context,true);assert.ok(packet.recent_notes.some(row=>row.id===note.id));assert.match(packet.briefing,/NOTES-ONLY-CONTINUITY/);
 assert.ok(packet.source_refs.some(ref=>ref.collection==='notes'&&ref.id===note.id));assert.equal(providerCalls,0);
});
test('a standalone visible snapshot resumes without an old call/session record',async()=>{
 const a=await fixture();
 const snapshot=await executeTool(a,'save_snapshot',{content:'STANDALONE-SNAPSHOT-CONTINUITY: saved directly in the dashboard.'}) as any;
 const packet=await buildContinuity(a,{recordReceipt:false});
 assert.equal(packet.saved_snapshot?.id,snapshot.id);assert.equal(packet.previous_session,undefined);assert.match(packet.briefing,/Saved snapshot/);
 assert.match(packet.briefing,/STANDALONE-SNAPSHOT-CONTINUITY/);assert.equal(providerCalls,0);
});
test('the forty-receipt cap omits overflow records instead of returning unreceipted content',async()=>{
 const a=await fixture(),first=await touchSession(a,{skipContinuity:true}),focus=await project(a);await bookmarkProject(a,first.session.id,focus.id);
 for(const [type,confirmation,review] of [['constraint','confirmed',false],['decision','confirmed',false],['constraint','proposed',false],['question','proposed',false],['task','proposed',false],['artifact','proposed',true]] as const)for(let i=0;i<4;i++){
  await pool.query("INSERT INTO project_items(project_id,user_id,brain_id,type,title,content,status,confirmation,needs_review,created_by,updated_by) VALUES($1,$2,$3,$4,$5,'Saved content','proposed',$6,$7,'maya','maya')",[focus.id,...tenant(a),type,type+' '+confirmation+' '+i,confirmation,review]);
 }
 for(const state of ['queued','done'])for(let i=0;i<3;i++)await pool.query('INSERT INTO jobs(user_id,brain_id,requested_by_agent,title,task,state,content_epoch,result_summary) VALUES($1,$2,$3,$4,$4,$5,0,$6)',[...tenant(a),'maya',state+' job '+i,state,'A completed result.']);
 for(let i=0;i<2;i++)await pool.query("INSERT INTO handoffs(user_id,brain_id,from_agent,to_agent,title,context) VALUES($1,$2,'maya','all',$3,'Open handoff content')",[...tenant(a),'Handoff '+i]);
 for(let i=0;i<4;i++)await executeTool(a,'remember',{key:'receipt fact '+i,value:'Saved fact '+i});
 for(let i=0;i<3;i++)await executeTool(a,'leave_note',{to:'all',text:'Saved note '+i});
 await executeTool(a,'save_snapshot',{content:'Previous snapshot.'},undefined,undefined,{sessionId:first.session.id});await rollupSession(a,first.session.id,{closeOnUnavailable:true});
 const next=await touchSession(a,{skipContinuity:true}),packet=await buildContinuity(a,{sessionId:next.session.id,maxBytes:32000});
 assert.equal(packet.source_refs.length,40);assert.equal(packet.truncated,true);
 const ids=[packet.project!.id,...['confirmed_constraints','confirmed_decisions','proposed_items','open_questions','unfinished_tasks','review_flags'].flatMap(key=>(packet.project as any)[key].map((row:any)=>row.id)),...packet.facts.map(row=>row.id),...packet.open_work.map(row=>row.id),...packet.waiting_results.map(row=>row.id),...packet.recent_notes.map(row=>row.id),...(packet.previous_session?[packet.previous_session.id,...(packet.previous_session.snapshot_id?[packet.previous_session.snapshot_id]:[])]:[])];
 for(const id of ids)assert.ok(packet.source_refs.some(ref=>ref.id===id),'Returned content needs receipt '+id);
});
test('think-only saved conversation resumes within the same open session without claiming a native call boundary',async()=>{
 const a=await fixture(),first=await touchSession(a);
 await recordSessionActivity(a,first.session.id,{tool:'think',write:false,summary:'User asked about the coastal route. Answer: The coastal route has the earlier arrival.',sourceAudience:['all']});
 const same=await touchSession(a);assert.equal(same.firstTouch,false);assert.equal(same.session.id,first.session.id);
 const packet=await buildContinuity(a,{sessionId:first.session.id});
 assert.equal(packet.saved_context,true);assert.equal(packet.current_session?.id,first.session.id);assert.equal(packet.previous_session,undefined);
 assert.equal(packet.current_session?.summary_source,'saved_tool_activity');assert.match(packet.current_session!.summary,/coastal route/);
 assert.match(packet.briefing,/Recent saved conversation context/);assert.ok(!packet.briefing.includes('previous call'));assert.ok(packet.source_refs.some(ref=>ref.collection==='brain_sessions'&&ref.id===first.session.id));
 assert.equal(providerCalls,0);
});
async function nightlyDiff(a:AuthContext,summary:string,options:{visibility?:string;audience?:string[];refs?:any[];createdAt?:Date}={}){
 return(await pool.query("INSERT INTO snapshots(user_id,brain_id,agent_label,title,kind,content,visibility,to_agents,source_refs,created_at) VALUES($1,$2,'brain-nightly','Overnight change','diff',$3,$4,$5,$6,$7) RETURNING id",[...tenant(a),JSON.stringify({schema:'brain_formulation_diff',schema_version:'1.0',generated_at:'2026-11-03T11:00:00.000Z',spoken_summary:summary}),options.visibility??'shared',options.audience??['all'],JSON.stringify(options.refs??[]),options.createdAt??new Date()])).rows[0].id as string;
}
test('nightly diff alone appears in first-touch briefing and explicit resume as generated interpretation with a receipt',async()=>{
 const a=await fixture(),summary=Array.from({length:100},(_,i)=>i===0?'OVERNIGHT-INTERPRETATION':'word'+i).join(' '),id=await nightlyDiff(a,summary);
 const first=await touchSession(a);
 assert.equal(first.continuity?.nightly_update?.id,id);assert.equal(first.continuity!.nightly_update!.summary.split(/\s+/).length,100);
 assert.match(first.briefing??'',/Latest overnight interpretation/);assert.match(first.briefing??'',/confirmed facts take precedence/);
 assert.equal(first.continuity?.saved_snapshot,undefined);assert.ok(first.continuity!.source_refs.some(ref=>ref.collection==='snapshots'&&ref.id===id));
 const resumed=await buildContinuity(a,{sessionId:first.session.id,recordReceipt:false});
 assert.equal(resumed.nightly_update?.id,id);assert.match(resumed.briefing,/2026-11-03/);assert.ok(resumed.bytes<=16000);assert.equal(resumed.bytes,Buffer.byteLength(JSON.stringify(resumed)));
 const unicodeSummary=Array.from({length:100},(_,i)=>('🧠"'.repeat(5))+i).join(' ');
 await pool.query('UPDATE snapshots SET content=$2 WHERE id=$1',[id,JSON.stringify({schema:'brain_formulation_diff',schema_version:'1.0',generated_at:'2026-11-03T11:00:00.000Z',spoken_summary:unicodeSummary})]);
 for(const maxBytes of [2048,16000]){
  const bounded=await buildContinuity(a,{sessionId:first.session.id,recordReceipt:false,maxBytes});
  assert.ok(bounded.bytes<=maxBytes);assert.equal(bounded.bytes,Buffer.byteLength(JSON.stringify(bounded)));assert.ok(!JSON.stringify(bounded).includes('\uFFFD'));
 }
 assert.equal(providerCalls,0);
});
test('private, foreign and withdrawn-source nightly interpretations stay out of continuity and briefings',async()=>{
 const a=await fixture(),b=await fixture(),source=await executeTool(a,'leave_note',{to:'all',text:'Withdraw this nightly evidence.'}) as any;
 await nightlyDiff(a,'WITHDRAWN-NIGHTLY-SECRET',{refs:[{collection:'notes',id:source.id}]});
 await pool.query("UPDATE notes SET visibility='owner_only',source_audience='{you}' WHERE id=$1",[source.id]);
 await nightlyDiff(a,'OWNER-NIGHTLY-SECRET',{visibility:'owner_only',audience:['you']});
 await nightlyDiff(b,'FOREIGN-NIGHTLY-SECRET');
 const packet=await buildContinuity(a,{recordReceipt:false});
 assert.equal(packet.nightly_update,undefined);assert.ok(!JSON.stringify(packet).includes('NIGHTLY-SECRET'));assert.equal(packet.saved_context,false);
 const spoof=await buildContinuity({...a,agent_label:'you'},{recordReceipt:false}).catch(()=>undefined);
 assert.ok(!spoof||!JSON.stringify(spoof).includes('OWNER-NIGHTLY-SECRET'));assert.equal(providerCalls,0);
});
test('preparing context creates no receipt; successful final delivery can stamp a closed same-epoch session',async()=>{
 const a=await fixture();await executeTool(a,'remember',{key:'delivery proof',value:'Saved only once delivery succeeds.'});
 const call=await touchSession(a,{skipContinuity:true}),packet=await buildContinuity(a,{sessionId:call.session.id,recordReceipt:false,maxBytes:2048});
 assert.equal(Number((await pool.query('SELECT resume_count FROM brain_sessions WHERE id=$1',[call.session.id])).rows[0].resume_count),0);
 await assert.rejects(executeTool(a,'get_snapshot',{id:randomUUID()}),/not found/);
 assert.equal(Number((await pool.query('SELECT resume_count FROM brain_sessions WHERE id=$1',[call.session.id])).rows[0].resume_count),0);
 await rollupSession(a,call.session.id,{closeOnUnavailable:true});
 const delivered=await recordContinuityReceipt(a,call.session.id,packet);
 assert.equal(delivered,packet);assert.equal(delivered.resume_count,1);assert.ok(delivered.resumed_at);assert.ok(delivered.bytes<=2048);assert.equal(delivered.bytes,Buffer.byteLength(JSON.stringify(delivered)));
});
test('final continuity receipt rejects nested provenance withdrawn after packet preparation without counting retrieval',async()=>{
 const a=await fixture(),evidence=await executeTool(a,'leave_note',{to:'all',text:'Nested evidence for a generated interpretation.'}) as any;
 await nightlyDiff(a,'INTERPRETATION-TO-WITHDRAW',{refs:[{collection:'notes',id:evidence.id}]});
 const call=await touchSession(a,{skipContinuity:true}),packet=await buildContinuity(a,{sessionId:call.session.id,recordReceipt:false});assert.ok(packet.nightly_update);
 await pool.query("UPDATE notes SET visibility='owner_only',source_audience='{you}' WHERE id=$1",[evidence.id]);
 await assert.rejects(recordContinuityReceipt(a,call.session.id,packet),/no longer available/);
 assert.equal(Number((await pool.query('SELECT resume_count FROM brain_sessions WHERE id=$1',[call.session.id])).rows[0].resume_count),0);
});
test('an empty final packet does not produce a saved-context receipt',async()=>{
 const a=await fixture(),call=await touchSession(a,{skipContinuity:true}),packet=await buildContinuity(a,{sessionId:call.session.id,recordReceipt:false});
 assert.equal(packet.saved_context,false);await recordContinuityReceipt(a,call.session.id,packet);
 assert.equal(Number((await pool.query('SELECT resume_count FROM brain_sessions WHERE id=$1',[call.session.id])).rows[0].resume_count),0);
});
