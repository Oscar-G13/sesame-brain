import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base=(process.env.BASE_URL||'https://brain.arxsable.ai').replace(/\/$/,'');
await mkdir('evidence/screenshots',{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,reducedMotion:'reduce'});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const receipts=[];
async function capture(name,path){
 if(path){const response=await page.goto(base+path,{waitUntil:'networkidle'});assert.equal(response.status(),200,`Page ${path}`);}
 const widths=await page.evaluate(()=>({body:document.body.scrollWidth,viewport:innerWidth}));assert.ok(widths.body<=widths.viewport,`Horizontal overflow on ${name}: ${JSON.stringify(widths)}`);
 await page.screenshot({path:`evidence/screenshots/${name}-390.png`,fullPage:true});
 receipts.push({page:name,status:'pass',viewport:'390x844',horizontal_overflow:false});
}
let created=false;
try {
 for(const [name,path] of [['home','/'],['docs','/docs'],['privacy','/privacy'],['login','/login'],['signup','/signup']])await capture(name,path);
 const email='screenshots-'+Date.now()+'-'+randomBytes(6).toString('hex')+'@example.invalid';
 await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill(randomBytes(24).toString('base64url'));await page.getByRole('checkbox').check();
 await page.getByRole('button',{name:'Create account'}).click();await page.waitForURL(base+'/account');created=true;
 await capture('account');
 const verifier=randomBytes(48).toString('base64url');
 const params=new URLSearchParams({client_id:base+'/e2e/client.json',redirect_uri:base+'/e2e/callback',response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:'brain:read brain:write',resource:base+'/mcp',state:randomBytes(12).toString('hex')});
 await capture('consent','/authorize?'+params);
 assert.equal(await page.locator('input[type="radio"]:checked').count(),0,'Consent must not preselect an identity');
 assert.equal(await page.locator('input[type="radio"]').count(),5);
 await page.getByText('Maya',{exact:true}).click();assert.equal(await page.locator('input[type="radio"]:checked').inputValue(),'maya');
 console.log('PASS mobile pages, no horizontal overflow, consent identity picker');
}finally{
 if(created){await page.goto(base+'/account/delete');await page.getByLabel('Type DELETE to confirm').fill('DELETE');await page.getByRole('button',{name:'Delete account and all data',exact:true}).click();await page.waitForURL(base+'/');}
 await writeFile('evidence/screenshots/verification.json',JSON.stringify({pages:receipts,console_errors:errors,disposable_account_deleted:created},null,2)+'\n');
 await browser.close();
}
assert.deepEqual(errors,[],'Browser console must contain no application exceptions');
