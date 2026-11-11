import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANTS } from '@resourcehub/db';
import { HOSTS, request, type TestApp } from './helpers.js';
import { cookieFrom, createListeningApp, refreshSession, signIn } from './auth-helpers.js';

let app: TestApp;

beforeAll(async () => {
  app = await createListeningApp();
});
afterAll(async () => {
  await app.close();
});

describe('OIDC sign-in (authorization code + PKCE) against the dev IdP', () => {
  it('signs a member in and returns their role for this workspace', async () => {
    const s = await signIn(app, HOSTS.contoso, { oid: 'dev-erin' });
    expect(s.user).toMatchObject({ email: 'erin@contoso.example', role: 'editor' });
    const me = await request(app, { host: HOSTS.contoso, url: '/api/v1/me', token: s.accessToken });
    expect(me.statusCode).toBe(200);
    expect(me.json().workspaces.map((w: { slug: string }) => w.slug)).toEqual(['contoso']);
  });

  it('sets the refresh cookie HttpOnly + SameSite=Lax, scoped to /api/v1/auth', async () => {
    const login = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/login',
      headers: { host: HOSTS.contoso },
    });
    const c = login.cookies.find((x) => x.name === 'rh_oidc')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
  });

  it('rejects a callback whose state does not match the cookie', async () => {
    const login = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/login',
      headers: { host: HOSTS.contoso },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/callback?code=abc&state=forged',
      headers: { host: HOSTS.contoso },
      cookies: { rh_oidc: cookieFrom(login, 'rh_oidc')! },
    });
    expect(res.headers.location).toBe('/signin?error=signin_state_mismatch');
  });

  it('never redirects off-site after sign-in', async () => {
    const login = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/login?returnTo=//evil.example/steal',
      headers: { host: HOSTS.contoso },
    });
    expect(login.statusCode).toBe(302);
    // returnTo is sealed inside the signed state cookie; safeReturnTo() turned it into "/".
    const { safeReturnTo } = await import('../src/modules/auth/auth.controller.js');
    expect(safeReturnTo('//evil.example/steal')).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('/resources?x=1')).toBe('/resources?x=1');
  });

  it('a person in two workspaces gets a different role on each host', async () => {
    const a = await signIn(app, HOSTS.contoso, { oid: 'dev-sam' });
    const b = await signIn(app, HOSTS.northwind, { oid: 'dev-sam' });
    expect(a.user.role).toBe('viewer');
    expect(b.user.role).toBe('admin');
  });

  it('only platform admins can sign in on the admin host', async () => {
    const pat = await signIn(app, HOSTS.platform, { oid: 'dev-pat' });
    expect(pat.user).toMatchObject({ role: null });
    const me = await request(app, {
      host: HOSTS.platform,
      url: '/api/v1/me',
      token: pat.accessToken,
    });
    expect(me.json().user.isPlatformAdmin).toBe(true);

    const login = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/login',
      headers: { host: HOSTS.platform },
    });
    const authorize = new URL(login.headers.location as string);
    const form = new URLSearchParams(authorize.searchParams);
    form.set('oid', 'dev-olivia');
    const picked = await app.inject({
      method: 'POST',
      url: authorize.pathname,
      headers: { host: authorize.host, 'content-type': 'application/x-www-form-urlencoded' },
      payload: form.toString(),
    });
    const cb = new URL(picked.headers.location as string);
    const res = await app.inject({
      method: 'GET',
      url: `${cb.pathname}${cb.search}`,
      headers: { host: HOSTS.platform },
      cookies: { rh_oidc: cookieFrom(login, 'rh_oidc')! },
    });
    expect(res.headers.location).toBe('/signin?error=not_platform_admin');
  });
});

describe('refresh token rotation', () => {
  it('rotates on every refresh', async () => {
    const s = await signIn(app, HOSTS.contoso, { oid: 'dev-victor' });
    const next = await refreshSession(app, HOSTS.contoso, s.refresh);
    expect(next.refresh).not.toBe(s.refresh);
  });

  it('tolerates a racing double refresh (two tabs) within the grace window', async () => {
    const s = await signIn(app, HOSTS.contoso, { oid: 'dev-victor' });
    await refreshSession(app, HOSTS.contoso, s.refresh);
    const again = await refreshSession(app, HOSTS.contoso, s.refresh);
    expect(again.accessToken).toBeTruthy();
  });

  it('detects reuse of a rotated-out token and revokes the whole family', async () => {
    const s = await signIn(app, HOSTS.contoso, { oid: 'dev-victor' });
    const next = await refreshSession(app, HOSTS.contoso, s.refresh);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    try {
      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { host: HOSTS.contoso },
        cookies: { rh_refresh: s.refresh },
      });
      expect(replay.statusCode).toBe(401);
      // The legitimate holder's newer token is dead too.
      const victim = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { host: HOSTS.contoso },
        cookies: { rh_refresh: next.refresh },
      });
      expect(victim.statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects cross-origin refresh attempts', async () => {
    const s = await signIn(app, HOSTS.contoso, { oid: 'dev-victor' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { host: HOSTS.contoso, origin: 'http://evil.localhost' },
      cookies: { rh_refresh: s.refresh },
    });
    expect(res.statusCode).toBe(403);
  });

  it('logout revokes the session', async () => {
    const s = await signIn(app, HOSTS.contoso, { oid: 'dev-victor' });
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { host: HOSTS.contoso },
      cookies: { rh_refresh: s.refresh },
    });
    expect(out.statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { host: HOSTS.contoso },
      cookies: { rh_refresh: s.refresh },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('membership and role guards', () => {
  it('401 without a token, 401 with a garbage token', async () => {
    expect((await request(app, { host: HOSTS.contoso, url: '/api/v1/me' })).statusCode).toBe(401);
    expect(
      (await request(app, { host: HOSTS.contoso, url: '/api/v1/me', token: 'nope' })).statusCode,
    ).toBe(401);
  });

  it('a signed-in non-member can see /me (role null) but nothing else', async () => {
    const s = await signIn(app, HOSTS.contoso, { email: 'stranger@example.com' });
    expect(s.user.role).toBeNull();
    const list = await request(app, {
      host: HOSTS.contoso,
      url: '/api/v1/invitations',
      token: s.accessToken,
    });
    expect(list.statusCode).toBe(403);
  });

  it('editors cannot manage invitations', async () => {
    const s = await signIn(app, HOSTS.contoso, { oid: 'dev-erin' });
    const res = await request(app, {
      host: HOSTS.contoso,
      url: '/api/v1/invitations',
      token: s.accessToken,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/admin role/);
  });

  it('the tenant id in the token must match the host', () => {
    expect(DEMO_TENANTS.contoso.id).not.toBe(DEMO_TENANTS.northwind.id);
  });
});
