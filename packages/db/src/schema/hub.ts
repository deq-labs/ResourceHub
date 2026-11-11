import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';
import { tenants, users } from './tenancy.js';

// NOTE: cross-table references between tenant tables are COMPOSITE foreign keys on
// (tenant_id, id), declared in the migration SQL. A plain FK on `category_id` alone would let
// tenant A point a row at tenant B's category, because FK checks bypass RLS.

export const RESOURCE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export interface ResourceBody {
  format: 'markdown';
  content: string;
}

export const categories = pgTable(
  'categories',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    icon: text('icon'),
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('categories_tenant_slug_key').on(t.tenantId, t.slug),
    uniqueIndex('categories_tenant_id_key').on(t.tenantId, t.id),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tags_tenant_slug_key').on(t.tenantId, t.slug),
    uniqueIndex('tags_tenant_id_key').on(t.tenantId, t.id),
  ],
);

export const resources = pgTable(
  'resources',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    summary: text('summary'),
    body: jsonb('body').$type<ResourceBody>().notNull(),
    status: text('status', { enum: RESOURCE_STATUSES }).notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    categoryId: uuid('category_id'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set when the resource came from an integration (e.g. a partner SOAP feed). */
    externalSource: text('external_source'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('resources_tenant_slug_key').on(t.tenantId, t.slug),
    uniqueIndex('resources_tenant_id_key').on(t.tenantId, t.id),
    index('resources_tenant_status_updated_idx').on(t.tenantId, t.status, t.updatedAt),
    index('resources_tenant_category_idx').on(t.tenantId, t.categoryId),
  ],
);

export const resourceTags = pgTable(
  'resource_tags',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    resourceId: uuid('resource_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.resourceId, t.tagId] }),
    index('resource_tags_tenant_tag_idx').on(t.tenantId, t.tagId),
  ],
);

export const FILE_STATUSES = ['pending', 'ready'] as const;

/** Blob metadata. Paths always start with `tenants/{tenantId}/`. */
export const files = pgTable(
  'files',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    resourceId: uuid('resource_id'),
    blobPath: text('blob_path').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    checksum: text('checksum'),
    status: text('status', { enum: FILE_STATUSES }).notNull().default('pending'),
    purpose: text('purpose', { enum: ['attachment', 'logo'] })
      .notNull()
      .default('attachment'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('files_tenant_resource_idx').on(t.tenantId, t.resourceId),
    uniqueIndex('files_tenant_id_key').on(t.tenantId, t.id),
  ],
);

export interface BrandColors {
  primary: string;
  primaryForeground: string;
  accent: string;
  background: string;
}

/** Theme tokens the SPA loads at boot. One row per tenant. */
export const tenantBranding = pgTable(
  'tenant_branding',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    hubTitle: text('hub_title'),
    tagline: text('tagline'),
    colors: jsonb('colors').$type<BrandColors>().notNull(),
    font: text('font').notNull().default('Inter'),
    logoFileId: uuid('logo_file_id'),
    faviconUrl: text('favicon_url'),
    ...timestamps,
  },
  (t) => [uniqueIndex('tenant_branding_tenant_key').on(t.tenantId)],
);
