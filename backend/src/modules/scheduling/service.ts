import { and, eq } from 'drizzle-orm';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { services, type Service } from '../../db/schema.js';
import type { CalendarAdapter } from '../../adapters/types.js';
import { after, AppError, bounded, type Clock } from '../../shared/core.js';
import { signSlot } from '../../shared/crypto.js';
import type { CallContext } from '../calls/service.js';
import { AuditService } from '../audit/service.js';
import { calculateSlots, normalizeDate } from './engine.js';

export class SchedulingService {
  constructor(private db: Database, private calendar: CalendarAdapter, private config: Config, private clock: Clock, private audit: AuditService) {}
  async resolveService(tenantId: string, serviceId?: string | null): Promise<Service | undefined> {
    const [service] = await this.db.select().from(services).where(and(eq(services.tenantId, tenantId), serviceId ? eq(services.id, serviceId) : eq(services.isDiagnostic, true)));
    if (serviceId && !service) throw new AppError(404, 'SERVICE_NOT_FOUND');
    return service;
  }
  async availability(context: CallContext, input: { service_id?: string | null; date_query: string }) {
    const tenant = context.tenant;
    if (tenant.mode === 'RELAY') return { status: 'FALLBACK_RELAY', reason: 'RELAY_MODE' };
    const service = await this.resolveService(tenant.id, input.service_id);
    if (!service) return { status: 'SERVICE_CLARIFICATION_REQUIRED' };
    const now = this.clock.now(); const range = normalizeDate(input.date_query, now);
    if (!range) return { status: 'DATE_CLARIFICATION_REQUIRED' };
    let busy;
    try { busy = await bounded(() => this.calendar.busy(tenant.calendarId!, range.from.toUTC().toISO()!, range.to.plus({ days: 1 }).toUTC().toISO()!), this.config.PROVIDER_TIMEOUT_MS); }
    catch {
      await this.audit.write(tenant.id, context.call.callId, 'PROVIDER_ERROR', { provider_status: 'UNKNOWN' });
      return { status: 'FALLBACK_RELAY', reason: 'CALENDAR_UNAVAILABLE' };
    }
    const slots = calculateSlots(tenant, service, range, busy, now).slice(0, 5).map((slot) => ({ ...slot,
      slot_id: signSlot(this.config.SLOT_SECRET, { tenant_id: tenant.id, service_id: service.id, ...slot, exp: Math.floor(after(now, 15 * 60000).getTime() / 1000) }) }));
    await this.audit.write(tenant.id, context.call.callId, 'SLOTS_CHECKED', { service_id: service.id, mode: tenant.mode });
    return { status: slots.length ? 'SLOTS_AVAILABLE' : 'NO_SLOTS', service_id: service.id, slots };
  }
}
