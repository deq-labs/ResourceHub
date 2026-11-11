import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';

const Discovery = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  end_session_endpoint: z.string().optional(),
});
type Discovery = z.infer<typeof Discovery>;

const TokenResponse = z.object({ id_token: z.string() });

export interface OidcIdentity {
  /** Stable subject. Entra puts the object id in `oid`; other IdPs use `sub`. */
  oid: string;
  email: string;
  name: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Minimal OIDC relying party: discovery, authorization-code + PKCE (S256), id_token
 * validation against the IdP's JWKS. The same code path serves Entra External ID in Azure
 * and the built-in dev IdP locally; only OIDC_ISSUER / OIDC_CLIENT_ID change.
 */
@Injectable()
export class OidcClient {
  private readonly logger = new Logger(OidcClient.name);
  private discovery?: Promise<{ doc: Discovery; jwks: JWTVerifyGetKey }>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  static pkce(): PkcePair {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  static nonce(): string {
    return randomBytes(16).toString('base64url');
  }

  private load() {
    this.discovery ??= (async () => {
      const url = `${this.config.OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      const doc = Discovery.parse(await res.json());
      return { doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
    })().catch((err: unknown) => {
      this.discovery = undefined; // retry on the next login
      throw err;
    });
    return this.discovery;
  }

  async authorizationUrl(p: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    loginHint?: string;
  }): Promise<string> {
    const { doc } = await this.load();
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.OIDC_CLIENT_ID,
      redirect_uri: p.redirectUri,
      scope: this.config.OIDC_SCOPES,
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      ...(p.loginHint ? { login_hint: p.loginHint } : {}),
    }).toString();
    return url.toString();
  }

  async exchangeCode(p: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<OidcIdentity> {
    const { doc, jwks } = await this.load();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: this.config.OIDC_CLIENT_ID,
      code_verifier: p.codeVerifier,
      ...(this.config.OIDC_CLIENT_SECRET ? { client_secret: this.config.OIDC_CLIENT_SECRET } : {}),
    });
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      this.logger.warn({ status: res.status }, 'OIDC token exchange failed');
      throw new Error('token exchange failed');
    }
    const { id_token } = TokenResponse.parse(await res.json());
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer: doc.issuer,
      audience: this.config.OIDC_CLIENT_ID,
      maxTokenAge: '10 minutes',
    });
    if (payload.nonce !== p.nonce) throw new Error('id_token nonce mismatch');

    const claims = z
      .object({
        sub: z.string(),
        oid: z.string().optional(),
        email: z.string().optional(),
        preferred_username: z.string().optional(),
        name: z.string().optional(),
      })
      .parse(payload);
    const email = claims.email ?? claims.preferred_username;
    if (!email) throw new Error('id_token has no email claim');
    return { oid: claims.oid ?? claims.sub, email, name: claims.name ?? email };
  }
}
