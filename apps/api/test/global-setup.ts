import type { TestProject } from 'vitest/node';
import { RedisContainer } from '@testcontainers/redis';
import { GenericContainer, Wait } from 'testcontainers';
import { contentSeedSteps, seedDemo } from '@resourcehub/db';
import { startTestDatabase, type TestDatabaseUrls } from '@resourcehub/db/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    db: TestDatabaseUrls;
    redisUrl: string;
    storageConnectionString: string;
  }
}

export default async function setup(project: TestProject) {
  const [db, redis, azurite] = await Promise.all([
    startTestDatabase(),
    new RedisContainer('redis:7-alpine').start(),
    new GenericContainer('mcr.microsoft.com/azure-storage/azurite:3.35.0')
      .withCommand(['azurite-blob', '--blobHost', '0.0.0.0', '--loose', '--skipApiVersionCheck'])
      .withExposedPorts(10000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);
  await seedDemo(db.urls.platform, contentSeedSteps);
  project.provide('db', db.urls);
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide(
    'storageConnectionString',
    `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://${azurite.getHost()}:${azurite.getMappedPort(10000)}/devstoreaccount1;`,
  );
  return async () => {
    await Promise.all([db.stop(), redis.stop(), azurite.stop()]);
  };
}
