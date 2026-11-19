import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { SchedulingConfig, TechnicalResult, WorkHours } from '../shared/contracts.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const modeEnum = pgEnum('workshop_mode', ['CALENDAR', 'RELAY']);
export const operationStatus = pgEnum('operation_status', ['PENDING', 'COMPLETED', 'UNCERTAIN', 'FAILED']);
export const callStatus = pgEnum('call_status', ['ACTIVE', 'CLOSED', 'REJECTED']);
export const gateState = pgEnum('gate_state', ['IDLE', 'BUSY', 'RECOVERY_REQUIRED']);
export const auditAction = pgEnum('audit_action', ['CALL_ADMITTED', 'CALL_REJECTED_LIMIT', 'SLOTS_CHECKED', 'BOOKING_CREATED', 'BOOKING_CONFLICT', 'RELAY_SENT', 'PROVIDER_ERROR']);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(), name: text('name').notNull(), mode: modeEnum('mode').notNull(),
  isActive: boolean('is_active').notNull().default(true), zadarmaNumber: text('zadarma_number').notNull().unique(),
  agentId: text('elevenlabs_agent_id').notNull().unique(), calendarId: text('google_calendar_id'),
  smsPhone: text('sms_recipient_phone').notNull(), workHours: jsonb('work_hours').$type<WorkHours>().notNull(),
  scheduling: jsonb('scheduling_config').$type<SchedulingConfig>().notNull(),
  createdAt: ts('created_at').notNull(), updatedAt: ts('updated_at').notNull(),
}, (t) => [check('calendar_mode_requires_calendar', sql`${t.mode} <> 'CALENDAR' OR ${t.calendarId} IS NOT NULL`)]);
export type Tenant = typeof tenants.$inferSelect;

export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), durationMinutes: integer('duration_minutes').notNull(), isDiagnostic: boolean('is_diagnostic').notNull().default(false),
}, (t) => [index('services_tenant').on(t.tenantId), uniqueIndex('one_diagnostic_per_tenant').on(t.tenantId).where(sql`${t.isDiagnostic} = true`), check('positive_duration', sql`${t.durationMinutes} BETWEEN 5 AND 1440`)]);
export type Service = typeof services.$inferSelect;

export const pilotUsage = pgTable('pilot_usage', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id), activatedAt: ts('activated_at').notNull(), expiresAt: ts('expires_at').notNull(),
  minutesLimit: integer('minutes_limit').notNull().default(40), minutesUsed: integer('minutes_used').notNull().default(0), isBlocked: boolean('is_blocked').notNull().default(false),
}, (t) => [check('nonnegative_usage', sql`${t.minutesLimit} >= 0 AND ${t.minutesUsed} >= 0`)]);

export const processedEvents = pgTable('processed_events', {
  key: text('idempotency_key').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id), eventType: text('event_type').notNull(),
  status: operationStatus('status').notNull(), externalRef: text('external_ref'), calendarRef: text('calendar_ref'), parentKey: text('parent_operation_key'),
  result: jsonb('result_payload').$type<TechnicalResult>(),
  createdAt: ts('created_at').notNull(), updatedAt: ts('updated_at').notNull(), expiresAt: ts('expires_at').notNull(),
}, (t) => [index('operations_expiry').on(t.expiresAt), index('operations_recovery').on(t.tenantId, t.status)]);
export type Operation = typeof processedEvents.$inferSelect;

export const calls = pgTable('active_call_reservations', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id), provider: text('provider').notNull(), externalCallId: text('external_call_id').notNull(),
  callId: uuid('call_id').notNull().unique(), auditSessionId: uuid('audit_session_id').notNull(), status: callStatus('status').notNull(), admissionReason: text('admission_reason'),
  reservedMinutes: integer('reserved_minutes').notNull(), reservationExpiresAt: ts('reservation_expires_at'),
  callStartedAt: ts('call_started_at').notNull(), callEndedAt: ts('call_ended_at'), usageAccounted: boolean('usage_accounted').notNull().default(false),
  bookingKey: text('booking_operation_key'),
  createdAt: ts('created_at').notNull(), expiresAt: ts('expires_at').notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.provider, t.externalCallId] }), index('active_reservations').on(t.tenantId, t.status, t.reservationExpiresAt), index('calls_expiry').on(t.expiresAt), check('nonnegative_reserve', sql`${t.reservedMinutes} >= 0`)]);
export type Call = typeof calls.$inferSelect;

export const gates = pgTable('tenant_booking_gates', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id), state: gateState('state').notNull().default('IDLE'),
  operationKey: text('operation_key'), ownerToken: uuid('owner_token'), ownerVersion: bigint('owner_version', { mode: 'number' }).notNull().default(0),
  leaseExpiresAt: ts('lease_expires_at'), updatedAt: ts('updated_at').notNull(),
}, (t) => [check('gate_operation_required', sql`(${t.state} = 'IDLE' AND ${t.operationKey} IS NULL) OR ${t.state} = 'RECOVERY_REQUIRED' OR (${t.state} = 'BUSY' AND ${t.operationKey} IS NOT NULL)`)]);

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id), auditSessionId: uuid('audit_session_id').notNull(),
  action: auditAction('action').notNull(), encryptedMeta: text('encrypted_meta').notNull(), createdAt: ts('created_at').notNull(), expiresAt: ts('expires_at').notNull(),
}, (t) => [index('audit_expiry').on(t.expiresAt), index('audit_session').on(t.auditSessionId)]);
