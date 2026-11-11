import type { TestProject } from 'vitest/node';
import { startTestDatabase, type TestDatabaseUrls } from '../src/testing.js';
import { seedDemo } from '../src/seed/seed.js';
import { contentSeedSteps } from '../src/seed/steps.js';

declare module 'vitest' {
  export interface ProvidedContext {
    db: TestDatabaseUrls;
  }
}

export default async function setup(project: TestProject) {
  const db = await startTestDatabase();
  await seedDemo(db.urls.platform, contentSeedSteps);
  project.provide('db', db.urls);
  return async () => {
    await db.stop();
  };
}
