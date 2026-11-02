import http from 'node:http';
import {mkdtemp,writeFile,rm,lstat,unlink,chmod,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const socket=process.env.BRAIN_SANDBOX_SOCKET||'/run/brain-sandbox/runner.sock';
if(!socket.startsWith('/')||socket.includes('\0'))throw new Error('Invalid socket path');
let busy=false,activeKill;
async function cleanup(dir){
 if(!dir)return;
 const pending=[dir];
 while(pending.length){const path=pending.pop();const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())continue;await chmod(path,0o700);for(const entry of await readdir(path,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())pending.push(path+'/'+entry.name);}
 await rm(dir,{recursive:true,force:true});
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.method==='GET'&&req.url==='/health'){res.end('{"ok":true}');return;}
 if(req.method!=='POST'||req.url!=='/run'){res.writeHead(404).end('{"error":"Not found"}');return;}
 if(busy){res.writeHead(429).end('{"error":"Execution busy"}');return;}
 busy=true;let dir,child,bodyTimer,resultBody='{"error":"Execution failed"}',status=200;
 const kill=()=>{if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}};
 activeKill=kill;
 req.on('aborted',kill);res.on('close',()=>{if(!res.writableEnded)kill();});
 try{
  bodyTimer=setTimeout(()=>req.destroy(new Error('Input timeout')),5000);
  let body='',bytes=0;
  for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)throw new Error('Input too large');body+=chunk;}
  clearTimeout(bodyTimer);
  const parsed=JSON.parse(body),code=parsed?.code;
  if(typeof code!=='string'||code.length<1||Buffer.byteLength(code)>32000)throw new Error('Invalid input');
  dir=await mkdtemp('/tmp/brain-code-');await writeFile(dir+'/main.mjs',code,{mode:0o600});
  const result=await new Promise(resolve=>{
   let bytes=0,truncated=false,timedOut=false,settled=false;const output=[];
   child=spawn(process.execPath,['--permission','--max-old-space-size=96','--unhandled-rejections=strict','--allow-fs-read='+dir,'--allow-fs-write='+dir,dir+'/main.mjs'],{cwd:dir,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:dir},stdio:['ignore','pipe','pipe'],detached:true});
   const timer=setTimeout(()=>{timedOut=true;kill();},8000);
   const collect=data=>{const remaining=32000-bytes;if(data.length>remaining){truncated=true;if(remaining>0)output.push(data.subarray(0,remaining));bytes=32000;kill();}else{output.push(data);bytes+=data.length;}};
   child.stdout.on('data',collect);child.stderr.on('data',collect);
   const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);kill();resolve(value);};
   child.on('error',()=>finish({exit_code:null,error:'Execution unavailable'}));
   child.on('close',exitCode=>finish({exit_code:exitCode,timed_out:timedOut,truncated,output:Buffer.concat(output).toString('utf8').replace(/\uFFFD+$/u,'')}));
  });
  resultBody=JSON.stringify(result);
 }catch{status=400;}
 finally{
  clearTimeout(bodyTimer);kill();
  try{await cleanup(dir);}catch{status=500;resultBody='{"error":"Execution cleanup failed"}';}
  finally{busy=false;activeKill=undefined;}
  if(!res.destroyed){res.writeHead(status);res.end(resultBody);}
 }
});
server.headersTimeout=5000;server.requestTimeout=5000;server.keepAliveTimeout=1000;server.maxConnections=16;
try{const stat=await lstat(socket);if(!stat.isSocket())throw new Error('Socket path occupied');await unlink(socket);}catch(error){if(error.code!=='ENOENT')throw error;}
server.listen(socket,async()=>{await chmod(socket,0o660);});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{activeKill?.();server.close(()=>{void unlink(socket).catch(()=>{}).finally(()=>process.exit(0));});setTimeout(()=>process.exit(1),1000).unref();});
