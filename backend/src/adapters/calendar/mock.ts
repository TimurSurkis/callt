import type { BusyInterval, CalendarAdapter, CalendarEvent } from '../types.js';
import { ProviderError } from '../../shared/core.js';

export type CalendarFault = 'REJECTED' | 'TIMEOUT_BEFORE' | 'TIMEOUT_AFTER' | 'SERVER_ERROR' | 'CONFLICT';
// Controls are injected in tests only, never exposed by public HTTP routes.
export class MockCalendar implements CalendarAdapter {
  readonly kind = 'mock' as const;
  readonly events = new Map<string, CalendarEvent>();
  readonly manual = new Map<string, BusyInterval[]>();
  insertCalls = 0;
  busyCalls = 0;
  getCalls = 0;
  nextInsert?: CalendarFault;
  failBusy = false;
  failGet = false;
  beforeInsert?: () => Promise<void>;
  private key(calendar: string, id: string) { return JSON.stringify([calendar, id]); }
  async busy(calendarId: string, from: string, to: string): Promise<BusyInterval[]> {
    this.busyCalls++;
    if (this.failBusy) throw new ProviderError('UNKNOWN');
    const items: BusyInterval[] = [...this.events.entries()].filter(([key]) => (JSON.parse(key) as string[])[0] === calendarId).map(([, e]) => e);
    return [...items, ...(this.manual.get(calendarId) ?? [])].filter((e) => Date.parse(e.start_at) < Date.parse(to) && Date.parse(e.end_at) > Date.parse(from)).map(({ start_at, end_at }) => ({ start_at, end_at }));
  }
  async insert(calendarId: string, event: CalendarEvent) {
    this.insertCalls++;
    await this.beforeInsert?.();
    const fault = this.nextInsert; this.nextInsert = undefined;
    if (fault === 'REJECTED') throw new ProviderError('REJECTED');
    if (fault === 'TIMEOUT_BEFORE' || fault === 'SERVER_ERROR') throw new ProviderError('UNKNOWN');
    const key = this.key(calendarId, event.id);
    if (this.events.has(key) || fault === 'CONFLICT') throw new ProviderError('CONFLICT');
    this.events.set(key, structuredClone(event));
    if (fault === 'TIMEOUT_AFTER') throw new ProviderError('UNKNOWN');
  }
  async get(calendarId: string, eventId: string): Promise<CalendarEvent | null> {
    this.getCalls++;
    if (this.failGet) throw new ProviderError('UNKNOWN');
    const event = this.events.get(this.key(calendarId, eventId));
    return event ? structuredClone(event) : null;
  }
}
