import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';
import { tenants, users } from './tenancy.js';

export const INTEGRATION_KINDS = ['rest', 'soap'] as const;
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunStats {
  fetched?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  pushedReference?: string;
}

/** A configured connection to an outside system. `secret_ref` names a secret; never holds one. */
export const integrations = pgTable(
  'integrations',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: INTEGRATION_KINDS }).notNull(),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    secretRef: text('secret_ref'),
    enabled: boolean('enabled').notNull().default(true),
    scheduleMinutes: integer('schedule_minutes'),
    /** High-water mark for incremental syncs. */
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('integrations_tenant_idx').on(t.tenantId, t.createdAt),
    uniqueIndex('integrations_tenant_id_key').on(t.tenantId, t.id),
  ],
);

/** Sync / push history. One row per BullMQ job; written by the worker inside the tenant's RLS. */
export const integrationRuns = pgTable(
  'integration_runs',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    integrationId: uuid('integration_id').notNull(),
    type: text('type', { enum: ['sync', 'push'] })
      .notNull()
      .default('sync'),
    trigger: text('trigger', { enum: ['manual', 'schedule'] }).notNull(),
    status: text('status', { enum: RUN_STATUSES }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    stats: jsonb('stats').$type<RunStats>(),
    error: text('error'),
    traceId: text('trace_id'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('integration_runs_tenant_integration_idx').on(t.tenantId, t.integrationId, t.createdAt),
  ],
);
