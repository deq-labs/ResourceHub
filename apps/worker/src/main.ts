// ResourceHub worker: BullMQ consumers for integration syncs/pushes and outbound email.
import { createDatabase, eq, schema } from '@resourcehub/db';
import { QUEUES, SecretResolver, type EmailJob, type SyncJob } from '@resourcehub/integrations';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import nodemailer from 'nodemailer';
import { loadWorkerConfig, redisConnection } from './config.js';
import { processSyncJob, RedisBreakerStore } from './sync.js';

const config = loadWorkerConfig();
const tracer = trace.getTracer('resourcehub-worker');
const log = (msg: string, extra: Record<string, unknown> = {}) => {
  console.log(
    JSON.stringify({ level: 'info', time: new Date().toISOString(), svc: 'worker', msg, ...extra }),
  );
};

// The worker uses the app role (RLS applies) for tenant work, and the platform role only for the
// audited startup reconciliation of schedules, which is inherently cross-tenant.
const db = createDatabase({
  appUrl: config.DATABASE_URL_APP,
  platformUrl: config.DATABASE_URL_PLATFORM,
  poolMax: config.WORKER_CONCURRENCY + 2,
  platformAudit: async (tx, entry) => {
    await tx.insert(schema.auditLog).values({
      tenantId: entry.tenantId ?? null,
      actorId: entry.actorId,
      action: entry.action,
      diff: { ...(entry.diff ?? {}), platform: true, system: 'worker' },
    });
  },
});
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
const secrets = new SecretResolver({
  keyVaultUrl: config.KEY_VAULT_URL,
  allowEnv: config.NODE_ENV !== 'production',
});
const mailer = nodemailer.createTransport(config.SMTP_URL);
const connection = redisConnection(config.REDIS_URL);

const syncWorker = new Worker<SyncJob>(
  QUEUES.sync,
  async (job) => {
    const maxAttempts = job.opts.attempts ?? 1;
    // One span per run attempt, tagged with tenant + integration, parent of the HTTP/SOAP and
    // Postgres spans the auto-instrumentation records inside it.
    const outcome = await tracer.startActiveSpan(`integration.${job.data.type}`, async (span) => {
      span.setAttributes({
        'tenant.id': job.data.tenantId,
        'integration.id': job.data.integrationId,
        'integration.run_id': job.data.runId || 'scheduled',
        'integration.trigger': job.data.trigger,
        'messaging.system': 'bullmq',
        'job.attempt': job.attemptsMade + 1,
      });
      try {
        const result = await processSyncJob(job.data, job.attemptsMade + 1, maxAttempts, {
          db,
          secrets,
          breakerStore: new RedisBreakerStore(redis),
          breaker: {
            failureThreshold: config.BREAKER_FAILURE_THRESHOLD,
            openMs: config.BREAKER_OPEN_SECONDS * 1000,
          },
          log,
        });
        span.setAttribute('integration.outcome', result.status);
        if (result.error) {
          span.setAttribute('integration.error_code', result.error.code);
          span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.message });
        }
        return result;
      } finally {
        span.end();
      }
    });
    if (outcome.status === 'retry') throw outcome.error ?? new Error('retry'); // BullMQ backs off and retries
    if (outcome.status === 'failed')
      throw new UnrecoverableError(outcome.error?.message ?? 'failed');
  },
  { connection, concurrency: config.WORKER_CONCURRENCY },
);

const emailWorker = new Worker<EmailJob>(
  QUEUES.email,
  async (job) => {
    await mailer.sendMail({
      from: config.MAIL_FROM,
      to: job.data.to,
      subject: job.data.subject,
      text: job.data.text,
      html: job.data.html,
    });
    log('email sent', {
      tenantId: job.data.tenantId,
      to: job.data.to.replace(/^(.).*@/, '$1***@'),
    });
  },
  { connection, concurrency: 2 },
);

for (const w of [syncWorker, emailWorker]) {
  w.on('failed', (job, err) => {
    log('job failed', {
      queue: w.name,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err.message,
    });
  });
}

/** Re-register schedules for every enabled integration (e.g. after a Redis flush or a fresh seed). */
async function reconcileSchedules(): Promise<void> {
  const rows = await db.withPlatformTx(
    { actorId: null, action: 'platform.worker_schedules_reconciled' },
    (tx) =>
      tx
        .select({
          id: schema.integrations.id,
          tenantId: schema.integrations.tenantId,
          minutes: schema.integrations.scheduleMinutes,
        })
        .from(schema.integrations)
        .where(eq(schema.integrations.enabled, true)),
  );
  const queue = new Queue<SyncJob>(QUEUES.sync, { connection });
  for (const r of rows) {
    if (!r.minutes) continue;
    await queue.upsertJobScheduler(
      `schedule:${r.id}`,
      { every: r.minutes * 60_000 },
      {
        name: 'sync',
        data: {
          type: 'sync',
          tenantId: r.tenantId,
          integrationId: r.id,
          runId: '',
          trigger: 'schedule',
        },
      },
    );
  }
  await queue.close();
  log('schedules reconciled', { count: rows.filter((r) => r.minutes).length });
}

reconcileSchedules().catch((err: unknown) => {
  log('schedule reconcile failed', { error: String(err) });
});
log('worker started', { queues: Object.values(QUEUES), concurrency: config.WORKER_CONCURRENCY });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('shutting down', { signal });
  // Finish in-flight jobs (BullMQ waits for active jobs), then release connections.
  await Promise.allSettled([syncWorker.close(), emailWorker.close()]);
  await Promise.allSettled([db.close(), redis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
