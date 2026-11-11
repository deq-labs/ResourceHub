import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { TenantScopedCache } from './tenant-cache.js';

const A = '01960000-0000-7000-8000-00000000c001';
const B = '01960000-0000-7000-8000-00000000a001';

describe('TenantScopedCache', () => {
  it('always puts the tenant id in the key', () => {
    expect(TenantScopedCache.key(A, 'branding')).toBe(`t:${A}:branding`);
    expect(TenantScopedCache.key(A, 'branding')).not.toBe(TenantScopedCache.key(B, 'branding'));
  });

  it('refuses keys without a valid tenant id', () => {
    expect(() => TenantScopedCache.key('', 'branding')).toThrow();
    expect(() => TenantScopedCache.key('contoso', 'branding')).toThrow();
    expect(() => TenantScopedCache.key(A, '')).toThrow();
  });

  it('reads and writes through the namespaced key', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      set: vi.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve('OK');
      }),
      del: vi.fn(),
    } as unknown as Redis;
    const cache = new TenantScopedCache(redis);
    await cache.set(A, 'branding', { color: 'blue' }, 60);
    expect(await cache.get(A, 'branding')).toEqual({ color: 'blue' });
    expect(await cache.get(B, 'branding')).toBeUndefined();
    expect([...store.keys()]).toEqual([`t:${A}:branding`]);
  });
});
