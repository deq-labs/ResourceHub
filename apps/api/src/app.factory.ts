import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import { TenantResolverService } from './modules/tenants/tenant-resolver.service.js';

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: config.TRUST_PROXY,
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    adapter,
    {
      logger: config.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'],
      bufferLogs: false,
    },
  );
  app.setGlobalPrefix('api/v1');

  // Layer 1 of isolation: resolve the tenant from Host before routing, guards or auth.
  const resolver = app.get(TenantResolverService);
  const fastify = app.getHttpAdapter().getInstance();
  // Decorated with null up front so Fastify keeps a stable request shape; set in onRequest.
  fastify.decorateRequest('site', null as never);
  fastify.addHook('onRequest', async (req, reply) => {
    req.site = await resolver.resolve(req.host);
    void reply.header('x-request-id', req.id);
  });

  await app.init();
  return app;
}
