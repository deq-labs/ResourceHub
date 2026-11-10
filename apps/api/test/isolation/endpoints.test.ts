// "For every endpoint, A's token on A's host can't see, change or count B's rows."
// This suite gates merging: never weaken or skip it. A new route without an entry below fails
// the coverage test at the bottom, so isolation is considered for every endpoint by construction.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TENANTS, eq, newId, schema } from '@resourcehub/db';
import { DbService } from '../../src/infra/db.service.js';
import { buildOpenApi } from '../../src/openapi.js';
import { HOSTS, request, type TestApp } from '../helpers.js';
import { createListeningApp, signIn, type Session } from '../auth-helpers.js';

const B = DEMO_TENANTS.northwind.id;

let app: TestApp;
let a: Session; // Contoso owner: highest privilege in tenant A
const bIds: Record<string, string> = {};
const bMarkers: string[] = [];

beforeAll(async () => {
  app = await createListeningApp();
  a = await signIn(app, HOSTS.contoso, { oid: 'dev-olivia' });
  const db = app.get(DbService);
  // Collect real ids from tenant B (and plant a file, domain and invitation there).
  await db.withPlatformTx(
    { actorId: null, action: 'test.isolation_fixture', tenantId: B },
    async (tx) => {
      const [res] = await tx
        .select()
        .from(schema.resources)
        .where(eq(schema.resources.tenantId, B))
        .limit(1);
      const [cat] = await tx
        .select()
        .from(schema.categories)
        .where(eq(schema.categories.tenantId, B))
        .limit(1);
      const [tag] = await tx.select().from(schema.tags).where(eq(schema.tags.tenantId, B)).limit(1);
      const fileId = newId();
      await tx.insert(schema.files).values({
        id: fileId,
        tenantId: B,
        resourceId: res!.id,
        blobPath: `tenants/${B}/files/${fileId}/secret.pdf`,
        filename: 'northwind-secret.pdf',
        mime: 'application/pdf',
        size: 10,
        status: 'ready',
      });
      const [dom] = await tx
        .insert(schema.tenantDomains)
        .values({ tenantId: B, hostname: 'isolation.northwind.test', verificationToken: 'zzz' })
        .returning();
      const [inv] = await tx
        .insert(schema.invitations)
        .values({
          tenantId: B,
          email: 'b-secret@northwind.example',
          role: 'viewer',
          tokenHash: 'h'.repeat(64),
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning();
      Object.assign(bIds, {
        resource: res!.id,
        resourceSlug: res!.slug,
        category: cat!.id,
        tag: tag!.id,
        file: fileId,
        domain: dom!.id,
        invitation: inv!.id,
      });
      bMarkers.push(
        res!.id,
        res!.title,
        cat!.id,
        cat!.name,
        tag!.id,
        fileId,
        'northwind-secret.pdf',
        dom!.id,
        'isolation.northwind.test',
        inv!.id,
        'b-secret@northwind.example',
        'Northwind',
      );
    },
  );
});
afterAll(async () => {
  await app.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
interface Case {
  method: Method;
  /** OpenAPI path template, e.g. /api/v1/resources/{id} */
  route: string;
  url: () => string;
  body?: () => unknown;
  /** Acceptable statuses when A targets B's data. */
  expect: number[];
}

const cases: Case[] = [
  // reads that list or count: must contain nothing from B
  {
    method: 'GET',
    route: '/api/v1/resources',
    url: () => '/api/v1/resources?limit=100',
    expect: [200],
  },
  { method: 'GET', route: '/api/v1/categories', url: () => '/api/v1/categories', expect: [200] },
  { method: 'GET', route: '/api/v1/tags', url: () => '/api/v1/tags', expect: [200] },
  { method: 'GET', route: '/api/v1/invitations', url: () => '/api/v1/invitations', expect: [200] },
  { method: 'GET', route: '/api/v1/domains', url: () => '/api/v1/domains', expect: [200] },
  { method: 'GET', route: '/api/v1/me', url: () => '/api/v1/me', expect: [200] },
  { method: 'GET', route: '/api/v1/branding', url: () => '/api/v1/branding', expect: [200] },
  { method: 'GET', route: '/api/v1/tenant', url: () => '/api/v1/tenant', expect: [200] },
  // direct reads of B's ids
  {
    method: 'GET',
    route: '/api/v1/resources/{idOrSlug}',
    url: () => `/api/v1/resources/${bIds.resource}`,
    expect: [404],
  },
  {
    method: 'GET',
    route: '/api/v1/files/{id}/download',
    url: () => `/api/v1/files/${bIds.file}/download`,
    expect: [404],
  },
  // writes against B's ids
  {
    method: 'PATCH',
    route: '/api/v1/resources/{id}',
    url: () => `/api/v1/resources/${bIds.resource}`,
    body: () => ({ title: 'pwned by A' }),
    expect: [404],
  },
  {
    method: 'DELETE',
    route: '/api/v1/resources/{id}',
    url: () => `/api/v1/resources/${bIds.resource}`,
    expect: [404],
  },
  {
    method: 'PATCH',
    route: '/api/v1/categories/{id}',
    url: () => `/api/v1/categories/${bIds.category}`,
    body: () => ({ name: 'pwned' }),
    expect: [404],
  },
  {
    method: 'DELETE',
    route: '/api/v1/categories/{id}',
    url: () => `/api/v1/categories/${bIds.category}`,
    expect: [404],
  },
  {
    method: 'DELETE',
    route: '/api/v1/tags/{id}',
    url: () => `/api/v1/tags/${bIds.tag}`,
    expect: [404],
  },
  {
    method: 'POST',
    route: '/api/v1/files/{id}/complete',
    url: () => `/api/v1/files/${bIds.file}/complete`,
    expect: [404],
  },
  {
    method: 'DELETE',
    route: '/api/v1/files/{id}',
    url: () => `/api/v1/files/${bIds.file}`,
    expect: [404],
  },
  {
    method: 'POST',
    route: '/api/v1/domains/{id}/verify',
    url: () => `/api/v1/domains/${bIds.domain}/verify`,
    expect: [404],
  },
  {
    method: 'DELETE',
    route: '/api/v1/domains/{id}',
    url: () => `/api/v1/domains/${bIds.domain}`,
    expect: [404],
  },
  {
    method: 'DELETE',
    route: '/api/v1/invitations/{id}',
    url: () => `/api/v1/invitations/${bIds.invitation}`,
    expect: [404],
  },
  // creates that reference B's ids
  {
    method: 'POST',
    route: '/api/v1/resources',
    url: () => '/api/v1/resources',
    body: () => ({ title: 'Cross-tenant link', categoryId: bIds.category, tagIds: [bIds.tag] }),
    expect: [400],
  },
  {
    method: 'POST',
    route: '/api/v1/files/uploads',
    url: () => '/api/v1/files/uploads',
    body: () => ({
      filename: 'x.pdf',
      mime: 'application/pdf',
      size: 1,
      resourceId: bIds.resource,
    }),
    expect: [404],
  },
  {
    method: 'PUT',
    route: '/api/v1/branding',
    url: () => '/api/v1/branding',
    body: () => ({ logoFileId: bIds.file }),
    expect: [400],
  },
  {
    method: 'POST',
    route: '/api/v1/domains',
    url: () => '/api/v1/domains',
    body: () => ({ hostname: 'isolation.northwind.test' }),
    expect: [409],
  },
  // creates with no B reference: must not show up in B (checked in the final test)
  {
    method: 'POST',
    route: '/api/v1/categories',
    url: () => '/api/v1/categories',
    body: () => ({ name: 'A only category' }),
    expect: [201],
  },
  {
    method: 'POST',
    route: '/api/v1/tags',
    url: () => '/api/v1/tags',
    body: () => ({ name: 'a-only-tag' }),
    expect: [201],
  },
  {
    method: 'POST',
    route: '/api/v1/invitations',
    url: () => '/api/v1/invitations',
    body: () => ({ email: 'a-only@contoso.example', role: 'viewer' }),
    expect: [201],
  },
  {
    method: 'PATCH',
    route: '/api/v1/me',
    url: () => '/api/v1/me',
    body: () => ({ name: 'Olivia Owens' }),
    expect: [200],
  },
];

/** Routes that are not tenant data (or are covered by dedicated suites). */
const NOT_TENANT_DATA = new Set([
  'GET /api/v1/health',
  'GET /api/v1/auth/login',
  'GET /api/v1/auth/callback',
  'POST /api/v1/auth/refresh', // auth-isolation.test.ts: A's cookie on B's host
  'POST /api/v1/auth/logout',
  'GET /api/v1/invitations/preview', // auth-isolation.test.ts
  'POST /api/v1/invitations/accept', // auth-isolation.test.ts
]);

describe('A cannot see, change or count B through any endpoint', () => {
  for (const c of cases) {
    it(`${c.method} ${c.route}`, async () => {
      const res = await request(app, {
        host: HOSTS.contoso,
        method: c.method,
        url: c.url(),
        token: a.accessToken,
        ...(c.body ? { body: c.body() } : {}),
        headers: {
          'idempotency-key': `iso-${c.method}-${Math.random().toString(36).slice(2, 12)}`,
        },
      });
      expect(c.expect, `${res.statusCode}: ${res.body}`).toContain(res.statusCode);
      for (const marker of bMarkers) expect(res.body).not.toContain(marker);
    });
  }

  it("B's data is untouched and A's new rows are invisible to B", async () => {
    const db = app.get(DbService);
    const [res] = await db.withPlatformTx({ actorId: null, action: 'test.isolation_check' }, (tx) =>
      tx.select().from(schema.resources).where(eq(schema.resources.id, bIds.resource!)),
    );
    expect(res?.title).not.toBe('pwned by A');
    const nora = await signIn(app, HOSTS.northwind, { oid: 'dev-nora' });
    for (const url of [
      '/api/v1/categories',
      '/api/v1/tags',
      '/api/v1/invitations',
      '/api/v1/resources?limit=100',
    ]) {
      const body = (await request(app, { host: HOSTS.northwind, url, token: nora.accessToken }))
        .body;
      for (const marker of [
        'A only category',
        'a-only-tag',
        'a-only@contoso.example',
        'Cross-tenant link',
        'Contoso',
      ]) {
        expect(body, url).not.toContain(marker);
      }
    }
  });

  it('every API route is covered by this suite or explicitly classified', () => {
    const doc = buildOpenApi(app);
    const covered = new Set(cases.map((c) => `${c.method} ${c.route}`));
    const missing: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops as object)) {
        const key = `${method.toUpperCase()} ${path}`;
        if (!covered.has(key) && !NOT_TENANT_DATA.has(key)) missing.push(key);
      }
    }
    expect(missing, 'add an isolation case for these routes').toEqual([]);
  });
});
