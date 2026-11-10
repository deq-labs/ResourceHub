import { Injectable } from '@nestjs/common';
import { eq, schema, sql } from '@resourcehub/db';
import type { SessionResponse, SessionUser } from '@resourcehub/contracts';
import { DbService } from '../../infra/db.service.js';
import { problems } from '../../common/problem.js';
import { IdentityService } from './identity.service.js';
import type { SessionRecord } from './session.service.js';
import { TokenService, type AccessClaims } from './token.service.js';

/** Turns a session into an access token + the SPA's view of the signed-in user. */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly identity: IdentityService,
    private readonly tokens: TokenService,
  ) {}

  async issueForTenant(tenantId: string, session: SessionRecord): Promise<SessionResponse> {
    const user = await this.db.withTenantTx(async (tx) => {
      // The user may not be a member yet (invitation flow), so read them via the self policy.
      await tx.execute(sql`select set_config('app.user_id', ${session.userId}, true)`);
      const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, session.userId));
      return u;
    });
    if (!user) throw problems.unauthorized();

    const memberships = await this.identity.memberships(user.id);
    const here = memberships.find((m) => m.tenantId === tenantId);

    let impersonatedBy: SessionUser['impersonatedBy'] = null;
    if (session.impersonatorId) {
      const impersonatorId = session.impersonatorId;
      impersonatedBy = await this.db.withPlatformTx(
        {
          actorId: impersonatorId,
          action: 'platform.impersonation_token_issued',
          tenantId,
          entity: 'user',
          entityId: user.id,
        },
        async (tx) => {
          const [admin] = await tx
            .select({ id: schema.users.id, name: schema.users.name })
            .from(schema.users)
            .where(eq(schema.users.id, impersonatorId));
          return admin ?? null;
        },
      );
    }

    const claims: AccessClaims = {
      sub: user.id,
      email: user.email,
      name: user.name,
      sid: session.id,
      ctx: 'tenant',
      tid: tenantId,
      mem: memberships.map((m) => ({ t: m.tenantId, r: m.role })),
      // Platform powers are never granted on a tenant host.
      pa: false,
      ...(impersonatedBy ? { act: { sub: impersonatedBy.id, name: impersonatedBy.name } } : {}),
    };
    return {
      accessToken: await this.tokens.signAccess(claims),
      expiresIn: this.tokens.accessTtlSeconds,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: here?.role ?? null,
        isPlatformAdmin: user.isPlatformAdmin,
        impersonatedBy,
      },
    };
  }

  async issueForPlatform(session: SessionRecord): Promise<SessionResponse> {
    const user = await this.db.withPlatformTx(
      { actorId: session.userId, action: 'platform.token_issued' },
      async (tx) => {
        const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, session.userId));
        return u;
      },
    );
    if (!user?.isPlatformAdmin) throw problems.forbidden('Platform access is restricted.');
    const claims: AccessClaims = {
      sub: user.id,
      email: user.email,
      name: user.name,
      sid: session.id,
      ctx: 'platform',
      mem: [],
      pa: true,
    };
    return {
      accessToken: await this.tokens.signAccess(claims),
      expiresIn: this.tokens.accessTtlSeconds,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: null,
        isPlatformAdmin: true,
        impersonatedBy: null,
      },
    };
  }
}
