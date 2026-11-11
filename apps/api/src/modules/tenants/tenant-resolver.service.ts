import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from '@resourcehub/db';
import type { Redis } from 'ioredis';
import { DbService } from '../../infra/db.service.js';
import { APP_CONFIG, REDIS } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import type { ResolvedTenant, Site } from '../../common/site.js';

const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NEGATIVE_TTL_SECONDS = 30;
const RESERVED_SLUGS = new Set(['admin', 'www', 'api', 'app', 'static', 'cdn', 'mail']);

export const hostCacheKey = (hostname: string) => `host:${hostname}`;

/**
 * Layer 1 of tenant isolation: map the Host header to exactly one tenant.
 * `{slug}.{ROOT_DOMAIN}` or a *verified* custom domain; cached in Redis for 5 minutes.
 */
@Injectable()
export class TenantResolverService {
  private readonly logger = new Logger(TenantResolverService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly db: DbService,
  ) {}

  static isReservedSlug(slug: string): boolean {
    return RESERVED_SLUGS.has(slug);
  }

  normalizeHost(rawHost: string | undefined): string | null {
    if (!rawHost) return null;
    const host = rawHost.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    return HOSTNAME_RE.test(host) ? host : null;
  }

  async resolve(rawHost: string | undefined): Promise<Site> {
    const host = this.normalizeHost(rawHost);
    if (!host) return { kind: 'none', host: rawHost ?? '' };
    if (host === this.config.PLATFORM_HOST) return { kind: 'platform', host };
    if (host === this.config.ROOT_DOMAIN) return { kind: 'none', host };

    const tenant = await this.lookup(host);
    return tenant ? { kind: 'tenant', tenant, host } : { kind: 'none', host };
  }

  async invalidate(hostname: string): Promise<void> {
    await this.redis.del(hostCacheKey(hostname.toLowerCase()));
  }

  private async lookup(host: string): Promise<ResolvedTenant | null> {
    const key = hostCacheKey(host);
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) return JSON.parse(cached) as ResolvedTenant | null;
    } catch (err) {
      // Cache is an optimisation; resolution still works (slower) if Redis is down.
      this.logger.warn({ err }, 'tenant host cache read failed');
    }

    const suffix = `.${this.config.ROOT_DOMAIN}`;
    const label = host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
    const slug = label && !label.includes('.') && !RESERVED_SLUGS.has(label) ? label : null;

    const tenant = await this.db.withAppConnection(async (db) => {
      const result = await db.execute<{ id: string; slug: string; name: string; status: string }>(
        sql`select id, slug, name, status from app_resolve_tenant(${slug}, ${slug ? null : host})`,
      );
      const row = result.rows[0];
      return row
        ? ({ id: row.id, slug: row.slug, name: row.name, status: row.status } as ResolvedTenant)
        : null;
    });

    try {
      await this.redis.set(
        key,
        JSON.stringify(tenant),
        'EX',
        tenant ? this.config.TENANT_HOST_CACHE_TTL_SECONDS : NEGATIVE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn({ err }, 'tenant host cache write failed');
    }
    return tenant;
  }
}
