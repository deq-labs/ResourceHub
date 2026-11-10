import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';
import { ROLES, tenants, users } from './tenancy.js';

/**
 * Refresh-token sessions for a tenant host. Tokens are stored as SHA-256 hashes and rotate on
 * every use; presenting a rotated-out token revokes the whole family (reuse detection).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    /** Set when a platform admin is impersonating this user. */
    impersonatorId: uuid('impersonator_id').references(() => users.id, { onDelete: 'set null' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [
    index('sessions_tenant_user_idx').on(t.tenantId, t.userId),
    index('sessions_tenant_family_idx').on(t.tenantId, t.familyId),
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
  ],
);

/** Sessions on the platform admin host. Only the platform role can touch them. */
export const platformSessions = pgTable(
  'platform_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('platform_sessions_token_hash_key').on(t.tokenHash),
    index('platform_sessions_family_idx').on(t.familyId),
  ],
);

/** Single-use invitations. Only a hash of the token is stored. */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('invitations_tenant_idx').on(t.tenantId, t.createdAt),
    uniqueIndex('invitations_token_hash_key').on(t.tokenHash),
  ],
);

/**
 * Append-only audit trail. The app role may INSERT and SELECT, never UPDATE or DELETE, and a
 * trigger blocks changes for every role. Platform-level events have a NULL tenant_id, so only
 * the platform role can see them.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    impersonatorId: uuid('impersonator_id'),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    diff: jsonb('diff').$type<Record<string, unknown>>(),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('audit_log_tenant_action_idx').on(t.tenantId, t.action),
  ],
);
