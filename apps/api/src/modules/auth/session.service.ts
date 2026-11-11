import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, newId, schema, type Tx } from '@resourcehub/db';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import { DbService } from '../../infra/db.service.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { TokenService } from './token.service.js';

/** A refresh racing another refresh (two tabs, React StrictMode) within this window is benign. */
const REUSE_GRACE_MS = 10_000;

export interface SessionRecord {
  id: string;
  userId: string;
  familyId: string;
  impersonatorId: string | null;
}

export type RotateResult =
  | { kind: 'rotated'; session: SessionRecord; refreshToken: string }
  | { kind: 'grace'; session: SessionRecord }
  | { kind: 'invalid' }
  | { kind: 'reuse'; familyId: string; userId: string };

interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Rotating refresh tokens, stored hashed. Tenant sessions live under RLS in `sessions`;
 * admin-host sessions live in `platform_sessions`, which only the platform role can touch.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private expiry(): Date {
    return new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  }

  // ---- tenant host --------------------------------------------------------------------------

  async createTenantSession(
    tenantId: string,
    userId: string,
    meta: SessionMeta,
    impersonatorId: string | null = null,
  ): Promise<{ session: SessionRecord; refreshToken: string }> {
    const refreshToken = TokenService.randomToken();
    const session = await this.db.withTenantTx(async (tx) => {
      const [row] = await tx
        .insert(schema.sessions)
        .values({
          tenantId,
          userId,
          familyId: newId(),
          tokenHash: TokenService.hash(refreshToken),
          expiresAt: this.expiry(),
          impersonatorId,
          ip: meta.ip,
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
        })
        .returning();
      return row!;
    });
    return { session, refreshToken };
  }

  async rotateTenantSession(
    tenantId: string,
    token: string,
    meta: SessionMeta,
  ): Promise<RotateResult> {
    const result = await this.db.withTenantTx(async (tx): Promise<RotateResult> => {
      const [s] = await tx
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.tokenHash, TokenService.hash(token)))
        .for('update');
      if (!s) return { kind: 'invalid' };
      if (s.revokedAt) {
        if (!s.replacedBy) return { kind: 'invalid' };
        if (Date.now() - s.revokedAt.getTime() < REUSE_GRACE_MS) {
          const [next] = await tx
            .select()
            .from(schema.sessions)
            .where(eq(schema.sessions.id, s.replacedBy));
          return next && !next.revokedAt ? { kind: 'grace', session: next } : { kind: 'invalid' };
        }
        // A rotated-out token came back: assume theft and kill the whole family.
        await tx
          .update(schema.sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(schema.sessions.familyId, s.familyId), isNull(schema.sessions.revokedAt)));
        await this.audit.record(
          tx,
          tenantId,
          { actorId: s.userId, impersonatorId: null, ip: meta.ip },
          {
            action: 'auth.refresh_reuse_detected',
            entity: 'session',
            entityId: s.familyId,
          },
        );
        return { kind: 'reuse', familyId: s.familyId, userId: s.userId };
      }
      if (s.expiresAt.getTime() < Date.now()) return { kind: 'invalid' };

      const refreshToken = TokenService.randomToken();
      const id = newId();
      const [next] = await tx
        .insert(schema.sessions)
        .values({
          id,
          tenantId,
          userId: s.userId,
          familyId: s.familyId,
          tokenHash: TokenService.hash(refreshToken),
          expiresAt: this.expiry(),
          impersonatorId: s.impersonatorId,
          ip: meta.ip,
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
        })
        .returning();
      await tx
        .update(schema.sessions)
        .set({ revokedAt: new Date(), replacedBy: id })
        .where(eq(schema.sessions.id, s.id));
      return { kind: 'rotated', session: next!, refreshToken };
    });
    return result;
  }

  async revokeTenantSession(token: string): Promise<SessionRecord | undefined> {
    return this.db.withTenantTx(async (tx) => {
      const [s] = await tx
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.tokenHash, TokenService.hash(token)));
      if (!s) return undefined;
      await revokeFamily(tx, s.familyId);
      return s;
    });
  }

  /** Revoke every session a user has in the current tenant (role change, removal). */
  async revokeUserSessions(tx: Tx, userId: string): Promise<void> {
    await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
  }

  // ---- platform admin host ------------------------------------------------------------------

  async createPlatformSession(
    userId: string,
    meta: SessionMeta,
  ): Promise<{ session: SessionRecord; refreshToken: string }> {
    const refreshToken = TokenService.randomToken();
    const session = await this.db.withPlatformTx(
      { actorId: userId, action: 'platform.login', ip: meta.ip },
      async (tx) => {
        const [row] = await tx
          .insert(schema.platformSessions)
          .values({
            userId,
            familyId: newId(),
            tokenHash: TokenService.hash(refreshToken),
            expiresAt: this.expiry(),
            ip: meta.ip,
            userAgent: meta.userAgent?.slice(0, 300) ?? null,
          })
          .returning();
        return row!;
      },
    );
    return { session: { ...session, impersonatorId: null }, refreshToken };
  }

  async rotatePlatformSession(token: string, meta: SessionMeta): Promise<RotateResult> {
    return this.db.withPlatformTx(
      { actorId: null, action: 'platform.session_refresh', ip: meta.ip },
      async (tx): Promise<RotateResult> => {
        const t = schema.platformSessions;
        const [s] = await tx
          .select()
          .from(t)
          .where(eq(t.tokenHash, TokenService.hash(token)))
          .for('update');
        if (!s) return { kind: 'invalid' };
        if (s.revokedAt) {
          if (s.replacedBy && Date.now() - s.revokedAt.getTime() < REUSE_GRACE_MS) {
            const [next] = await tx.select().from(t).where(eq(t.id, s.replacedBy));
            return next && !next.revokedAt
              ? { kind: 'grace', session: { ...next, impersonatorId: null } }
              : { kind: 'invalid' };
          }
          if (s.replacedBy) {
            await tx
              .update(t)
              .set({ revokedAt: new Date() })
              .where(and(eq(t.familyId, s.familyId), isNull(t.revokedAt)));
            return { kind: 'reuse', familyId: s.familyId, userId: s.userId };
          }
          return { kind: 'invalid' };
        }
        if (s.expiresAt.getTime() < Date.now()) return { kind: 'invalid' };
        const refreshToken = TokenService.randomToken();
        const id = newId();
        const [next] = await tx
          .insert(t)
          .values({
            id,
            userId: s.userId,
            familyId: s.familyId,
            tokenHash: TokenService.hash(refreshToken),
            expiresAt: this.expiry(),
            ip: meta.ip,
            userAgent: meta.userAgent?.slice(0, 300) ?? null,
          })
          .returning();
        await tx.update(t).set({ revokedAt: new Date(), replacedBy: id }).where(eq(t.id, s.id));
        return { kind: 'rotated', session: { ...next!, impersonatorId: null }, refreshToken };
      },
    );
  }

  async revokePlatformSession(token: string, actor: AuditActor): Promise<void> {
    await this.db.withPlatformTx(
      { actorId: actor.actorId, action: 'platform.logout', ip: actor.ip },
      async (tx) => {
        const t = schema.platformSessions;
        const [s] = await tx
          .select()
          .from(t)
          .where(eq(t.tokenHash, TokenService.hash(token)));
        if (s)
          await tx
            .update(t)
            .set({ revokedAt: new Date() })
            .where(and(eq(t.familyId, s.familyId), isNull(t.revokedAt)));
      },
    );
  }
}

async function revokeFamily(tx: Tx, familyId: string): Promise<void> {
  await tx
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.familyId, familyId), isNull(schema.sessions.revokedAt)));
}
