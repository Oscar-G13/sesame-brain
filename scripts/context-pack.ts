import {buildContextPack} from '../src/brain/context.js';
import {pool} from '../src/db/index.js';
const args=process.argv.slice(2),get=(name:string)=>{const index=args.indexOf('--'+name);return index>=0?args[index+1]:undefined;};
async function main(){
 const user=get('user'),brain=get('brain'),agent=get('agent')??'maya';
 if(!user||!brain||!/^[a-z0-9-]{1,32}$/.test(agent)||agent==='all')throw new Error('Usage: npm exec tsx scripts/context-pack.ts -- --user UUID --brain UUID [--agent maya] [--session UUID] [--budget 20000]');
 const pack=await buildContextPack({user_id:user,brain_id:brain,agent_label:agent,client_id:'operator-context-dry-run',scopes:['brain:read'],grant_id:'00000000-0000-0000-0000-000000000000',token_hash:'operator-context-dry-run'},{sessionId:get('session'),tokenBudget:get('budget')?Number(get('budget')):undefined,markJobsSurfaced:false});
 process.stdout.write(JSON.stringify(pack,null,2)+'\n');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Context dry-run failed.');process.exitCode=1;}).finally(()=>pool.end());
