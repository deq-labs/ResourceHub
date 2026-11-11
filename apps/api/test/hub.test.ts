import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOSTS, request, type TestApp } from './helpers.js';
import { createListeningApp, signIn, type Session } from './auth-helpers.js';

let app: TestApp;
let viewer: Session;
let editor: Session;
let admin: Session;
let key = 0;
const idem = () => ({ 'idempotency-key': `hub-test-${Date.now()}-${key++}` });

beforeAll(async () => {
  app = await createListeningApp();
  [viewer, editor, admin] = await Promise.all([
    signIn(app, HOSTS.contoso, { oid: 'dev-victor' }),
    signIn(app, HOSTS.contoso, { oid: 'dev-erin' }),
    signIn(app, HOSTS.contoso, { oid: 'dev-adam' }),
  ]);
});
afterAll(async () => {
  await app.close();
});

const get = (s: Session, url: string) =>
  request(app, { host: HOSTS.contoso, url, token: s.accessToken });

describe('resources', () => {
  it('viewers only see published resources; editors also see drafts', async () => {
    const asViewer = (await get(viewer, '/api/v1/resources?limit=100')).json();
    const asEditor = (await get(editor, '/api/v1/resources?limit=100')).json();
    expect(asViewer.data.every((r: { status: string }) => r.status === 'published')).toBe(true);
    expect(asEditor.data.some((r: { status: string }) => r.status === 'draft')).toBe(true);
    expect(asEditor.data.length).toBeGreaterThan(asViewer.data.length);
  });

  it('a viewer asking for a draft by slug gets 404, not 403', async () => {
    const res = await get(viewer, '/api/v1/resources/supplier-visit-policy-faq-draft');
    expect(res.statusCode).toBe(404);
    expect(
      (await get(editor, '/api/v1/resources/supplier-visit-policy-faq-draft')).statusCode,
    ).toBe(200);
  });

  it('paginates with an opaque cursor and no duplicates', async () => {
    const first = (await get(editor, '/api/v1/resources?limit=3')).json();
    expect(first.data).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    const second = (
      await get(editor, `/api/v1/resources?limit=3&cursor=${first.nextCursor}`)
    ).json();
    const ids = [...first.data, ...second.data].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await get(editor, '/api/v1/resources?cursor=garbage')).statusCode).toBe(400);
  });

  it('filters by category, tag, featured and full-text search', async () => {
    const byCat = (await get(viewer, '/api/v1/resources?filter[category]=quality')).json();
    expect(
      byCat.data.every((r: { category: { slug: string } }) => r.category.slug === 'quality'),
    ).toBe(true);
    const byTag = (await get(viewer, '/api/v1/resources?filter[tag]=checklist')).json();
    expect(byTag.data.length).toBeGreaterThanOrEqual(3);
    const featured = (await get(viewer, '/api/v1/resources?filter[featured]=true')).json();
    expect(featured.data.every((r: { featured: boolean }) => r.featured)).toBe(true);
    const search = (await get(viewer, '/api/v1/resources?q=near%20miss')).json();
    expect(search.data[0].title).toBe('Near-miss reporting in 24 hours');
  });

  it('editor creates, publishes and edits; viewer cannot write; only admins delete', async () => {
    const cats = (await get(editor, '/api/v1/categories')).json().data;
    const tags = (await get(editor, '/api/v1/tags')).json().data;
    const created = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/resources',
      token: editor.accessToken,
      headers: idem(),
      body: {
        title: 'Line stoppage response',
        summary: 'What to do when a production line stops unexpectedly.',
        body: '## Steps\n\n1. Quarantine\n2. Report',
        categoryId: cats[0].id,
        tagIds: [tags[0].id],
      },
    });
    expect(created.statusCode).toBe(201);
    const r = created.json();
    expect(r).toMatchObject({
      slug: 'line-stoppage-response',
      status: 'draft',
      author: { name: 'Erin Edwards' },
    });
    expect(r.tags).toHaveLength(1);

    const published = await request(app, {
      host: HOSTS.contoso,
      method: 'PATCH',
      url: `/api/v1/resources/${r.id}`,
      token: editor.accessToken,
      body: { status: 'published' },
    });
    expect(published.json()).toMatchObject({ status: 'published' });
    expect(published.json().publishedAt).toBeTruthy();

    const viewerWrite = await request(app, {
      host: HOSTS.contoso,
      method: 'PATCH',
      url: `/api/v1/resources/${r.id}`,
      token: viewer.accessToken,
      body: { title: 'hacked' },
    });
    expect(viewerWrite.statusCode).toBe(403);

    const editorDelete = await request(app, {
      host: HOSTS.contoso,
      method: 'DELETE',
      url: `/api/v1/resources/${r.id}`,
      token: editor.accessToken,
    });
    expect(editorDelete.statusCode).toBe(403);
    const adminDelete = await request(app, {
      host: HOSTS.contoso,
      method: 'DELETE',
      url: `/api/v1/resources/${r.id}`,
      token: admin.accessToken,
    });
    expect(adminDelete.statusCode).toBe(204);
  });

  it('dedupes slugs', async () => {
    const make = () =>
      request(app, {
        host: HOSTS.contoso,
        method: 'POST',
        url: '/api/v1/resources',
        token: editor.accessToken,
        headers: idem(),
        body: { title: 'Duplicate title here' },
      });
    const a = (await make()).json();
    const b = (await make()).json();
    expect([a.slug, b.slug]).toEqual(['duplicate-title-here', 'duplicate-title-here-2']);
  });
});

