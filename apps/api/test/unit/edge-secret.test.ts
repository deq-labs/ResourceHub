import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory.js';
import { loadConfig } from '../../src/config.js';

const SECRET = 'edge-secret-0123456789abcdef0123456789abcdef';

describe('generic edge origin lock-down (EDGE_SECRET)', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createApp(loadConfig({ NODE_ENV: 'test', EDGE_SECRET: SECRET }));
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (headers: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/tenant',
      headers: { host: 'localhost', ...headers },
    });

  it('rejects requests without the secret, with a wrong one, or with a prefix of it', async () => {
    expect((await get({})).statusCode).toBe(403);
    expect((await get({ 'x-edge-secret': 'nope' })).statusCode).toBe(403);
    expect((await get({ 'x-edge-secret': SECRET.slice(0, -1) })).statusCode).toBe(403);
  });

  it('passes edge traffic on to routing and keeps health probes open', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect((await get({ 'x-edge-secret': SECRET })).statusCode).toBe(404); // reached tenant resolution
  });

  it('refuses a short secret at config time', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', EDGE_SECRET: 'short' })).toThrow();
  });
});
