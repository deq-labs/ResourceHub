import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory.js';
import { loadConfig } from '../../src/config.js';

describe('Front Door origin lock-down (FRONT_DOOR_ID)', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createApp(loadConfig({ NODE_ENV: 'test', FRONT_DOOR_ID: 'fd-guid-123' }));
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('rejects requests that did not come through our Front Door profile', async () => {
    const direct = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant',
      headers: { host: 'localhost' },
    });
    expect(direct.statusCode).toBe(403);
    const otherProfile = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant',
      headers: { host: 'localhost', 'x-azure-fdid': 'someone-else' },
    });
    expect(otherProfile.statusCode).toBe(403);
  });

  it('lets health probes through and passes Front Door traffic on to routing', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    const viaEdge = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant',
      headers: { host: 'localhost', 'x-azure-fdid': 'fd-guid-123' },
    });
    expect(viaEdge.statusCode).toBe(404); // reached tenant resolution: bare root domain is not a tenant
  });
});
