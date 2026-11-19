import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { connect } from '../../src/db/index.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { auditLogs, calls, gates, pilotUsage, processedEvents } from '../../src/db/schema.js';
import { MockCalendar } from '../../src/adapters/calendar/mock.js';
import { MockSms } from '../../src/adapters/sms/mock.js';
import { after, DAY_MS } from '../../src/shared/core.js';
import { decrypt, readSlot, signSlot } from '../../src/shared/crypto.js';
import { TestClock, tenantInput, testConfig } from '../helpers.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated TEST_DATABASE_URL required; run npm run test:integration');
const { db, pool } = connect(url);
const config = testConfig(url);
let clock: TestClock;
let calendar: MockCalendar;
let sms: MockSms;
let runtime: ReturnType<typeof createApp>;
const logs: string[] = [];
const client = { client_name: 'PRIVATE_ALICJA_739', client_phone: '+48739998877', car_model: 'PRIVATE_CAR_739', problem_description: 'PRIVATE_PROBLEM_739' };
type Fixture = { id: string; serviceId: string; input: ReturnType<typeof tenantInput> };
type Session = Fixture & { callId: string; externalId: string; started: string };
beforeAll(async () => { await migrateDatabase(url); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.execute(sql`TRUNCATE TABLE audit_logs, active_call_reservations, processed_events, tenant_booking_gates, pilot_usage, services, tenants`);
  clock = new TestClock(); calendar = new MockCalendar(); sms = new MockSms(); logs.length = 0;
  runtime = createApp({ db, config, clock, calendar, sms, log: { event: (code) => logs.push(code) } });
});
afterAll(async () => { await pool.end(); });

async function workshop(index = 1, mode: 'CALENDAR' | 'RELAY' = 'CALENDAR'): Promise<Fixture> {
  const input = tenantInput(index, mode);
  const created = await request(runtime.app).post('/admin/tenants').set('x-admin-secret', config.ADMIN_SECRET).send(input).expect(201);
  const added = await request(runtime.app).post(`/admin/tenants/${created.body.id}/services`).set('x-admin-secret', config.ADMIN_SECRET)
    .send({ services: [{ name: 'TEST diagnostyka', duration_minutes: 90, is_diagnostic: true }] }).expect(200);
  return { id: created.body.id as string, serviceId: added.body.services[0].id as string, input };
}
async function session(fixture: Fixture): Promise<Session> {
  const externalId = randomUUID(); const started = after(clock.now(), -100000).toISOString();
  const response = await admission(fixture, externalId, started).expect(200);
  expect(response.body.allowed).toBe(true);
  return { ...fixture, callId: response.body.call_id as string, externalId, started };
}
function admission(fixture: Fixture, externalId: string, started = after(clock.now(), -100000).toISOString()) {
  return request(runtime.app).post('/webhooks/call-admission').set('x-webhook-secret', config.WEBHOOK_SECRET).send({ called_number: fixture.input.zadarma_number, agent_id: fixture.input.elevenlabs_agent_id, external_call_id: externalId, call_started_at: started });
}
function tool(s: Session, path: string, caller = true) {
  let req = request(runtime.app).post(`/tools/${path}`).set('x-tool-secret', config.TOOL_SECRET)
    .set('x-test-called-number', s.input.zadarma_number).set('x-test-agent-id', s.input.elevenlabs_agent_id).set('x-test-call-id', s.callId);
  if (caller) req = req.set('x-test-caller-id', '+48600111222');
  return req;
}
async function slots(s: Session) {
  const response = await tool(s, 'check-availability').send({ service_id: s.serviceId, date_query: 'jutro' }).expect(200);
  expect(response.body.status).toBe('SLOTS_AVAILABLE');
  return response.body.slots as { slot_id: string; start_at: string; end_at: string }[];
}
function end(s: Session, seconds = 85) {
  return request(runtime.app).post('/webhooks/call-ended').set('x-webhook-secret', config.WEBHOOK_SECRET)
    .send({ called_number: s.input.zadarma_number, agent_id: s.input.elevenlabs_agent_id, external_call_id: s.externalId, call_started_at: s.started, call_ended_at: clock.now().toISOString(), ai_seconds: seconds });
}

