import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TENANTS, DEMO_USERS } from '@resourcehub/db';
import { HOSTS, request, type TestApp } from './helpers.js';
import { createListeningApp, signIn, type Session } from './auth-helpers.js';

let app: TestApp;
let owner: Session;
let admin: Session;
let pat: Session;
const uid = (oid: string) => DEMO_USERS.find((u) => u.oid === oid)!.id;
let k = 0;
const idem = () => ({ 'idempotency-key': `admin-test-${Date.now()}-${k++}` });

beforeAll(async () => {
  app = await createListeningApp();
  [owner, admin, pat] = await Promise.all([
    signIn(app, HOSTS.contoso, { oid: 'dev-olivia' }),
    signIn(app, HOSTS.contoso, { oid: 'dev-adam' }),
    signIn(app, HOSTS.platform, { oid: 'dev-pat' }),
  ]);
});
afterAll(async () => {
  await app.close();
});

const call = (
  s: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  host: string = HOSTS.contoso,
) =>
  request(app, {
    host,
    method,
    url,
    token: s.accessToken,
    ...(body !== undefined ? { body } : {}),
    headers: idem(),
  });

/** Invite + accept a fresh user so destructive tests don't disturb the shared demo users. */
async function newMember(email: string, role: 'viewer' | 'editor' = 'viewer') {
  const inv = await call(owner, 'POST', '/api/v1/invitations', { email, role });
  const token = new URL(inv.json().acceptUrl).pathname.split('/').pop()!;
  const s = await signIn(app, HOSTS.contoso, { email });
  await call(s, 'POST', '/api/v1/invitations/accept', { token });
  const me = await call(s, 'GET', '/api/v1/me');
  return { session: s, id: me.json().user.id as string };
}

