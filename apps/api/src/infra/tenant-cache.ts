import type { Redis } from 'ioredis';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only cache API for tenant data. Every key is namespaced `t:{tenantId}:...`, so one
 * tenant can never read another tenant's cached value, even when the logical key is the same.
 */
export class TenantScopedCache {
  constructor(private readonly redis: Redis) {}

  static key(tenantId: string, key: string): string {
    if (!UUID_RE.test(tenantId)) throw new Error('TenantScopedCache requires a tenant id');
    if (!key) throw new Error('TenantScopedCache requires a key');
    return `t:${tenantId}:${key}`;
  }

  async get<T>(tenantId: string, key: string): Promise<T | undefined> {
    const raw = await this.redis.get(TenantScopedCache.key(tenantId, key));
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set(tenantId: string, key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      TenantScopedCache.key(tenantId, key),
      JSON.stringify(value),
      'EX',
      ttlSeconds,
    );
  }

  async del(tenantId: string, key: string): Promise<void> {
    await this.redis.del(TenantScopedCache.key(tenantId, key));
  }
}
