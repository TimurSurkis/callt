import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './core.js';
import { instant } from './contracts.js';

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function opaqueKey(secret: string, values: unknown[]): string {
  return createHmac('sha256', secret).update(JSON.stringify(values)).digest('hex');
}
export const slotSchema = z.object({ tenant_id: z.string().uuid(), service_id: z.string().uuid(), start_at: instant, end_at: instant, exp: z.number().int().positive() }).strict();
export type Slot = z.infer<typeof slotSchema>;
export function signSlot(secret: string, slot: Slot): string {
  const body = Buffer.from(JSON.stringify(slotSchema.parse(slot))).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
// Expiry is deliberately checked by the caller AFTER an existing-operation lookup.
export function readSlot(secret: string, token: string): Slot {
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error();
    const signature = createHmac('sha256', secret).update(parts[0]).digest('base64url');
    if (!safeEqual(parts[1], signature)) throw new Error();
    const slot = slotSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
    if (new Date(slot.start_at) >= new Date(slot.end_at)) throw new Error();
    return slot;
  } catch { throw new AppError(400, 'INVALID_SLOT'); }
}
export function encrypt(key: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('hex')).join(':');
}
export function decrypt(key: string, value: string): unknown {
  const parts = value.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(parts[0]!, 'hex'));
  decipher.setAuthTag(Buffer.from(parts[1]!, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'hex')), decipher.final()]).toString('utf8')) as unknown;
}
