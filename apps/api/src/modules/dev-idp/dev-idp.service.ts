import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';

interface PendingCode {
  sub: string;
  email: string;
  name: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
  expiresAt: number;
}

/** Callback URLs the dev IdP will redirect to: any *.localhost host, the API's callback path. */
const REDIRECT_RE = /^https?:\/\/([a-z0-9-]+\.)*localhost(:\d+)?\/api\/v1\/auth\/callback$/;

/**
 * A real (if tiny) OpenID Connect provider for local demos: discovery, JWKS, authorization code
 * + PKCE S256, RS256 id_tokens. The API's OIDC client talks to it exactly as it would to Entra.
 * Never enabled in production (config refuses AUTH_PROVIDER=dev there).
 */
@Injectable()
export class DevIdpService {
  private keys?: Promise<{ privateKey: CryptoKey; jwk: JWK }>;
  private readonly codes = new Map<string, PendingCode>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get issuer(): string {
    return this.config.OIDC_ISSUER.replace(/\/$/, '');
  }

  private loadKeys() {
    this.keys ??= (async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
      const jwk = { ...(await exportJWK(publicKey)), kid: 'dev-idp-1', alg: 'RS256', use: 'sig' };
      return { privateKey, jwk };
    })();
    return this.keys;
  }

  discovery() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: `${this.issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'profile', 'email'],
    };
  }

  async jwks() {
    return { keys: [(await this.loadKeys()).jwk] };
  }

  /** Any *.localhost callback, or https on an explicitly listed demo host (DEV_IDP_REDIRECT_HOSTS). */
  isAllowedRedirect(uri: string): boolean {
    if (REDIRECT_RE.test(uri)) return true;
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    return (
      u.protocol === 'https:' &&
      u.port === '' &&
      u.username === '' &&
      u.search === '' &&
      u.hash === '' &&
      u.pathname === '/api/v1/auth/callback' &&
      this.config.DEV_IDP_REDIRECT_HOSTS.includes(u.hostname)
    );
  }

  /** form-action must also allow the redirect after the sign-in POST. */
  get pageCsp(): string {
    const hosted = this.config.DEV_IDP_REDIRECT_HOSTS.map((h) => ` https://${h}`).join('');
    return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://localhost:* http://*.localhost:*${hosted}; frame-ancestors 'none'`;
  }

  validateAuthorizeRequest(p: Record<string, string | undefined>): string | null {
    if (p.response_type !== 'code') return 'unsupported response_type';
    if (p.client_id !== this.config.OIDC_CLIENT_ID) return 'unknown client_id';
    if (!p.redirect_uri || !this.isAllowedRedirect(p.redirect_uri))
      return 'redirect_uri not allowed';
    if (p.code_challenge_method !== 'S256' || !p.code_challenge) return 'PKCE S256 is required';
    if (!p.state || !p.nonce) return 'state and nonce are required';
    return null;
  }

  issueCode(p: Omit<PendingCode, 'expiresAt'>): string {
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, { ...p, expiresAt: Date.now() + 60_000 });
    for (const [k, v] of this.codes) if (v.expiresAt < Date.now()) this.codes.delete(k);
    return code;
  }

  async redeem(p: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
  }): Promise<{
    id_token: string;
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
  } | null> {
    const pending = this.codes.get(p.code);
    this.codes.delete(p.code); // single use
    if (!pending || pending.expiresAt < Date.now()) return null;
    if (pending.redirectUri !== p.redirectUri || pending.clientId !== p.clientId) return null;
    const challenge = createHash('sha256').update(p.codeVerifier).digest('base64url');
    if (challenge !== pending.challenge) return null;

    const { privateKey } = await this.loadKeys();
    const idToken = await new SignJWT({
      email: pending.email,
      name: pending.name,
      oid: pending.sub,
      nonce: pending.nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'dev-idp-1' })
      .setIssuer(this.issuer)
      .setAudience(pending.clientId)
      .setSubject(pending.sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return {
      id_token: idToken,
      access_token: randomBytes(16).toString('base64url'),
      token_type: 'Bearer',
      expires_in: 300,
    };
  }

  static subjectForEmail(email: string): string {
    return `dev-email-${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16)}`;
  }
}
