import pg from 'pg';
export const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 12, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000});
pool.on('error', () => console.error(JSON.stringify({level:'error',event:'database_pool_error'})));
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
 const client = await pool.connect();
 try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
 catch (err) { await client.query('ROLLBACK'); throw err; }
 finally { client.release(); }
}
