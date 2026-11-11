import 'reflect-metadata';
import { inject } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../src/app.factory.js';
import { loadConfig, type AppConfig } from '../src/config.js';

export const HOSTS = {
  contoso: 'contoso.localhost',
  northwind: 'northwind.localhost',
  platform: 'admin.localhost',
  unknown: 'nobody.localhost',
} as const;

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  const db = inject('db');
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL_APP: db.app,
    DATABASE_URL_PLATFORM: db.platform,
    REDIS_URL: inject('redisUrl'),
    DB_POOL_MAX: '4',
    ...overrides,
  });
}

export async function createTestApp(overrides: Record<string, string> = {}) {
  const app = await createApp(testConfig(overrides));
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export type TestApp = NestFastifyApplication;
type InjectOptions = Exclude<Parameters<TestApp['inject']>[0], string | undefined>;
export type TestResponse = Awaited<ReturnType<TestApp['inject']>>;

/** Fire a request at a given host, optionally with a bearer token. */
export function request(
  app: TestApp,
  opts: {
    host: string;
    method?: InjectOptions['method'];
    url: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  },
): Promise<TestResponse> {
  return app.inject({
    method: opts.method ?? 'GET',
    url: opts.url,
    headers: {
      host: opts.host,
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.cookies ? { cookies: opts.cookies } : {}),
    ...(opts.body !== undefined ? { payload: opts.body as InjectOptions['payload'] } : {}),
  });
}
