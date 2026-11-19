import express from 'express';
import { execFile, fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { connect } from '../../src/db/index.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { processedEvents } from '../../src/db/schema.js';
import { MockCalendar } from '../../src/adapters/calendar/mock.js';
import { TestClock, tenantInput, testConfig } from '../helpers.js';
import { after } from '../../src/shared/core.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test database required');
const { db, pool } = connect(url);
const config = testConfig(url);
const children: ChildProcess[] = [];
let provider: Server;
let providerUrl: string;
let calendar: MockCalendar;
let clock: TestClock;
let inserted: () => void;
let release: () => void;
let insertion: Promise<void>;
let pause: Promise<void>;
let holdResponse = false;

beforeAll(async () => {
  await migrateDatabase(url);
  const app = express(); app.use(express.json());
  app.post('/busy', async (req, res) => { res.json(await calendar.busy(req.body.calendarId, req.body.from, req.body.to)); });
  app.post('/get', async (req, res) => { res.json(await calendar.get(req.body.calendarId, req.body.eventId)); });
  app.post('/insert', async (req, res) => {
    try {
      await calendar.insert(req.body.calendarId, req.body.event);
      inserted();
      if (holdResponse) await pause;
      if (!res.destroyed) res.json({ accepted: true });
    } catch { if (!res.destroyed) res.status(409).json({ error: 'CONFLICT' }); }
  });
  provider = app.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const address = provider.address(); if (!address || typeof address !== 'object') throw new Error('No test provider port');
  providerUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE audit_logs, active_call_reservations, processed_events, tenant_booking_gates, pilot_usage, services, tenants`);
  calendar = new MockCalendar(); clock = new TestClock(); holdResponse = false;
  insertion = new Promise<void>((resolve) => { inserted = resolve; }); pause = new Promise<void>((resolve) => { release = resolve; });
});
afterEach(async () => {
  release();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
  }
});
afterAll(async () => {
  provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve())); await pool.end();
});
async function startBackend() {
  const env = Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)]));
  const child = fork(fileURLToPath(new URL('../fixtures/backend-process.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, ...env, GLOSO_TEST_CLOCK: clock.now().toISOString(), GLOSO_TEST_PROVIDER: providerUrl },
  });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Backend fixture startup timed out')); }, 15000);
    child.once('message', (message) => { clearTimeout(timer); resolve((message as { port: number }).port); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Backend fixture exited before ready')); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}
async function post(base: string, path: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  expect(response.status).toBeLessThan(400);
  return response.json() as Promise<Record<string, unknown>>;
}
async function fixture(base: string) {
  const tenant = tenantInput(); const admin = { 'x-admin-secret': config.ADMIN_SECRET };
  const created = await post(base, '/admin/tenants', tenant, admin);
  const services = await post(base, `/admin/tenants/${created.id}/services`, { services: [{ name: 'TEST', duration_minutes: 60, is_diagnostic: true }] }, admin);
  const admitted = await post(base, '/webhooks/call-admission', { called_number: tenant.zadarma_number, agent_id: tenant.elevenlabs_agent_id,
    external_call_id: randomUUID(), call_started_at: after(clock.now(), -100000).toISOString() }, { 'x-webhook-secret': config.WEBHOOK_SECRET });
  const headers = { 'x-tool-secret': config.TOOL_SECRET, 'x-test-called-number': tenant.zadarma_number, 'x-test-agent-id': tenant.elevenlabs_agent_id,
    'x-test-call-id': String(admitted.call_id), 'x-test-caller-id': '+48600000000' };
  const result = await post(base, '/tools/check-availability', { service_id: (services.services as { id: string }[])[0]!.id, date_query: 'jutro' }, headers);
  const slot = (result.slots as { slot_id: string }[])[0]!;
  return { headers, body: { slot_id: slot.slot_id, client_name: 'Test caller', car_model: 'Test car', problem_description: 'Test problem' } };
}

describe('independent backend processes and surviving provider', () => {
  it('runs the actual migration, repeatable seed and compiled server entrypoint', async () => {
    const env = { ...process.env, ...Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)])) };
    const exec = promisify(execFile);
    await exec(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], { env });
    const firstSeed = await exec(process.execPath, ['--import', 'tsx', 'src/db/seed.ts'], { env });
    const seed = JSON.parse(firstSeed.stdout.split('\n')[0]!) as { tenant_id: string };
    const secondSeed = await exec(process.execPath, ['--import', 'tsx', 'src/db/seed.ts'], { env });
    expect(secondSeed.stdout).toContain('already_exists');
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => { const address = probe.address(); const value = address && typeof address === 'object' ? address.port : 0; probe.close(() => resolve(value)); });
    });
    const child = spawn(process.execPath, ['dist/server.js'], { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Compiled server startup timed out')), 10000);
      child.stdout.on('data', (data: Buffer) => { if (data.toString().includes('LOCAL_MOCK_SERVER_STARTED')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Compiled server exited before ready')); });
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const status = await fetch(`http://127.0.0.1:${port}/admin/tenants/${seed.tenant_id}/status`, { headers: { 'x-admin-secret': config.ADMIN_SECRET } });
    expect(status.status).toBe(200);
    const exit = once(child, 'exit'); child.kill('SIGTERM');
    expect((await exit)[0]).toBe(0);
  });
  it('serializes the same tool call across two processes', async () => {
    const a = await startBackend(); const b = await startBackend(); const f = await fixture(a.url); holdResponse = true;
    const first = post(a.url, '/tools/book-slot', f.body, f.headers);
    await insertion;
    const concurrent = await post(b.url, '/tools/book-slot', f.body, f.headers);
    expect(concurrent.status).toBe('PENDING_VERIFICATION');
    release(); expect((await first).status).toBe('BOOKED');
    expect((await post(b.url, '/tools/book-slot', f.body, f.headers)).status).toBe('BOOKED');
    expect(calendar.insertCalls).toBe(1);
  });
  it('recovers after SIGKILL between external creation and result commit', async () => {
    const a = await startBackend(); const f = await fixture(a.url); holdResponse = true;
    const first = post(a.url, '/tools/book-slot', f.body, f.headers).catch(() => null);
    await insertion;
    const exiting = once(a.child, 'exit'); a.child.kill('SIGKILL'); await exiting; await first;
    const [pending] = await db.select().from(processedEvents).where(eq(processedEvents.eventType, 'BOOKING'));
    expect(pending!.status).toBe('PENDING'); expect(calendar.events.size).toBe(1);
    release(); holdResponse = false; clock.advance(31000);
    const b = await startBackend(); // startup recovery uses the original provider, not a fresh in-memory fake
    expect((await post(b.url, '/tools/book-slot', f.body, f.headers)).status).toBe('BOOKED');
    expect(calendar.insertCalls).toBe(1);
  });
  it('serializes different callers across processes, not only duplicate operation keys', async () => {
    const a = await startBackend(); const b = await startBackend(); const f = await fixture(a.url);
    const secondCall = await post(b.url, '/webhooks/call-admission', {
      called_number: f.headers['x-test-called-number'], agent_id: f.headers['x-test-agent-id'],
      external_call_id: randomUUID(), call_started_at: after(clock.now(), -100000).toISOString(),
    }, { 'x-webhook-secret': config.WEBHOOK_SECRET });
    const secondHeaders = { ...f.headers, 'x-test-call-id': String(secondCall.call_id) };
    holdResponse = true;
    const first = post(a.url, '/tools/book-slot', f.body, f.headers); await insertion;
    expect((await post(b.url, '/tools/book-slot', f.body, secondHeaders)).status).toBe('PENDING_VERIFICATION');
    release(); expect((await first).status).toBe('BOOKED');
    expect((await post(b.url, '/tools/book-slot', f.body, secondHeaders)).status).toBe('SLOT_CONFLICT');
    expect(calendar.insertCalls).toBe(1);
  });
});
