CREATE TABLE "integration_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"type" text DEFAULT 'sync' NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"stats" jsonb,
	"error" text,
	"trace_id" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret_ref" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule_minutes" integer,
	"last_synced_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_runs" ADD CONSTRAINT "integration_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_runs" ADD CONSTRAINT "integration_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_runs_tenant_integration_idx" ON "integration_runs" USING btree ("tenant_id","integration_id","created_at");--> statement-breakpoint
CREATE INDEX "integrations_tenant_idx" ON "integrations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_tenant_id_key" ON "integrations" USING btree ("tenant_id","id");--> statement-breakpoint
-- Runs can only reference an integration in the same tenant (FK checks bypass RLS).
ALTER TABLE integration_runs ADD CONSTRAINT integration_runs_integration_fk
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE integrations ADD CONSTRAINT integrations_secret_ref_format
  CHECK (secret_ref IS NULL OR secret_ref ~ '^(env:[A-Z][A-Z0-9_]{1,63}|kv:[a-zA-Z0-9-]{1,127})$');--> statement-breakpoint
-- Integration-sourced resources are upserted by (source, external id) per tenant.
CREATE UNIQUE INDEX resources_tenant_external_key ON resources (tenant_id, external_source, external_id)
  WHERE external_source IS NOT NULL;--> statement-breakpoint

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON integrations USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE integration_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE integration_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON integration_runs USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations, integration_runs TO resourcehub_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations, integration_runs TO resourcehub_platform;
