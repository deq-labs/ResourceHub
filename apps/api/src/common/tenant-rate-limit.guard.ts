import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { APP_CONFIG, REDIS } from '../tokens.js';
import type { AppConfig } from '../config.js';
import { TenantScopedCache } from '../infra/tenant-cache.js';
import { ProblemException } from './problem.js';

/**
 * Per-tenant request budget (fixed one-minute window in Redis), on top of the per-IP limit from
 * @fastify/rate-limit. One noisy tenant can't starve the others.
 */
@Injectable()
export class TenantRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(TenantRateLimitGuard.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (req.site.kind !== 'tenant') return true;
    const minute = Math.floor(Date.now() / 60_000);
    const key = TenantScopedCache.key(req.site.tenant.id, `rl:${minute}`);
    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 61);
    } catch (err) {
      this.logger.warn({ err }, 'tenant rate limiter unavailable; allowing request');
      return true;
    }
    const limit = this.config.RATE_LIMIT_PER_TENANT_PER_MINUTE;
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    void reply
      .header('x-tenant-ratelimit-limit', limit)
      .header('x-tenant-ratelimit-remaining', Math.max(0, limit - count));
    if (count > limit) {
      void reply.header('retry-after', 60 - (Math.floor(Date.now() / 1000) % 60));
      throw new ProblemException(
        429,
        'rate-limited',
        'Too Many Requests',
        'This workspace is sending too many requests.',
      );
    }
    return true;
  }
}
