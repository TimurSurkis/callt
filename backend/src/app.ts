import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import type { Config } from './config/index.js';
import { tenantLock, type Database } from './db/index.js';
import { gates } from './db/schema.js';
import { MockCalendar } from './adapters/calendar/mock.js';
import { MockSms } from './adapters/sms/mock.js';
import type { CalendarAdapter, SmsAdapter } from './adapters/types.js';
import { requireSecret, LocalProviderAuth } from './http/middleware/security.js';
import { TenantService } from './modules/tenants/service.js';
import { CallService, TestCallContextResolver, type CallContextResolver, type ProviderAuthAdapter } from './modules/calls/service.js';
import { AuditService } from './modules/audit/service.js';
import { SchedulingService } from './modules/scheduling/service.js';
import { NotificationService } from './modules/relay/notifications.js';
import { BookingService } from './modules/bookings/service.js';
import { Maintenance } from './workers/maintenance.js';
import { AppError, logger, systemClock, type Clock, type Logger } from './shared/core.js';
import { availabilitySchema, bookingSchema, callAdmissionSchema, callEndedSchema, createTenantSchema, patchTenantSchema, relaySchema, servicesSchema } from './shared/contracts.js';

export interface Dependencies {
  db: Database; config: Config; clock?: Clock; calendar?: CalendarAdapter; sms?: SmsAdapter;
  contextResolver?: CallContextResolver; providerAuth?: ProviderAuthAdapter; log?: Logger;
}
function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return databaseErrorCode(error.cause);
}
export function createApp(deps: Dependencies) {
  const { db, config } = deps;
  if (config.NODE_ENV === 'production') throw new Error('Production adapters are not implemented');
  const clock = deps.clock ?? systemClock; const log = deps.log ?? logger;
  const calendar = deps.calendar ?? new MockCalendar(); const sms = deps.sms ?? new MockSms();
  const audit = new AuditService(db, config, clock);
  const tenants = new TenantService(db, clock);
  const calls = new CallService(db, config, clock, audit);
  const context = deps.contextResolver ?? new TestCallContextResolver(db, config, clock);
  const providerAuth = deps.providerAuth ?? new LocalProviderAuth(config.WEBHOOK_SECRET);
  const notifications = new NotificationService(db, sms, config, clock, audit);
  const scheduling = new SchedulingService(db, calendar, config, clock, audit);
  const bookings = new BookingService(db, calendar, config, clock, audit, notifications);
  const maintenance = new Maintenance(db, bookings, clock, log);
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((_req, res, next) => { res.set('X-Gloso-Mode', 'local-mock'); res.set('Cache-Control', 'no-store'); next(); });
  // Authenticate before parsing request bodies, including malformed bodies.
  app.use('/admin', requireSecret('x-admin-secret', config.ADMIN_SECRET));
  app.use('/tools', requireSecret('x-tool-secret', config.TOOL_SECRET));
  app.use('/webhooks', (req, _res, next) => { providerAuth.verify(req); next(); });
  app.use((req, _res, next) => {
    if (['POST', 'PATCH'].includes(req.method) && !req.is('application/json')) throw new AppError(415, 'JSON_REQUIRED');
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  app.get('/health', async (_req, res) => {
    try { await db.execute(sql`SELECT 1`); res.json({ status: 'ok', mode: 'local-mock' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.post('/admin/tenants', async (req, res) => { res.status(201).json(await tenants.create(createTenantSchema.parse(req.body))); });
  app.patch('/admin/tenants/:id', async (req, res) => { res.json(await tenants.patch(z.string().uuid().parse(req.params.id), patchTenantSchema.parse(req.body))); });
  app.post('/admin/tenants/:id/services', async (req, res) => { res.json(await tenants.upsertServices(z.string().uuid().parse(req.params.id), servicesSchema.parse(req.body))); });
  app.get('/admin/tenants/:id/status', async (req, res) => { res.json(await tenants.status(z.string().uuid().parse(req.params.id))); });
  // Deliberately narrow manual release: no API can casually unlock an unknown in-flight write.
  app.post('/admin/tenants/:id/recovery-release', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    z.object({ writers_stopped: z.literal(true), external_calendar_verified: z.literal(true) }).strict().parse(req.body);
    await db.transaction(async (tx) => {
      await tenantLock(tx, id);
      const [gate] = await tx.select().from(gates).where(eq(gates.tenantId, id));
      if (!gate) throw new AppError(404, 'TENANT_NOT_FOUND');
      if (gate.state !== 'RECOVERY_REQUIRED') throw new AppError(409, 'MANUAL_RELEASE_NOT_ALLOWED');
      await tx.update(gates).set({ state: 'IDLE', operationKey: null, ownerToken: null, ownerVersion: gate.ownerVersion + 1, leaseExpiresAt: null, updatedAt: clock.now() }).where(and(eq(gates.tenantId, id), eq(gates.state, 'RECOVERY_REQUIRED')));
    });
    log.event('MANUAL_RECOVERY_RELEASED');
    res.json({ status: 'RELEASED' });
  });
  app.post('/webhooks/call-admission', async (req, res) => { res.json(await calls.admit(callAdmissionSchema.parse(req.body), providerAuth.provider)); });
  app.post('/webhooks/call-ended', async (req, res) => { res.json(await calls.end(callEndedSchema.parse(req.body), providerAuth.provider)); });
  app.post('/tools/check-availability', async (req, res) => { const ctx = await context.resolve(req); res.json(await scheduling.availability(ctx, availabilitySchema.parse(req.body))); });
  app.post('/tools/book-slot', async (req, res) => { const ctx = await context.resolve(req); res.json(await bookings.book(ctx, bookingSchema.parse(req.body))); });
  app.post('/tools/create-relay', async (req, res) => { const ctx = await context.resolve(req); res.json(await notifications.relay(ctx, relaySchema.parse(req.body))); });
  app.use((_req, _res) => { throw new AppError(404, 'NOT_FOUND'); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', fields: [...new Set(error.issues.map((i) => i.path.join('.')))] } }); return; }
    if (error instanceof AppError) { res.status(error.status).json({ error: { code: error.code } }); return; }
    const code = databaseErrorCode(error);
    if (code === '23505' || code === '23514') { res.status(409).json({ error: { code: 'CONFIGURATION_CONFLICT' } }); return; }
    if (error && typeof error === 'object' && 'type' in error && (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'INVALID_JSON' } }); return;
    }
    log.event('REQUEST_FAILED');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  };
  app.use(errors);
  return { app, tenants, calls, scheduling, bookings, notifications, audit, maintenance, calendar, sms };
}
