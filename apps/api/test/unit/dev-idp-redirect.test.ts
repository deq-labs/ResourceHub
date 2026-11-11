import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DevIdpService } from '../../src/modules/dev-idp/dev-idp.service.js';

const idp = (hosts = '') =>
  new DevIdpService(loadConfig({ NODE_ENV: 'test', DEV_IDP_REDIRECT_HOSTS: hosts }));

describe('dev IdP redirect allow-list', () => {
  it('allows *.localhost callbacks by default and nothing else', () => {
    const s = idp();
    expect(s.isAllowedRedirect('http://contoso.localhost:5173/api/v1/auth/callback')).toBe(true);
    expect(s.isAllowedRedirect('https://rh-contoso.vercel.app/api/v1/auth/callback')).toBe(false);
  });

  it('allows https callbacks on listed demo hosts only, on the exact callback path', () => {
    const s = idp(' RH-Contoso.vercel.app , rh-admin.vercel.app');
    expect(s.isAllowedRedirect('https://rh-contoso.vercel.app/api/v1/auth/callback')).toBe(true);
    expect(s.isAllowedRedirect('https://rh-admin.vercel.app/api/v1/auth/callback')).toBe(true);
    for (const bad of [
      'http://rh-contoso.vercel.app/api/v1/auth/callback', // not https
      'https://rh-contoso.vercel.app:8443/api/v1/auth/callback', // port
      'https://evil.example/api/v1/auth/callback', // unlisted host
      'https://rh-contoso.vercel.app.evil.example/api/v1/auth/callback', // suffix trick
      'https://user@rh-contoso.vercel.app/api/v1/auth/callback', // userinfo
      'https://rh-contoso.vercel.app/api/v1/auth/callback?next=https://evil.example', // query
      'https://rh-contoso.vercel.app/elsewhere', // path
      'not a url',
    ]) {
      expect(s.isAllowedRedirect(bad), bad).toBe(false);
    }
  });

  it('lets the sign-in form post back to listed hosts (CSP form-action)', () => {
    expect(idp('rh-contoso.vercel.app').pageCsp).toContain('https://rh-contoso.vercel.app');
    expect(idp().pageCsp).not.toContain('https://');
  });
});
