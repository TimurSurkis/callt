import { z } from 'zod';

export const phone = z.string().regex(/^\+[1-9]\d{6,14}$/);
export const identifier = z.string().min(1).max(200).regex(/^[\w.+:@/-]+$/);
export const instant = z.string().datetime({ offset: true });
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const period = z.object({ start: time, end: time }).strict().refine((p) => p.start < p.end, 'Invalid interval');
export const workHoursSchema = z.partialRecord(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.array(period).max(4)).refine((hours) =>
  Object.values(hours).every((periods) => {
    const ordered = [...periods].sort((a, b) => a.start.localeCompare(b.start));
    return ordered.every((p, i) => i === 0 || ordered[i - 1]!.end <= p.start);
  }), 'Overlapping intervals');
export type WorkHours = z.infer<typeof workHoursSchema>;
export const schedulingSchema = z.object({
  slot_step_minutes: z.number().int().min(5).max(240),
  booking_horizon_days: z.number().int().min(1).max(90),
  min_lead_time_minutes: z.number().int().min(0).max(10080),
}).strict();
export type SchedulingConfig = z.infer<typeof schedulingSchema>;
export const testScheduling: SchedulingConfig = { slot_step_minutes: 30, booking_horizon_days: 14, min_lead_time_minutes: 60 };

const tenantFields = {
  name: z.string().trim().min(1).max(120),
  mode: z.enum(['CALENDAR', 'RELAY']),
  is_active: z.boolean(),
  zadarma_number: phone,
  elevenlabs_agent_id: identifier,
  google_calendar_id: z.string().min(1).max(250).nullable(),
  sms_recipient_phone: phone,
  work_hours: workHoursSchema,
  scheduling_config: schedulingSchema,
};
export const createTenantSchema = z.object({ ...tenantFields,
  is_active: tenantFields.is_active.default(true),
  google_calendar_id: tenantFields.google_calendar_id.default(null),
  scheduling_config: schedulingSchema.default(testScheduling),
}).strict();
export const patchTenantSchema = z.object(tenantFields).partial().strict().refine((v) => Object.keys(v).length > 0);
export const serviceSchema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(120),
  duration_minutes: z.number().int().min(5).max(1440), is_diagnostic: z.boolean().default(false),
}).strict();
export const servicesSchema = z.object({ services: z.array(serviceSchema).min(1).max(50) }).strict().refine((v) => v.services.filter((s) => s.is_diagnostic).length <= 1);
export const callAdmissionSchema = z.object({
  called_number: phone, agent_id: identifier, external_call_id: identifier, call_started_at: instant,
}).strict();
export const callEndedSchema = callAdmissionSchema.extend({ call_ended_at: instant, ai_seconds: z.number().int().min(0).max(7 * 86400) }).strict();
export type AdmissionInput = z.infer<typeof callAdmissionSchema>;
export type EndedInput = z.infer<typeof callEndedSchema>;
export const availabilitySchema = z.object({ service_id: z.string().uuid().nullable().optional(), date_query: z.string().trim().min(1).max(150) }).strict();
const clientFields = {
  client_name: z.string().trim().min(1).max(100),
  client_phone: phone.optional(),
  car_model: z.string().trim().min(1).max(150),
  problem_description: z.string().trim().min(1).max(1000),
};
export const bookingSchema = z.object({ ...clientFields, slot_id: z.string().min(20).max(2048) }).strict();
export const relaySchema = z.object({ ...clientFields, preferred_time: z.string().trim().min(1).max(150) }).strict();
export type ClientInput = z.infer<typeof relaySchema> | z.infer<typeof bookingSchema>;
export const resultSchema = z.object({
  status: z.enum(['BOOKED', 'SLOT_CONFLICT', 'CALENDAR_ERROR_USE_RELAY', 'PENDING_VERIFICATION', 'ACCEPTED', 'FAILED']),
  error_code: z.enum(['PROVIDER_REJECTED', 'PROVIDER_UNKNOWN', 'SLOT_CONFLICT', 'INVALID_SLOT', 'CONFIGURATION_CHANGED']).optional(),
  sms_status: z.enum(['ACCEPTED', 'FAILED', 'PENDING_VERIFICATION']).optional(),
}).strict();
export type TechnicalResult = z.infer<typeof resultSchema>;
export const auditMetaSchema = z.object({ service_id: z.string().uuid().optional(), mode: z.enum(['CALENDAR', 'RELAY']).optional(), provider_status: z.enum(['ACCEPTED', 'REJECTED', 'UNKNOWN', 'ANOMALY']).optional(), ai_seconds: z.number().int().nonnegative().optional() }).strict();
export type AuditMeta = z.infer<typeof auditMetaSchema>;
