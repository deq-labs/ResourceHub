import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    new FastifyAdapter({ trustProxy: true }),
    { logger: config.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'] },
  );
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}
