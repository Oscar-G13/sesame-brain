import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool,transaction} from '../src/db/index.js';
import {config} from '../src/config.js';
import {executeTool,type AuthContext} from '../src/tools/service.js';
import {correctFact,listFactHistory,assertContentCapacity} from '../src/brain/memory.js';
import {buildContextPack,clearContextCache} from '../src/brain/context.js';
import {touchSession,recordSessionActivity,sessionTrailer,rollupSession} from '../src/brain/sessions.js';
import {purgeBrainContent} from '../src/brain/purge.js';
const users:string[]=[],client='memory-evidence-'+randomUUID();
before(async()=>{await pool.query("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES($1,'dcr',$2)",[client,{client_name:'Evidence test',redirect_uris:['https://example.invalid/callback']}]);});
after(async()=>{clearContextCache();for(const uid of users)await pool.query('DELETE FROM users WHERE id=$1',[uid]);await pool.query('DELETE FROM oauth_clients WHERE client_id=$1',[client]);await pool.end();});
async function fixture(agent='maya'):Promise<AuthContext>{
 const uid=randomUUID(),bid=randomUUID(),gid=randomUUID();users.push(uid);
 await pool.query("INSERT INTO users(id,email,password_hash,ai_access_state) VALUES($1,$2,'fixture','approved')",[uid,'memory-'+uid+'@example.invalid']);
 await pool.query('INSERT INTO brains(id,user_id) VALUES($1,$2)',[bid,uid]);
 await pool.query('INSERT INTO grants(id,user_id,brain_id,agent_label,client_id,scope,resource) VALUES($1,$2,$3,$4,$5,$6,$7)',[gid,uid,bid,agent,client,'brain:read brain:write',config.resource]);
 return{user_id:uid,brain_id:bid,agent_label:agent,client_id:client,scopes:['brain:read','brain:write'],grant_id:gid,token_hash:randomBytes(32).toString('hex')};
}
const tenant=(a:AuthContext)=>[a.user_id,a.brain_id];
async function owner(a:AuthContext):Promise<AuthContext>{
 const id=(await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id",[a.user_id,randomBytes(32).toString('hex')])).rows[0].id;
 return{...a,agent_label:'you',client_id:'dashboard',grant_id:'',browser_session_id:id};
}
test('fact corrections preserve prior values and attribution; unconfirmed model conflicts become proposals',async()=>{
 const a=await fixture(),web=await owner(a);
 const initial=await executeTool(a,'remember',{key:'commute',value:'Take the 7:40 train.'}) as any;
 const corrected=await correctFact(web,{key:'commute',value:'Take the 8:10 train.',reason:'The timetable changed.'});
 assert.equal(corrected.previous_value,'Take the 7:40 train.');assert.equal(corrected.confirmation,'user_confirmed');
 const proposal=await executeTool(a,'remember',{key:'commute',value:'Take the 9:00 train.'},undefined,undefined,{provenance:{source_type:'model_derived',confidence:'high'}}) as any;
 assert.equal(proposal.proposed,true);
 assert.equal((await executeTool(a,'recall',{key:'commute'}) as any[])[0].value,'Take the 8:10 train.');
 const history=await listFactHistory(web,{key:'commute'});assert.equal(history.length,3);
 const old=history.find(row=>row.id===initial.revision_id)!;
 assert.equal(old.status,'superseded');assert.equal(old.superseded_by_id,corrected.revision_id);
 assert.equal(history.find(row=>row.id===corrected.revision_id)!.source_type,'user_correction');
 assert.equal(history.find(row=>row.id===proposal.revision_id)!.status,'proposed');
 await assert.rejects(correctFact(a,{key:'commute',value:'Spoofed confirmation'}),/owner correction/);
 const foreign=await fixture();assert.deepEqual(await listFactHistory(foreign,{key:'commute'}),[]);
});
test('source-backed derivation cannot promote a targeted note into shared facts or snapshots',async()=>{
 const a=await fixture(),maya={...a,agent_label:'maya'},miles={...a,agent_label:'miles'},charlie={...a,agent_label:'charlie'};
 const note=await executeTool(charlie,'leave_note',{to:['maya','miles'],text:'The private launch codename is Zephyr.'}) as any;
 const provenance={source_type:'model_derived' as const,source_refs:[{collection:'notes' as const,id:note.id}]};
 const saved=await executeTool(maya,'remember',{key:'codename',value:'Zephyr'},undefined,undefined,{provenance}) as any;
 assert.deepEqual(saved.source_refs,[{collection:'notes',id:note.id}]);assert.equal(saved.visibility,'restricted');
 assert.equal((await executeTool(miles,'recall',{key:'codename'}) as any[]).length,1);
 assert.deepEqual(await executeTool({...a,agent_label:'outsider'},'recall',{key:'codename'}),[]);
 const snapshot=await executeTool(maya,'save_snapshot',{content:'Zephyr plan'},undefined,undefined,{provenance}) as any;
 await assert.rejects(executeTool({...a,agent_label:'outsider'},'get_snapshot',{id:snapshot.id}),/not found/);
 await assert.rejects(executeTool(maya,'leave_note',{to:'outsider',text:'Leak'},undefined,undefined,{provenance}),/not shared/);
 const foreign=await fixture();await assert.rejects(executeTool(foreign,'remember',{key:'stolen',value:'Zephyr'},undefined,undefined,{provenance}),/not available/);
 await assert.rejects(executeTool({...a,agent_label:'outsider'},'remember',{key:'stolen',value:'Zephyr'},undefined,undefined,{provenance}),/not visible/);
});
test('owner-only artifacts require owner authentication, including when OAuth label is literally you',async()=>{
 const a=await fixture(),web=await owner(a);
 const saved=await executeTool(web,'save_snapshot',{content:'Owner private memorandum.'},undefined,undefined,{sourceAudience:['you']}) as any;
 await assert.rejects(executeTool({...a,agent_label:'you'},'get_snapshot',{id:saved.id}),/not found/);
 assert.equal((await executeTool(web,'get_snapshot',{id:saved.id}) as any).content,'Owner private memorandum.');
 assert.ok(!(await buildContextPack({...a,agent_label:'you'},{query:'memorandum',audience:['you']})).blocks.some(b=>b.text.includes('Owner private')));
 assert.ok((await buildContextPack(web,{query:'memorandum',audience:['you']})).blocks.some(b=>b.text.includes('Owner private')));
});
test('question-aware retrieval keeps old relevant sources, current session and pending results within its byte budget',async()=>{
 const a=await fixture(),session=await touchSession(a);
 for(let i=0;i<80;i++)await pool.query('INSERT INTO facts(user_id,brain_id,key,value,updated_by) VALUES($1,$2,$3,$4,$5)',[...tenant(a),'background-'+i,'Unrelated generic history. '.repeat(250),a.agent_label]);
 const old=(await pool.query("INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text,created_at) VALUES($1,$2,'maya','{all}',$3,'2020-01-01') RETURNING id",[...tenant(a),'The Zephyr launch window is Tuesday at 08:10.'])).rows[0].id;
 await recordSessionActivity(a,session.session.id,{tool:'think',write:false,summary:'The current request needs the launch window.',sourceAudience:['all']});
 const job=(await pool.query("INSERT INTO jobs(user_id,brain_id,requested_by_agent,title,task,state,content_epoch,result_summary,finished_at) VALUES($1,$2,'maya','Launch checks','Check launch','done',0,'Zephyr checks passed.',now()) RETURNING id",tenant(a))).rows[0].id;
 const pack=await buildContextPack(a,{query:'What is the Zephyr launch window?',sessionId:session.session.id,tokenBudget:4000});
 const text=pack.blocks.map(b=>b.text).join('\n\n');assert.ok(text.includes('Tuesday at 08:10'));assert.ok(text.includes('current request'));assert.ok(text.includes('Zephyr checks passed'));
 assert.ok(pack.includedJobIds.includes(job));assert.ok(pack.sourceRefs.some(r=>r.id===old));
 assert.ok(pack.bytes<=4000);assert.equal(pack.bytes,Buffer.byteLength(text));assert.ok(!text.includes('\uFFFD'));
});
test('project audience selection excludes unrelated private evidence before deriving the result audience',async()=>{
 const a=await fixture(),charlie={...a,agent_label:'charlie'};
 await executeTool(charlie,'leave_note',{to:'maya',text:'SECRET restricted Zephyr route.'});
 await executeTool(a,'leave_note',{to:'all',text:'PUBLIC Zephyr schedule.'});
 const shared=await buildContextPack(a,{query:'Zephyr',audience:['all']});assert.ok(shared.blocks.some(b=>b.text.includes('PUBLIC')));assert.ok(!shared.blocks.some(b=>b.text.includes('SECRET')));assert.deepEqual(shared.audience,['all']);
 const restricted=await buildContextPack(a,{query:'Zephyr',audience:['maya','charlie']});assert.ok(restricted.blocks.some(b=>b.text.includes('SECRET')));assert.deepEqual(restricted.audience,['charlie','maya']);
 const other=await buildContextPack(a,{query:'Zephyr',audience:['maya','miles']});assert.ok(!other.blocks.some(b=>b.text.includes('SECRET')));
});
test('owner dashboard current-session evidence respects a restricted project audience',async()=>{
 const a=await fixture(),web=await owner(a),session=await touchSession(web);
 await recordSessionActivity(web,session.session.id,{tool:'think',write:false,summary:'OWNER-ONLY session detail.',sourceAudience:['you']});
 const shared=await buildContextPack(web,{sessionId:session.session.id,query:'session detail',audience:['maya','charlie']});
 assert.ok(!shared.blocks.some(b=>b.text.includes('OWNER-ONLY')));
 const own=await buildContextPack(web,{sessionId:session.session.id,query:'session detail',audience:['you']});assert.ok(own.blocks.some(b=>b.text.includes('OWNER-ONLY')));
});
test('internal tool writes count exactly once and session summaries retain the source audience',async()=>{
 const a=await fixture(),now=new Date(),session=await touchSession(a,{now});
 await executeTool(a,'remember',{key:'private-session',value:'Private planning detail'},undefined,undefined,{sessionId:session.session.id,sourceAudience:['maya']});
 await recordSessionActivity(a,session.session.id,{tool:'think',write:false,summary:'I saved the planning detail.',sourceAudience:['maya']});
 assert.equal(Number((await pool.query('SELECT write_count FROM brain_sessions WHERE id=$1',[session.session.id])).rows[0].write_count),1);
 assert.ok(!(await sessionTrailer(a,session.session.id,new Date(now.getTime()+6*60000))).includes('No notes saved'));
 const result=await rollupSession(a,session.session.id,{summarizer:async()=> 'Private planning detail was saved.'});assert.ok(result.snapshotId);
 const snapshot=(await pool.query('SELECT visibility,to_agents FROM snapshots WHERE id=$1',[result.snapshotId])).rows[0];assert.equal(snapshot.visibility,'restricted');assert.deepEqual(snapshot.to_agents,['maya']);
 await assert.rejects(executeTool({...a,agent_label:'miles'},'get_snapshot',{id:result.snapshotId}),/not found/);
});
test('hard content quota rolls back multirow revisions without deleting existing memory and releases capacity on forget',async()=>{
 const a=await fixture();await pool.query('UPDATE brains SET content_limit_rows=2 WHERE user_id=$1 AND id=$2',tenant(a));
 await executeTool(a,'remember',{key:'limited',value:'Keep this value.'});
 await assert.rejects(executeTool(a,'remember',{key:'limited',value:'This must roll back.'}),/quota reached/);
 assert.equal((await executeTool(a,'recall',{key:'limited'}) as any[])[0].value,'Keep this value.');
 assert.equal((await listFactHistory(a,{key:'limited'})).length,1);
 assert.equal(Number((await pool.query('SELECT content_rows FROM brains WHERE id=$1',[a.brain_id])).rows[0].content_rows),2);
 await executeTool(a,'forget',{key:'limited'});assert.equal(Number((await pool.query('SELECT content_rows FROM brains WHERE id=$1',[a.brain_id])).rows[0].content_rows),0);
 await executeTool(a,'leave_note',{to:'all',text:'Capacity available again.'});
});
test('quota is serialized across direct concurrent inserts and permits bookkeeping and shrinking at the limit',async()=>{
 const a=await fixture();await pool.query('UPDATE brains SET content_limit_rows=1 WHERE user_id=$1 AND id=$2',tenant(a));
 const insert=()=>pool.query("INSERT INTO snapshots(user_id,brain_id,agent_label,content) VALUES($1,$2,'maya','A bounded record')",tenant(a));
 const results=await Promise.allSettled([insert(),insert()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const before=(await pool.query('SELECT content_bytes,content_rows FROM brains WHERE id=$1',[a.brain_id])).rows[0];assert.equal(Number(before.content_rows),1);
 await pool.query('UPDATE brains SET content_limit_bytes=content_bytes WHERE id=$1',[a.brain_id]);
 await assert.rejects(pool.query("UPDATE snapshots SET content=content||' extra' WHERE user_id=$1 AND brain_id=$2",tenant(a)),/quota reached/);
 await pool.query("UPDATE snapshots SET title=title,created_at=now() WHERE user_id=$1 AND brain_id=$2",tenant(a));
 await pool.query("UPDATE snapshots SET content='A' WHERE user_id=$1 AND brain_id=$2",tenant(a));
 const after=(await pool.query('SELECT content_bytes FROM brains WHERE id=$1',[a.brain_id])).rows[0];assert.ok(Number(after.content_bytes)<Number(before.content_bytes));
 await assert.rejects(transaction(db=>assertContentCapacity(db,a,1,1)),/quota reached/);
});
test('content purge removes evidence history and sessions while preserving account and assistant authorization',async()=>{
 const a=await fixture();await executeTool(a,'remember',{key:'purge','value':'Delete the content, preserve connections.'});await touchSession(a);
 await purgeBrainContent(a.user_id,a.brain_id);
 for(const table of ['facts','fact_revisions','notes','snapshots','handoffs','brain_sessions','activity'])assert.equal((await pool.query('SELECT 1 FROM '+table+' WHERE user_id=$1 AND brain_id=$2',tenant(a))).rowCount,0);
 assert.equal((await pool.query('SELECT 1 FROM users WHERE id=$1',[a.user_id])).rowCount,1);assert.equal((await pool.query('SELECT 1 FROM grants WHERE id=$1',[a.grant_id])).rowCount,1);
 const size=(await pool.query('SELECT content_bytes,content_rows FROM brains WHERE id=$1',[a.brain_id])).rows[0];assert.equal(Number(size.content_rows),0);assert.equal(Number(size.content_bytes),0);
});
test('project item and event receipts retain the project ACL and deny owner-only OAuth labels',async()=>{
 const a=await fixture(),web=await owner(a);
 const project=(await pool.query("INSERT INTO projects(user_id,brain_id,title,goal,created_by,allowed_agents) VALUES($1,$2,'Restricted project','Private goal','maya','{maya,charlie}') RETURNING id",tenant(a))).rows[0].id;
 const item=(await pool.query("INSERT INTO project_items(project_id,user_id,brain_id,type,title,content,created_by,updated_by) VALUES($1,$2,$3,'decision','Choose train','Take the 8:10 train','maya','maya') RETURNING id",[project,...tenant(a)])).rows[0].id;
 const event=(await pool.query("INSERT INTO project_events(project_id,user_id,brain_id,version,kind,actor_agent,summary,after) VALUES($1,$2,$3,1,'item_added','maya','Recorded timetable decision',$4) RETURNING id",[project,...tenant(a),{content:'Take the 8:10 train',source_type:'user_statement'}])).rows[0].id;
 const refs=[{collection:'projects' as const,id:project},{collection:'project_items' as const,id:item},{collection:'project_events' as const,id:event}];
 const saved=await executeTool(a,'remember',{key:'project-train',value:'Take the 8:10 train.'},undefined,undefined,{provenance:{source_type:'model_derived',source_refs:refs}}) as any;
 assert.equal(saved.visibility,'restricted');assert.deepEqual(saved.source_refs,refs);assert.deepEqual(saved.audience,['charlie','maya']);
 await assert.rejects(executeTool({...a,agent_label:'miles'},'remember',{key:'unavailable',value:'No'},undefined,undefined,{provenance:{source_refs:refs}}),/not visible/);
 await pool.query("UPDATE projects SET allowed_agents='{you}' WHERE id=$1",[project]);
 await assert.rejects(executeTool({...a,agent_label:'you'},'remember',{key:'owner-spoof',value:'No'},undefined,undefined,{provenance:{source_refs:refs}}),/not visible/);
 assert.equal((await executeTool(web,'remember',{key:'owner-project',value:'Owner only'},undefined,undefined,{provenance:{source_refs:refs}}) as any).visibility,'owner_only');
});
test('private reads taint subsequent plain memory writes without adding read activity or losing receipts',async()=>{
 const {narrowSessionAudience}=await import('../src/brain/sessions.js');
 const a=await fixture(),session=await touchSession(a),charlie={...a,agent_label:'charlie'};
 const note=await executeTool(charlie,'leave_note',{to:'maya',text:'Private route information.'}) as any;
 const activityBefore=(await pool.query('SELECT count(*) FROM activity WHERE user_id=$1 AND brain_id=$2',tenant(a))).rows[0].count;
 await narrowSessionAudience(a,session.session.id,['all'],[{collection:'notes',id:note.id}]);
 assert.equal((await pool.query('SELECT count(*) FROM activity WHERE user_id=$1 AND brain_id=$2',tenant(a))).rows[0].count,activityBefore);
 const saved=await executeTool(a,'remember',{key:'derived-from-read',value:'Private route information.'},undefined,undefined,{sessionId:session.session.id}) as any;
 assert.equal(saved.visibility,'restricted');assert.deepEqual(saved.source_refs,[{collection:'notes',id:note.id}]);
 assert.deepEqual(await executeTool({...a,agent_label:'miles'},'recall',{key:'derived-from-read'}),[]);
});
test('model search of direct handoffs narrows later internal memory writes to the actual recipients',async()=>{
 const {callModelTool}=await import('../src/brain/model-tools.js');
 const a=await fixture();const handoff=await executeTool({...a,agent_label:'charlie'},'handoff',{to:'maya',title:'Restricted route','context':'Zephyr private handoff detail.'}) as any;
 const modelContext:{audience?:string[];sourceRefs?:any[]}={audience:['all'],sourceRefs:[]};
 await callModelTool(a,0,'brain_search',{query:'Zephyr',collection:'handoffs'},new AbortController().signal,modelContext);
 assert.deepEqual(modelContext.audience,['charlie','maya']);assert.ok(modelContext.sourceRefs!.some(r=>r.id===handoff.id));
 await callModelTool(a,0,'brain_write_fact',{key:'private-search',value:'Zephyr private handoff detail.'},new AbortController().signal,modelContext);
 assert.deepEqual(await executeTool({...a,agent_label:'miles'},'recall',{key:'private-search'}),[]);
});
test('mixed owner and assistant audiences never grant owner access to an OAuth assistant named you',async()=>{
 const a=await fixture(),web=await owner(a);
 const snapshot=await executeTool(web,'save_snapshot',{content:'Mixed owner and Maya private source.'},undefined,undefined,{sourceAudience:['you','maya']}) as any;
 assert.equal((await executeTool(a,'get_snapshot',{id:snapshot.id}) as any).content,'Mixed owner and Maya private source.');
 await assert.rejects(executeTool({...a,agent_label:'you'},'get_snapshot',{id:snapshot.id}),/not found/);
 assert.deepEqual(await executeTool({...a,agent_label:'you'},'list_snapshots',{}),[]);
 await assert.rejects(executeTool({...a,agent_label:'you'},'remember',{key:'mixed-spoof',value:'No'},undefined,undefined,{provenance:{source_refs:[{collection:'snapshots',id:snapshot.id}]}}),/not visible/);
});
