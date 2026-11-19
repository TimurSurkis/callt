import type { BusyInterval, CalendarAdapter, CalendarEvent } from '../../src/adapters/types.js';
import { ProviderError } from '../../src/shared/core.js';

// Test-only transport: the mock provider lives OUTSIDE the backend process under test.
export class RemoteMockCalendar implements CalendarAdapter {
  readonly kind = 'mock' as const;
  constructor(private url: string) {}
  private async invoke(path: string, data: unknown): Promise<unknown> {
    const response = await fetch(`${this.url}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new ProviderError('UNKNOWN');
    return response.json();
  }
  async busy(calendarId: string, from: string, to: string) { return await this.invoke('busy', { calendarId, from, to }) as BusyInterval[]; }
  async insert(calendarId: string, event: CalendarEvent) { await this.invoke('insert', { calendarId, event }); }
  async get(calendarId: string, eventId: string) { return await this.invoke('get', { calendarId, eventId }) as CalendarEvent | null; }
}
