import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  createDatabase,
  type Database,
  type Db,
  type PlatformAuditEntry,
  type PlatformAuditSink,
  type Tx,
} from '@resourcehub/db';
import { APP_CONFIG } from '../tokens.js';
import type { AppConfig } from '../config.js';

/**
 * The only way API modules touch Postgres.
 * - withTenantTx(): RLS-scoped work for the tenant in the current request context.
 * - withPlatformTx(): audited cross-tenant work (platform admin module only).
 */
@Injectable()
export class DbService implements Database, OnModuleDestroy {
  private readonly db: Database;
  private auditSink: PlatformAuditSink | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.db = createDatabase({
      appUrl: config.DATABASE_URL_APP,
      platformUrl: config.DATABASE_URL_PLATFORM,
      poolMax: config.DB_POOL_MAX,
      platformAudit: (tx, entry) =>
        this.auditSink ? this.auditSink(tx, entry) : Promise.resolve(),
    });
  }

  /** Registered by the audit module so every platform transaction writes an audit row. */
  setPlatformAuditSink(sink: PlatformAuditSink): void {
    this.auditSink = sink;
  }

  withTenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withTenantTx(fn);
  }

  withPlatformTx<T>(entry: PlatformAuditEntry, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withPlatformTx(entry, fn);
  }

  withAppConnection<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.db.withAppConnection(fn);
  }

  ping(): Promise<void> {
    return this.db.ping();
  }

  close(): Promise<void> {
    return this.db.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.close();
  }
}
