import type { SmsAdapter, SmsMessage } from '../types.js';
import { ProviderError } from '../../shared/core.js';
import { randomUUID } from 'node:crypto';

export class MockSms implements SmsAdapter {
  readonly kind = 'mock' as const;
  readonly messages = new Map<string, SmsMessage>();
  sendCalls = 0;
  nextSend?: 'REJECTED' | 'TIMEOUT_BEFORE' | 'TIMEOUT_AFTER';
  supportsLookup = true;
  async send(operationKey: string, message: SmsMessage) {
    this.sendCalls++;
    const fault = this.nextSend; this.nextSend = undefined;
    if (fault === 'REJECTED') throw new ProviderError('REJECTED');
    if (fault === 'TIMEOUT_BEFORE') throw new ProviderError('UNKNOWN');
    // Simulates a provider WITHOUT an idempotent send API. Caller must deduplicate.
    if (this.messages.has(operationKey)) throw new Error('Duplicate SMS attempt');
    this.messages.set(operationKey, structuredClone(message));
    if (fault === 'TIMEOUT_AFTER') throw new ProviderError('UNKNOWN');
    return { reference: randomUUID() };
  }
  async lookup(operationKey: string): Promise<'ACCEPTED' | 'UNKNOWN'> {
    return this.supportsLookup && this.messages.has(operationKey) ? 'ACCEPTED' : 'UNKNOWN';
  }
}
