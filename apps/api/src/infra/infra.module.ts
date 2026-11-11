import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, REDIS } from '../tokens.js';
import type { AppConfig } from '../config.js';
import { DbService } from './db.service.js';
import { TenantScopedCache } from './tenant-cache.js';
import { MailService } from './mail.service.js';
import { StorageService } from './storage.service.js';

@Global()
@Module({
  providers: [
    DbService,
    MailService,
    StorageService,
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 }),
    },
    {
      provide: TenantScopedCache,
      inject: [REDIS],
      useFactory: (redis: Redis) => new TenantScopedCache(redis),
    },
  ],
  exports: [DbService, REDIS, TenantScopedCache, MailService, StorageService],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => undefined);
  }
}
