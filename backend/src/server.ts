import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { connect } from './db/index.js';
import { logger } from './shared/core.js';

async function main() {
  const config = loadConfig();
  const { db, pool } = connect(config.DATABASE_URL);
  const runtime = createApp({ db, config });
  try { await runtime.maintenance.run(); }
  catch { await pool.end(); throw new Error('Startup maintenance failed; verify database migrations'); }
  runtime.maintenance.start();
  const server = runtime.app.listen(config.PORT, config.HOST, () => logger.event('LOCAL_MOCK_SERVER_STARTED'));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => { logger.event('SHUTDOWN_TIMEOUT'); process.exit(1); }, 15000);
    timer.unref();
    server.close(() => { void (async () => { await runtime.maintenance.stop(); await pool.end(); clearTimeout(timer); })().catch(() => { process.exitCode = 1; }); });
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  server.on('error', () => { logger.event('LISTEN_FAILED'); stop(); process.exitCode = 1; });
}
main().catch(() => { logger.event('STARTUP_FAILED'); process.exitCode = 1; });
