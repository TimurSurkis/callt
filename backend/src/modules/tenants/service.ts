import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { tenantLock, type Database } from '../../db/index.js';
import { calls, gates, pilotUsage, services, tenants } from '../../db/schema.js';
import { createTenantSchema, patchTenantSchema, servicesSchema } from '../../shared/contracts.js';
import { AppError, calendarDays, type Clock } from '../../shared/core.js';

export class TenantService {
  constructor(private db: Database, private clock: Clock) {}
  async create(input: z.infer<typeof createTenantSchema>) {
    if (input.mode === 'CALENDAR' && !input.google_calendar_id) throw new AppError(400, 'CALENDAR_REQUIRED');
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [tenant] = await tx.insert(tenants).values({ name: input.name, mode: input.mode, isActive: input.is_active,
        zadarmaNumber: input.zadarma_number, agentId: input.elevenlabs_agent_id, calendarId: input.google_calendar_id,
        smsPhone: input.sms_recipient_phone, workHours: input.work_hours, scheduling: input.scheduling_config, createdAt: now, updatedAt: now }).returning();
      if (!tenant) throw new Error('Insert failed');
      await tx.insert(pilotUsage).values({ tenantId: tenant.id, activatedAt: now, expiresAt: calendarDays(now, 14) });
      await tx.insert(gates).values({ tenantId: tenant.id, updatedAt: now });
      return this.publicTenant(tenant);
    });
  }
  private publicTenant(tenant: typeof tenants.$inferSelect) {
    return { id: tenant.id, name: tenant.name, mode: tenant.mode, is_active: tenant.isActive,
      zadarma_number: tenant.zadarmaNumber, elevenlabs_agent_id: tenant.agentId, google_calendar_id: tenant.calendarId,
      sms_recipient_phone: tenant.smsPhone, work_hours: tenant.workHours, scheduling_config: tenant.scheduling,
      created_at: tenant.createdAt, updated_at: tenant.updatedAt };
  }
  async patch(id: string, input: z.infer<typeof patchTenantSchema>) {
    return this.db.transaction(async (tx) => {
      await tenantLock(tx, id);
      const [old] = await tx.select().from(tenants).where(eq(tenants.id, id));
      if (!old) throw new AppError(404, 'TENANT_NOT_FOUND');
      const calendarId = input.google_calendar_id === undefined ? old.calendarId : input.google_calendar_id;
      if ((input.mode ?? old.mode) === 'CALENDAR' && !calendarId) throw new AppError(400, 'CALENDAR_REQUIRED');
      const [gate] = await tx.select().from(gates).where(eq(gates.tenantId, id));
      if (gate?.state !== 'IDLE' && (input.google_calendar_id !== undefined || input.mode !== undefined)) throw new AppError(409, 'BOOKING_RECOVERY_REQUIRED');
      const [updated] = await tx.update(tenants).set({ name: input.name, mode: input.mode, isActive: input.is_active,
        zadarmaNumber: input.zadarma_number, agentId: input.elevenlabs_agent_id, calendarId,
        smsPhone: input.sms_recipient_phone, workHours: input.work_hours, scheduling: input.scheduling_config, updatedAt: this.clock.now() }).where(eq(tenants.id, id)).returning();
      return this.publicTenant(updated!);
    });
  }
  async upsertServices(id: string, input: z.infer<typeof servicesSchema>) {
    return this.db.transaction(async (tx) => {
      await tenantLock(tx, id);
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, id));
      if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND');
      const ids = input.services.flatMap((s) => s.id ? [s.id] : []);
      if (new Set(ids).size !== ids.length) throw new AppError(400, 'DUPLICATE_SERVICE');
      // Temporarily clear diagnostic flags only for updated entries, preserving omitted services.
      for (const item of input.services) {
        if (item.id) {
          const [existing] = await tx.select().from(services).where(and(eq(services.id, item.id), eq(services.tenantId, id)));
          if (!existing) throw new AppError(404, 'SERVICE_NOT_FOUND');
          await tx.update(services).set({ isDiagnostic: false }).where(eq(services.id, item.id));
        }
      }
      const result = [];
      for (const item of input.services) {
        const values = { tenantId: id, name: item.name, durationMinutes: item.duration_minutes, isDiagnostic: item.is_diagnostic };
        const rows = item.id ? await tx.update(services).set(values).where(and(eq(services.id, item.id), eq(services.tenantId, id))).returning()
          : await tx.insert(services).values(values).returning();
        result.push(...rows);
      }
      return { services: result.map((s) => ({ id: s.id, name: s.name, duration_minutes: s.durationMinutes, is_diagnostic: s.isDiagnostic })) };
    });
  }
  async status(id: string) {
    return this.db.transaction(async (tx) => {
      await tenantLock(tx, id);
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, id));
      if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND');
      const [pilot] = await tx.select().from(pilotUsage).where(eq(pilotUsage.tenantId, id));
      const [gate] = await tx.select().from(gates).where(eq(gates.tenantId, id));
      const now = this.clock.now();
      const [sum] = await tx.select({ value: sql<number>`coalesce(sum(${calls.reservedMinutes}), 0)::int` }).from(calls).where(and(eq(calls.tenantId, id), eq(calls.status, 'ACTIVE'), gt(calls.reservationExpiresAt, now), gt(calls.expiresAt, now)));
      const items = await tx.select().from(services).where(eq(services.tenantId, id));
      return { ...this.publicTenant(tenant), pilot: { activated_at: pilot!.activatedAt, expires_at: pilot!.expiresAt,
        minutes_limit: pilot!.minutesLimit, minutes_used: pilot!.minutesUsed, minutes_reserved: sum!.value,
        minutes_available: Math.max(0, pilot!.minutesLimit - pilot!.minutesUsed - sum!.value), is_blocked: pilot!.isBlocked,
        days_remaining: Math.max(0, Math.ceil((pilot!.expiresAt.getTime() - now.getTime()) / 86400000)) },
      booking_gate: gate!.state, services: items.map((s) => ({ id: s.id, name: s.name, duration_minutes: s.durationMinutes, is_diagnostic: s.isDiagnostic })) };
    });
  }
}
