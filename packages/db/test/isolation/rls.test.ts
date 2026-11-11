// DB-level tenant isolation. These tests gate merging: never weaken or skip them.
import { afterAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../../src/database.js';
import { runWithTenant } from '../../src/context.js';
import { checkRlsCoverage } from '../../src/rls-check.js';
import * as schema from '../../src/schema/index.js';
import { DEMO_TENANTS, DEMO_USERS } from '../../src/seed/demo-data.js';

const urls = inject('db');
const db = createDatabase({ appUrl: urls.app, platformUrl: urls.platform, poolMax: 4 });
const A = DEMO_TENANTS.contoso;
const B = DEMO_TENANTS.northwind;
const asTenant = <T>(tenantId: string, fn: () => Promise<T>) => runWithTenant({ tenantId }, fn);

/** Drizzle wraps driver errors; the RLS denial is SQLSTATE 42501 on the cause. */
async function expectRlsViolation(p: Promise<unknown>): Promise<void> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  expect(cause?.code).toBe('42501');
  expect(cause?.message).toMatch(/row-level security/);
}

afterAll(async () => {
  await db.close();
});

async function rawAsApp<T extends pg.QueryResultRow>(sqlText: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: urls.app });
  await client.connect();
  try {
    return await client.query<T>(sqlText, params);
  } finally {
    await client.end();
  }
}

describe('RLS coverage', () => {
  it('every table has RLS enabled + forced + a tenant policy + a tenant_id-leading index', async () => {
    expect(await checkRlsCoverage(urls.migrator)).toEqual([]);
  });

  it('the app role cannot bypass RLS and owns no tables', async () => {
    const { rows } = await rawAsApp<{ rolbypassrls: boolean; owned: number }>(`
      SELECT r.rolbypassrls,
             (SELECT count(*)::int FROM pg_tables t WHERE t.tableowner = current_user) AS owned
        FROM pg_roles r WHERE r.rolname = current_user`);
    expect(rows[0]).toEqual({ rolbypassrls: false, owned: 0 });
  });
});

describe('raw queries as resourcehub_app with no tenant set', () => {
  for (const table of [
    'tenants',
    'tenant_domains',
    'memberships',
    'users',
    'sessions',
    'invitations',
    'audit_log',
  ]) {
    it(`${table} returns zero rows`, async () => {
      const { rows } = await rawAsApp<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0]?.n).toBe(0);
    });
  }

  it('still returns zero rows on a pooled connection that previously had a tenant set', async () => {
    const client = new pg.Client({ connectionString: urls.app });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [A.id]);
      const inside = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM memberships',
      );
      expect(inside.rows[0]?.n).toBeGreaterThan(0);
      await client.query('COMMIT');
      // The GUC is now '' (not NULL) on this connection. NULLIF() keeps that from erroring or matching.
      const after = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM memberships');
      expect(after.rows[0]?.n).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('withTenantTx()', () => {
  it('only sees the current tenant', async () => {
    const seen = await asTenant(A.id, () =>
      db.withTenantTx(async (tx) => tx.select().from(schema.tenants)),
    );
    expect(seen.map((t) => t.slug)).toEqual(['contoso']);
  });

  it("cannot read another tenant's memberships even when filtering by its id", async () => {
    const rows = await asTenant(A.id, () =>
      db.withTenantTx((tx) =>
        tx.select().from(schema.memberships).where(eq(schema.memberships.tenantId, B.id)),
      ),
    );
    expect(rows).toEqual([]);
  });

  it("cannot count another tenant's rows", async () => {
    const [aCount, bCount] = await Promise.all([
      asTenant(A.id, () =>
        db.withTenantTx(async (tx) => (await tx.select().from(schema.memberships)).length),
      ),
      asTenant(B.id, () =>
        db.withTenantTx(async (tx) => (await tx.select().from(schema.memberships)).length),
      ),
    ]);
    const expectedA = DEMO_USERS.filter((u) => u.memberships.some((m) => m.tenant === 'contoso'));
    const expectedB = DEMO_USERS.filter((u) => u.memberships.some((m) => m.tenant === 'northwind'));
    expect(aCount).toBe(expectedA.length);
    expect(bCount).toBe(expectedB.length);
  });

  it('cannot insert a row for another tenant (WITH CHECK)', async () => {
    const nora = DEMO_USERS.find((u) => u.oid === 'dev-nora')!;
    await expectRlsViolation(
      asTenant(A.id, () =>
        db.withTenantTx((tx) =>
          tx.insert(schema.memberships).values({ tenantId: B.id, userId: nora.id, role: 'viewer' }),
        ),
      ),
    );
  });

  it("cannot update or delete another tenant's rows", async () => {
    const result = await asTenant(A.id, () =>
      db.withTenantTx(async (tx) => {
        const updated = await tx
          .update(schema.memberships)
          .set({ role: 'owner' })
          .where(eq(schema.memberships.tenantId, B.id))
          .returning();
        const deleted = await tx
          .delete(schema.memberships)
          .where(eq(schema.memberships.tenantId, B.id))
          .returning();
        return { updated: updated.length, deleted: deleted.length };
      }),
    );
    expect(result).toEqual({ updated: 0, deleted: 0 });
  });

  it('cannot move a row into another tenant', async () => {
    await expectRlsViolation(
      asTenant(A.id, () =>
        db.withTenantTx((tx) =>
          tx
            .update(schema.memberships)
            .set({ tenantId: B.id })
            .where(eq(schema.memberships.tenantId, A.id)),
        ),
      ),
    );
  });

  it('only exposes users who are members of the current tenant', async () => {
    const visible = await asTenant(B.id, () =>
      db.withTenantTx(async (tx) => (await tx.select().from(schema.users)).map((u) => u.email)),
    );
    expect(visible.sort()).toEqual([
      'ned@northwind.example',
      'nora@northwind.example',
      'sam@consultant.example',
    ]);
  });

  it('nested calls join the same transaction', async () => {
    const ids = await asTenant(A.id, () =>
      db.withTenantTx(async (outer) => {
        const a = await outer.execute<{ txid: string }>('SELECT txid_current()::text AS txid');
        const b = await db.withTenantTx((inner) =>
          inner.execute<{ txid: string }>('SELECT txid_current()::text AS txid'),
        );
        return [a.rows[0]?.txid, b.rows[0]?.txid];
      }),
    );
    expect(ids[0]).toBe(ids[1]);
  });

  it('throws without a tenant context', async () => {
    await expect(db.withTenantTx(() => Promise.resolve(1))).rejects.toThrow(/No tenant context/);
  });
});