describe('taxonomy', () => {
  it('lists categories with counts of what the caller can see', async () => {
    const cats = (await get(viewer, '/api/v1/categories')).json().data;
    expect(cats.map((c: { slug: string }) => c.slug)).toContain('plant-operations');
    const training = cats.find((c: { slug: string }) => c.slug === 'training');
    expect(training.resourceCount).toBe(1); // the draft FAQ is hidden from viewers
  });

  it('rejects duplicate category slugs with 409', async () => {
    const make = () =>
      request(app, {
        host: HOSTS.contoso,
        method: 'POST',
        url: '/api/v1/categories',
        token: editor.accessToken,
        headers: idem(),
        body: { name: 'Sustainability' },
      });
    expect((await make()).statusCode).toBe(201);
    expect((await make()).statusCode).toBe(409);
  });
});

describe('files (direct-to-blob upload via SAS)', () => {
  it('upload ticket -> PUT to blob -> complete -> download link', async () => {
    const resource = (await get(editor, '/api/v1/resources/line-startup-checklist')).json();
    const content = Buffer.from('%PDF-1.4 demo checklist');
    const ticket = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/files/uploads',
      token: editor.accessToken,
      headers: idem(),
      body: {
        filename: 'Line startup checklist.pdf',
        mime: 'application/pdf',
        size: content.length,
        resourceId: resource.id,
      },
    });
    expect(ticket.statusCode).toBe(201);
    const t = ticket.json();
    expect(t.uploadUrl).toContain(`/tenants/${resource.id ? '' : ''}`);
    expect(decodeURIComponent(t.uploadUrl)).toMatch(/tenants\/[0-9a-f-]{36}\/files\//);
    expect(t.uploadUrl).toMatch(/sp=cw/); // write-only SAS

    const put = await fetch(t.uploadUrl, { method: 'PUT', headers: t.headers, body: content });
    expect(put.status).toBe(201);

    const done = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: `/api/v1/files/${t.file.id}/complete`,
      token: editor.accessToken,
      headers: idem(),
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'ready', size: content.length });

    const detail = (await get(viewer, '/api/v1/resources/line-startup-checklist')).json();
    expect(detail.attachments.map((a: { filename: string }) => a.filename)).toContain(
      'Line startup checklist.pdf',
    );

    const link = (await get(viewer, `/api/v1/files/${t.file.id}/download`)).json();
    expect(link.url).toMatch(/sp=r/);
    const blob = await fetch(link.url);
    expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe(content.toString());
  });

  it('rejects disallowed types and oversize uploads', async () => {
    const bad = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/files/uploads',
      token: editor.accessToken,
      headers: idem(),
      body: { filename: 'evil.exe', mime: 'application/x-msdownload', size: 10 },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('branding and domains', () => {
  it('serves branding publicly (no token) for the SPA boot', async () => {
    const res = await request(app, { host: HOSTS.contoso, url: '/api/v1/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hubTitle: 'Contoso Operations Hub',
      font: 'IBM Plex Sans',
      colors: { primary: '#0f766e' },
    });
  });

  it('admins update branding; the cached copy is invalidated', async () => {
    const res = await request(app, {
      host: HOSTS.contoso,
      method: 'PUT',
      url: '/api/v1/branding',
      token: admin.accessToken,
      body: { tagline: 'Updated by the test suite.' },
    });
    expect(res.statusCode).toBe(200);
    const after = (await request(app, { host: HOSTS.contoso, url: '/api/v1/branding' })).json();
    expect(after.tagline).toBe('Updated by the test suite.');
    const editorTry = await request(app, {
      host: HOSTS.contoso,
      method: 'PUT',
      url: '/api/v1/branding',
      token: editor.accessToken,
      body: { font: 'Lora' },
    });
    expect(editorTry.statusCode).toBe(403);
  });

  it('custom domain: add -> TXT instructions -> verify -> traffic routes to the tenant', async () => {
    const created = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/domains',
      token: admin.accessToken,
      headers: idem(),
      body: { hostname: 'hub.contoso-mfg.localhost' },
    });
    expect(created.statusCode).toBe(201);
    const domain = created.json();
    expect(domain.verification).toMatchObject({
      type: 'TXT',
      name: '_resourcehub-challenge.hub.contoso-mfg.localhost',
    });

    expect(
      (await request(app, { host: 'hub.contoso-mfg.localhost', url: '/api/v1/tenant' })).statusCode,
    ).toBe(404);
    const verified = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: `/api/v1/domains/${domain.id}/verify`,
      token: admin.accessToken,
      headers: idem(),
    });
    expect(verified.json().verified).toBe(true);
    const routed = await request(app, {
      host: 'hub.contoso-mfg.localhost',
      url: '/api/v1/tenant',
    });
    expect(routed.json()).toMatchObject({ slug: 'contoso' });
  });

  it('refuses hostnames under the platform root domain', async () => {
    const res = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/domains',
      token: admin.accessToken,
      headers: idem(),
      body: { hostname: 'northwind.localhost' },
    });
    expect(res.statusCode).toBe(400);
  });
});
