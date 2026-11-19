import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import { tenantLock, type Database } from '../../db/index.js';
import { auditLogs, calls, pilotUsage, tenants, type Call, type Tenant } from '../../db/schema.js';
import { phone, type AdmissionInput, type EndedInput } from '../../shared/contracts.js';
import { after, AppError, DAY_MS, OPERATION_TTL_MS, type Clock } from '../../shared/core.js';
import { AuditService } from '../audit/service.js';

export interface CallContext { tenant: Tenant; call: Call; callerId?: string }
export interface CallContextResolver { resolve(request: Request): Promise<CallContext> }
export interface ProviderAuthAdapter { readonly provider: string; verify(request: Request): void }

export class CallService {
  constructor(private db: Database, private config: Config, private clock: Clock, private audit: AuditService) {}
  private async resolveTenant(input: AdmissionInput) {
    const [tenant] = await this.db.select().from(tenants).where(and(eq(tenants.zadarmaNumber, input.called_number), eq(tenants.agentId, input.agent_id)));
    return tenant;
  }
  private checkAge(start: Date) {
    const now = this.clock.now();
    if (start > now) throw new AppError(400, 'INVALID_EVENT_TIME');
    if (now.getTime() - start.getTime() >= OPERATION_TTL_MS) return false;
    return true;
  }
  async admit(input: AdmissionInput, provider: string) {
    const started = new Date(input.call_started_at);
    if (!this.checkAge(started)) return { allowed: false, reason: 'EVENT_TOO_OLD' };
    // Local simulation of the earliest permissible AI start; actual routing remains provider work.
    if (this.clock.now().getTime() - started.getTime() < 10000) return { allowed: false, reason: 'TOO_EARLY', retry_after_seconds: Math.ceil((10000 - (this.clock.now().getTime() - started.getTime())) / 1000) };
    const tenant = await this.resolveTenant(input);
    if (!tenant) return { allowed: false, reason: 'TENANT_NOT_FOUND' };
    return this.db.transaction(async (tx) => {
      await tenantLock(tx, tenant.id);
      const [current] = await tx.select().from(tenants).where(eq(tenants.id, tenant.id));
      const [pilot] = await tx.select().from(pilotUsage).where(eq(pilotUsage.tenantId, tenant.id)).for('update');
      if (!current || current.zadarmaNumber !== input.called_number || current.agentId !== input.agent_id) return { allowed: false, reason: 'TENANT_NOT_FOUND' };
      if (!this.checkAge(started)) return { allowed: false, reason: 'EVENT_TOO_OLD' };
      const now = this.clock.now();
      const [old] = await tx.select().from(calls).where(and(eq(calls.tenantId, tenant.id), eq(calls.provider, provider), eq(calls.externalCallId, input.external_call_id)));
      if (old) {
        if (old.callStartedAt.getTime() !== started.getTime()) throw new AppError(409, 'CALL_CONTEXT_MISMATCH');
        if (old.status === 'CLOSED') return { allowed: false, reason: 'CALL_CLOSED' };
        if (old.status === 'REJECTED') return { allowed: false, reason: old.admissionReason };
        if (old.expiresAt <= now || !old.reservationExpiresAt || old.reservationExpiresAt <= now) return { allowed: false, reason: 'ADMISSION_EXPIRED' };
        return { allowed: true, tenant_id: tenant.id, mode: current!.mode, call_id: old.callId };
      }
      const [sum] = await tx.select({ value: sql<number>`coalesce(sum(${calls.reservedMinutes}), 0)::int` }).from(calls).where(and(eq(calls.tenantId, tenant.id), eq(calls.status, 'ACTIVE'), gt(calls.reservationExpiresAt, now), gt(calls.expiresAt, now)));
      const reason = !current!.isActive ? 'TENANT_INACTIVE' : pilot!.expiresAt <= now ? 'PILOT_EXPIRED'
        : pilot!.isBlocked ? 'TENANT_BLOCKED' : pilot!.minutesUsed + sum!.value + this.config.TEST_RESERVE_MINUTES > pilot!.minutesLimit ? 'LIMIT_EXCEEDED' : null;
      const [call] = await tx.insert(calls).values({ tenantId: tenant.id, provider, externalCallId: input.external_call_id,
        callId: randomUUID(), auditSessionId: randomUUID(), status: reason ? 'REJECTED' : 'ACTIVE', admissionReason: reason,
        reservedMinutes: reason ? 0 : this.config.TEST_RESERVE_MINUTES, reservationExpiresAt: reason ? null : after(now, this.config.TEST_CALL_RESERVATION_TTL_SECONDS * 1000),
        callStartedAt: started, createdAt: now, expiresAt: after(now, OPERATION_TTL_MS) }).returning();
      await this.audit.inTransaction(tx, call!.callId, reason ? 'CALL_REJECTED_LIMIT' : 'CALL_ADMITTED', { mode: current!.mode });
      return reason ? { allowed: false, reason } : { allowed: true, tenant_id: tenant.id, mode: current!.mode, call_id: call!.callId };
    });
  }
  async end(input: EndedInput, provider: string) {
    const started = new Date(input.call_started_at); const ended = new Date(input.call_ended_at);
    if (!this.checkAge(started)) return { status: 'EVENT_TOO_OLD' };
    if (ended < started || ended > this.clock.now() || input.ai_seconds * 1000 > ended.getTime() - started.getTime()) throw new AppError(400, 'INVALID_EVENT_TIME');
    const tenant = await this.resolveTenant(input);
    if (!tenant) return { status: 'TENANT_NOT_FOUND' };
    return this.db.transaction(async (tx) => {
      await tenantLock(tx, tenant.id);
      const [pilot] = await tx.select().from(pilotUsage).where(eq(pilotUsage.tenantId, tenant.id)).for('update');
      const [current] = await tx.select().from(tenants).where(eq(tenants.id, tenant.id));
      if (!current || current.zadarmaNumber !== input.called_number || current.agentId !== input.agent_id) return { status: 'TENANT_NOT_FOUND' };
      if (!this.checkAge(started)) return { status: 'EVENT_TOO_OLD' };
      const now = this.clock.now();
      let [call] = await tx.select().from(calls).where(and(eq(calls.tenantId, tenant.id), eq(calls.provider, provider), eq(calls.externalCallId, input.external_call_id))).for('update');
      if (call && call.callStartedAt.getTime() !== started.getTime()) throw new AppError(409, 'CALL_CONTEXT_MISMATCH');
      if (call?.usageAccounted) return { status: 'ALREADY_PROCESSED' };
      if (!call) {
        [call] = await tx.insert(calls).values({ tenantId: tenant.id, provider, externalCallId: input.external_call_id, callId: randomUUID(), auditSessionId: randomUUID(),
          status: 'CLOSED', reservedMinutes: 0, callStartedAt: started, createdAt: now, expiresAt: after(now, OPERATION_TTL_MS) }).returning();
        await this.audit.inTransaction(tx, call!.callId, 'PROVIDER_ERROR', { provider_status: 'ANOMALY' });
      }
      const minutes = Math.ceil(input.ai_seconds / 60);
      const total = pilot!.minutesUsed + minutes;
      await tx.update(pilotUsage).set({ minutesUsed: total, isBlocked: pilot!.isBlocked || total >= pilot!.minutesLimit }).where(eq(pilotUsage.tenantId, tenant.id));
      await tx.update(calls).set({ status: 'CLOSED', usageAccounted: true, callEndedAt: ended }).where(eq(calls.callId, call!.callId));
      if (call!.expiresAt > now) await tx.update(auditLogs).set({ expiresAt: after(ended, 30 * DAY_MS) }).where(and(eq(auditLogs.auditSessionId, call!.auditSessionId), gt(auditLogs.expiresAt, now)));
      return { status: 'ACCOUNTED', minutes_charged: minutes };
    });
  }
}

