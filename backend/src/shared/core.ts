import { DateTime } from 'luxon';

export const ZONE = 'Europe/Warsaw';
export const DAY_MS = 86400000;
export const OPERATION_TTL_MS = 7 * DAY_MS;
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
export const after = (date: Date, ms: number) => new Date(date.getTime() + ms);
export function calendarDays(date: Date, days: number): Date {
  return DateTime.fromJSDate(date, { zone: ZONE }).plus({ days }).toJSDate();
}
export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export class ProviderError extends Error {
  constructor(public readonly outcome: 'REJECTED' | 'UNKNOWN' | 'CONFLICT') { super(outcome); }
}
// No untrusted messages, URLs, query parameters, headers or bodies reach logs.
export interface Logger { event(code: string): void }
export const logger: Logger = { event: (code) => console.info(JSON.stringify({ event: code, at: new Date().toISOString() })) };

export async function bounded<T>(request: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(request),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderError('UNKNOWN')), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
