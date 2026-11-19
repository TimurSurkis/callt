import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config/index.js';
import type { Clock } from '../src/shared/core.js';

export class TestClock implements Clock {
  constructor(public date = new Date('2026-11-19T08:00:00.000Z')) {}
  now() { return new Date(this.date); }
  advance(ms: number) { this.date = new Date(this.date.getTime() + ms); }
}
export function testConfig(databaseUrl = 'postgresql://test@localhost/gloso_test') {
  return loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl,
    ADMIN_SECRET: randomBytes(32).toString('hex'), TOOL_SECRET: randomBytes(32).toString('hex'), WEBHOOK_SECRET: randomBytes(32).toString('hex'),
    SLOT_SECRET: randomBytes(32).toString('hex'), IDEMPOTENCY_SECRET: randomBytes(32).toString('hex'), AUDIT_KEY: randomBytes(32).toString('hex') });
}
export const testHours = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i + 1), [{ start: '08:00', end: '17:00' }]]));
export function tenantInput(index = 1, mode: 'CALENDAR' | 'RELAY' = 'CALENDAR') {
  return { name: `TEST ${index}`, mode, zadarma_number: `+4822000${String(index).padStart(4, '0')}`, elevenlabs_agent_id: `test-agent-${index}`,
    google_calendar_id: mode === 'CALENDAR' ? `calendar-${index}` : null, sms_recipient_phone: '+48500111222', work_hours: testHours,
    scheduling_config: { slot_step_minutes: 30, booking_horizon_days: 14, min_lead_time_minutes: 60 } };
}
