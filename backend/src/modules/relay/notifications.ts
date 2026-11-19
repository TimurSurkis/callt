import { and, eq, gt } from 'drizzle-orm';
import type { Config } from '../../config/index.js';
import { tenantLock, type Database } from '../../db/index.js';
import { calls, processedEvents } from '../../db/schema.js';
import type { ClientDetails, SmsAdapter } from '../../adapters/types.js';
import { after, AppError, bounded, OPERATION_TTL_MS, ProviderError, type Clock } from '../../shared/core.js';
import { opaqueKey } from '../../shared/crypto.js';
import { resultSchema, type ClientInput } from '../../shared/contracts.js';
import type { CallContext } from '../calls/service.js';
import { AuditService } from '../audit/service.js';

export function clientDetails(context: CallContext, input: ClientInput): ClientDetails {
  const phone = context.callerId ?? input.client_phone;
  if (!phone) throw new AppError(400, 'CALLBACK_PHONE_REQUIRED');
  return { name: input.client_name, phone, phone_source: context.callerId ? 'CALLER_ID' : 'DICTATED_UNVERIFIED', car: input.car_model, problem: input.problem_description };
}
export class NotificationService {
  constructor(private db: Database, private sms: SmsAdapter, private config: Config, private clock: Clock, private audit: AuditService) {}
  async send(context: CallContext, parentKey: string, text: string, relay: boolean): Promise<'ACCEPTED' | 'FAILED' | 'PENDING_VERIFICATION'> {
    const key = opaqueKey(this.config.IDEMPOTENCY_SECRET, [context.tenant.id, parentKey, 'SMS']);
    const claim = await this.db.transaction(async (tx) => {
      await tenantLock(tx, context.tenant.id);
      const now = this.clock.now();
      // Relay must not disguise an unresolved Calendar write as a new independent request.
      const [call] = await tx.select().from(calls).where(and(eq(calls.callId, context.call.callId), gt(calls.expiresAt, now)));
      if (!call) throw new AppError(401, 'INVALID_CALL_CONTEXT');
      if (relay && call.bookingKey) {
        const [booking] = await tx.select().from(processedEvents).where(eq(processedEvents.key, call.bookingKey));
        if (!booking || booking.status === 'PENDING' || booking.status === 'UNCERTAIN') return 'BLOCKED' as const;
        if (booking.status === 'COMPLETED') throw new AppError(409, 'BOOKING_ALREADY_CREATED');
      }
      const [old] = await tx.select().from(processedEvents).where(eq(processedEvents.key, key));
      if (old) return old;
      const [operation] = await tx.insert(processedEvents).values({ key, tenantId: context.tenant.id, eventType: relay ? 'RELAY_SMS' : 'BOOKING_SMS',
        status: 'PENDING', parentKey, createdAt: now, updatedAt: now, expiresAt: after(now, OPERATION_TTL_MS) }).returning();
      return { ...operation!, fresh: true };
    });
    if (claim === 'BLOCKED') return 'PENDING_VERIFICATION';
    if (claim.status === 'COMPLETED') return 'ACCEPTED';
    if (claim.status === 'FAILED') return 'FAILED';
    let outcome: 'ACCEPTED' | 'FAILED' | 'PENDING_VERIFICATION' = 'PENDING_VERIFICATION';
    let reference: string | undefined;
    if ('fresh' in claim) {
      try {
        const response = await bounded(() => this.sms.send(key, { recipient: context.tenant.smsPhone, text }), this.config.PROVIDER_TIMEOUT_MS);
        reference = response.reference; outcome = 'ACCEPTED';
      } catch (error) { if (error instanceof ProviderError && error.outcome === 'REJECTED') outcome = 'FAILED'; }
    } else {
      try { if (await bounded(() => this.sms.lookup(key), this.config.PROVIDER_TIMEOUT_MS) === 'ACCEPTED') outcome = 'ACCEPTED'; }
      catch { /* Unknown is not a definite rejection and is never blindly resent. */ }
    }
    return this.db.transaction(async (tx) => {
      await tenantLock(tx, context.tenant.id);
      const [current] = await tx.select().from(processedEvents).where(eq(processedEvents.key, key));
      if (!current) return 'PENDING_VERIFICATION';
      if (current.status === 'COMPLETED') return 'ACCEPTED';
      if (current.status === 'FAILED') return 'FAILED';
      await tx.update(processedEvents).set({ status: outcome === 'ACCEPTED' ? 'COMPLETED' : outcome === 'FAILED' ? 'FAILED' : 'UNCERTAIN',
        externalRef: reference, result: resultSchema.parse({ status: outcome }), updatedAt: this.clock.now() }).where(eq(processedEvents.key, key));
      if (outcome === 'ACCEPTED' && relay) await this.audit.inTransaction(tx, context.call.callId, 'RELAY_SENT', { provider_status: 'ACCEPTED', mode: context.tenant.mode });
      if (outcome !== 'ACCEPTED') await this.audit.inTransaction(tx, context.call.callId, 'PROVIDER_ERROR', { provider_status: outcome === 'FAILED' ? 'REJECTED' : 'UNKNOWN' });
      return outcome;
    });
  }
  async relay(context: CallContext, input: ClientInput & { preferred_time: string }) {
    const client = clientDetails(context, input);
    const key = opaqueKey(this.config.IDEMPOTENCY_SECRET, [context.tenant.id, context.call.callId, 'RELAY']);
    const status = await this.send(context, key,
      `Gloso — PROŚBA O KONTAKT, termin NIEPOTWIERDZONY. ${client.name}; tel. ${client.phone} (${client.phone_source === 'CALLER_ID' ? 'Caller ID, własność niezweryfikowana' : 'numer podyktowany, niezweryfikowany'}); ${client.car}; ${client.problem}; preferowany termin: ${input.preferred_time}`, true);
    return { status: status === 'ACCEPTED' ? 'RELAY_SENT' : status === 'FAILED' ? 'RELAY_FAILED' : 'PENDING_VERIFICATION' };
  }
}
