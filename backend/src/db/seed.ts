import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { connect } from './index.js';
import { tenants } from './schema.js';
import { TenantService } from '../modules/tenants/service.js';
import { createTenantSchema } from '../shared/contracts.js';
import { systemClock } from '../shared/core.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (process.env.NODE_ENV === 'production') throw new Error('Test seed is disabled in production');
const { db, pool } = connect(process.env.DATABASE_URL);
try {
  const service = new TenantService(db, systemClock);
  for (const [index, mode] of (['CALENDAR', 'RELAY'] as const).entries()) {
    const agent = `mock-agent-${index + 1}`;
    const [existing] = await db.select().from(tenants).where(eq(tenants.agentId, agent));
    if (existing) { console.info(JSON.stringify({ mode, tenant_id: existing.id, status: 'already_exists' })); continue; }
    const tenant = await service.create(createTenantSchema.parse({ name: `TEST — ${mode}`, mode, zadarma_number: `+4822000000${index + 1}`,
      elevenlabs_agent_id: agent, google_calendar_id: mode === 'CALENDAR' ? 'mock-calendar-1' : null, sms_recipient_phone: '+48500000000',
      work_hours: { '1': [{ start: '08:00', end: '17:00' }], '2': [{ start: '08:00', end: '17:00' }], '3': [{ start: '08:00', end: '17:00' }], '4': [{ start: '08:00', end: '17:00' }], '5': [{ start: '08:00', end: '17:00' }] } }));
    const items = await service.upsertServices(tenant.id, { services: [{ name: 'TEST — diagnostyka', duration_minutes: 60, is_diagnostic: true }, { name: 'TEST — wymiana oleju', duration_minutes: 30, is_diagnostic: false }] });
    console.info(JSON.stringify({ mode, tenant_id: tenant.id, services: items.services.map((s) => ({ id: s.id, name: s.name })) }));
  }
} finally { await pool.end(); }
