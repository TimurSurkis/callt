import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connect } from './index.js';

export async function migrateDatabase(url: string) {
  const { pool, db } = connect(url);
  try { await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) }); }
  finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await migrateDatabase(process.env.DATABASE_URL);
  console.info('Migrations complete');
}
