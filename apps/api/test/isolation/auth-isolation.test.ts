// Layer 2: membership. These tests gate merging: never weaken or skip them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOSTS, request, type TestApp } from '../helpers.js';
import { createListeningApp, signIn, type Session } from '../auth-helpers.js';

let app: TestApp;
let contosoAdmin: Session;
let northwindOwner: Session;
let samOnContoso: Session;
let platform: Session;

beforeAll(async () => {
  app = await createListeningApp();
  [contosoAdmin, northwindOwner, samOnContoso, platform] = await Promise.all([
    signIn(app, HOSTS.contoso, { oid: 'dev-adam' }),
    signIn(app, HOSTS.northwind, { oid: 'dev-nora' }),
    signIn(app, HOSTS.contoso, { oid: 'dev-sam' }),
    signIn(app, HOSTS.platform, { oid: 'dev-pat' }),
  ]);
});
afterAll(async () => {
  await app.close();
});

describe("A's token on B's host", () => {
  it('returns 403 for a member of A only', async () => {
    const res = await request(app, {
      host: HOSTS.northwind,
      url: '/api/v1/me',
      token: contosoAdmin.accessToken,
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 even for someone who is a member of both (tokens are bound to the issuing workspace)', async () => {
    const res = await request(app, {
      host: HOSTS.northwind,
      url: '/api/v1/me',
      token: samOnContoso.accessToken,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/different workspace/);
  });

  it("A's refresh cookie does not open a session on B's host (RLS hides the row)", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { host: HOSTS.northwind },
      cookies: { rh_refresh: contosoAdmin.refresh },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a tenant token is rejected on the platform admin host, and vice versa', async () => {
    const onAdmin = await request(app, {
      host: HOSTS.platform,
      url: '/api/v1/me',
      token: contosoAdmin.accessToken,
    });
    expect(onAdmin.statusCode).toBe(403);
    const onTenant = await request(app, {
      host: HOSTS.contoso,
      url: '/api/v1/me',
      token: platform.accessToken,
    });
    expect(onTenant.statusCode).toBe(403);
  });

  it('an unknown host is a 404 even with a valid token', async () => {
    const res = await request(app, {
      host: HOSTS.unknown,
      url: '/api/v1/me',
      token: contosoAdmin.accessToken,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('invitations are tenant-scoped', () => {
  it("B's admin cannot see A's invitations", async () => {
    const created = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/invitations',
      token: contosoAdmin.accessToken,
      headers: { 'idempotency-key': 'iso-invite-0001' },
      body: { email: 'iso-check@contoso.example', role: 'viewer' },
    });
    expect(created.statusCode).toBe(201);
    const theirs = await request(app, {
      host: HOSTS.northwind,
      url: '/api/v1/invitations',
      token: northwindOwner.accessToken,
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().data.map((i: { email: string }) => i.email)).not.toContain(
      'iso-check@contoso.example',
    );
  });

  it("A's invitation token cannot be redeemed or even previewed on B's host", async () => {
    const created = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/invitations',
      token: contosoAdmin.accessToken,
      headers: { 'idempotency-key': 'iso-invite-0002' },
      body: { email: 'nora@northwind.example', role: 'admin' },
    });
    const token = new URL(created.json().acceptUrl).pathname.split('/').pop()!;
    const preview = await request(app, {
      host: HOSTS.northwind,
      url: `/api/v1/invitations/preview?token=${token}`,
    });
    expect(preview.statusCode).toBe(404);
    const accept = await request(app, {
      host: HOSTS.northwind,
      method: 'POST',
      url: '/api/v1/invitations/accept',
      token: northwindOwner.accessToken,
      body: { token },
    });
    expect(accept.statusCode).toBe(404);
  });
});
