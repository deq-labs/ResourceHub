import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';

const ISSUER = 'resourcehub-api';
const AUDIENCE = 'resourcehub';

/** Claims in the API-issued access token (15 minutes, held in SPA memory only). */
export interface AccessClaims {
  sub: string;
  email: string;
  name: string;
  /** Session id (refresh-token family member) that minted this token. */
  sid: string;
  /** Which host kind the token was issued on. Tenant tokens never work on the admin host. */
  ctx: 'tenant' | 'platform';
  /** Tenant the token was issued for (tenant ctx only). */
  tid?: string;
  /** Every membership the user holds, as of issue time. */
  mem: { t: string; r: string }[];
  pa: boolean;
  /** RFC 8693 actor claim: the platform admin impersonating this user. */
  act?: { sub: string; name: string };
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.key = new TextEncoder().encode(config.AUTH_JWT_SECRET);
  }

  get accessTtlSeconds(): number {
    return this.config.ACCESS_TOKEN_TTL_SECONDS;
  }

  async signAccess(claims: AccessClaims): Promise<string> {
    const { sub, ...rest } = claims;
    return new SignJWT({ ...rest })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${this.config.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      typ: 'at+jwt',
    });
    return payload as unknown as AccessClaims & JWTPayload;
  }

  /** Short-lived signed blob for OIDC state/PKCE (cookie) and impersonation hand-off tickets. */
  async signEphemeral(
    purpose: string,
    data: Record<string, unknown>,
    ttlSeconds: number,
  ): Promise<string> {
    return new SignJWT({ ...data, purpose })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(`${AUDIENCE}:${purpose}`)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.key);
  }

  async verifyEphemeral<T>(purpose: string, token: string): Promise<T> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: ISSUER,
      audience: `${AUDIENCE}:${purpose}`,
      algorithms: ['HS256'],
    });
    return payload as T;
  }

  static randomToken(): string {
    return randomBytes(32).toString('base64url');
  }

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
