import { and, eq, gt } from 'drizzle-orm';
import type { Config } from '../../config/index.js';
import { tenantLock, type Database, type Tx } from '../../db/index.js';
import { auditLogs, calls } from '../../db/schema.js';
import { auditMetaSchema, type AuditMeta } from '../../shared/contracts.js';
import { after, DAY_MS, type Clock } from '../../shared/core.js';
import { decrypt, encrypt } from '../../shared/crypto.js';

type Action = typeof auditLogs.$inferInsert.action;
export class AuditService {
  constructor(private db: Database, private config: Config, private clock: Clock) {}
  async inTransaction(tx: Tx, callId: string, action: Action, meta: AuditMeta = {}) {
    const now = this.clock.now();
    const [call] = await tx.select().from(calls).where(and(eq(calls.callId, callId), gt(calls.expiresAt, now))).for('update');
    if (!call) return;
    const expiresAt = after(call.callEndedAt ?? now, 30 * DAY_MS);
    if (expiresAt <= now) return;
    await tx.insert(auditLogs).values({ tenantId: call.tenantId, auditSessionId: call.auditSessionId, action,
      encryptedMeta: encrypt(this.config.AUDIT_KEY, auditMetaSchema.parse(meta)), createdAt: now, expiresAt });
  }
  async write(tenantId: string, callId: string, action: Action, meta: AuditMeta = {}) {
    await this.db.transaction(async (tx) => { await tenantLock(tx, tenantId); await this.inTransaction(tx, callId, action, meta); });
  }
  // Internal-only reader. There is intentionally no caller archive HTTP endpoint.
  async read(tenantId: string) {
    const rows = await this.db.select().from(auditLogs).where(and(eq(auditLogs.tenantId, tenantId), gt(auditLogs.expiresAt, this.clock.now())));
    return rows.map((row) => ({ ...row, meta: auditMetaSchema.parse(decrypt(this.config.AUDIT_KEY, row.encryptedMeta)) }));
  }
}
