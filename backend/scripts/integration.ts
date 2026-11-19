import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

// Never use DATABASE_URL here: an ordinary test command must not touch application data.
const explicit = process.env.TEST_DATABASE_URL;
let dir: string | undefined;
let pgBin: string | undefined;
try {
  let url = explicit;
  if (url) {
    if (!/^\/[^/]*_test$/.test(new URL(url).pathname)) throw new Error('TEST_DATABASE_URL must use a dedicated database ending in _test');
  } else {
    pgBin = process.env.PG_BIN;
    if (!pgBin) {
      try { pgBin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); }
      catch { throw new Error('Install PostgreSQL binaries, set PG_BIN, or set a dedicated TEST_DATABASE_URL'); }
    }
    if (!existsSync(join(pgBin, 'initdb'))) throw new Error('initdb not found in PG_BIN');
    const base = process.env.GLOSO_TEST_TMP ?? '/tmp/opencode';
    if (!existsSync(base)) throw new Error('Create GLOSO_TEST_TMP or /tmp/opencode first');
    dir = mkdtempSync(join(base, 'gloso-pg-'));
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const address = server.address(); const n = typeof address === 'object' && address ? address.port : 0; server.close(() => resolve(n)); });
    });
    execFileSync(join(pgBin, 'initdb'), ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'gloso_test', '--no-locale', '-E', 'UTF8'], { stdio: 'pipe' });
    execFileSync(join(pgBin, 'pg_ctl'), ['-D', join(dir, 'data'), '-l', join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${dir}`, '-w', 'start'], { stdio: 'pipe' });
    const admin = new pg.Client({ connectionString: `postgresql://gloso_test@127.0.0.1:${port}/postgres` });
    await admin.connect();
    try { await admin.query('CREATE DATABASE gloso_test'); } finally { await admin.end(); }
    url = `postgresql://gloso_test@127.0.0.1:${port}/gloso_test`;
  }
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--project', 'integration'], { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url, NODE_ENV: 'test' } });
  const interrupt = () => { child.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (value) => resolve(value ?? 1)); });
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  process.exitCode = code;
} finally {
  if (dir && pgBin) {
    try { execFileSync(join(pgBin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' }); }
    catch { /* initdb/start may have failed before the server existed. */ }
    // Only this runner's own mkdtemp directory; never a configured database directory.
    rmSync(dir, { recursive: true, force: true });
  }
}
