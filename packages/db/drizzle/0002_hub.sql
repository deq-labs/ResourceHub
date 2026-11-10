CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"icon" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"resource_id" uuid,
	"blob_path" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"checksum" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"purpose" text DEFAULT 'attachment' NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_tags" (
	"tenant_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_tags_tenant_id_resource_id_tag_id_pk" PRIMARY KEY("tenant_id","resource_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"body" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"category_id" uuid,
	"author_id" uuid,
	"external_source" text,
	"external_id" text,
	"external_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_branding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hub_title" text,
	"tagline" text,
	"colors" jsonb NOT NULL,
	"font" text DEFAULT 'Inter' NOT NULL,
	"logo_file_id" uuid,
	"favicon_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_tags" ADD CONSTRAINT "resource_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_tenant_slug_key" ON "categories" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_tenant_id_key" ON "categories" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "files_tenant_resource_idx" ON "files" USING btree ("tenant_id","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_tenant_id_key" ON "files" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "resource_tags_tenant_tag_idx" ON "resource_tags" USING btree ("tenant_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_tenant_slug_key" ON "resources" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_tenant_id_key" ON "resources" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "resources_tenant_status_updated_idx" ON "resources" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "resources_tenant_category_idx" ON "resources" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_tenant_slug_key" ON "tags" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_tenant_id_key" ON "tags" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_branding_tenant_key" ON "tenant_branding" USING btree ("tenant_id");--> statement-breakpoint
-- ============================================================================
-- Tenant-safe relationships. FK checks bypass RLS, so a plain FK on category_id would let
-- tenant A attach tenant B's category (and probe for B's ids). Composite (tenant_id, x_id) FKs
-- make cross-tenant references impossible at the schema level.
-- ============================================================================
ALTER TABLE resources ADD CONSTRAINT resources_category_fk
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
  ON DELETE SET NULL (category_id);--> statement-breakpoint
ALTER TABLE resource_tags ADD CONSTRAINT resource_tags_resource_fk
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE resource_tags ADD CONSTRAINT resource_tags_tag_fk
  FOREIGN KEY (tenant_id, tag_id) REFERENCES tags (tenant_id, id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE files ADD CONSTRAINT files_resource_fk
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id)
  ON DELETE SET NULL (resource_id);--> statement-breakpoint
ALTER TABLE files ADD CONSTRAINT files_blob_path_prefix
  CHECK (blob_path LIKE 'tenants/' || tenant_id::text || '/%');--> statement-breakpoint
ALTER TABLE tenant_branding ADD CONSTRAINT tenant_branding_logo_fk
  FOREIGN KEY (tenant_id, logo_file_id) REFERENCES files (tenant_id, id)
  ON DELETE SET NULL (logo_file_id);--> statement-breakpoint

-- Full-text search over title (A), summary (B) and body (C).
ALTER TABLE resources ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(body->>'content', '')), 'C')
) STORED;--> statement-breakpoint
CREATE INDEX resources_search_idx ON resources USING gin (search);--> statement-breakpoint

-- ============================================================================
-- RLS + grants
-- ============================================================================
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE categories FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON categories USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tags USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE resources FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON resources USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE resource_tags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE resource_tags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON resource_tags USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE files ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE files FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON files USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_branding USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON categories, tags, resources, resource_tags, files, tenant_branding TO resourcehub_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON categories, tags, resources, resource_tags, files, tenant_branding TO resourcehub_platform;
