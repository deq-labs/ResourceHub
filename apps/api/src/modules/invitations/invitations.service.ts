import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, schema, sql } from '@resourcehub/db';
import type {
  CreatedInvitation,
  CreateInvitation,
  Invitation,
  InvitationPreview,
  Role,
} from '@resourcehub/contracts';
import type { Redis } from 'ioredis';
import { APP_CONFIG, REDIS } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import { DbService } from '../../infra/db.service.js';
import { MailService } from '../../infra/mail.service.js';
import { TenantScopedCache } from '../../infra/tenant-cache.js';
import { ProblemException, problems } from '../../common/problem.js';
import { roleAtLeast } from '../../common/roles.js';
import type { AuthUser, ResolvedTenant } from '../../common/site.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { TokenService } from '../auth/token.service.js';

const INVITE_TTL_DAYS = 7;
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_WINDOW_SECONDS = 15 * 60;

type InvitationRow = typeof schema.invitations.$inferSelect;

function status(row: InvitationRow): Invitation['status'] {
  if (row.acceptedAt) return 'accepted';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() < Date.now()) return 'expired';
  return 'pending';
}

function toDto(row: InvitationRow, invitedBy: string | null): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: status(row),
    invitedBy,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  async list(): Promise<Invitation[]> {
    return this.db.withTenantTx(async (tx) => {
      const rows = await tx
        .select({ inv: schema.invitations, inviter: schema.users.name })
        .from(schema.invitations)
        .leftJoin(schema.users, eq(schema.users.id, schema.invitations.invitedBy))
        .orderBy(desc(schema.invitations.createdAt))
        .limit(200);
      return rows.map((r) => toDto(r.inv, r.inviter));
    });
  }

  async create(
    tenant: ResolvedTenant,
    host: string,
    auth: AuthUser,
    actor: AuditActor,
    input: CreateInvitation,
  ): Promise<CreatedInvitation> {
    // You can only grant a role up to your own (admins can't mint owners).
    if (!roleAtLeast(auth.role, input.role)) {
      throw problems.forbidden(`Only an ${input.role} or higher can invite an ${input.role}.`);
    }
    const token = TokenService.randomToken();
    const row = await this.db.withTenantTx(async (tx) => {
      const existing = await tx
        .select({ id: schema.users.id })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(sql`lower(${schema.users.email}) = ${input.email}`);
      if (existing.length > 0) throw problems.conflict(`${input.email} is already a member.`);

      // Re-inviting supersedes any pending invitation for the same address.
      await tx
        .update(schema.invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.invitations.email, input.email),
            isNull(schema.invitations.acceptedAt),
            isNull(schema.invitations.revokedAt),
          ),
        );
      const [created] = await tx
        .insert(schema.invitations)
        .values({
          tenantId: tenant.id,
          email: input.email,
          role: input.role,
          tokenHash: TokenService.hash(token),
          invitedBy: auth.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
        })
        .returning();
      await this.audit.record(tx, tenant.id, actor, {
        action: 'invitation.created',
        entity: 'invitation',
        entityId: created!.id,
        diff: { email: input.email, role: input.role },
      });
      return created!;
    });

    const acceptUrl = `${this.config.PUBLIC_SCHEME}://${host}/invite/${token}`;
    await this.mail.send({
      to: input.email,
      subject: `${auth.name} invited you to ${tenant.name} on ResourceHub`,
      text: `${auth.name} invited you to join ${tenant.name} as ${input.role}.\n\nAccept: ${acceptUrl}\n\nThis link expires in ${INVITE_TTL_DAYS} days and can be used once.`,
      html: `<p><strong>${escapeHtml(auth.name)}</strong> invited you to join <strong>${escapeHtml(tenant.name)}</strong> as <em>${input.role}</em>.</p><p><a href="${acceptUrl}">Accept the invitation</a></p><p style="color:#6b7280">This link expires in ${INVITE_TTL_DAYS} days and can be used once.</p>`,
    });
    return { ...toDto(row, auth.name), acceptUrl };
  }

  async revoke(id: string, tenantId: string, actor: AuditActor): Promise<void> {
    await this.db.withTenantTx(async (tx) => {
      const [row] = await tx
        .update(schema.invitations)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.invitations.id, id), isNull(schema.invitations.acceptedAt)))
        .returning();
      if (!row) throw problems.notFound();
      await this.audit.record(tx, tenantId, actor, {
        action: 'invitation.revoked',
        entity: 'invitation',
        entityId: id,
      });
    });
  }

  private failKey(tenantId: string, ip: string) {
    return TenantScopedCache.key(tenantId, `invite-fail:${ip}`);
  }

  /** Lockout after repeated bad tokens from one IP, so invitation links can't be brute-forced. */
  private async assertNotLocked(tenantId: string, ip: string): Promise<void> {
    const n = Number((await this.redis.get(this.failKey(tenantId, ip))) ?? 0);
    if (n >= MAX_FAILED_ATTEMPTS) {
      throw new ProblemException(
        429,
        'too-many-attempts',
        'Too many attempts',
        'Try again in 15 minutes.',
      );
    }
  }

  private async recordFailure(tenantId: string, ip: string): Promise<void> {
    const key = this.failKey(tenantId, ip);
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, FAILED_WINDOW_SECONDS);
  }

  private async findPending(token: string): Promise<InvitationRow | undefined> {
    return this.db.withTenantTx(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.invitations)
        .where(eq(schema.invitations.tokenHash, TokenService.hash(token)));
      return row && status(row) === 'pending' ? row : undefined;
    });
  }

  async preview(tenant: ResolvedTenant, token: string, ip: string): Promise<InvitationPreview> {
    await this.assertNotLocked(tenant.id, ip);
    const row = await this.findPending(token);
    if (!row) {
      await this.recordFailure(tenant.id, ip);
      throw problems.notFound('This invitation is invalid, used, or expired.');
    }
    return {
      workspace: tenant.name,
      role: row.role,
      emailHint: maskEmail(row.email),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async accept(
    tenant: ResolvedTenant,
    auth: AuthUser,
    actor: AuditActor,
    token: string,
  ): Promise<{ role: Role }> {
    await this.assertNotLocked(tenant.id, actor.ip ?? 'unknown');
    const row = await this.findPending(token);
    if (!row) {
      await this.recordFailure(tenant.id, actor.ip ?? 'unknown');
      throw problems.notFound('This invitation is invalid, used, or expired.');
    }
    if (row.email.toLowerCase() !== auth.email.toLowerCase()) {
      await this.recordFailure(tenant.id, actor.ip ?? 'unknown');
      throw problems.forbidden(
        `This invitation was sent to ${maskEmail(row.email)}. Sign in with that address.`,
      );
    }
    return this.db.withTenantTx(async (tx) => {
      // Single use: the conditional update means two concurrent accepts can't both win.
      const [claimed] = await tx
        .update(schema.invitations)
        .set({ acceptedAt: new Date(), acceptedBy: auth.id })
        .where(
          and(
            eq(schema.invitations.id, row.id),
            isNull(schema.invitations.acceptedAt),
            isNull(schema.invitations.revokedAt),
          ),
        )
        .returning();
      if (!claimed) throw problems.conflict('This invitation was already used.');
      await tx
        .insert(schema.memberships)
        .values({ tenantId: tenant.id, userId: auth.id, role: row.role })
        .onConflictDoNothing();
      await this.audit.record(tx, tenant.id, actor, {
        action: 'invitation.accepted',
        entity: 'invitation',
        entityId: row.id,
        diff: { role: row.role, email: row.email },
      });
      return { role: row.role };
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
