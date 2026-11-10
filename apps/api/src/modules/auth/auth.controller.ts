import { Controller, Get, HttpCode, Inject, Logger, Post, Query, Req, Res } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { runWithTenant } from '@resourcehub/db';
import { SessionResponse } from '@resourcehub/contracts';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import { ForHost } from '../../common/host-scope.js';
import { Public } from '../../common/public.decorator.js';
import { problems } from '../../common/problem.js';
import { DbService } from '../../infra/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from './auth.service.js';
import { IdentityService } from './identity.service.js';
import { OidcClient } from './oidc.client.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

class SessionResponseDto extends createZodDto(SessionResponse) {}

export const REFRESH_COOKIE = 'rh_refresh';
const OIDC_COOKIE = 'rh_oidc';
const AUTH_PATH = '/api/v1/auth';

const LoginQuery = z.object({
  returnTo: z.string().max(500).optional(),
  loginHint: z.email().optional(),
});
const CallbackQuery = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(200).optional(),
  error: z.string().max(200).optional(),
});
interface OidcState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  host: string;
}

/** Only same-origin relative paths: blocks open redirects like `//evil.com` or `https://...`. */
export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return '/';
  return value;
}

const authRateLimit = { rateTier: 'auth' };

@ApiTags('auth')
@Controller('auth')
@ForHost('site')
@Public()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly oidc: OidcClient,
    private readonly tokens: TokenService,
    private readonly identity: IdentityService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly db: DbService,
  ) {}

  private callbackUrl(req: FastifyRequest): string {
    return `${this.config.PUBLIC_SCHEME}://${req.host}${AUTH_PATH}/callback`;
  }

  private cookieBase() {
    return { httpOnly: true, secure: this.config.COOKIE_SECURE, sameSite: 'lax' as const };
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    void reply.setCookie(REFRESH_COOKIE, token, {
      ...this.cookieBase(),
      path: AUTH_PATH,
      maxAge: this.config.REFRESH_TOKEN_TTL_DAYS * 86_400,
    });
  }

  /** CSRF defence for cookie-authenticated POSTs, on top of SameSite=Lax. */
  private assertSameOrigin(req: FastifyRequest): void {
    const origin = req.headers.origin;
    if (!origin) return; // non-browser clients; SameSite still protects browsers
    try {
      if (new URL(origin).host !== req.host)
        throw problems.forbidden('Cross-origin request rejected.');
    } catch {
      throw problems.forbidden('Cross-origin request rejected.');
    }
  }

  private meta(req: FastifyRequest) {
    return { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
  }

  /** Step 1: redirect to the identity provider with PKCE + state + nonce. */
  @Get('login')
  @RouteConfig(authRateLimit)
  async login(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query() query: unknown,
  ): Promise<void> {
    const q = LoginQuery.parse(query);
    const pkce = OidcClient.pkce();
    const st: OidcState = {
      state: OidcClient.nonce(),
      nonce: OidcClient.nonce(),
      verifier: pkce.verifier,
      returnTo: safeReturnTo(q.returnTo),
      host: req.host,
    };
    const url = await this.oidc.authorizationUrl({
      redirectUri: this.callbackUrl(req),
      state: st.state,
      nonce: st.nonce,
      codeChallenge: pkce.challenge,
      ...(q.loginHint ? { loginHint: q.loginHint } : {}),
    });
    void reply.setCookie(OIDC_COOKIE, await this.tokens.signEphemeral('oidc', { ...st }, 600), {
      ...this.cookieBase(),
      path: `${AUTH_PATH}/callback`,
      maxAge: 600,
    });
    return reply.redirect(url, 302);
  }

  /** Step 2: the IdP redirects back with a code; exchange it, create a session, set the cookie. */
  @Get('callback')
  @RouteConfig(authRateLimit)
  async callback(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query() query: unknown,
  ): Promise<void> {
    const fail = (reason: string) => {
      void reply.clearCookie(OIDC_COOKIE, { path: `${AUTH_PATH}/callback` });
      return reply.redirect(`/signin?error=${encodeURIComponent(reason)}`, 302);
    };
    const q = CallbackQuery.safeParse(query);
    if (!q.success || q.data.error || !q.data.code || !q.data.state)
      return fail('signin_cancelled');

    const cookie = req.cookies[OIDC_COOKIE];
    if (!cookie) return fail('signin_expired');
    let st: OidcState;
    try {
      st = await this.tokens.verifyEphemeral<OidcState>('oidc', cookie);
    } catch {
      return fail('signin_expired');
    }
    if (st.state !== q.data.state || st.host !== req.host) return fail('signin_state_mismatch');

    let identity;
    try {
      identity = await this.oidc.exchangeCode({
        code: q.data.code,
        redirectUri: this.callbackUrl(req),
        codeVerifier: st.verifier,
        nonce: st.nonce,
      });
    } catch (err) {
      this.logger.warn({ err }, 'OIDC callback failed');
      return fail('signin_failed');
    }
    const user = await this.identity.upsertFromIdp(identity);
    const meta = this.meta(req);

    if (req.site.kind === 'platform') {
      if (!user.isPlatformAdmin) return fail('not_platform_admin');
      const { refreshToken } = await this.sessions.createPlatformSession(user.id, meta);
      this.setRefreshCookie(reply, refreshToken);
    } else if (req.site.kind === 'tenant') {
      const tenantId = req.site.tenant.id;
      const { refreshToken } = await runWithTenant({ tenantId, userId: user.id }, async () => {
        const created = await this.sessions.createTenantSession(tenantId, user.id, meta);
        await this.db.withTenantTx((tx) =>
          this.audit.record(
            tx,
            tenantId,
            { actorId: user.id, impersonatorId: null, ip: req.ip },
            {
              action: 'auth.login',
              entity: 'session',
              entityId: created.session.id,
            },
          ),
        );
        return created;
      });
      this.setRefreshCookie(reply, refreshToken);
    } else {
      throw problems.unknownHost();
    }

    void reply.clearCookie(OIDC_COOKIE, { path: `${AUTH_PATH}/callback` });
    return reply.redirect(st.returnTo, 302);
  }

  /** Rotate the refresh cookie and mint a 15-minute access token. Called at SPA boot and before expiry. */
  @Post('refresh')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: SessionResponseDto })
  @RouteConfig(authRateLimit)
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    this.assertSameOrigin(req);
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw problems.unauthorized('No session.');
    const meta = this.meta(req);

    const result =
      req.site.kind === 'tenant'
        ? await this.sessions.rotateTenantSession(req.site.tenant.id, token, meta)
        : await this.sessions.rotatePlatformSession(token, meta);

    if (result.kind === 'invalid' || result.kind === 'reuse') {
      void reply.clearCookie(REFRESH_COOKIE, { path: AUTH_PATH });
      throw problems.unauthorized('Session expired. Sign in again.');
    }
    if (result.kind === 'rotated') this.setRefreshCookie(reply, result.refreshToken);

    return req.site.kind === 'tenant'
      ? this.auth.issueForTenant(req.site.tenant.id, result.session)
      : this.auth.issueForPlatform(result.session);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    this.assertSameOrigin(req);
    const token = req.cookies[REFRESH_COOKIE];
    void reply.clearCookie(REFRESH_COOKIE, { path: AUTH_PATH });
    if (!token) return;
    if (req.site.kind === 'tenant') {
      const tenantId = req.site.tenant.id;
      const s = await this.sessions.revokeTenantSession(token);
      if (s) {
        await this.db.withTenantTx((tx) =>
          this.audit.record(
            tx,
            tenantId,
            { actorId: s.userId, impersonatorId: s.impersonatorId, ip: req.ip },
            {
              action: 'auth.logout',
              entity: 'session',
              entityId: s.familyId,
            },
          ),
        );
      }
    } else {
      await this.sessions.revokePlatformSession(token, {
        actorId: null,
        impersonatorId: null,
        ip: req.ip,
      });
    }
  }
}
