import argon2 from 'argon2';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const email='oscar@arxsable.ai';
const found=await pool.query('SELECT id FROM users WHERE email=$1',[email]);
if(found.rowCount){await pool.end();throw new Error('Owner already exists; credential generation skipped');}
const password=randomBytes(18).toString('base64url');
const hash=await argon2.hash(password,{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1});
const client=await pool.connect();
try{await client.query('BEGIN');const r=await client.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id',[email,hash]);await client.query("INSERT INTO brains(user_id,name) VALUES($1,'default')",[r.rows[0].id]);await client.query('COMMIT');console.log('Email: '+email+'\nPassword: '+password+'\nURL: https://brain.arxsable.ai/login');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();}
