import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TENANTS, eq, schema } from '@resourcehub/db';
import { DbService } from '../src/infra/db.service.js';
import { HOSTS, request, type TestApp } from './helpers.js';
import { createListeningApp, refreshSession, signIn, type Session } from './auth-helpers.js';

let app: TestApp;
let admin: Session;
let owner: Session;

beforeAll(async () => {
  app = await createListeningApp();
  admin = await signIn(app, HOSTS.contoso, { oid: 'dev-adam' });
  owner = await signIn(app, HOSTS.contoso, { oid: 'dev-olivia' });
});
afterAll(async () => {
  await app.close();
});

const invite = (s: Session, body: unknown, key?: string) =>
  request(app, {
    host: HOSTS.contoso,
    method: 'POST',
    url: '/api/v1/invitations',
    token: s.accessToken,
    body,
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  });

const tokenOf = (acceptUrl: string) => new URL(acceptUrl).pathname.split('/').pop()!;

describe('invitations', () => {
  it('requires an Idempotency-Key and replays the first response for a retried key', async () => {
    expect(
      (await invite(admin, { email: 'retry@contoso.example', role: 'viewer' })).statusCode,
    ).toBe(400);
    const first = await invite(
      admin,
      { email: 'retry@contoso.example', role: 'viewer' },
      'key-retry-0001',
    );
    const second = await invite(
      admin,
      { email: 'retry@contoso.example', role: 'viewer' },
      'key-retry-0001',
    );
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
    const misuse = await invite(
      admin,
      { email: 'other@contoso.example', role: 'viewer' },
      'key-retry-0001',
    );
    expect(misuse.statusCode).toBe(422);
  });

  it('validates input with problem+json field errors', async () => {
    const res = await invite(admin, { email: 'not-an-email', role: 'wizard' }, 'key-invalid-0001');
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(
      res
        .json()
        .errors.map((e: { path: string }) => e.path)
        .sort(),
    ).toEqual(['email', 'role']);
  });

  it('admins cannot mint owners; owners can', async () => {
    expect(
      (await invite(admin, { email: 'boss@contoso.example', role: 'owner' }, 'key-owner-0001'))
        .statusCode,
    ).toBe(403);
    expect(
      (await invite(owner, { email: 'boss@contoso.example', role: 'owner' }, 'key-owner-0002'))
        .statusCode,
    ).toBe(201);
  });

  it('refuses to invite an existing member', async () => {
    const res = await invite(
      admin,
      { email: 'erin@contoso.example', role: 'viewer' },
      'key-member-0001',
    );
    expect(res.statusCode).toBe(409);
  });

  it('end to end: invite -> preview -> sign in as the invitee -> accept -> refreshed token has the role', async () => {
    const created = await invite(
      admin,
      { email: 'New.Hire@Contoso.example', role: 'editor' },
      'key-e2e-00001',
    );
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      email: 'new.hire@contoso.example',
      role: 'editor',
      status: 'pending',
    });
    const token = tokenOf(created.json().acceptUrl);

    const preview = await request(app, {
      host: HOSTS.contoso,
      url: `/api/v1/invitations/preview?token=${token}`,
    });
    expect(preview.json()).toMatchObject({
      workspace: 'Contoso Pharma',
      role: 'editor',
      emailHint: 'n•••••••@contoso.example',
    });

    const invitee = await signIn(app, HOSTS.contoso, {
      email: 'new.hire@contoso.example',
      name: 'New Hire',
    });
    expect(invitee.user.role).toBeNull();
    const accepted = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/invitations/accept',
      token: invitee.accessToken,
      body: { token },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ role: 'editor' });

    const refreshed = await refreshSession(app, HOSTS.contoso, invitee.refresh);
    expect(refreshed.user.role).toBe('editor');

    // Single use.
    const again = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/invitations/accept',
      token: refreshed.accessToken,
      body: { token },
    });
    expect(again.statusCode).toBe(404);
  });

  it('only the invited email address can accept', async () => {
    const created = await invite(
      admin,
      { email: 'intended@contoso.example', role: 'viewer' },
      'key-email-0001',
    );
    const wrong = await signIn(app, HOSTS.contoso, { email: 'someone.else@example.com' });
    const res = await request(app, {
      host: HOSTS.contoso,
      method: 'POST',
      url: '/api/v1/invitations/accept',
      token: wrong.accessToken,
      body: { token: tokenOf(created.json().acceptUrl) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('locks out an IP after repeated bad tokens', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/invitations/preview?token=${'x'.repeat(30)}${i}`,
        headers: { host: HOSTS.contoso },
        remoteAddress: '10.9.8.7',
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('writes audit rows for the whole flow, in the right tenant', async () => {
    const db = app.get(DbService);
    const rows = await db.withPlatformTx({ actorId: null, action: 'test.read_audit' }, (tx) =>
      tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.tenantId, DEMO_TENANTS.contoso.id)),
    );
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['auth.login', 'invitation.created', 'invitation.accepted'])
      expect(actions).toContain(a);
    expect(rows.every((r) => !JSON.stringify(r.diff ?? {}).includes('token'))).toBe(true);
  });
});