describe('tenant admin: members', () => {
  it('lists members with roles', async () => {
    const res = await call(admin, 'GET', '/api/v1/members');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((m: { email: string }) => m.email)).toContain(
      'olivia@contoso.example',
    );
  });

  it('admins change roles below owner; only owners touch ownership; nobody changes their own role', async () => {
    const temp = await newMember('role.change@contoso.example');
    const up = await call(admin, 'PATCH', `/api/v1/members/${temp.id}`, { role: 'editor' });
    expect(up.json()).toMatchObject({ role: 'editor' });
    expect(
      (await call(admin, 'PATCH', `/api/v1/members/${temp.id}`, { role: 'owner' })).statusCode,
    ).toBe(403);
    expect(
      (await call(admin, 'PATCH', `/api/v1/members/${uid('dev-olivia')}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(admin, 'PATCH', `/api/v1/members/${uid('dev-adam')}`, { role: 'owner' }))
        .statusCode,
    ).toBe(400);
  });

  it('removing a member revokes their sessions immediately', async () => {
    const temp = await newMember('to.remove@contoso.example');
    expect((await call(admin, 'DELETE', `/api/v1/members/${temp.id}`)).statusCode).toBe(204);
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { host: HOSTS.contoso },
      cookies: { rh_refresh: temp.session.refresh },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('editors and viewers cannot reach admin endpoints', async () => {
    const erin = await signIn(app, HOSTS.contoso, { oid: 'dev-erin' });
    for (const url of ['/api/v1/members', '/api/v1/audit'])
      expect((await call(erin, 'GET', url)).statusCode).toBe(403);
  });

  it('the audit log viewer filters by action prefix and paginates', async () => {
    const res = await call(admin, 'GET', '/api/v1/audit?filter[action]=membership.&limit=2');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((e: { action: string }) => e.action.startsWith('membership.'))).toBe(
      true,
    );
  });
});

describe('platform console (admin host)', () => {
  it('is invisible to tenant tokens and on tenant hosts', async () => {
    expect(
      (await call(owner, 'GET', '/api/v1/platform/tenants', undefined, HOSTS.platform)).statusCode,
    ).toBe(403);
    expect(
      (await call(pat, 'GET', '/api/v1/platform/tenants', undefined, HOSTS.contoso)).statusCode,
    ).toBe(404);
  });

  it('lists tenants with counts', async () => {
    const res = await call(pat, 'GET', '/api/v1/platform/tenants', undefined, HOSTS.platform);
    const contoso = res.json().data.find((t: { slug: string }) => t.slug === 'contoso');
    expect(contoso).toMatchObject({ status: 'active', plan: 'enterprise' });
    expect(contoso.memberCount).toBeGreaterThan(3);
    expect(contoso.resourceCount).toBeGreaterThan(5);
  });

  it('creates a tenant that is live on its subdomain, then suspends it', async () => {
    const created = await call(
      pat,
      'POST',
      '/api/v1/platform/tenants',
      {
        slug: 'fabrikam',
        name: 'Fabrikam Labs',
        plan: 'pro',
        ownerEmail: 'owner@fabrikam.example',
      },
      HOSTS.platform,
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().ownerInviteUrl).toContain('fabrikam.localhost');
    const live = await request(app, { host: 'fabrikam.localhost', url: '/api/v1/branding' });
    expect(live.json()).toMatchObject({ hubTitle: 'Fabrikam Labs' });

    const id = created.json().tenant.id as string;
    const suspended = await call(
      pat,
      'PATCH',
      `/api/v1/platform/tenants/${id}`,
      { status: 'suspended' },
      HOSTS.platform,
    );
    expect(suspended.json()).toMatchObject({ status: 'suspended' });
    const blocked = await request(app, { host: 'fabrikam.localhost', url: '/api/v1/branding' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().title).toBe('Tenant suspended');

    expect(
      (
        await call(
          pat,
          'POST',
          '/api/v1/platform/tenants',
          { slug: 'admin', name: 'Nope', ownerEmail: 'x@y.example' },
          HOSTS.platform,
        )
      ).statusCode,
    ).toBe(400);
  });

  it('impersonation: reason required -> one-time ticket -> tenant session flagged and audited', async () => {
    const victorId = uid('dev-victor');
    const noReason = await call(
      pat,
      'POST',
      '/api/v1/platform/impersonations',
      { tenantId: DEMO_TENANTS.contoso.id, userId: victorId, reason: 'x' },
      HOSTS.platform,
    );
    expect(noReason.statusCode).toBe(400);

    const started = await call(
      pat,
      'POST',
      '/api/v1/platform/impersonations',
      {
        tenantId: DEMO_TENANTS.contoso.id,
        userId: victorId,
        reason: 'Support ticket #4821: viewer cannot see attachments',
      },
      HOSTS.platform,
    );
    expect(started.statusCode).toBe(201);
    const url = new URL(started.json().url);
    expect(url.host).toBe('contoso.localhost:5173');

    // Wrong workspace: the ticket is bound to Contoso.
    const wrongHost = await app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
      headers: { host: HOSTS.northwind },
    });
    expect(wrongHost.statusCode).toBe(403);

    const redeemed = await app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
      headers: { host: HOSTS.contoso },
    });
    expect(redeemed.statusCode).toBe(302);
    const cookie = redeemed.cookies.find((c) => c.name === 'rh_refresh')!.value;

    const again = await app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
      headers: { host: HOSTS.contoso },
    });
    expect(again.statusCode).toBe(401);

    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { host: HOSTS.contoso },
      cookies: { rh_refresh: cookie },
    });
    expect(session.json().user).toMatchObject({
      email: 'victor@contoso.example',
      role: 'viewer',
      impersonatedBy: { name: 'Pat Platform' },
    });

    const audit = await call(owner, 'GET', '/api/v1/audit?filter[action]=auth.impersonation');
    const entry = audit.json().data[0];
    expect(entry).toMatchObject({
      action: 'auth.impersonation_started',
      actor: { id: victorId },
      impersonator: { id: uid('dev-pat') },
    });
    expect(entry.diff.reason).toMatch(/Support ticket/);

    const platformAudit = await call(
      pat,
      'GET',
      '/api/v1/platform/audit',
      undefined,
      HOSTS.platform,
    );
    expect(platformAudit.json().data.map((e: { action: string }) => e.action)).toContain(
      'platform.impersonation_requested',
    );
  });

  it('cannot impersonate someone outside the tenant', async () => {
    const res = await call(
      pat,
      'POST',
      '/api/v1/platform/impersonations',
      {
        tenantId: DEMO_TENANTS.contoso.id,
        userId: uid('dev-nora'),
        reason: 'Trying to cross tenants here',
      },
      HOSTS.platform,
    );
    expect(res.statusCode).toBe(404);
  });
});
