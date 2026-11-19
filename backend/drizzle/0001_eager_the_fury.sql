ALTER TABLE "services" DROP CONSTRAINT "services_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "tenant_booking_gates" ALTER COLUMN "owner_version" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;