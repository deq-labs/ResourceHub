CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_domains_hostname_lower" CHECK ("tenant_domains"."hostname" = lower("tenant_domains"."hostname"))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_format" CHECK ("tenants"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entra_oid" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_key" ON "memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tenant_domains_tenant_idx" ON "tenant_domains" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_domains_hostname_key" ON "tenant_domains" USING btree ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_entra_oid_key" ON "users" USING btree ("entra_oid");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
-- ============================================================================
-- Tenancy: helpers, Row-Level Security, grants (hand-written; same migration as the tables)
-- ============================================================================
-- NULLIF guards the classic pooled-connection gotcha: once a custom GUC has been SET LOCAL on a
-- connection, later transactions see '' (not NULL), and ''::uuid would raise instead of matching nothing.
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_tenant(), app_current_user() TO resourcehub_app, resourcehub_platform;
--> statement-breakpoint

-- tenants: the app role can only ever see the tenant it is acting for.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, UPDATE (name, updated_at) ON tenants TO resourcehub_app;--> statement-breakpoint

-- tenant_domains
ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_domains FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_domains
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_domains TO resourcehub_app;--> statement-breakpoint

-- memberships
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO resourcehub_app;--> statement-breakpoint

-- users: global identity. The app sees itself plus members of the current tenant (the EXISTS
-- subquery is itself filtered by the memberships policy). Inserts only via app_upsert_user().
ALTER TABLE users ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY users_visible ON users FOR SELECT
  USING (id = app_current_user() OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id));--> statement-breakpoint
CREATE POLICY users_update_self ON users FOR UPDATE
  USING (id = app_current_user())
  WITH CHECK (id = app_current_user());--> statement-breakpoint
GRANT SELECT, UPDATE (name, updated_at) ON users TO resourcehub_app;--> statement-breakpoint

-- The platform role (BYPASSRLS) gets full DML; it is only used by audited platform code.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, tenant_domains, users, memberships TO resourcehub_platform;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Pre-tenant lookup. Host resolution happens before any tenant is known, so it can't run under
-- the tenant policy. This narrow SECURITY DEFINER function (owned by the BYPASSRLS role) answers
-- exactly one question, "which tenant does this host belong to?", and nothing else.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app_resolve_tenant(p_slug text, p_hostname text)
  RETURNS TABLE (id uuid, slug text, name text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.id, t.slug, t.name, t.status FROM tenants t
     WHERE p_slug IS NOT NULL AND t.slug = p_slug
    UNION ALL
    SELECT t.id, t.slug, t.name, t.status FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
     WHERE p_hostname IS NOT NULL AND d.hostname = lower(p_hostname) AND d.verified_at IS NOT NULL
    LIMIT 1
  $$;--> statement-breakpoint
-- ALTER OWNER requires the new owner to hold CREATE on the schema; grant it only for this step.
GRANT CREATE ON SCHEMA public TO resourcehub_platform;--> statement-breakpoint
ALTER FUNCTION app_resolve_tenant(text, text) OWNER TO resourcehub_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM resourcehub_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_tenant(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_tenant(text, text) TO resourcehub_app;
