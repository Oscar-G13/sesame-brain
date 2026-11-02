import {pool} from '../src/db/index.js';
import {setAiAccess,getAiAccess} from '../src/auth/access.js';
const args=process.argv.slice(2),email=args[args.indexOf('--email')+1];
if(!args.includes('--email')||!email||!(args.includes('--approve')||args.includes('--revoke')))throw new Error('Usage: ai-access.ts --email ADDRESS --approve|--revoke [--reason TEXT]');
try{const row=(await pool.query('SELECT id FROM users WHERE email=$1 AND deleted_at IS NULL',[email])).rows[0];if(!row)throw new Error('Account not found');const approved=args.includes('--approve'),reason=args.includes('--reason')?args[args.indexOf('--reason')+1]:(approved?'Hosted AI access approved by the operator.':'Hosted AI access disabled by the operator.');await setAiAccess(row.id,approved,reason);const access=await getAiAccess(row.id);console.log(JSON.stringify({ok:true,state:access.state}));}finally{await pool.end();}
