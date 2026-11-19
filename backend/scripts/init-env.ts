import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

let template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
for (const name of ['ADMIN_SECRET', 'TOOL_SECRET', 'WEBHOOK_SECRET', 'SLOT_SECRET', 'IDEMPOTENCY_SECRET', 'AUDIT_KEY']) {
  template = template.replace(new RegExp(`^${name}=$`, 'm'), `${name}=${randomBytes(32).toString('hex')}`);
}
// Never overwrite existing developer credentials, even when this command is repeated.
writeFileSync(new URL('../.env', import.meta.url), template, { flag: 'wx', mode: 0o600 });
console.info('Created .env with independent local secrets. Configure DATABASE_URL before migrating.');
