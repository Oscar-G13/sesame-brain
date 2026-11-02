import { clearContextCache } from './context.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { transaction } from '../db/index.js';
import { aiConfig } from './config.js';
export async function purgeBrainContent(userId:string,brainId:string):Promise<void>{
 await transaction(async db=>{
  const brain=await db.query('UPDATE brains SET content_epoch=content_epoch+1,memory_version=memory_version+1 WHERE user_id=$1 AND id=$2 RETURNING id',[userId,brainId]);
  if(!brain.rowCount)throw new Error('Brain not found.');
  for(const table of ['jobs','projects','brain_sessions','nightly_runs','notes','handoffs','fact_revisions','facts','snapshots','activity','usage','usage_reservations'])await db.query('DELETE FROM '+table+' WHERE user_id=$1 AND brain_id=$2',[userId,brainId]);
  // Only validated IDs returned by PostgreSQL become filesystem components.
  await rm(join(aiConfig.workspace,userId,brain.rows[0].id),{recursive:true,force:true});
 });
 clearContextCache({userId,brainId});
}

export async function removeUserWorkspaces(userId:string):Promise<void>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))throw new Error('Invalid user ID.');
 await rm(join(aiConfig.workspace,userId),{recursive:true,force:true});
 clearContextCache();
}