describe('HTTP and configuration', () => {
  it('checks health and marks responses as local mocks', async () => {
    const response = await request(runtime.app).get('/health').expect(200);
    expect(response.body.mode).toBe('local-mock'); expect(response.headers['x-gloso-mode']).toBe('local-mock');
  });
  it('separates secrets and authenticates before parsing', async () => {
    await request(runtime.app).post('/admin/tenants').send({}).expect(401);
    await request(runtime.app).post('/admin/tenants').set('x-admin-secret', config.TOOL_SECRET).send({}).expect(401);
    await request(runtime.app).post('/admin/tenants').set('Content-Type', 'application/json').send('{broken').expect(401);
    await request(runtime.app).post('/tools/check-availability').send({}).expect(401);
    await request(runtime.app).post('/webhooks/call-ended').send({}).expect(401);
  });
  it('validates bodies, does not echo input values and handles invalid JSON', async () => {
    const response = await request(runtime.app).post('/admin/tenants').set('x-admin-secret', config.ADMIN_SECRET).send({ client_phone: 'PRIVATE_VALUE' }).expect(400);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_VALUE');
    await request(runtime.app).post('/admin/tenants').set('x-admin-secret', config.ADMIN_SECRET).set('Content-Type', 'application/json').send('{broken').expect(400);
    await request(runtime.app).post('/admin/tenants').set('x-admin-secret', config.ADMIN_SECRET).type('text').send('text').expect(415);
  });
  it('persists settings across application instances and rejects inconsistent config', async () => {
    const w = await workshop();
    runtime = createApp({ db, config, clock, calendar, sms });
    const response = await request(runtime.app).get(`/admin/tenants/${w.id}/status`).set('x-admin-secret', config.ADMIN_SECRET).expect(200);
    expect(response.body.pilot.minutes_limit).toBe(40); expect(response.body.services).toHaveLength(1);
    await request(runtime.app).patch(`/admin/tenants/${w.id}`).set('x-admin-secret', config.ADMIN_SECRET).send({ google_calendar_id: null }).expect(400);
    await request(runtime.app).post(`/admin/tenants/${w.id}/services`).set('x-admin-secret', config.ADMIN_SECRET)
      .send({ services: [{ name: 'Another diagnostic', duration_minutes: 60, is_diagnostic: true }] }).expect(409);
  });
  it('does not allow a service update across tenants', async () => {
    const a = await workshop(); const b = await workshop(2);
    await request(runtime.app).post(`/admin/tenants/${a.id}/services`).set('x-admin-secret', config.ADMIN_SECRET)
      .send({ services: [{ id: b.serviceId, name: 'bad', duration_minutes: 30 }] }).expect(404);
  });
});