export class TestCallContextResolver implements CallContextResolver {
  constructor(private db: Database, private config: Config, private clock: Clock) {}
  async resolve(request: Request): Promise<CallContext> {
    if (this.config.NODE_ENV === 'production') throw new AppError(503, 'PROVIDER_CONTEXT_UNAVAILABLE');
    const headers = z.object({ number: phone, agent: z.string().min(1).max(200), call: z.string().uuid(), caller: phone.optional() }).safeParse({
      number: request.get('x-test-called-number'), agent: request.get('x-test-agent-id'), call: request.get('x-test-call-id'), caller: request.get('x-test-caller-id'),
    });
    if (!headers.success) throw new AppError(401, 'INVALID_CALL_CONTEXT');
    const now = this.clock.now();
    const [row] = await this.db.select({ tenant: tenants, call: calls }).from(calls).innerJoin(tenants, eq(calls.tenantId, tenants.id)).where(and(
      eq(calls.callId, headers.data.call), eq(calls.provider, 'local'), eq(tenants.zadarmaNumber, headers.data.number), eq(tenants.agentId, headers.data.agent),
      eq(calls.status, 'ACTIVE'), gt(calls.expiresAt, now)));
    if (!row || !row.tenant.isActive || now.getTime() - row.call.callStartedAt.getTime() >= OPERATION_TTL_MS) throw new AppError(401, 'INVALID_CALL_CONTEXT');
    // Reserve expiry and pilot exhaustion must NOT interrupt an already admitted call.
    return { ...row, callerId: headers.data.caller };
  }
}
