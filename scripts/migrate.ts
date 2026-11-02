import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from '../src/db/index.js';
export async function migrate(): Promise<void> {
 const client = await pool.connect();
 try {
  await client.query('SELECT pg_advisory_lock(7263519801)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const directory = resolve(process.cwd(),'migrations');
  for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
   if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount) continue;
   await client.query('BEGIN');
   try { await client.query(await readFile(resolve(directory,name),'utf8')); await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]); await client.query('COMMIT'); console.log(JSON.stringify({event:'migration_applied',name})); }
   catch(error) { await client.query('ROLLBACK'); throw error; }
  }
 } finally { await client.query('SELECT pg_advisory_unlock(7263519801)'); client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 migrate().then(()=>pool.end()).catch(()=>{console.error(JSON.stringify({event:'migration_failed'}));process.exitCode=1;return pool.end();});
}
