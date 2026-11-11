import type { TestProject } from 'vitest/node';
import { RedisContainer } from '@testcontainers/redis';
import { seedDemo } from '@resourcehub/db';
import { startTestDatabase, type TestDatabaseUrls } from '@resourcehub/db/testing';
import { apiSeedSteps } from '../src/seed-steps.js';

declare module 'vitest' {
  export interface ProvidedContext {
    db: TestDatabaseUrls;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const [db, redis] = await Promise.all([
    startTestDatabase(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  await seedDemo(db.urls.platform, apiSeedSteps);
  project.provide('db', db.urls);
  project.provide('redisUrl', redis.getConnectionUrl());
  return async () => {
    await Promise.all([db.stop(), redis.stop()]);
  };
}
