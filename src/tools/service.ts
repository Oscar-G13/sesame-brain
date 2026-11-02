import type pg from 'pg';
import { transaction } from '../db/index.js';
import { isToolName, toolDefinitions, toolScope, type ToolName } from './definitions.js';

export interface AuthContext { user_id:string;brain_id:string;agent_label:string;client_id:string;scopes:string[];grant_id:string;token_hash:string;browser_session_id?:string; }
export class ToolError extends Error { constructor(message:string,public readonly status=400){super(message);} }
type Db=pg.PoolClient;
async function event(db:Db,a:AuthContext,kind:string,ref:string|null):Promise<void>{
 await db.query('INSERT INTO activity(user_id,brain_id,actor_agent,kind,ref_id) VALUES($1,$2,$3,$4,$5)',[a.user_id,a.brain_id,a.agent_label,kind,ref]);
}
async function autoNote(db:Db,a:AuthContext,to:string,text:string):Promise<void>{
 const r=await db.query('INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text,tags) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[a.user_id,a.brain_id,a.agent_label,[to],text,['handoff']]);
 await event(db,a,'note_left',r.rows[0].id);
}
export async function executeTool(a:AuthContext,name:string,input:unknown={},expectedEpoch?:number,authorize?: (db:Db)=>Promise<void>):Promise<unknown>{
 if(!isToolName(name))throw new ToolError('Unknown tool.');
 if(!a.scopes.includes(toolScope(name)))throw new ToolError('insufficient_scope',403);
 return transaction(async db=>{
  if(expectedEpoch!==undefined)await db.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[a.user_id]);
  // A locked, tenant-checked parent makes deletion and concurrent snapshot pruning atomic.
  const brain=await db.query('SELECT id,name,content_epoch FROM brains WHERE user_id=$1 AND id=$2 '+(toolScope(name)==='brain:write'?'FOR UPDATE':'FOR SHARE'),[a.user_id,a.brain_id]);
  if(!brain.rowCount)throw new ToolError('Brain not found.',404);
  if(expectedEpoch!==undefined&&Number(brain.rows[0].content_epoch)!==expectedEpoch)throw new ToolError('Brain reset; work stopped.',409);
  if(authorize)await authorize(db);
  return run(db,a,name,input,brain.rows[0].name as string);
 });
}
async function run(db:Db,a:AuthContext,name:ToolName,input:unknown,brainName:string):Promise<unknown>{
 const tenant=[a.user_id,a.brain_id];
 const who=a.agent_label;
 switch(name){
 case 'whoami':{
  toolDefinitions.whoami.inputSchema.parse(input);
  const agents=await db.query('SELECT agent_label AS agent,max(last_used_at) AS last_seen FROM grants WHERE user_id=$1 AND brain_id=$2 AND revoked_at IS NULL GROUP BY agent_label ORDER BY agent_label',tenant);
  const notes=await db.query("SELECT count(*)::int AS n FROM notes WHERE user_id=$1 AND brain_id=$2 AND ($3=ANY(to_agents) OR 'all'=ANY(to_agents)) AND NOT $3=ANY(read_by)",[...tenant,who]);
  const handoffs=await db.query("SELECT count(*)::int AS n FROM handoffs WHERE user_id=$1 AND brain_id=$2 AND (to_agent=$3 OR EXISTS(SELECT 1 FROM jobs j WHERE j.user_id=handoffs.user_id AND j.brain_id=handoffs.brain_id AND j.handoff_id=handoffs.id)) AND status IN ('pending','accepted')",[...tenant,who]);
  return {agent:who,brain:brainName,connected_agents:agents.rows,unread_notes:notes.rows[0].n,pending_handoffs:handoffs.rows[0].n,server_time:new Date().toISOString()};
 }
 case 'inbox':{
  const p=toolDefinitions.inbox.inputSchema.parse(input);
  const notes=await db.query("SELECT * FROM notes WHERE user_id=$1 AND brain_id=$2 AND ($3=ANY(to_agents) OR 'all'=ANY(to_agents)) AND NOT $3=ANY(read_by) ORDER BY created_at DESC,id DESC LIMIT $4",[...tenant,who,p.limit]);
  const handoffs=await db.query("SELECT * FROM handoffs WHERE user_id=$1 AND brain_id=$2 AND (to_agent=$3 OR EXISTS(SELECT 1 FROM jobs j WHERE j.user_id=handoffs.user_id AND j.brain_id=handoffs.brain_id AND j.handoff_id=handoffs.id)) AND status IN ('pending','accepted') ORDER BY created_at DESC,id DESC LIMIT $4",[...tenant,who,p.limit]);
  const items=[...notes.rows.map(note=>({...note,note_kind:note.kind,kind:'note'})),...handoffs.rows.map(handoff=>({kind:'handoff',...handoff}))].sort((x,y)=>new Date(y.created_at).getTime()-new Date(x.created_at).getTime()).slice(0,p.limit);
  return {items,notes:items.filter(i=>i.kind==='note'),handoffs:items.filter(i=>i.kind==='handoff')};
 }
 case 'read_notes':{
  const p=toolDefinitions.read_notes.inputSchema.parse(input);
  const r=await db.query("SELECT * FROM notes WHERE user_id=$1 AND brain_id=$2 AND ($3=ANY(to_agents) OR 'all'=ANY(to_agents) OR from_agent=$3) AND ($4::text IS NULL OR from_agent=$4) AND ($5::text IS NULL OR $5=ANY(to_agents)) AND (NOT $6::boolean OR NOT $3=ANY(read_by)) AND ($7::timestamptz IS NULL OR created_at >= $7) AND ($8::text IS NULL OR $8=ANY(tags)) ORDER BY created_at DESC,id DESC LIMIT $9",[...tenant,who,p.from??null,p.to??null,p.unread_only,p.since??null,p.tag??null,p.limit]);
  return r.rows;
 }
 case 'recall':{
  const p=toolDefinitions.recall.inputSchema.parse(input);
  const r=await db.query("SELECT * FROM facts WHERE user_id=$1 AND brain_id=$2 AND ($3::text IS NULL OR key=$3) AND ($4::text IS NULL OR to_tsvector('simple',key || ' ' || value) @@ plainto_tsquery('simple',$4) OR (key || ' ' || value) % $4 OR strpos(lower(key || ' ' || value),lower($4)) > 0) AND ($5::text IS NULL OR $5=ANY(tags)) ORDER BY updated_at DESC,id DESC LIMIT $6",[...tenant,p.key??null,p.query??null,p.tag??null,p.limit]);
  return r.rows;
 }
 case 'list_snapshots':{
  const p=toolDefinitions.list_snapshots.inputSchema.parse(input);
  const r=await db.query('SELECT id,agent_label AS agent,title,kind,created_at,octet_length(content) AS bytes FROM snapshots WHERE user_id=$1 AND brain_id=$2 AND ($3::text IS NULL OR agent_label=$3) ORDER BY created_at DESC,id DESC LIMIT $4',[...tenant,p.agent??null,p.limit]);
  return r.rows;
 }
 case 'get_snapshot':{
  const p=toolDefinitions.get_snapshot.inputSchema.parse(input);
  const r=await db.query('SELECT id,agent_label AS agent,title,kind,content,created_at FROM snapshots WHERE user_id=$1 AND brain_id=$2 AND id=$3',[...tenant,p.id]);
  if(!r.rowCount)throw new ToolError('Snapshot not found.',404);
  return r.rows[0];
 }
 case 'activity':{
  const p=toolDefinitions.activity.inputSchema.parse(input);
  const r=await db.query('SELECT id,actor_agent,kind,ref_id,created_at FROM activity WHERE user_id=$1 AND brain_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3',[...tenant,p.limit]);
  return r.rows;
 }
 case 'leave_note':{
  const p=toolDefinitions.leave_note.inputSchema.parse(input);
  const to=[...new Set(Array.isArray(p.to)?p.to:[p.to])];
  const r=await db.query('INSERT INTO notes(user_id,brain_id,from_agent,to_agents,text,tags) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[...tenant,who,to,p.text,p.tags??[]]);
  await event(db,a,'note_left',r.rows[0].id);
  return {id:r.rows[0].id};
 }
 case 'mark_notes_read':{
  const p=toolDefinitions.mark_notes_read.inputSchema.parse(input);
  const r=await db.query("UPDATE notes SET read_by=array_append(read_by,$3) WHERE user_id=$1 AND brain_id=$2 AND ($3=ANY(to_agents) OR 'all'=ANY(to_agents)) AND NOT $3=ANY(read_by) AND ($4::boolean OR id=ANY($5::uuid[])) RETURNING id",[...tenant,who,p.all===true,p.ids??[]]);
  await event(db,a,'notes_read',r.rows[0]?.id??null);
  return {marked:r.rowCount};
 }
 case 'handoff':{
  const p=toolDefinitions.handoff.inputSchema.parse(input);
  const r=await db.query('INSERT INTO handoffs(user_id,brain_id,from_agent,to_agent,title,context,next_steps) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[...tenant,who,p.to,p.title,p.context,p.next_steps??null]);
  await event(db,a,'handoff_created',r.rows[0].id);
  return {id:r.rows[0].id};
 }
 case 'accept_handoff':{
  const p=toolDefinitions.accept_handoff.inputSchema.parse(input);
  const r=await db.query("UPDATE handoffs SET status='accepted',accepted_at=now() WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND to_agent=$4 AND status='pending' RETURNING id,from_agent,title",[...tenant,p.id,who]);
  if(!r.rowCount)throw new ToolError('Pending handoff not found for this assistant.',404);
  await autoNote(db,a,r.rows[0].from_agent,'Accepted handoff: '+r.rows[0].title);
  await event(db,a,'handoff_accepted',p.id);
  return {id:p.id,status:'accepted'};
 }
 case 'complete_handoff':{
  const p=toolDefinitions.complete_handoff.inputSchema.parse(input);
  const r=await db.query("UPDATE handoffs SET status='completed',summary=$5,accepted_at=COALESCE(accepted_at,now()),completed_at=now() WHERE user_id=$1 AND brain_id=$2 AND id=$3 AND to_agent=$4 AND status IN ('pending','accepted') RETURNING id,from_agent,title",[...tenant,p.id,who,p.summary]);
  if(!r.rowCount)throw new ToolError('Open handoff not found for this assistant.',404);
  await autoNote(db,a,r.rows[0].from_agent,'Completed handoff: '+r.rows[0].title+'\n'+p.summary);
  await event(db,a,'handoff_completed',p.id);
  return {id:p.id,status:'completed'};
 }
 case 'remember':{
  const p=toolDefinitions.remember.inputSchema.parse(input);
  const r=await db.query('INSERT INTO facts(user_id,brain_id,key,value,tags,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(brain_id,key) DO UPDATE SET value=EXCLUDED.value,tags=EXCLUDED.tags,updated_by=EXCLUDED.updated_by,updated_at=now() WHERE facts.user_id=$1 AND facts.brain_id=$2 RETURNING id,key',[...tenant,p.key,p.value,p.tags??[],who]);
  await event(db,a,'fact_stored',r.rows[0].id);
  return {id:r.rows[0].id,key:p.key};
 }
 case 'forget':{
  const p=toolDefinitions.forget.inputSchema.parse(input);
  const r=await db.query('DELETE FROM facts WHERE user_id=$1 AND brain_id=$2 AND key=$3 RETURNING id',[...tenant,p.key]);
  await event(db,a,'fact_forgotten',r.rows[0]?.id??null);
  return {deleted:Boolean(r.rowCount)};
 }
 case 'save_snapshot':{
  const p=toolDefinitions.save_snapshot.inputSchema.parse(input);
  const r=await db.query('INSERT INTO snapshots(user_id,brain_id,agent_label,title,content) VALUES($1,$2,$3,$4,$5) RETURNING id',[...tenant,who,p.title??null,p.content]);
  await event(db,a,'snapshot_saved',r.rows[0].id);
  return {id:r.rows[0].id};
 }
 }
}
export function resultSummary(name:string,data:unknown):string {
 if(Array.isArray(data))return name+': '+data.length+' result'+(data.length===1?'':'s')+'.';
 if(name==='whoami')return 'Connected to your shared brain.';
 if(name==='inbox')return 'Inbox checked; nothing marked as read.';
 return name.replaceAll('_',' ')+': done.';
}
