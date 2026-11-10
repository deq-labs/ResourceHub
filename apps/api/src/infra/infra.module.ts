import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, REDIS } from '../tokens.js';
import type { AppConfig } from '../config.js';
import { DbService } from './db.service.js';
import { TenantScopedCache } from './tenant-cache.js';
import { MailService } from './mail.service.js';
import { StorageService } from './storage.service.js';
import { QueueService } from './queue.service.js';

const logger = new Logger('Redis');

@Global()
@Module({
  providers: [
    DbService,
    MailService,
    StorageService,
    QueueService,
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
        // Callers degrade gracefully when Redis is down; log instead of crashing on error.
        redis.on('error', (err: Error) => {
          logger.warn(`redis: ${err.message}`);
        });
        return redis;
      },
    },
    {
      provide: TenantScopedCache,
      inject: [REDIS],
      useFactory: (redis: Redis) => new TenantScopedCache(redis),
    },
  ],
  exports: [DbService, REDIS, TenantScopedCache, MailService, StorageService, QueueService],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => undefined);
  }
}
