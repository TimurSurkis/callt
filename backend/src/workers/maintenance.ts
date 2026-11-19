import { and, eq, lte, sql } from 'drizzle-orm';
import { tenantLock, type Database } from '../db/index.js';
import { auditLogs, calls, gates, processedEvents, tenants } from '../db/schema.js';
import type { BookingService } from '../modules/bookings/service.js';
import { type Clock, type Logger } from '../shared/core.js';

export class Maintenance {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(private db: Database, private bookings: BookingService, private clock: Clock, private log: Logger) {}
  async cleanup() {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(719312047) AS locked`);
      if (!result.rows[0]?.locked) return;
      const now = this.clock.now();
      // Same lock order as normal operations. No provider network calls in this transaction.
      const workshops = await tx.select({ id: tenants.id }).from(tenants).orderBy(tenants.id);
      for (const tenant of workshops) {
        await tenantLock(tx, tenant.id);
        const [gate] = await tx.select().from(gates).where(eq(gates.tenantId, tenant.id));
        if (gate?.operationKey) {
          const [operation] = await tx.select().from(processedEvents).where(eq(processedEvents.key, gate.operationKey));
          if (!operation || operation.expiresAt <= now) await tx.update(gates).set({ state: 'RECOVERY_REQUIRED', operationKey: null, ownerToken: null,
            ownerVersion: gate.ownerVersion + 1, leaseExpiresAt: null, updatedAt: now }).where(eq(gates.tenantId, tenant.id));
        }
        await tx.delete(processedEvents).where(and(eq(processedEvents.tenantId, tenant.id), lte(processedEvents.expiresAt, now)));
        await tx.delete(calls).where(and(eq(calls.tenantId, tenant.id), lte(calls.expiresAt, now)));
        await tx.delete(auditLogs).where(and(eq(auditLogs.tenantId, tenant.id), lte(auditLogs.expiresAt, now)));
      }
    });
  }
  async recover() {
    const workshops = await this.db.select({ id: gates.tenantId }).from(gates).where(eq(gates.state, 'BUSY'));
    for (const workshop of workshops) {
      try { await this.bookings.recover(workshop.id); }
      catch { this.log.event('RECOVERY_FAILED'); }
    }
  }
  async run() {
    if (this.running) return this.running;
    this.running = (async () => { await this.recover(); await this.cleanup(); })();
    try { await this.running; }
    finally { this.running = undefined; }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.run().catch(() => this.log.event('MAINTENANCE_FAILED')); }, 3600000);
    this.timer.unref();
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.running; }
}
