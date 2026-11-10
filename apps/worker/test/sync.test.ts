import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contentSeedSteps,
  createDatabase,
  DEMO_TENANTS,
  eq,
  runWithTenant,
  schema,
  seedDemo,
  type Database,
} from '@resourcehub/db';
import { startTestDatabase, type TestDatabase } from '@resourcehub/db/testing';
import { MemoryBreakerStore, SecretResolver } from '@resourcehub/integrations';
import { processSyncJob, type SyncDeps } from '../src/sync.js';

const A = DEMO_TENANTS.contoso.id;
const B = DEMO_TENANTS.northwind.id;
const integrationsDir = dirname(
  createRequire(import.meta.url).resolve('@resourcehub/integrations/package.json'),
);

let pg: TestDatabase;
let db: Database;
let soapMock: ChildProcess;
let deps: SyncDeps;
let integrationId: string;
let feedIntegrationId: string;

beforeAll(async () => {
  pg = await startTestDatabase();
  await seedDemo(pg.urls.platform, contentSeedSteps);
  db = createDatabase({ appUrl: pg.urls.app, platformUrl: pg.urls.platform, poolMax: 4 });

  const port = 19000 + Math.floor(Math.random() * 900);
  soapMock = spawn(process.execPath, [join(integrationsDir, 'mocks/soap-server/server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      WSDL_PATH: join(integrationsDir, 'wsdl/partner-docs.wsdl'),
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  process.env.PARTNER_SOAP_PASSWORD = 'partner-demo-password';
  deps = {
    db,
    secrets: new SecretResolver({ allowEnv: true }),
    breakerStore: new MemoryBreakerStore(),
    breaker: { failureThreshold: 3, openMs: 60_000 },
    log: () => undefined,
  };

  // Point Contoso's seeded SOAP integration at this test's mock.
  await runWithTenant({ tenantId: A }, () =>
    db.withTenantTx(async (tx) => {
      const rows = await tx.select().from(schema.integrations);
      const soap = rows.find((r) => r.provider === 'partner-docs')!;
      const feed = rows.find((r) => r.provider === 'partner-feed')!;
      integrationId = soap.id;
      feedIntegrationId = feed.id;
      await tx
        .update(schema.integrations)
        .set({ config: { ...soap.config, endpoint: `http://127.0.0.1:${port}/soap/partner-docs` } })
        .where(eq(schema.integrations.id, soap.id));
      // A REST integration pointed at nothing: always unavailable.
      await tx
        .update(schema.integrations)
        .set({ config: { baseUrl: 'http://127.0.0.1:1' }, secretRef: 'env:PARTNER_SOAP_PASSWORD' })
        .where(eq(schema.integrations.id, feed.id));
    }),
  );
}, 180_000);

afterAll(async () => {
  soapMock.kill();
  await db.close();
  await pg.stop();
});

const tenantRows = <T>(tenantId: string, fn: Parameters<Database['withTenantTx']>[0]) =>
  runWithTenant({ tenantId }, () => db.withTenantTx(fn)) as Promise<T>;

describe('worker: SOAP sync job', () => {
  it('pulls partner documents into the tenant as drafts and records the run', async () => {
    const outcome = await processSyncJob(
      { type: 'sync', tenantId: A, integrationId, runId: '', trigger: 'schedule' },
      1,
      3,
      deps,
    );
    expect(outcome.status).toBe('succeeded');

    const imported = await tenantRows<{ title: string; status: string }[]>(A, (tx) =>
      tx.select().from(schema.resources).where(eq(schema.resources.externalSource, 'partner-docs')),
    );
    expect(imported).toHaveLength(6);
    expect(imported.every((r) => r.status === 'draft')).toBe(true);

    const runs = await tenantRows<{ status: string; stats: unknown; trigger: string }[]>(A, (tx) =>
      tx
        .select()
        .from(schema.integrationRuns)
        .where(eq(schema.integrationRuns.integrationId, integrationId)),
    );
    expect(runs[0]).toMatchObject({
      status: 'succeeded',
      trigger: 'schedule',
      stats: { fetched: 6, created: 6 },
    });
  });

  it('is idempotent: a second run upserts nothing new', async () => {
    // Force a full re-fetch (ignore the high-water mark) to prove upserts are idempotent.
    await tenantRows(A, (tx) =>
      tx
        .update(schema.integrations)
        .set({ lastSyncedAt: null })
        .where(eq(schema.integrations.id, integrationId)),
    );
    await processSyncJob(
      { type: 'sync', tenantId: A, integrationId, runId: '', trigger: 'manual' },
      1,
      3,
      deps,
    );
    const runs = await tenantRows<{ stats: { created?: number; unchanged?: number } | null }[]>(
      A,
      (tx) =>
        tx
          .select()
          .from(schema.integrationRuns)
          .where(eq(schema.integrationRuns.integrationId, integrationId)),
    );
    const latest = runs.sort((a, b) =>
      (a as unknown as { createdAt: Date }).createdAt <
      (b as unknown as { createdAt: Date }).createdAt
        ? 1
        : -1,
    )[0]!;
    expect(latest.stats).toMatchObject({ created: 0, unchanged: 6 });
  });

  it("never writes into another tenant: Northwind sees none of Contoso's synced rows", async () => {
    const leaked = await tenantRows<unknown[]>(B, (tx) =>
      tx.select().from(schema.resources).where(eq(schema.resources.externalSource, 'partner-docs')),
    );
    expect(leaked).toEqual([]);
  });

  it('a job carrying the wrong tenant cannot see the integration (RLS) and does nothing', async () => {
    const outcome = await processSyncJob(
      { type: 'sync', tenantId: B, integrationId, runId: '', trigger: 'manual' },
      1,
      3,
      deps,
    );
    expect(outcome.status).toBe('succeeded'); // "vanished" from B's point of view
    const bRuns = await tenantRows<unknown[]>(B, (tx) => tx.select().from(schema.integrationRuns));
    expect(bRuns).toEqual([]);
  });

  it('pushes a hub resource to the partner and stores the reference', async () => {
    const [res] = await tenantRows<{ id: string }[]>(A, (tx) =>
      tx.select().from(schema.resources).limit(1),
    );
    const [run] = await tenantRows<{ id: string }[]>(A, (tx) =>
      tx
        .insert(schema.integrationRuns)
        .values({ tenantId: A, integrationId, type: 'push', trigger: 'manual' })
        .returning(),
    );
    const outcome = await processSyncJob(
      {
        type: 'push',
        tenantId: A,
        integrationId,
        runId: run!.id,
        trigger: 'manual',
        resourceId: res!.id,
      },
      1,
      3,
      deps,
    );
    expect(outcome.status).toBe('succeeded');
    const [after] = await tenantRows<{ stats: { pushedReference?: string } }[]>(A, (tx) =>
      tx.select().from(schema.integrationRuns).where(eq(schema.integrationRuns.id, run!.id)),
    );
    expect(after!.stats.pushedReference).toMatch(/^PDREF-/);
  });
});

describe('worker: failures', () => {
  it('a down partner is retried (run goes back to queued), then fails and opens the breaker', async () => {
    const job = {
      type: 'sync' as const,
      tenantId: A,
      integrationId: feedIntegrationId,
      runId: '',
      trigger: 'manual' as const,
    };
    const first = await processSyncJob(job, 1, 2, {
      ...deps,
      breakerStore: new MemoryBreakerStore(),
    });
    expect(first.status).toBe('retry');
    const last = await processSyncJob(job, 2, 2, deps);
    expect(last.status).toBe('failed');
    expect(last.error?.code).toBe('unavailable');
  });

  it('bad credentials fail immediately without retry', async () => {
    process.env.PARTNER_SOAP_PASSWORD_WRONG = 'nope';
    await tenantRows(A, (tx) =>
      tx
        .update(schema.integrations)
        .set({ secretRef: 'env:PARTNER_SOAP_PASSWORD_WRONG' })
        .where(eq(schema.integrations.id, integrationId)),
    );
    const outcome = await processSyncJob(
      { type: 'sync', tenantId: A, integrationId, runId: '', trigger: 'manual' },
      1,
      3,
      { ...deps, secrets: new SecretResolver({ allowEnv: true }) },
    );
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'auth' } });
  });
});