describe('admission and usage', () => {
  it('waits at least ten seconds in the local admission simulation', async () => {
    const w = await workshop();
    const response = await admission(w, randomUUID(), clock.now().toISOString());
    expect(response.body).toMatchObject({ allowed: false, reason: 'TOO_EARLY', retry_after_seconds: 10 });
  });
  it('admits only one concurrent caller when one minute remains', async () => {
    const w = await workshop();
    await db.update(pilotUsage).set({ minutesUsed: 39 }).where(eq(pilotUsage.tenantId, w.id));
    const responses = await Promise.all(Array.from({ length: 12 }, () => admission(w, randomUUID())));
    expect(responses.filter((r) => r.body.allowed)).toHaveLength(1);
    const rows = await db.select().from(calls).where(and(eq(calls.tenantId, w.id), eq(calls.status, 'ACTIVE')));
    expect(rows).toHaveLength(1);
  });
  it('deduplicates admission without prolonging the reserve', async () => {
    const s = await session(await workshop());
    const [old] = await db.select().from(calls).where(eq(calls.callId, s.callId));
    clock.advance(10000);
    const again = await admission(s, s.externalId, s.started);
    const [next] = await db.select().from(calls).where(eq(calls.callId, s.callId));
    expect(again.body.call_id).toBe(s.callId); expect(next!.reservationExpiresAt).toEqual(old!.reservationExpiresAt);
    clock.advance(600000);
    const expired = await admission(s, s.externalId, s.started);
    expect(expired.body.reason).toBe('ADMISSION_EXPIRED');
  });
  it('charges ceil(seconds / 60) exactly once under concurrent deliveries', async () => {
    const s = await session(await workshop());
    const results = await Promise.all([end(s), end(s), end(s)]);
    expect(results.filter((r) => r.body.status === 'ACCOUNTED')).toHaveLength(1);
    const [pilot] = await db.select().from(pilotUsage).where(eq(pilotUsage.tenantId, s.id));
    expect(pilot!.minutesUsed).toBe(2);
    expect((await admission(s, s.externalId, s.started)).body.reason).toBe('CALL_CLOSED');
  });
  it('expires reservations logically and still accounts late completion', async () => {
    const s = await session(await workshop());
    clock.advance(11 * 60000);
    const status = await request(runtime.app).get(`/admin/tenants/${s.id}/status`).set('x-admin-secret', config.ADMIN_SECRET);
    expect(status.body.pilot.minutes_reserved).toBe(0);
    expect((await end(s)).body.minutes_charged).toBe(2);
  });
  it('accounts zero-length and orphan completions without freeing someone else’s reserve', async () => {
    const w = await workshop(); const active = await session(w); const zero = await session(w);
    expect((await end(zero, 0)).body.minutes_charged).toBe(0);
    const orphan = { ...active, externalId: randomUUID() };
    await end(orphan).expect(200);
    const [stillActive] = await db.select().from(calls).where(eq(calls.callId, active.callId));
    expect(stillActive!.status).toBe('ACTIVE');
    expect((await end(orphan)).body.status).toBe('ALREADY_PROCESSED');
  });
  it('blocks new callers after exhaustion but allows tools for an ongoing call', async () => {
    const w = await workshop(); const ongoing = await session(w); const completed = await session(w);
    await db.update(pilotUsage).set({ minutesUsed: 39 }).where(eq(pilotUsage.tenantId, w.id));
    await end(completed);
    expect((await admission(w, randomUUID())).body.allowed).toBe(false);
    await slots(ongoing);
  });
  it('rejects expired pilots and events outside the replay window', async () => {
    const w = await workshop();
    await db.update(pilotUsage).set({ expiresAt: after(clock.now(), -1) }).where(eq(pilotUsage.tenantId, w.id));
    expect((await admission(w, randomUUID())).body.reason).toBe('PILOT_EXPIRED');
    expect((await admission(w, randomUUID(), after(clock.now(), -8 * DAY_MS).toISOString())).body.reason).toBe('EVENT_TOO_OLD');
  });
});

