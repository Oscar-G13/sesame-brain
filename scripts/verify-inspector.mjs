import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=(process.env.BASE_URL||'https://brain.arxsable.ai').replace(/\/$/,'');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
const email='inspector-'+Date.now()+'-'+randomBytes(6).toString('hex')+'@example.invalid',password=randomBytes(24).toString('base64url');
let child,created=false,raw='';
const redacted=text=>text.replace(/https?:[^\s"<>]*(?:authorize|callback)[^\s"<>]*/g,'[OAuth URL redacted]').replace(/(access_token|refresh_token|client_secret|code_verifier)(["\s:=]+)[A-Za-z0-9_.-]+/g,'$1$2[redacted]');
try {
 await page.goto(base+'/signup');await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('checkbox').check();
 await page.getByRole('button',{name:'Create account'}).click();await page.waitForURL(base+'/dashboard');created=true;await page.goto(base+'/account');
 await page.getByRole('button',{name:'Sign out of this browser'}).click();await page.waitForURL(base+'/');
 let foundUrl;const authorizationUrl=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Inspector did not request interactive OAuth within 150 seconds')),150000);
  child=spawn('npx',['--yes','@modelcontextprotocol/inspector','--cli','--server-url',base+'/mcp','--transport','http','--method','tools/list','--connect-timeout','120000','--format','json','--callback-url','http://127.0.0.1:6276/oauth/callback'],{stdio:['pipe','pipe','pipe'],env:{...process.env,CI:'false',MCP_AUTO_OPEN_ENABLED:'true'}});
  const capture=data=>{raw+=data.toString();const clean=raw.replace(/\x1b\[[0-9;]*m/g,'');const urls=clean.match(/https:\/\/[^\s"<>]+/g)||[];const match=urls.find(url=>url.startsWith(base+'/authorize?'));if(match&&!foundUrl){foundUrl=true;clearTimeout(timer);resolve(match);}};
  child.stdout.on('data',capture);child.stderr.on('data',capture);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{if(!foundUrl){clearTimeout(timer);reject(new Error('Inspector exited before OAuth: '+code+' '+redacted(raw).slice(-1200)));}});
 });
 const completion=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Inspector CLI timed out'));},210000);child.once('exit',(code)=>{clearTimeout(timer);resolve(code);});});
 const url=await authorizationUrl;assert.ok(url.startsWith(base+'/authorize?'));
 await page.goto(url,{waitUntil:'networkidle'});assert.equal(new URL(page.url()).pathname,'/login');
 await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(u=>u.pathname==='/authorize');
 await page.getByRole('radio',{name:'Other',exact:true}).check();await page.getByLabel('Custom name, if you chose Other').fill('inspector');
 await page.getByRole('button',{name:'Connect assistant'}).click();await page.waitForURL(u=>u.hostname==='127.0.0.1');
 const code=await completion;assert.equal(code,0,'Inspector must exit0: '+redacted(raw).slice(-1000));
 const expected=['whoami','inbox','read_notes','recall','list_snapshots','get_snapshot','activity','leave_note','mark_notes_read','handoff','accept_handoff','complete_handoff','remember','forget','save_snapshot'];
 for(const name of expected)assert.ok(raw.includes('"name": "'+name+'"')||raw.includes('"name":"'+name+'"'),'Inspector omitted '+name);
 await writeFile('evidence/inspector-cli.txt',redacted(raw));
 await writeFile('evidence/inspector-verification.json',JSON.stringify({oauth_flow:'pass',registration:'dynamic',login_form:'pass',consent:'pass',agent:'inspector',loopback_callback:'pass',cli_exit_code:code,tool_count:expected.length,tools:expected},null,2)+'\n');
 console.log('PASS official MCP Inspector CLI: DCR → browser login → consent → loopback callback → all15tools');
}finally {
 if(child&&!child.killed)child.kill('SIGTERM');
 if(created){await page.goto(base+'/account/delete');if(new URL(page.url()).pathname==='/login'){await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(u=>u.pathname==='/account/delete');}await page.getByLabel('Type DELETE to confirm').fill('DELETE');await page.getByRole('button',{name:'Delete account and all data',exact:true}).click();await page.waitForURL(base+'/');}
 await browser.close();
}
