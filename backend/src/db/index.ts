import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export function connect(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  // A pool error must not crash the process or log a connection string.
  pool.on('error', () => undefined);
  return { pool, db: drizzle(pool, { schema }) };
}
export type Database = ReturnType<typeof connect>['db'];
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export async function tenantLock(tx: Tx, tenantId: string) {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);
}