describe('slots and bookings', () => {
  it('uses diagnostic fallback and asks to clarify ambiguous dates', async () => {
    const s = await session(await workshop());
    const found = await tool(s, 'check-availability').send({ date_query: 'jutro' });
    expect(found.body.service_id).toBe(s.serviceId);
    const count = calendar.busyCalls;
    expect((await tool(s, 'check-availability').send({ service_id: s.serviceId, date_query: 'kiedyś' })).body.status).toBe('DATE_CLARIFICATION_REQUIRED');
    expect(calendar.busyCalls).toBe(count);
  });
  it('books one event, sends one SMS and uses trusted Caller ID', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s);
    const booked = await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id }).expect(200);
    expect(booked.body).toMatchObject({ status: 'BOOKED', sms_sent: true });
    const repeat = await tool(s, 'book-slot').send({ ...client, client_name: 'CHANGED', slot_id: slot!.slot_id });
    expect(repeat.body.status).toBe('BOOKED'); expect(calendar.insertCalls).toBe(1); expect(sms.sendCalls).toBe(1);
    const event = [...calendar.events.values()][0]!;
    expect(event.client.phone).toBe('+48600111222'); expect(event.client.name).toBe(client.client_name);
    expect(event.client.phone_source).toBe('CALLER_ID');
    expect(Date.parse(event.end_at) - Date.parse(event.start_at)).toBe(90 * 60000);
  });
  it('rejects forged context, extra LLM authority fields and cross-tenant slots', async () => {
    const a = await session(await workshop()); const b = await session(await workshop(2)); const [slot] = await slots(a);
    await tool(b, 'book-slot').send({ ...client, slot_id: slot!.slot_id }).expect(403);
    await tool(a, 'check-availability').set('x-test-call-id', b.callId).send({ service_id: a.serviceId, date_query: 'jutro' }).expect(401);
    await tool(a, 'check-availability').send({ service_id: a.serviceId, date_query: 'jutro', called_number: b.input.zadarma_number }).expect(400);
    await tool(a, 'book-slot').send({ ...client, slot_id: `${slot!.slot_id}x` }).expect(400);
    await tool(a, 'check-availability').send({ service_id: b.serviceId, date_query: 'jutro' }).expect(404);
  });
  it('returns conflicts after manual calendar changes', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s);
    calendar.manual.set(s.input.google_calendar_id!, [{ start_at: slot!.start_at, end_at: slot!.end_at }]);
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id })).body.status).toBe('SLOT_CONFLICT');
    expect(calendar.insertCalls).toBe(0);
  });
  it('allows Relay after a read failure before insert or a definite insert rejection', async () => {
    const a = await session(await workshop()); const [slotA] = await slots(a); calendar.failBusy = true;
    expect((await tool(a, 'book-slot').send({ ...client, slot_id: slotA!.slot_id })).body.status).toBe('CALENDAR_ERROR_USE_RELAY');
    expect((await tool(a, 'create-relay').send({ ...client, preferred_time: 'jutro' })).body.status).toBe('RELAY_SENT');
    calendar.failBusy = false;
    const b = await session(await workshop(2)); const [slotB] = await slots(b); calendar.nextInsert = 'REJECTED';
    expect((await tool(b, 'book-slot').send({ ...client, slot_id: slotB!.slot_id })).body.status).toBe('CALENDAR_ERROR_USE_RELAY');
    expect((await tool(b, 'create-relay').send({ ...client, preferred_time: 'jutro' })).body.status).toBe('RELAY_SENT');
  });
  it('keeps an ambiguous 5xx and a conflicting ID pending until successful verification', async () => {
    const a = await session(await workshop()); const [slotA] = await slots(a); calendar.nextInsert = 'SERVER_ERROR';
    expect((await tool(a, 'book-slot').send({ ...client, slot_id: slotA!.slot_id })).body.status).toBe('PENDING_VERIFICATION');
    const b = await session(await workshop(2)); const [slotB] = await slots(b); calendar.nextInsert = 'CONFLICT';
    expect((await tool(b, 'book-slot').send({ ...client, slot_id: slotB!.slot_id })).body.status).toBe('PENDING_VERIFICATION');
    calendar.failGet = true;
    expect((await tool(b, 'book-slot').send({ ...client, slot_id: slotB!.slot_id })).body.status).toBe('PENDING_VERIFICATION');
    expect(calendar.insertCalls).toBe(2);
  });
  it('serializes different operations while no DB transaction is held during insert', async () => {
    const w = await workshop(); const a = await session(w); const b = await session(w); const [slot] = await slots(a);
    let release!: () => void; let entered!: () => void;
    const pause = new Promise<void>((r) => { release = r; }); const started = new Promise<void>((r) => { entered = r; });
    calendar.beforeInsert = async () => { entered(); await pause; };
    const first = tool(a, 'book-slot').send({ ...client, slot_id: slot!.slot_id }).then((r) => r);
    await started;
    const second = await tool(b, 'book-slot').send({ ...client, slot_id: slot!.slot_id });
    expect(second.body.status).toBe('PENDING_VERIFICATION');
    release();
    expect((await first).body.status).toBe('BOOKED');
    calendar.beforeInsert = undefined;
    const retry = await tool(b, 'book-slot').send({ ...client, slot_id: slot!.slot_id });
    expect(retry.body.status).toBe('SLOT_CONFLICT'); expect(calendar.events.size).toBe(1);
  });
  it('recovers an insert that succeeded before a network timeout', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s); calendar.nextInsert = 'TIMEOUT_AFTER';
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id })).body.status).toBe('PENDING_VERIFICATION');
    expect((await tool(s, 'create-relay').send({ ...client, preferred_time: 'jutro' })).body.status).toBe('PENDING_VERIFICATION');
    expect(sms.sendCalls).toBe(0);
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id })).body.status).toBe('BOOKED');
    expect(calendar.insertCalls).toBe(1); expect(sms.sendCalls).toBe(1);
  });
  it('keeps a 404 after an uncertain insert blocked rather than inserting a new event', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s); calendar.nextInsert = 'TIMEOUT_BEFORE';
    await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id });
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id })).body.status).toBe('PENDING_VERIFICATION');
    const [gate] = await db.select().from(gates).where(eq(gates.tenantId, s.id));
    expect(gate!.state).toBe('BUSY'); expect(calendar.insertCalls).toBe(1);
  });
  it('recovers durable PENDING after result-commit failure and application recreation', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s);
    calendar.beforeInsert = async () => { vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('simulated commit failure')); };
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id })).body.status).toBe('PENDING_VERIFICATION');
    const [op] = await db.select().from(processedEvents).where(eq(processedEvents.eventType, 'BOOKING'));
    expect(op!.status).toBe('PENDING');
    calendar.beforeInsert = undefined; clock.advance(31000);
    runtime = createApp({ db, config, clock, calendar, sms });
    await runtime.maintenance.recover();
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id })).body.status).toBe('BOOKED');
    expect(calendar.insertCalls).toBe(1);
  });
  it('does not let an old lease owner release the gate after a delayed insert', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s);
    let release!: () => void; let entered!: () => void;
    const pause = new Promise<void>((r) => { release = r; }); const enteredPromise = new Promise<void>((r) => { entered = r; });
    calendar.beforeInsert = async () => { entered(); await pause; };
    const response = tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id }).then((r) => r);
    await enteredPromise; clock.advance(31000);
    await runtime.bookings.recover(s.id); // 404 while old insert is still in flight.
    release(); expect((await response).body.status).toBe('PENDING_VERIFICATION');
    const [gate] = await db.select().from(gates).where(eq(gates.tenantId, s.id));
    expect(gate!.state).toBe('BUSY');
    clock.advance(31000); await runtime.bookings.recover(s.id);
    expect(calendar.events.size).toBe(1);
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id })).body.status).toBe('BOOKED');
  });
  it('keeps booked events when SMS fails', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s); sms.nextSend = 'REJECTED';
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id })).body).toMatchObject({ status: 'BOOKED', sms_sent: false, sms_status: 'FAILED' });
    await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id });
    expect(calendar.insertCalls).toBe(1); expect(sms.sendCalls).toBe(1);
  });
  it('deduplicates reissued tokens and allows expired tokens only for existing results', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s);
    await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id });
    const payload = readSlot(config.SLOT_SECRET, slot!.slot_id);
    const reissued = signSlot(config.SLOT_SECRET, { ...payload, exp: payload.exp + 100 });
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: reissued })).body.status).toBe('BOOKED');
    clock.advance(16 * 60000);
    expect((await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id })).body.status).toBe('BOOKED');
    const other = signSlot(config.SLOT_SECRET, { ...payload, start_at: '2026-11-20T15:00:00.000Z', end_at: '2026-11-20T16:30:00.000Z' });
    await tool(s, 'book-slot').send({ ...client, slot_id: other }).expect(400);
    expect(calendar.insertCalls).toBe(1);
  });
});

