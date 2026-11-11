import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';
import { currentTenantContext, requireTenantContext } from './context.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface PlatformAuditEntry {
  /** The platform admin (or system job) acting across tenants. */
  actorId: string | null;
  action: string;
  reason?: string;
  /** Tenant the action touches, if any (NULL = platform-level event). */
  tenantId?: string | null;
  entity?: string;
  entityId?: string;
  diff?: Record<string, unknown>;
  ip?: string | null;
}

export type PlatformAuditSink = (tx: Tx, entry: PlatformAuditEntry) => Promise<void>;

export interface DatabaseOptions {
  /** Connection string for resourcehub_app (NOBYPASSRLS). */
  appUrl: string;
  /** Connection string for resourcehub_platform (BYPASSRLS). Optional for services that never need it. */
  platformUrl?: string;
  /** Max connections per pool, per replica. Keep (replicas x max) under the server limit. */
  poolMax?: number;
  /** Writes an audit row for every platform transaction. Wired by the API in Phase 2. */
  platformAudit?: PlatformAuditSink;
}

export interface Database {
  /**
   * Run `fn` in a transaction that starts with `SET LOCAL app.tenant_id` (and `app.user_id`).
   * RLS then filters every statement. Nested calls join the open transaction.
   */
  withTenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Cross-tenant work as resourcehub_platform (BYPASSRLS). Every call is audited.
   * Only the platform-admin module and cross-tenant jobs may use this.
   */
  withPlatformTx<T>(entry: PlatformAuditEntry, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Call a SECURITY DEFINER lookup function (host resolution, login) on the app pool. */
  withAppConnection<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDatabase(opts: DatabaseOptions): Database {
  const appPool = new pg.Pool({
    connectionString: opts.appUrl,
    max: opts.poolMax ?? 10,
    application_name: 'resourcehub-app',
  });
  const platformPool = opts.platformUrl
    ? new pg.Pool({
        connectionString: opts.platformUrl,
        max: Math.max(2, Math.floor((opts.poolMax ?? 10) / 4)),
        application_name: 'resourcehub-platform',
      })
    : undefined;

  const appDb = drizzle(appPool, { schema });
  const platformDb = platformPool ? drizzle(platformPool, { schema }) : undefined;

  return {
    async withTenantTx(fn) {
      const ctx = requireTenantContext();
      if (ctx.tx) return fn(ctx.tx);
      if (!UUID_RE.test(ctx.tenantId)) throw new Error('Tenant context holds an invalid id');

      return appDb.transaction(async (tx) => {
        // set_config(..., true) is SET LOCAL: scoped to this transaction only, so it is safe
        // with PgBouncer in transaction mode and never leaks to the next pooled request.
        await tx.execute(
          sql`select set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.user_id', ${ctx.userId ?? ''}, true)`,
        );
        ctx.tx = tx;
        try {
          return await fn(tx);
        } finally {
          ctx.tx = undefined;
        }
      });
    },

    async withPlatformTx(entry, fn) {
      if (!platformDb) throw new Error('Platform database is not configured for this process');
      if (currentTenantContext()?.tx) {
        throw new Error('withPlatformTx() cannot run inside a tenant transaction');
      }
      return platformDb.transaction(async (tx) => {
        if (opts.platformAudit) await opts.platformAudit(tx, entry);
        return fn(tx);
      });
    },

    async withAppConnection(fn) {
      return fn(appDb);
    },

    async ping() {
      await appPool.query('select 1');
    },

    async close() {
      await appPool.end();
      await platformPool?.end();
    },
  };
}
