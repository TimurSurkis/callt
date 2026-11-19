import { DateTime } from 'luxon';
import type { BusyInterval } from '../../adapters/types.js';
import type { Service, Tenant } from '../../db/schema.js';
import { ZONE } from '../../shared/core.js';

export type DateRange = { from: DateTime; to: DateTime };
export function normalizeDate(query: string, now: Date): DateRange | null {
  const text = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const today = DateTime.fromJSDate(now, { zone: ZONE }).startOf('day');
  const relative = /^(dzisiaj|dziś|jutro|pojutrze)(?: (rano|po południu|wieczorem))?$/.exec(text);
  if (relative) {
    const day = today.plus({ days: relative[1] === 'jutro' ? 1 : relative[1] === 'pojutrze' ? 2 : 0 });
    const hours = relative[2] === 'rano' ? [8, 12] : relative[2] === 'po południu' ? [12, 18] : relative[2] === 'wieczorem' ? [18, 24] : [0, 24];
    return { from: day.set({ hour: hours[0]! }), to: day.plus({ days: hours[1] === 24 ? 1 : 0 }).set({ hour: hours[1] === 24 ? 0 : hours[1]! }) };
  }
  if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/.test(text)) return null;
  const format = text.length === 10 ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm';
  const from = DateTime.fromFormat(text, format, { zone: ZONE });
  // Luxon normalizes nonexistent local times: round-trip validation rejects them.
  if (!from.isValid || from.toFormat(format) !== text || (text.length > 10 && from.getPossibleOffsets().length !== 1)) return null;
  return { from, to: text.length === 10 ? from.plus({ days: 1 }) : from.plus({ minutes: 1 }) };
}

export function calculateSlots(tenant: Tenant, service: Service, range: DateRange, busy: BusyInterval[], now: Date): BusyInterval[] {
  const current = DateTime.fromJSDate(now, { zone: ZONE });
  const horizon = current.plus({ days: tenant.scheduling.booking_horizon_days });
  const minimum = current.plus({ minutes: tenant.scheduling.min_lead_time_minutes });
  const results: BusyInterval[] = [];
  // Bounded by configured horizon, even for an untrusted far-future date query.
  if (range.to <= current || range.from > horizon) return results;
  for (let day = range.from.startOf('day'); day < range.to && day <= horizon; day = day.plus({ days: 1 })) {
    const periods = tenant.workHours[String(day.weekday) as keyof Tenant['workHours']] ?? [];
    for (const period of periods) {
      const open = DateTime.fromFormat(`${day.toISODate()} ${period.start}`, 'yyyy-MM-dd HH:mm', { zone: ZONE });
      const close = DateTime.fromFormat(`${day.toISODate()} ${period.end}`, 'yyyy-MM-dd HH:mm', { zone: ZONE });
      if (open.toFormat('HH:mm') !== period.start || close.toFormat('HH:mm') !== period.end || open.getPossibleOffsets().length !== 1 || close.getPossibleOffsets().length !== 1) continue;
      for (let start = open; start < close; start = start.plus({ minutes: tenant.scheduling.slot_step_minutes })) {
        const end = start.plus({ minutes: service.durationMinutes });
        if (start < range.from || start >= range.to || start < minimum || start > horizon || end > close || start.getPossibleOffsets().length !== 1 || end.getPossibleOffsets().length !== 1) continue;
        if (busy.some((b) => start.toMillis() < Date.parse(b.end_at) && end.toMillis() > Date.parse(b.start_at))) continue;
        results.push({ start_at: start.toUTC().toISO()!, end_at: end.toUTC().toISO()! });
      }
    }
  }
  return results;
}
