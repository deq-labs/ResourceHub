import { createServer } from 'node:net';
import { expect } from 'vitest';
import { createApp } from '../src/app.factory.js';
import { testConfig, type TestApp, type TestResponse } from './helpers.js';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * An app that is also listening on a real port, because the API's OIDC client fetches the dev
 * IdP's discovery/JWKS/token endpoints over HTTP, exactly as it would call Entra.
 */
export async function createListeningApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const port = await freePort();
  const app = await createApp(
    testConfig({
      OIDC_ISSUER: `http://localhost:${port}/api/v1/dev-idp`,
      RATE_LIMIT_AUTH_PER_MINUTE: '10000',
      ...overrides,
    }),
  );
  await app.listen({ port, host: '127.0.0.1' });
  return app;
}

export function cookieFrom(res: TestResponse, name: string): string | undefined {
  const c = res.cookies.find((x) => x.name === name);
  return c?.value;
}

export interface Session {
  accessToken: string;
  refresh: string;
  user: { id: string; role: string | null; email: string };
}

/**
 * Drive the full browser flow with inject(): /auth/login -> dev IdP authorize (form POST) ->
 * /auth/callback (server-side code exchange + PKCE) -> /auth/refresh.
 */
export async function signIn(
  app: TestApp,
  host: string,
  who: { oid: string } | { email: string; name?: string },
): Promise<Session> {
  const login = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/login?returnTo=/hub',
    headers: { host },
  });
  expect(login.statusCode).toBe(302);
  const authorize = new URL(login.headers.location as string);
  const oidcCookie = cookieFrom(login, 'rh_oidc')!;

  const form = new URLSearchParams(authorize.searchParams);
  if ('oid' in who) form.set('oid', who.oid);
  else {
    form.set('email', who.email);
    if (who.name) form.set('name', who.name);
  }
  const picked = await app.inject({
    method: 'POST',
    url: authorize.pathname,
    headers: { host: authorize.host, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form.toString(),
  });
  expect(picked.statusCode).toBe(302);
  const callback = new URL(picked.headers.location as string);

  const cb = await app.inject({
    method: 'GET',
    url: `${callback.pathname}${callback.search}`,
    headers: { host },
    cookies: { rh_oidc: oidcCookie },
  });
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toBe('/hub');
  const refresh = cookieFrom(cb, 'rh_refresh')!;
  expect(refresh).toBeTruthy();

  return refreshSession(app, host, refresh);
}

export async function refreshSession(
  app: TestApp,
  host: string,
  refresh: string,
): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: { host, origin: `http://${host}` },
    cookies: { rh_refresh: refresh },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<{ accessToken: string; user: Session['user'] }>();
  return {
    accessToken: body.accessToken,
    refresh: cookieFrom(res, 'rh_refresh') ?? refresh,
    user: body.user,
  };
}
