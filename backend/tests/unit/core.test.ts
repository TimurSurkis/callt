import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { auditMetaSchema, resultSchema, workHoursSchema } from '../../src/shared/contracts.js';
import { calendarDays, bounded, ProviderError } from '../../src/shared/core.js';
import { decrypt, encrypt, opaqueKey, readSlot, signSlot } from '../../src/shared/crypto.js';
import { testConfig } from '../helpers.js';

describe('configuration and crypto', () => {
  it('fails closed without secrets and in production', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://a/b' })).toThrow('Invalid configuration');
    expect(() => loadConfig({ ...testConfig(), NODE_ENV: 'production', PORT: '3000' } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
  it('signs slots and rejects tampering', () => {
    const config = testConfig();
    const slot = { tenant_id: randomUUID(), service_id: randomUUID(), start_at: '2026-11-20T09:00:00.000Z', end_at: '2026-11-20T10:00:00.000Z', exp: 1000 };
    const token = signSlot(config.SLOT_SECRET, slot);
    expect(readSlot(config.SLOT_SECRET, token)).toEqual(slot);
    expect(() => readSlot(config.SLOT_SECRET, `${token}x`)).toThrow('INVALID_SLOT');
    expect(() => readSlot(config.SLOT_SECRET, `${token}.more`)).toThrow('INVALID_SLOT');
  });
  it('encrypts with randomized IV and authenticates ciphertext', () => {
    const key = testConfig().AUDIT_KEY;
    const a = encrypt(key, { mode: 'RELAY' }); const b = encrypt(key, { mode: 'RELAY' });
    expect(a).not.toBe(b); expect(decrypt(key, a)).toEqual({ mode: 'RELAY' });
    const altered = `${a.slice(0, -2)}${a.endsWith('ff') ? '00' : 'ff'}`;
    expect(() => decrypt(key, altered)).toThrow();
  });
  it('rejects arbitrary payloads in persistent technical records', () => {
    expect(() => resultSchema.parse({ status: 'BOOKED', start_at: '2026-11-20' })).toThrow();
    expect(() => auditMetaSchema.parse({ client_phone: '+48555111222' })).toThrow();
    expect(opaqueKey('secret', ['call', 'slot'])).toHaveLength(64);
  });
  it('adds calendar days across DST, not a fixed number of hours', () => {
    expect(calendarDays(new Date('2026-03-20T12:00:00Z'), 14).toISOString()).toBe('2026-04-03T11:00:00.000Z');
  });
  it('rejects overlapping work intervals', () => {
    expect(workHoursSchema.safeParse({ '1': [{ start: '08:00', end: '12:00' }, { start: '11:00', end: '15:00' }] }).success).toBe(false);
  });
  it('bounds provider requests without treating a timeout as a rejection', async () => {
    await expect(bounded(() => new Promise(() => undefined), 5)).rejects.toEqual(new ProviderError('UNKNOWN'));
  });
});
