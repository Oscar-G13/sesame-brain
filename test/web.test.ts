import { test } from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { resolve } from 'node:path';
import { passwordError, safeNext, validAgent, validEmail } from '../src/web/validation.js';
test('password checks minimum length and bundled common passwords', () => {
 assert.ok(passwordError('short'));
 assert.ok(passwordError('1234567890'));
 assert.equal(passwordError('a unique passphrase for memory 6729'), undefined);
});
test('return URL keeps redirects on this origin', () => {
 assert.equal(safeNext('/authorize?client_id=abc'), '/authorize?client_id=abc');
 for(const value of ['//evil.example','https://evil.example','/\\evil.example','/\nLocation:evil']) assert.equal(safeNext(value), '/account');
});
test('agent labels reserve broadcast and enforce slug length', () => {
 assert.ok(validAgent('charlie')); assert.ok(validAgent('agent-2')); assert.ok(validAgent('3'));
 for(const value of ['all','Maya','bad space','a'.repeat(33),'']) assert.equal(validAgent(value),false);
 assert.ok(validEmail('test@example.com')); assert.equal(validEmail('not-an-email'),false);
});
test('consent renders all identities unselected and escapes client-controlled metadata', async () => {
 const html=await ejs.renderFile(resolve('src/web/views/consent.ejs'),{config:{name:'Brain',resource:'https://brain.example/mcp'},csrf:'csrf-token',client:{client_name:'<script>bad()</script>'},oauthParams:{scope:'brain:read brain:write',redirect_uri:'https://client.example/callback'},redirectHost:'client.example',loopback:false,error:undefined,user:undefined});
 assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;')); assert.ok(!html.includes('<script>bad()'));
 assert.equal((html.match(/type="radio"/g)||[]).length,5);
 assert.ok(!/type="radio"[^>]*checked/.test(html));
 assert.ok(html.includes('name="_csrf" value="csrf-token"'));
});
