import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { QUEUES, type EmailJob, type SyncJob } from '@resourcehub/integrations';
import { Queue } from 'bullmq';
import { APP_CONFIG } from '../tokens.js';
import type { AppConfig } from '../config.js';

const schedulerId = (integrationId: string) => `schedule:${integrationId}`;

/**
 * Producer side of BullMQ. The API never runs a sync inside a request: it records a run row and
 * enqueues a job that carries the tenantId; the worker opens its own withTenantTx() for it.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private sync?: Queue<SyncJob>;
  private email?: Queue<EmailJob>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private connection() {
    const u = new URL(this.config.REDIS_URL);
    return {
      host: u.hostname,
      port: Number(u.port || 6379),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
      lazyConnect: true,
    };
  }

  private syncQueue(): Queue<SyncJob> {
    this.sync ??= new Queue<SyncJob>(QUEUES.sync, {
      connection: this.connection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
    return this.sync;
  }

  private emailQueue(): Queue<EmailJob> {
    this.email ??= new Queue<EmailJob>(QUEUES.email, {
      connection: this.connection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 1000,
      },
    });
    return this.email;
  }

  async enqueueSync(job: SyncJob): Promise<void> {
    // jobId = runId: a retried HTTP request can't enqueue the same run twice.
    await this.syncQueue().add(job.type, job, { jobId: job.runId });
  }

  async upsertSchedule(tenantId: string, integrationId: string, minutes: number): Promise<void> {
    await this.syncQueue().upsertJobScheduler(
      schedulerId(integrationId),
      { every: minutes * 60_000 },
      {
        name: 'sync',
        data: { type: 'sync', tenantId, integrationId, runId: '', trigger: 'schedule' },
      },
    );
  }

  async removeSchedule(integrationId: string): Promise<void> {
    await this.syncQueue().removeJobScheduler(schedulerId(integrationId));
  }

  async enqueueEmail(job: EmailJob): Promise<void> {
    await this.emailQueue().add('send', job);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.sync?.close(), this.email?.close()]);
  }
}