describe('Relay and SMS uncertainty', () => {
  it('does not call calendar in Relay and marks dictated numbers unverified', async () => {
    const s = await session(await workshop(1, 'RELAY'));
    expect((await tool(s, 'check-availability').send({ date_query: 'jutro' })).body.reason).toBe('RELAY_MODE');
    expect((await tool(s, 'create-relay', false).send({ ...client, preferred_time: 'jutro' })).body.status).toBe('RELAY_SENT');
    await tool(s, 'create-relay', false).send({ ...client, preferred_time: 'jutro' });
    expect(calendar.busyCalls).toBe(0); expect(calendar.insertCalls).toBe(0); expect(sms.sendCalls).toBe(1);
    expect([...sms.messages.values()][0]!.text).toContain('niezweryfikowany');
  });
  it('requires a callback number when Caller ID is hidden', async () => {
    const s = await session(await workshop(1, 'RELAY'));
    await tool(s, 'create-relay', false).send({ client_name: 'A', car_model: 'B', problem_description: 'C', preferred_time: 'jutro' }).expect(400);
    expect(sms.sendCalls).toBe(0);
  });
  it('falls back for a calendar read failure without changing the permanent mode', async () => {
    const s = await session(await workshop()); calendar.failBusy = true;
    expect((await tool(s, 'check-availability').send({ service_id: s.serviceId, date_query: 'jutro' })).body.reason).toBe('CALENDAR_UNAVAILABLE');
    expect((await tool(s, 'create-relay').send({ ...client, preferred_time: 'jutro' })).body.status).toBe('RELAY_SENT');
    const status = await request(runtime.app).get(`/admin/tenants/${s.id}/status`).set('x-admin-secret', config.ADMIN_SECRET);
    expect(status.body.mode).toBe('CALENDAR');
  });
  it('reconciles accepted SMS without resending', async () => {
    const s = await session(await workshop(1, 'RELAY')); sms.nextSend = 'TIMEOUT_AFTER';
    expect((await tool(s, 'create-relay').send({ ...client, preferred_time: 'jutro' })).body.status).toBe('PENDING_VERIFICATION');
    expect((await tool(s, 'create-relay').send({ ...client, preferred_time: 'jutro' })).body.status).toBe('RELAY_SENT');
    expect(sms.sendCalls).toBe(1);
  });
  it('never blindly retries an SMS whose outcome cannot be verified', async () => {
    const s = await session(await workshop(1, 'RELAY')); sms.nextSend = 'TIMEOUT_BEFORE'; sms.supportsLookup = false;
    await tool(s, 'create-relay').send({ ...client, preferred_time: 'jutro' });
    expect((await tool(s, 'create-relay').send({ ...client, preferred_time: 'jutro' })).body.status).toBe('PENDING_VERIFICATION');
    expect(sms.sendCalls).toBe(1);
  });
});

