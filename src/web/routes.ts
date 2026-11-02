import { Router, type Request, type Response } from 'express';
import express from 'express';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { pool, transaction } from '../db/index.js';
import { config } from '../config.js';
import { createSession, destroySession, requireUser, csrf, csrfToken } from '../auth/session.js';
import { loginRateLimit } from '../auth/rate-limit.js';
import { purgeBrainContent,removeUserWorkspaces } from '../brain/purge.js';
import { dashboardRouter } from './dashboard.js';
import { passwordError, safeNext, validAgent, validEmail } from './validation.js';

export const webRouter = Router();
webRouter.use('/assets', express.static(resolve('src/web/public'), { maxAge: '1h', immutable: false }));
webRouter.use((req, res, next) => {
  res.locals.config = config;
  res.locals.user = req.user;
  res.locals.csrf = csrfToken(req);
  res.locals.error = undefined;
  res.locals.notice = undefined;
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const page = (res: Response, view: string, title: string, locals: Record<string, unknown> = {}) => res.render(view, { title, ...locals });
webRouter.get('/', (_req, res) => page(res, 'home', 'A shared brain for your assistants'));
webRouter.get('/docs', (_req, res) => page(res, 'docs', 'Connect your assistants'));
webRouter.get('/privacy', (_req, res) => page(res, 'privacy', 'Your data, under your control'));
webRouter.get('/signup', (req, res) => page(res, 'auth', 'Create your brain', { mode: 'signup', next: safeNext(req.query.next), email: '' }));
webRouter.get('/login', (req, res) => page(res, 'auth', 'Welcome back', { mode: 'login', next: safeNext(req.query.next), email: '' }));

// A fixed real hash makes failed unknown-account verification take the same expensive path.
const dummyHash = argon2.hash(randomBytes(32), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
webRouter.post('/signup', csrf, loginRateLimit, async (req: Request, res: Response) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body.password;
  const next = safeNext(req.body.next);
  let error = passwordError(password);
  if (!validEmail(email)) error = 'Enter a valid email address.';
  if (req.body.age_confirm !== 'yes') error = 'You must be 18 or older to use Brain.';
  if (error) return page(res.status(400), 'auth', 'Create your brain', { mode: 'signup', next, email, error });
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  try {
    const userId = await transaction(async db => {
      const user = await db.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email, passwordHash]);
      await db.query("INSERT INTO brains(user_id,name) VALUES($1,'default')", [user.rows[0].id]);
      return user.rows[0].id as string;
    });
    await createSession(req, res, userId);
    res.redirect(303, next);
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err;
    page(res.status(400), 'auth', 'Create your brain', { mode: 'signup', next, email, error: 'Unable to create an account with those details. Try signing in.' });
  }
});
webRouter.post('/login', csrf, loginRateLimit, async (req: Request, res: Response) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' && req.body.password.length <= 1024 ? req.body.password : '';
  const next = safeNext(req.body.next);
  const users = await pool.query('SELECT id,password_hash FROM users WHERE email=$1 AND deleted_at IS NULL', [email]);
  const found = users.rows[0];
  const matches = await argon2.verify(found?.password_hash ?? await dummyHash, password).catch(() => false);
  if (!found || !matches) return page(res.status(400), 'auth', 'Welcome back', { mode: 'login', next, email, error: 'Email or password is incorrect.' });
  await createSession(req, res, found.id);
  res.redirect(303, next);
});
webRouter.post('/logout', csrf, async (req, res) => {
  await destroySession(req, res);
  res.redirect(303, '/');
});
webRouter.use('/dashboard',dashboardRouter);
webRouter.get('/account', requireUser, async (req, res) => {
  const grants = await pool.query(`SELECT g.id,g.agent_label,g.client_id,g.created_at,g.last_used_at,c.metadata->>'client_name' AS client_name FROM grants g LEFT JOIN oauth_clients c ON c.client_id=g.client_id WHERE g.user_id=$1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`, [req.user!.id]);
  page(res, 'account', 'Your shared brain', { grants: grants.rows, notice: req.query.saved === '1' ? 'Saved.' : undefined });
});
webRouter.get('/account/export', requireUser, async (req, res) => {
  const userId = req.user!.id;
  const data = await transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const result: Record<string, unknown> = { format_version: 2, exported_at: new Date().toISOString(), account: req.user };
    for (const table of ['brains','notes','handoffs','facts','snapshots','activity','brain_sessions','jobs','usage','usage_reservations','nightly_runs']) {
      const rows=(await db.query(`SELECT * FROM ${table} WHERE user_id=$1`, [userId])).rows;
      result[table] = rows.map(row=>{const {session_key,transport_session_id,token_hash,password_hash,secret_hash,lease_id,...safe}=row;return safe;});
    }
    result.connections = (await db.query('SELECT id,brain_id,agent_label,client_id,scope,created_at,last_used_at,revoked_at FROM grants WHERE user_id=$1', [userId])).rows;
    result.oauth_clients = (await db.query('SELECT c.client_id,c.kind,c.metadata,c.created_at,c.last_seen_at FROM oauth_clients c WHERE EXISTS(SELECT 1 FROM grants g WHERE g.client_id=c.client_id AND g.user_id=$1)', [userId])).rows;
    return result;
  });
  res.setHeader('Content-Disposition', 'attachment; filename="brain-export.json"');
  res.json(data);
});
webRouter.post('/account/grants/:id/rename', requireUser, csrf, async (req, res) => {
  if (!validAgent(req.body.agent_label)) return res.status(400).send('Choose a lowercase label with letters, numbers, or hyphens, up to 32 characters. The label all is reserved.');
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id as string)) return res.status(404).send('Connection not found.');
  await transaction(async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user!.id]);
    const grant = await db.query('UPDATE grants SET agent_label=$1 WHERE id=$2 AND user_id=$3 AND revoked_at IS NULL RETURNING id', [req.body.agent_label, req.params.id, req.user!.id]);
    if (grant.rowCount) {
      await db.query('UPDATE auth_codes SET agent_label=$1 WHERE grant_id=$2 AND user_id=$3 AND used_at IS NULL', [req.body.agent_label, req.params.id, req.user!.id]);
    }
  });
  res.redirect(303, '/account?saved=1');
});
webRouter.post('/account/grants/:id/revoke', requireUser, csrf, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id as string)) return res.status(404).send('Connection not found.');
  await transaction(async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user!.id]);
    await db.query('UPDATE grants SET revoked_at=now() WHERE id=$1 AND user_id=$2', [req.params.id, req.user!.id]);
    await db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE grant_id=$1 AND grant_id IN(SELECT id FROM grants WHERE user_id=$2)', [req.params.id, req.user!.id]);
    await db.query('DELETE FROM access_tokens WHERE grant_id=$1 AND grant_id IN(SELECT id FROM grants WHERE user_id=$2)', [req.params.id, req.user!.id]);
  });
  res.redirect(303, '/account?saved=1');
});
webRouter.get('/account/password', requireUser, (_req, res) => page(res, 'password', 'Change password'));
webRouter.post('/account/password', requireUser, csrf, async (req, res) => {
  const error = passwordError(req.body.password);
  if (error) return page(res.status(400), 'password', 'Change password', { error });
  const row = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user!.id]);
  const old = typeof req.body.current_password === 'string' && req.body.current_password.length <= 1024 ? req.body.current_password : '';
  if (!await argon2.verify(row.rows[0].password_hash, old)) return page(res.status(400), 'password', 'Change password', { error: 'Current password is incorrect.' });
  const hash = await argon2.hash(req.body.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  await transaction(async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user!.id]);
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user!.id]);
    await db.query('DELETE FROM auth_codes WHERE user_id=$1 AND used_at IS NULL', [req.user!.id]);
    await db.query('DELETE FROM sessions WHERE user_id=$1', [req.user!.id]);
  });
  await createSession(req, res, req.user!.id);
  res.redirect(303, '/account?saved=1');
});
webRouter.post('/account/signout-everywhere', requireUser, csrf, async (req, res) => {
  await transaction(async db => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user!.id]);
    await db.query('DELETE FROM auth_codes WHERE user_id=$1 AND used_at IS NULL', [req.user!.id]);
    await db.query('DELETE FROM sessions WHERE user_id=$1', [req.user!.id]);
    await db.query('UPDATE grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [req.user!.id]);
    await db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE grant_id IN(SELECT id FROM grants WHERE user_id=$1)', [req.user!.id]);
    await db.query('DELETE FROM access_tokens WHERE grant_id IN(SELECT id FROM grants WHERE user_id=$1)', [req.user!.id]);
  });
  await destroySession(req, res);
  res.redirect(303, '/login');
});
webRouter.get('/account/delete', requireUser, (_req, res) => page(res, 'delete', 'Delete your account'));
webRouter.post('/account/delete', requireUser, csrf, async (req, res) => {
  if (req.body.confirm !== 'DELETE') return page(res.status(400), 'delete', 'Delete your account', { error: 'Type DELETE to confirm.' });
  const brains=(await pool.query('SELECT id FROM brains WHERE user_id=$1',[req.user!.id])).rows;
  for(const brain of brains)await purgeBrainContent(req.user!.id,brain.id);
  await pool.query('DELETE FROM users WHERE id=$1', [req.user!.id]);
  await removeUserWorkspaces(req.user!.id);
  await destroySession(req, res);
  res.redirect(303, '/');
});
