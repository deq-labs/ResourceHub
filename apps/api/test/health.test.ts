import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../src/app.factory.js';
import { loadConfig } from '../src/config.js';

describe('GET /api/v1/health', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp(loadConfig({ NODE_ENV: 'test' }));
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});
