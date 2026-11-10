import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';

export const TENANT_STATUSES = ['active', 'suspended'] as const;
export const TENANT_PLANS = ['free', 'pro', 'enterprise'] as const;
export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Root of everything. Not tenant-owned, but RLS still limits the app role to its own row. */
export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: TENANT_STATUSES }).notNull().default('active'),
    plan: text('plan', { enum: TENANT_PLANS }).notNull().default('free'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tenants_slug_key').on(t.slug),
    check('tenants_slug_format', sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'`),
  ],
);

/** Custom domains. A domain only routes traffic after DNS TXT verification. */
export const tenantDomains = pgTable(
  'tenant_domains',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    hostname: text('hostname').notNull(),
    verificationToken: text('verification_token').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('tenant_domains_tenant_idx').on(t.tenantId, t.createdAt),
    // Hostnames are globally unique: one hostname can never route to two tenants.
    uniqueIndex('tenant_domains_hostname_key').on(t.hostname),
    check('tenant_domains_hostname_lower', sql`${t.hostname} = lower(${t.hostname})`),
  ],
);

/** Global identity. One person can belong to many tenants through memberships. */
export const users = pgTable(
  'users',
  {
    id: id(),
    entraOid: text('entra_oid').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_entra_oid_key').on(t.entraOid), index('users_email_idx').on(t.email)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ROLES }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('memberships_tenant_user_key').on(t.tenantId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);
