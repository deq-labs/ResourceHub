import {
  and,
  eq,
  runWithTenant,
  schema,
  upsertExternalResource,
  type Database,
} from '@resourcehub/db';
import {
  CircuitBreaker,
  ExternalDocument,
  getProvider,
  IntegrationError,
  type BreakerState,
  type BreakerStore,
  type SecretResolver,
  type SyncJob,
} from '@resourcehub/integrations';
import type { Redis } from 'ioredis';

/** Breaker state in Redis so every worker replica agrees a partner is down. Keyed per tenant. */
export class RedisBreakerStore implements BreakerStore {
  constructor(private readonly redis: Redis) {}
  async get(key: string): Promise<BreakerState | undefined> {
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as BreakerState) : undefined;
  }
  async set(key: string, state: BreakerState): Promise<void> {
    await this.redis.set(key, JSON.stringify(state), 'EX', 24 * 3600);
  }
}

export interface SyncDeps {
  db: Database;
  secrets: SecretResolver;
  breakerStore: BreakerStore;
  breaker: { failureThreshold: number; openMs: number };
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface SyncOutcome {
  status: 'succeeded' | 'failed' | 'retry';
  error?: IntegrationError;
}

/** Re-sync a little before the last high-water mark so clock skew can't drop changes. */
const OVERLAP_MS = 5 * 60_000;
const BATCH = 25;

/**
 * Process one sync/push job for ONE tenant. The job payload carries tenantId; everything below
 * runs inside runWithTenant(), so each withTenantTx() is RLS-scoped to that tenant only.
 */
export async function processSyncJob(
  job: SyncJob,
  attempt: number,
  maxAttempts: number,
  deps: SyncDeps,
): Promise<SyncOutcome> {
  return runWithTenant({ tenantId: job.tenantId }, async () => {
    const { db } = deps;
    const i = schema.integrations;
    const runs = schema.integrationRuns;

    // Load the integration and claim (or, for scheduled jobs, create) the run row.
    const ctx = await db.withTenantTx(async (tx) => {
      const [integration] = await tx.select().from(i).where(eq(i.id, job.integrationId));
      if (!integration) return null;
      let runId = job.runId;
      if (!runId) {
        const [created] = await tx
          .insert(runs)
          .values({
            tenantId: job.tenantId,
            integrationId: integration.id,
            type: 'sync',
            trigger: 'schedule',
          })
          .returning({ id: runs.id });
        runId = created!.id;
      }
      const [run] = await tx
        .update(runs)
        .set({ status: 'running', startedAt: new Date(), attempts: attempt, error: null })
        .where(eq(runs.id, runId))
        .returning();
      return run ? { integration, run } : null;
    });
    if (!ctx) {
      deps.log('integration or run vanished; skipping', { ...job });
      return { status: 'succeeded' };
    }
    const { integration, run } = ctx;
    const startedAt = run.startedAt ?? new Date();

    const finish = (
      values: Partial<typeof runs.$inferInsert>,
      action: string,
      diff: Record<string, unknown>,
    ) =>
      db.withTenantTx(async (tx) => {
        await tx.update(runs).set(values).where(eq(runs.id, run.id));
        if (values.status === 'succeeded' && run.type === 'sync') {
          await tx
            .update(i)
            .set({ lastSyncedAt: new Date(startedAt.getTime() - OVERLAP_MS) })
            .where(eq(i.id, integration.id));
        }
        await tx.insert(schema.auditLog).values({
          tenantId: job.tenantId,
          actorId: job.requestedBy ?? null,
          action,
          entity: 'integration',
          entityId: integration.id,
          diff: { runId: run.id, ...diff },
        });
      });

    try {
      const def = getProvider(integration.provider);
      if (!def)
        throw new IntegrationError('config', `Unknown provider ${integration.provider}`, false);
      if (!integration.enabled)
        throw new IntegrationError('config', 'Integration is disabled', false);
      const secret = await deps.secrets.resolve(integration.secretRef);
      const cfg = { ...integration.config, ...(secret ? { secret } : {}) };
      const breaker = new CircuitBreaker(
        deps.breakerStore,
        `t:${job.tenantId}:cb:${integration.id}`,
        deps.breaker,
      );
      const adapter = def.create({ breaker });

      if (job.type === 'push') {
        const [res] = await db.withTenantTx((tx) =>
          tx
            .select()
            .from(schema.resources)
            .where(and(eq(schema.resources.id, job.resourceId ?? ''))),
        );
        if (!res) throw new IntegrationError('config', 'Resource no longer exists', false);
        const record = ExternalDocument.parse({
          externalId: `RH-${res.id}`,
          title: res.title,
          summary: res.summary ?? '',
          body: res.body.content,
          category: null,
          url: null,
          updatedAt: res.updatedAt,
        });
        const pushed = await adapter.push(cfg, record);
        if (!pushed.ok) throw pushed.error;
        await finish(
          { status: 'succeeded', finishedAt: new Date(), stats: { pushedReference: pushed.value } },
          'integration.push_completed',
          { resourceId: res.id, reference: pushed.value },
        );
        return { status: 'succeeded' };
      }

      const since = integration.lastSyncedAt ?? new Date(0);
      const stats = { fetched: 0, created: 0, updated: 0, unchanged: 0 };
      let batch: ExternalDocument[] = [];
      const flush = async () => {
        if (batch.length === 0) return;
        const items = batch;
        batch = [];
        await db.withTenantTx(async (tx) => {
          for (const rec of items)
            stats[await upsertExternalResource(tx, job.tenantId, integration.provider, rec)]++;
        });
      };
      for await (const rec of adapter.fetchChanges(cfg, since)) {
        stats.fetched++;
        batch.push(rec);
        if (batch.length >= BATCH) await flush();
      }
      await flush();
      await finish(
        { status: 'succeeded', finishedAt: new Date(), stats },
        'integration.sync_completed',
        stats,
      );
      deps.log('sync completed', {
        tenantId: job.tenantId,
        integrationId: integration.id,
        ...stats,
      });
      return { status: 'succeeded' };
    } catch (e) {
      const error =
        e instanceof IntegrationError
          ? e
          : new IntegrationError('unavailable', e instanceof Error ? e.message : String(e), true);
      const willRetry = error.retryable && attempt < maxAttempts;
      await finish(
        {
          status: willRetry ? 'queued' : 'failed',
          error: `${error.code}: ${error.message}`.slice(0, 500),
          ...(willRetry ? {} : { finishedAt: new Date() }),
        },
        willRetry ? 'integration.run_retrying' : 'integration.run_failed',
        { code: error.code, attempt },
      );
      deps.log('run failed', {
        tenantId: job.tenantId,
        integrationId: integration.id,
        code: error.code,
        willRetry,
      });
      return { status: willRetry ? 'retry' : 'failed', error };
    }
  });
}