describe('privacy and retention', () => {
  it('does not persist client details, visit times, token or provider IDs in audits', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s);
    await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id });
    const forbidden = [...Object.values(client), '+48600111222', slot!.slot_id, slot!.start_at, slot!.end_at];
    for (const table of ['tenants', 'services', 'pilot_usage', 'active_call_reservations', 'processed_events', 'tenant_booking_gates', 'audit_logs']) {
      const result = await db.execute<{ data: string }>(sql.raw(`SELECT row_to_json(t)::text AS data FROM ${table} t`));
      const text = JSON.stringify(result.rows);
      for (const value of forbidden) expect(text, `${table} leaked ${value}`).not.toContain(value);
    }
    const audits = await db.select().from(auditLogs);
    for (const audit of audits) {
      const data = JSON.stringify(decrypt(config.AUDIT_KEY, audit.encryptedMeta));
      expect(data).not.toContain(s.externalId); expect(data).not.toContain(s.callId); expect(data).not.toContain('slot_start_at');
    }
    expect(JSON.stringify(logs)).not.toContain(client.client_name);
  });
  it('sets expiry from actual completion, including later audit writes', async () => {
    const s = await session(await workshop()); clock.advance(10000);
    const ended = clock.now(); await end(s);
    clock.advance(60000);
    await runtime.audit.write(s.id, s.callId, 'PROVIDER_ERROR', { provider_status: 'UNKNOWN' });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, s.id));
    expect(audits.every((a) => a.expiresAt.getTime() === ended.getTime() + 30 * DAY_MS)).toBe(true);
  });
  it('removes the operational mapping without cascading audit removal', async () => {
    const s = await session(await workshop()); await end(s); clock.advance(8 * DAY_MS);
    await runtime.maintenance.cleanup();
    expect(await db.select().from(calls)).toHaveLength(0);
    expect((await runtime.audit.read(s.id)).length).toBeGreaterThan(0);
    expect((await end(s)).body.status).toBe('EVENT_TOO_OLD');
  });
  it('hides expired audits before physical cleanup and coordinates cleanup runs', async () => {
    const s = await session(await workshop()); clock.advance(31 * DAY_MS);
    expect(await runtime.audit.read(s.id)).toHaveLength(0);
    expect((await db.select().from(auditLogs)).length).toBeGreaterThan(0);
    const other = createApp({ db, config, clock, calendar, sms });
    await Promise.all([runtime.maintenance.run(), runtime.maintenance.run(), other.maintenance.run()]);
    expect(await db.select().from(auditLogs)).toHaveLength(0);
  });
  it('keeps unresolved workshops blocked after journal deletion and requires explicit manual verification', async () => {
    const s = await session(await workshop()); const [slot] = await slots(s); calendar.nextInsert = 'TIMEOUT_BEFORE';
    await tool(s, 'book-slot').send({ ...client, slot_id: slot!.slot_id }); clock.advance(8 * DAY_MS);
    await runtime.maintenance.cleanup();
    const [gate] = await db.select().from(gates).where(eq(gates.tenantId, s.id));
    expect(gate!.state).toBe('RECOVERY_REQUIRED'); expect(gate!.operationKey).toBeNull();
    expect(await db.select().from(processedEvents)).toHaveLength(0);
    await request(runtime.app).post(`/admin/tenants/${s.id}/recovery-release`).set('x-admin-secret', config.ADMIN_SECRET).send({}).expect(400);
    await request(runtime.app).post(`/admin/tenants/${s.id}/recovery-release`).set('x-admin-secret', config.ADMIN_SECRET)
      .send({ writers_stopped: true, external_calendar_verified: true }).expect(200);
  });
});