describe('app_resolve_tenant()', () => {
  it('resolves a slug before any tenant context exists', async () => {
    const { rows } = await rawAsApp<{ slug: string }>(
      'SELECT slug FROM app_resolve_tenant($1, NULL)',
      ['contoso'],
    );
    expect(rows).toEqual([{ slug: 'contoso' }]);
  });

  it('ignores custom domains that are not verified', async () => {
    await db.withPlatformTx({ actorId: null, action: 'test.setup' }, (tx) =>
      tx.insert(schema.tenantDomains).values([
        {
          tenantId: A.id,
          hostname: 'docs.contoso.test',
          verificationToken: 't1',
          verifiedAt: new Date(),
        },
        { tenantId: B.id, hostname: 'pending.northwind.test', verificationToken: 't2' },
      ]),
    );
    const verified = await rawAsApp('SELECT slug FROM app_resolve_tenant(NULL, $1)', [
      'docs.contoso.test',
    ]);
    const pending = await rawAsApp('SELECT slug FROM app_resolve_tenant(NULL, $1)', [
      'pending.northwind.test',
    ]);
    expect(verified.rows).toEqual([{ slug: 'contoso' }]);
    expect(pending.rows).toEqual([]);
  });

  it('is the only cross-tenant path: the app role cannot read tenants directly', async () => {
    const { rows } = await rawAsApp('SELECT slug FROM tenants');
    expect(rows).toEqual([]);
  });
});

describe('audit_log is append-only', () => {
  it('the app role can insert and read its own tenant rows, but cannot update or delete', async () => {
    await asTenant(A.id, () =>
      db.withTenantTx((tx) =>
        tx.insert(schema.auditLog).values({ tenantId: A.id, action: 'test.event' }),
      ),
    );
    const mine = await asTenant(A.id, () =>
      db.withTenantTx((tx) => tx.select().from(schema.auditLog)),
    );
    expect(mine.some((r) => r.action === 'test.event')).toBe(true);
    const theirs = await asTenant(B.id, () =>
      db.withTenantTx((tx) => tx.select().from(schema.auditLog)),
    );
    expect(theirs.some((r) => r.action === 'test.event')).toBe(false);

    const err = await asTenant(A.id, () =>
      db.withTenantTx((tx) => tx.update(schema.auditLog).set({ action: 'tampered' })),
    ).catch((e: unknown) => e);
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('42501');
  });

  it('even the platform role cannot rewrite history', async () => {
    const err = await db
      .withPlatformTx({ actorId: null, action: 'test.tamper' }, (tx) =>
        tx.delete(schema.auditLog).where(eq(schema.auditLog.action, 'test.event')),
      )
      .catch((e: unknown) => e);
    expect(String((err as { cause?: Error }).cause?.message)).toMatch(/append-only/);
  });
});

describe('login lookups', () => {
  it('app_user_memberships lists every tenant for a multi-tenant user without a tenant context', async () => {
    const sam = DEMO_USERS.find((u) => u.oid === 'dev-sam')!;
    const { rows } = await rawAsApp<{ slug: string; role: string }>(
      'SELECT slug, role FROM app_user_memberships($1)',
      [sam.id],
    );
    expect(rows).toEqual([
      { slug: 'contoso', role: 'viewer' },
      { slug: 'northwind', role: 'admin' },
    ]);
  });

  it('platform_sessions are invisible to the app role', async () => {
    const res = await rawAsApp('SELECT * FROM platform_sessions').catch((e: unknown) => e);
    expect((res as { code?: string }).code).toBe('42501');
  });
});
