import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import { trace } from '@opentelemetry/api';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import { TenantResolverService } from './modules/tenants/tenant-resolver.service.js';
import { REDIS } from './tokens.js';

type RouteTier = { rateTier?: string };

/** Constant-time comparison of a header against a secret (hashing equalises the lengths). */
function safeEqual(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(header), digest(secret));
}

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    // Structured JSON request logs (pino), correlated with the active OpenTelemetry trace.
    // Credentials never reach the logs.
    logger:
      config.NODE_ENV === 'test' || config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                'req.query.ticket',
                'req.query.token',
                'req.query.code',
              ],
              censor: '[redacted]',
            },
            mixin() {
              const ctx = trace.getActiveSpan()?.spanContext();
              return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
            },
          },
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
    // Origin lock-down: only our edge may reach the API. Azure Front Door stamps X-Azure-FDID;
    // other edges (the free Vercel deployment) stamp a shared X-Edge-Secret.
    const viaFrontDoor =
      !config.FRONT_DOOR_ID || req.headers['x-azure-fdid'] === config.FRONT_DOOR_ID;
    const viaEdgeSecret =
      !config.EDGE_SECRET || safeEqual(req.headers['x-edge-secret'], config.EDGE_SECRET);
    if ((!viaFrontDoor || !viaEdgeSecret) && !req.url.startsWith('/api/v1/health')) {
      return reply.code(403).header('content-type', 'application/problem+json').send({
        type: 'https://resourcehub.dev/problems/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'Requests must come through the edge.',
      });
    }
    req.site = await resolver.resolve(req.host);
    if (req.site.kind === 'tenant') {
      // Every span and log line for this request can be filtered by tenant in App Insights.
      trace.getActiveSpan()?.setAttributes({
        'tenant.id': req.site.tenant.id,
        'tenant.slug': req.site.tenant.slug,
      });
    }
    void reply.header('x-request-id', req.id);
  });

  await app.init();
  return app;
}
