export interface BusyInterval { start_at: string; end_at: string }
export interface ClientDetails { name: string; phone: string; phone_source: 'CALLER_ID' | 'DICTATED_UNVERIFIED'; car: string; problem: string }
export interface CalendarEvent extends BusyInterval {
  id: string; operation_key: string; tenant_id: string; service_id: string; client: ClientDetails; origin: 'GLOSO';
}
export interface CalendarAdapter {
  readonly kind: 'mock' | 'real';
  busy(calendarId: string, from: string, to: string): Promise<BusyInterval[]>;
  insert(calendarId: string, event: CalendarEvent): Promise<void>;
  get(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
}
export interface SmsMessage { recipient: string; text: string }
export interface SmsAdapter {
  readonly kind: 'mock' | 'real';
  send(operationKey: string, message: SmsMessage): Promise<{ reference: string }>;
  lookup(operationKey: string): Promise<'ACCEPTED' | 'UNKNOWN'>;
}
