import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import { TenantResolverService } from './modules/tenants/tenant-resolver.service.js';
import { REDIS } from './tokens.js';

type RouteTier = { rateTier?: string };

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
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
      // Throw DI errors instead of process.exit(), so tests and the CLI see the real cause.
      abortOnError: false,
    },
  );
  app.setGlobalPrefix('api/v1');

  // Security headers. The API only serves JSON, so its CSP denies everything.
  // (The dev IdP's HTML page sets its own narrow CSP.)
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(fastifyCookie);

  // Per-IP limits backed by Redis (shared across replicas); auth endpoints get a tighter tier.
  const redis = app.get<Redis>(REDIS);
  const tier = (req: { routeOptions: { config: unknown } }) =>
    (req.routeOptions.config as RouteTier).rateTier ?? 'default';
  await app.register(fastifyRateLimit, {
    redis,
    nameSpace: 'rl:ip:',
    timeWindow: '1 minute',
    max: (req) =>
      tier(req) === 'auth'
        ? config.RATE_LIMIT_AUTH_PER_MINUTE
        : config.RATE_LIMIT_PER_IP_PER_MINUTE,
    keyGenerator: (req) => `${tier(req)}:${req.ip}`,
    skipOnError: true,
    errorResponseBuilder: (_req, ctx) => ({
      type: 'https://resourcehub.dev/problems/rate-limited',
      title: 'Too Many Requests',
      status: ctx.statusCode,
      detail: `Rate limit exceeded. Retry in ${ctx.after}.`,
    }),
  });

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
