// Layer 1: Host -> tenant resolution. These tests gate merging: never weaken or skip them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import { DEMO_TENANTS } from '@resourcehub/db';
import { DbService } from '../../src/infra/db.service.js';
import { hostCacheKey } from '../../src/modules/tenants/tenant-resolver.service.js';
import { schema } from '@resourcehub/db';
import { HOSTS, createTestApp, request, type TestApp } from '../helpers.js';

let app: TestApp;
let redis: Redis;

beforeAll(async () => {
  app = await createTestApp();
  redis = new Redis(inject('redisUrl'));
  await redis.flushall();
  const db = app.get(DbService);
  await db.withPlatformTx({ actorId: null, action: 'test.setup' }, (tx) =>
    tx.insert(schema.tenantDomains).values([
      {
        tenantId: DEMO_TENANTS.contoso.id,
        hostname: 'hub.contoso-pharma.test',
        verificationToken: 'x',
        verifiedAt: new Date(),
      },
      {
        tenantId: DEMO_TENANTS.northwind.id,
        hostname: 'unverified.northwind.test',
        verificationToken: 'y',
      },
    ]),
  );
});

afterAll(async () => {
  await redis.quit();
  await app.close();
});

describe('tenant resolution from Host', () => {
  it('resolves {slug}.localhost to that tenant', async () => {
    const res = await request(app, { host: HOSTS.contoso, url: '/api/v1/tenant' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: DEMO_TENANTS.contoso.id,
      slug: 'contoso',
      name: 'Contoso Pharma',
    });
  });

  it('ignores the port', async () => {
    const res = await request(app, { host: `${HOSTS.northwind}:5173`, url: '/api/v1/tenant' });
    expect(res.json()).toMatchObject({ slug: 'northwind' });
  });

  it('returns 404 problem+json for an unknown host, before any auth', async () => {
    const res = await request(app, { host: HOSTS.unknown, url: '/api/v1/tenant' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 404, title: 'Unknown host' });
    expect(res.json().traceId).toBeTruthy();
  });

  it('returns 404 for the bare root domain and the platform host on tenant routes', async () => {
    for (const host of ['localhost', HOSTS.platform]) {
      const res = await request(app, { host, url: '/api/v1/tenant' });
      expect(res.statusCode).toBe(404);
    }
  });

  it('rejects malformed hosts', async () => {
    const res = await request(app, { host: 'contoso.localhost\\@evil', url: '/api/v1/tenant' });
    expect(res.statusCode).toBe(404);
  });

  it('resolves a verified custom domain', async () => {
    const res = await request(app, { host: 'hub.contoso-pharma.test', url: '/api/v1/tenant' });
    expect(res.json()).toMatchObject({ slug: 'contoso' });
  });

  it('does not resolve a custom domain until it is verified', async () => {
    const res = await request(app, { host: 'unverified.northwind.test', url: '/api/v1/tenant' });
    expect(res.statusCode).toBe(404);
  });

  it('caches by hostname with a 300s TTL', async () => {
    await request(app, { host: HOSTS.contoso, url: '/api/v1/tenant' });
    const key = hostCacheKey(HOSTS.contoso);
    expect(JSON.parse((await redis.get(key))!)).toMatchObject({ id: DEMO_TENANTS.contoso.id });
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('health works on any host', async () => {
    const res = await request(app, { host: HOSTS.unknown, url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
  });
});
