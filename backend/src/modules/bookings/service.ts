import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import { tenantLock, type Database } from '../../db/index.js';
import { calls, gates, processedEvents, services, tenants, type Operation } from '../../db/schema.js';
import type { CalendarAdapter, CalendarEvent } from '../../adapters/types.js';
import { bookingSchema, resultSchema, type TechnicalResult } from '../../shared/contracts.js';
import { after, AppError, bounded, OPERATION_TTL_MS, ProviderError, ZONE, type Clock } from '../../shared/core.js';
import { opaqueKey, readSlot, type Slot } from '../../shared/crypto.js';
import type { CallContext } from '../calls/service.js';
import { AuditService } from '../audit/service.js';
import { calculateSlots, normalizeDate } from '../scheduling/engine.js';
import { clientDetails, NotificationService } from '../relay/notifications.js';

type Owner = { token: string; version: number };
type Claim = { kind: 'CACHED'; operation: Operation } | { kind: 'WAIT' } | { kind: 'NEW' | 'RECOVER'; operation: Operation; owner: Owner };
export class BookingService {
  constructor(private db: Database, private calendar: CalendarAdapter, private config: Config, private clock: Clock,
    private audit: AuditService, private notifications: NotificationService) {}

  private key(context: CallContext, slot: Slot) {
    return opaqueKey(this.config.IDEMPOTENCY_SECRET, [context.tenant.id, context.call.callId, 'BOOK', slot.service_id, new Date(slot.start_at).toISOString(), new Date(slot.end_at).toISOString()]);
  }
  private async claim(context: CallContext, slot: Slot, key: string): Promise<Claim> {
    return this.db.transaction(async (tx) => {
      await tenantLock(tx, context.tenant.id);
      const now = this.clock.now();
      const [operation] = await tx.select().from(processedEvents).where(eq(processedEvents.key, key));
      if (operation) {
        if (operation.expiresAt <= now) throw new AppError(409, 'OPERATION_EXPIRED');
        if (operation.status === 'COMPLETED' || operation.status === 'FAILED') return { kind: 'CACHED', operation };
      }
      if (!operation && slot.exp * 1000 <= now.getTime()) throw new AppError(400, 'SLOT_EXPIRED');
      const [gate] = await tx.select().from(gates).where(eq(gates.tenantId, context.tenant.id)).for('update');
      if (!gate || gate.state === 'RECOVERY_REQUIRED') return { kind: 'WAIT' };
      if (gate.state === 'BUSY' && (gate.operationKey !== key || (gate.leaseExpiresAt && gate.leaseExpiresAt > now))) return { kind: 'WAIT' };
      const [call] = await tx.select().from(calls).where(and(eq(calls.callId, context.call.callId), eq(calls.status, 'ACTIVE'), gt(calls.expiresAt, now)));
      if (!call) throw new AppError(401, 'INVALID_CALL_CONTEXT');
      if (call.bookingKey && call.bookingKey !== key) {
        const [previous] = await tx.select().from(processedEvents).where(eq(processedEvents.key, call.bookingKey));
        if (!previous || previous.status !== 'FAILED') throw new AppError(409, 'BOOKING_ALREADY_STARTED');
      }
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, context.tenant.id));
      if (!tenant?.isActive || tenant.mode !== 'CALENDAR' || !tenant.calendarId) throw new AppError(409, 'CALENDAR_MODE_REQUIRED');
      const owner = { token: randomUUID(), version: gate.ownerVersion + 1 };
      const [created] = operation ? [operation] : await tx.insert(processedEvents).values({ key, tenantId: tenant.id, eventType: 'BOOKING', status: 'PENDING',
        externalRef: `g${key}`, calendarRef: tenant.calendarId, createdAt: now, updatedAt: now, expiresAt: after(now, OPERATION_TTL_MS) }).returning();
      await tx.update(gates).set({ state: 'BUSY', operationKey: key, ownerToken: owner.token, ownerVersion: owner.version,
        leaseExpiresAt: after(now, this.config.BOOKING_LEASE_SECONDS * 1000), updatedAt: now }).where(eq(gates.tenantId, tenant.id));
      await tx.update(calls).set({ bookingKey: key }).where(eq(calls.callId, call.callId));
      return { kind: operation ? 'RECOVER' : 'NEW', operation: created!, owner };
    });
  }
  private async finish(tenantId: string, operation: Operation, owner: Owner, status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN', result: TechnicalResult, callId?: string) {
    return this.db.transaction(async (tx) => {
      await tenantLock(tx, tenantId);
      const [gate] = await tx.select().from(gates).where(eq(gates.tenantId, tenantId));
      if (!gate || gate.operationKey !== operation.key || gate.ownerToken !== owner.token || gate.ownerVersion !== owner.version) return false;
      const [current] = await tx.select().from(processedEvents).where(eq(processedEvents.key, operation.key));
      if (!current || current.expiresAt <= this.clock.now()) return false;
      await tx.update(processedEvents).set({ status, result: resultSchema.parse(result), updatedAt: this.clock.now() }).where(eq(processedEvents.key, operation.key));
      if (status !== 'UNCERTAIN') await tx.update(gates).set({ state: 'IDLE', operationKey: null, ownerToken: null, leaseExpiresAt: null, updatedAt: this.clock.now() }).where(eq(gates.tenantId, tenantId));
      else await tx.update(gates).set({ leaseExpiresAt: this.clock.now(), updatedAt: this.clock.now() }).where(eq(gates.tenantId, tenantId));
      if (callId) await this.audit.inTransaction(tx, callId, status === 'COMPLETED' ? 'BOOKING_CREATED' : result.status === 'SLOT_CONFLICT' ? 'BOOKING_CONFLICT' : 'PROVIDER_ERROR', { provider_status: status === 'COMPLETED' ? 'ACCEPTED' : status === 'FAILED' ? 'REJECTED' : 'UNKNOWN' });
      return true;
    });
  }
  private async stillOwned(tenantId: string, operation: Operation, owner: Owner): Promise<boolean> {
    const [gate] = await this.db.select().from(gates).where(and(eq(gates.tenantId, tenantId), eq(gates.operationKey, operation.key), eq(gates.ownerToken, owner.token), eq(gates.ownerVersion, owner.version), eq(gates.state, 'BUSY'), gt(gates.leaseExpiresAt, this.clock.now())));
    return !!gate;
  }
  async book(context: CallContext, input: z.infer<typeof bookingSchema>) {
    const client = clientDetails(context, input);
    const slot = readSlot(this.config.SLOT_SECRET, input.slot_id);
    if (slot.tenant_id !== context.tenant.id) throw new AppError(403, 'SLOT_TENANT_MISMATCH');
    const key = this.key(context, slot);
    const claim = await this.claim(context, slot, key);
    if (claim.kind === 'WAIT') return { status: 'PENDING_VERIFICATION' };
    if (claim.kind === 'CACHED') {
      if (claim.operation.status === 'FAILED') return claim.operation.result!;
      return this.confirm(context, slot, claim.operation);
    }
    const { operation, owner } = claim;
    if (claim.kind === 'RECOVER') {
      const recovered = await this.reconcile(operation, owner, context.call.callId);
      if (!recovered) return { status: 'PENDING_VERIFICATION' };
      return this.confirm(context, slot, operation);
    }
    try {
      const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, context.tenant.id));
      const [service] = await this.db.select().from(services).where(and(eq(services.id, slot.service_id), eq(services.tenantId, context.tenant.id)));
      if (!tenant || !service || !tenant.isActive || tenant.mode !== 'CALENDAR' || tenant.calendarId !== operation.calendarRef) {
        await this.finish(context.tenant.id, operation, owner, 'FAILED', { status: 'CALENDAR_ERROR_USE_RELAY' }, context.call.callId);
        return { status: 'CALENDAR_ERROR_USE_RELAY' };
      }
      let busy;
      try { busy = await bounded(() => this.calendar.busy(operation.calendarRef!, slot.start_at, slot.end_at), this.config.PROVIDER_TIMEOUT_MS); }
      catch {
        // This owner has not sent insert. A failed read is a definite pre-write failure.
        if (!await this.finish(context.tenant.id, operation, owner, 'FAILED', { status: 'CALENDAR_ERROR_USE_RELAY' }, context.call.callId)) return { status: 'PENDING_VERIFICATION' };
        return { status: 'CALENDAR_ERROR_USE_RELAY' };
      }
      const query = DateTime.fromISO(slot.start_at, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm');
      const range = normalizeDate(query, this.clock.now());
      const available = range && calculateSlots(tenant, service, range, busy, this.clock.now()).some((s) => Date.parse(s.start_at) === Date.parse(slot.start_at) && Date.parse(s.end_at) === Date.parse(slot.end_at));
      if (!available || slot.exp * 1000 <= this.clock.now().getTime()) {
        if (!await this.finish(context.tenant.id, operation, owner, 'FAILED', { status: 'SLOT_CONFLICT' }, context.call.callId)) return { status: 'PENDING_VERIFICATION' };
        return { status: 'SLOT_CONFLICT' };
      }
      if (!await this.stillOwned(context.tenant.id, operation, owner)) return { status: 'PENDING_VERIFICATION' };
      const event: CalendarEvent = { id: operation.externalRef!, operation_key: key, tenant_id: tenant.id, service_id: service.id,
        start_at: slot.start_at, end_at: slot.end_at, client, origin: 'GLOSO' };
      try { await bounded(() => this.calendar.insert(operation.calendarRef!, event), this.config.PROVIDER_TIMEOUT_MS); }
      catch (error) {
        if (error instanceof ProviderError && error.outcome === 'REJECTED') {
          if (!await this.finish(tenant.id, operation, owner, 'FAILED', { status: 'CALENDAR_ERROR_USE_RELAY' }, context.call.callId)) return { status: 'PENDING_VERIFICATION' };
          return { status: 'CALENDAR_ERROR_USE_RELAY' };
        }
        await this.finish(tenant.id, operation, owner, 'UNCERTAIN', { status: 'PENDING_VERIFICATION' }, context.call.callId);
        return { status: 'PENDING_VERIFICATION' };
      }
      if (!await this.finish(tenant.id, operation, owner, 'COMPLETED', { status: 'BOOKED' }, context.call.callId)) return { status: 'PENDING_VERIFICATION' };
    } catch {
      // No insert may have occurred, but an unexpected failure must not erase its durable intent.
      // A failed DB commit leaves PENDING and is recovered using the same external ID.
      return { status: 'PENDING_VERIFICATION' };
    }
    return this.confirm(context, slot, operation);
  }
  private async confirm(context: CallContext, slot: Slot, operation: Operation) {
    // Read original confirmed data; a retry cannot silently change the client or notification.
    let event: CalendarEvent | null;
    try { event = await bounded(() => this.calendar.get(operation.calendarRef!, operation.externalRef!), this.config.PROVIDER_TIMEOUT_MS); }
    catch { return { status: 'BOOKED', start_at: slot.start_at, end_at: slot.end_at, sms_sent: false, sms_status: 'PENDING_VERIFICATION' }; }
    if (!event || !this.matches(operation, event)) return { status: 'PENDING_VERIFICATION' };
    let smsStatus: 'ACCEPTED' | 'FAILED' | 'PENDING_VERIFICATION';
    try { smsStatus = await this.notifications.send(context, operation.key,
      `Gloso — POTWIERDZONA REZERWACJA: ${event.start_at}–${event.end_at}; ${event.client.name}; tel. ${event.client.phone} (${event.client.phone_source === 'CALLER_ID' ? 'Caller ID, własność niezweryfikowana' : 'numer niezweryfikowany'}); ${event.client.car}; ${event.client.problem}`, false); }
    catch { smsStatus = 'PENDING_VERIFICATION'; }
    return { status: 'BOOKED', start_at: event.start_at, end_at: event.end_at, sms_sent: smsStatus === 'ACCEPTED', sms_status: smsStatus };
  }
  private matches(operation: Operation, event: CalendarEvent) {
    return event.id === operation.externalRef && event.operation_key === operation.key && event.tenant_id === operation.tenantId && event.origin === 'GLOSO';
  }
  private async reconcile(operation: Operation, owner: Owner, callId?: string): Promise<boolean> {
    try {
      const event = await bounded(() => this.calendar.get(operation.calendarRef!, operation.externalRef!), this.config.PROVIDER_TIMEOUT_MS);
      if (event && this.matches(operation, event)) return this.finish(operation.tenantId, operation, owner, 'COMPLETED', { status: 'BOOKED' }, callId);
      // Neither a 404 nor an expired lease proves an old writer can no longer send an insert.
      await this.finish(operation.tenantId, operation, owner, 'UNCERTAIN', { status: 'PENDING_VERIFICATION' }, callId);
    } catch { /* Keep the gate occupied; never infer absence from a failed lookup. */ }
    return false;
  }
  async recover(tenantId: string) {
    const claim = await this.db.transaction(async (tx) => {
      await tenantLock(tx, tenantId);
      const now = this.clock.now();
      const [gate] = await tx.select().from(gates).where(eq(gates.tenantId, tenantId));
      if (!gate?.operationKey || gate.state !== 'BUSY' || (gate.leaseExpiresAt && gate.leaseExpiresAt > now)) return null;
      const [operation] = await tx.select().from(processedEvents).where(eq(processedEvents.key, gate.operationKey));
      if (!operation || operation.expiresAt <= now) return null;
      const owner = { token: randomUUID(), version: gate.ownerVersion + 1 };
      await tx.update(gates).set({ ownerToken: owner.token, ownerVersion: owner.version, leaseExpiresAt: after(now, this.config.BOOKING_LEASE_SECONDS * 1000), updatedAt: now }).where(eq(gates.tenantId, tenantId));
      return { operation, owner };
    });
    if (claim) {
      const [call] = await this.db.select({ id: calls.callId }).from(calls).where(and(eq(calls.bookingKey, claim.operation.key), gt(calls.expiresAt, this.clock.now())));
      return this.reconcile(claim.operation, claim.owner, call?.id);
    }
    return false;
  }
}
