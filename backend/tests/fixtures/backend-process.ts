import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { connect } from '../../src/db/index.js';
import { TestClock } from '../helpers.js';
import { RemoteMockCalendar } from './remote-calendar.js';

const config = loadConfig();
const { db, pool } = connect(config.DATABASE_URL);
const clock = new TestClock(new Date(process.env.GLOSO_TEST_CLOCK!));
const runtime = createApp({ db, config, clock, calendar: new RemoteMockCalendar(process.env.GLOSO_TEST_PROVIDER!), log: { event: () => undefined } });
await runtime.maintenance.run();
const server = runtime.app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') process.send?.({ port: address.port });
});
const shutdown = () => { server.close(() => { void pool.end().then(() => process.exit(0)); }); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
// Do not leave a child server behind if the Vitest worker crashes.
process.once('disconnect', shutdown);
