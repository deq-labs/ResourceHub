import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tx } from './database.js';

/**
 * Per-request (or per-job) tenancy context. It lives in AsyncLocalStorage so services never
 * pass tenantId around by hand, and a nested withTenantTx() joins the open transaction.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string | null;
  /** Set while a tenant transaction is open; nested calls reuse it. */
  tx?: Tx;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(
  ctx: { tenantId: string; userId?: string | null },
  fn: () => T,
): T {
  return storage.run({ tenantId: ctx.tenantId, userId: ctx.userId ?? null }, fn);
}

export function currentTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error('No tenant context: wrap the call in runWithTenant() before using the DB');
  }
  return ctx;
}
