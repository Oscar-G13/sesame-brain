import { startBrainRuntime } from './brain/runtime.js';
import { loadPreRegisteredClients } from './oauth/clients.js';
import { app } from './app.js';
import { pool } from './db/index.js';
import { config } from './config.js';
await loadPreRegisteredClients();
const stopBrain=await startBrainRuntime();
const server=app.listen(config.port,'0.0.0.0',()=>console.log(JSON.stringify({event:'listening',port:config.port,version:config.version})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopBrain();server.close(()=>void pool.end().then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref();});
