import 'reflect-metadata';
import { createApp } from './app.factory.js';
import { loadConfig } from './config.js';
import { StorageService } from './infra/storage.service.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  app.enableShutdownHooks();
  await app.get(StorageService).ensureReady();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

void bootstrap();
