import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { TokenService, type AccessClaims } from '../modules/auth/token.service.js';
import { IS_PUBLIC } from './public.decorator.js';
import { problems } from './problem.js';
import type { AuthUser } from './site.js';

export const ALLOW_NON_MEMBER = 'resourcehub:allow-non-member';

/** Signed in, but not (yet) a member of this workspace: /me, accepting an invitation. */
export const AllowNonMember = () => SetMetadata(ALLOW_NON_MEMBER, true);

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/**
 * Layer 2 of tenant isolation. Deny by default: every route needs a valid access token unless
 * marked @Public(). On a tenant host the token must have been issued for THIS tenant and the
 * user must be a member; on the admin host it must be a platform token for a platform admin.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const isPublic =
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) ?? false;
    const allowNonMember =
      this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_NON_MEMBER, targets) ?? false;

    const token = bearer(req);
    if (!token) {
      if (isPublic) return true;
      throw problems.unauthorized();
    }

    let claims: AccessClaims;
    try {
      claims = await this.tokens.verifyAccess(token);
    } catch {
      if (isPublic) return true;
      throw problems.unauthorized('Access token is invalid or expired.');
    }

    const auth: AuthUser = {
      id: claims.sub,
      email: claims.email,
      name: claims.name,
      isPlatformAdmin: claims.pa,
      memberships: claims.mem.map((m) => ({ tenantId: m.t, role: m.r })),
      sessionId: claims.sid,
      ...(claims.act ? { impersonatorId: claims.act.sub, impersonatorName: claims.act.name } : {}),
    };

    const { site } = req;
    if (site.kind === 'platform') {
      if (claims.ctx !== 'platform' || !claims.pa)
        throw problems.forbidden('Platform access only.');
    } else if (site.kind === 'tenant') {
      if (claims.ctx !== 'tenant' || claims.tid !== site.tenant.id) {
        throw problems.forbidden('This token was issued for a different workspace.');
      }
      const role = claims.mem.find((m) => m.t === site.tenant.id)?.r;
      if (role) auth.role = role;
      else if (!allowNonMember && !isPublic)
        throw problems.forbidden('You are not a member of this workspace.');
    } else if (!isPublic) {
      throw problems.unknownHost();
    }

    req.auth = auth;
    return true;
  }
}
