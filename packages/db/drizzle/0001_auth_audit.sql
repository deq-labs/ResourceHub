CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"actor_id" uuid,
	"impersonator_id" uuid,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"diff" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"impersonator_id" uuid,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonator_id_users_id_fk" FOREIGN KEY ("impersonator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_created_idx" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_action_idx" ON "audit_log" USING btree ("tenant_id","action");--> statement-breakpoint
CREATE INDEX "invitations_tenant_idx" ON "invitations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_sessions_token_hash_key" ON "platform_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "platform_sessions_family_idx" ON "platform_sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessions_tenant_user_idx" ON "sessions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "sessions_tenant_family_idx" ON "sessions" USING btree ("tenant_id","family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
-- ============================================================================
-- RLS + grants for auth tables (same migration as the tables)
-- ============================================================================
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON sessions TO resourcehub_app;--> statement-breakpoint

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON invitations TO resourcehub_app;--> statement-breakpoint

-- Platform sessions: no tenant. Deny everyone except BYPASSRLS (the platform role).
ALTER TABLE platform_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE platform_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY platform_only ON platform_sessions USING (false) WITH CHECK (false);--> statement-breakpoint

-- Audit log: append-only. INSERT + SELECT for the app role, scoped to its tenant.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO resourcehub_app;--> statement-breakpoint
CREATE FUNCTION audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    -- Only a tenant hard-delete (cascade) by the platform may remove rows, and it must opt in.
    IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP USING ERRCODE = '42501';
  END $$;--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, platform_sessions, invitations TO resourcehub_platform;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON audit_log TO resourcehub_platform;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Login lookups (pre-tenant, global identity). Narrow SECURITY DEFINER functions owned by the
-- platform role: the app role never gets direct INSERT on users or a cross-tenant view.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app_upsert_user(p_new_id uuid, p_oid text, p_email text, p_name text)
  RETURNS TABLE (id uuid, email text, name text, is_platform_admin boolean)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    INSERT INTO users AS u (id, entra_oid, email, name, last_login_at)
    -- p_new_id (a UUID v7 from the app) is only used when the user is new.
    VALUES (p_new_id, p_oid, lower(p_email), p_name, now())
    ON CONFLICT (entra_oid) DO UPDATE
      SET email = lower(EXCLUDED.email), name = EXCLUDED.name, last_login_at = now(), updated_at = now()
    RETURNING u.id, u.email, u.name, u.is_platform_admin
  $$;--> statement-breakpoint
CREATE FUNCTION app_user_memberships(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, slug text, name text, role text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.tenant_id, t.slug, t.name, m.role, t.status
      FROM memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = p_user_id
     ORDER BY t.name
  $$;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO resourcehub_platform;--> statement-breakpoint
ALTER FUNCTION app_upsert_user(uuid, text, text, text) OWNER TO resourcehub_platform;--> statement-breakpoint
ALTER FUNCTION app_user_memberships(uuid) OWNER TO resourcehub_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM resourcehub_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_upsert_user(uuid, text, text, text), app_user_memberships(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_upsert_user(uuid, text, text, text), app_user_memberships(uuid) TO resourcehub_app;
