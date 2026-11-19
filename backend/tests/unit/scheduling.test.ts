import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { calculateSlots, normalizeDate } from '../../src/modules/scheduling/engine.js';
import type { Service, Tenant } from '../../src/db/schema.js';

const now = new Date('2026-11-19T08:00:00.000Z');
const tenant: Tenant = { id: randomUUID(), name: 'Test', mode: 'CALENDAR', isActive: true, zadarmaNumber: '+48220000001', agentId: 'a', calendarId: 'c', smsPhone: '+48500000000',
  workHours: { '5': [{ start: '08:00', end: '12:00' }] }, scheduling: { slot_step_minutes: 30, booking_horizon_days: 14, min_lead_time_minutes: 60 }, createdAt: now, updatedAt: now };
const service: Service = { id: randomUUID(), tenantId: tenant.id, name: 'diagnostic', durationMinutes: 90, isDiagnostic: true };
describe('Warsaw scheduling', () => {
  it('requires clarification for vague, nonexistent and ambiguous local times', () => {
    expect(normalizeDate('w przyszłym tygodniu', now)).toBeNull();
    expect(normalizeDate('2026-03-29 02:30', now)).toBeNull();
    expect(normalizeDate('2026-10-25 02:30', now)).toBeNull();
    expect(normalizeDate('2026-02-30', now)).toBeNull();
  });
  it('normalizes relative dates before a provider request', () => {
    expect(normalizeDate('jutro po południu', now)!.from.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-11-20 12:00');
    expect(normalizeDate('pojutrze', now)!.from.toISODate()).toBe('2026-11-21');
    expect(normalizeDate('jutro rano', new Date('2026-03-28T12:00:00Z'))!.from.hour).toBe(8);
  });
  it('uses full duration, manual busy intervals and exact boundaries', () => {
    const slots = calculateSlots(tenant, service, normalizeDate('jutro', now)!, [{ start_at: '2026-11-20T08:30:00Z', end_at: '2026-11-20T09:00:00Z' }], now);
    expect(slots).toEqual([
      { start_at: '2026-11-20T07:00:00.000Z', end_at: '2026-11-20T08:30:00.000Z' },
      { start_at: '2026-11-20T09:00:00.000Z', end_at: '2026-11-20T10:30:00.000Z' },
      { start_at: '2026-11-20T09:30:00.000Z', end_at: '2026-11-20T11:00:00.000Z' },
    ]);
  });
  it('does not search the past or beyond the configured horizon', () => {
    expect(calculateSlots(tenant, service, normalizeDate('2026-01-01', now)!, [], now)).toEqual([]);
    expect(calculateSlots(tenant, service, normalizeDate('2027-01-01', now)!, [], now)).toEqual([]);
  });
});
