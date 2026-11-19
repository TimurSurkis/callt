CREATE TYPE "public"."audit_action" AS ENUM('CALL_ADMITTED', 'CALL_REJECTED_LIMIT', 'SLOTS_CHECKED', 'BOOKING_CREATED', 'BOOKING_CONFLICT', 'RELAY_SENT', 'PROVIDER_ERROR');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('ACTIVE', 'CLOSED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."gate_state" AS ENUM('IDLE', 'BUSY', 'RECOVERY_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."workshop_mode" AS ENUM('CALENDAR', 'RELAY');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('PENDING', 'COMPLETED', 'UNCERTAIN', 'FAILED');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"audit_session_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"encrypted_meta" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "active_call_reservations" (
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_call_id" text NOT NULL,
	"call_id" uuid NOT NULL,
	"audit_session_id" uuid NOT NULL,
	"status" "call_status" NOT NULL,
	"admission_reason" text,
	"reserved_minutes" integer NOT NULL,
	"reservation_expires_at" timestamp with time zone,
	"call_started_at" timestamp with time zone NOT NULL,
	"call_ended_at" timestamp with time zone,
	"usage_accounted" boolean DEFAULT false NOT NULL,
	"booking_operation_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "active_call_reservations_tenant_id_provider_external_call_id_pk" PRIMARY KEY("tenant_id","provider","external_call_id"),
	CONSTRAINT "active_call_reservations_call_id_unique" UNIQUE("call_id"),
	CONSTRAINT "nonnegative_reserve" CHECK ("active_call_reservations"."reserved_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_booking_gates" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"state" "gate_state" DEFAULT 'IDLE' NOT NULL,
	"operation_key" text,
	"owner_token" uuid,
	"owner_version" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gate_operation_required" CHECK (("tenant_booking_gates"."state" = 'IDLE' AND "tenant_booking_gates"."operation_key" IS NULL) OR "tenant_booking_gates"."state" = 'RECOVERY_REQUIRED' OR ("tenant_booking_gates"."state" = 'BUSY' AND "tenant_booking_gates"."operation_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "pilot_usage" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"minutes_limit" integer DEFAULT 40 NOT NULL,
	"minutes_used" integer DEFAULT 0 NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "nonnegative_usage" CHECK ("pilot_usage"."minutes_limit" >= 0 AND "pilot_usage"."minutes_used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"status" "operation_status" NOT NULL,
	"external_ref" text,
	"calendar_ref" text,
	"parent_operation_key" text,
	"result_payload" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"is_diagnostic" boolean DEFAULT false NOT NULL,
	CONSTRAINT "positive_duration" CHECK ("services"."duration_minutes" BETWEEN 5 AND 1440)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mode" "workshop_mode" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"zadarma_number" text NOT NULL,
	"elevenlabs_agent_id" text NOT NULL,
	"google_calendar_id" text,
	"sms_recipient_phone" text NOT NULL,
	"work_hours" jsonb NOT NULL,
	"scheduling_config" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tenants_zadarma_number_unique" UNIQUE("zadarma_number"),
	CONSTRAINT "tenants_elevenlabs_agent_id_unique" UNIQUE("elevenlabs_agent_id"),
	CONSTRAINT "calendar_mode_requires_calendar" CHECK ("tenants"."mode" <> 'CALENDAR' OR "tenants"."google_calendar_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_call_reservations" ADD CONSTRAINT "active_call_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_booking_gates" ADD CONSTRAINT "tenant_booking_gates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_usage" ADD CONSTRAINT "pilot_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_expiry" ON "audit_logs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "audit_session" ON "audit_logs" USING btree ("audit_session_id");--> statement-breakpoint
CREATE INDEX "active_reservations" ON "active_call_reservations" USING btree ("tenant_id","status","reservation_expires_at");--> statement-breakpoint
CREATE INDEX "calls_expiry" ON "active_call_reservations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "operations_expiry" ON "processed_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "operations_recovery" ON "processed_events" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "services_tenant" ON "services" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_diagnostic_per_tenant" ON "services" USING btree ("tenant_id") WHERE "services"."is_diagnostic" = true;