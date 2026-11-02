import {app} from '../src/app.js';
import {pool} from '../src/db/index.js';
const server=app.listen(3000,'0.0.0.0',()=>console.log(JSON.stringify({event:'dashboard_candidate_ready'})));
process.on('SIGTERM',()=>server.close(()=>void pool.end().then(()=>process.exit(0))));
