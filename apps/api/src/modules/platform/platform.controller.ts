import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreatedTenant,
  CreateTenant,
  ImpersonationTicket,
  PlatformAuditPage,
  PlatformMemberList,
  PlatformTenantList,
  StartImpersonation,
  UpdateTenant,
  type PlatformTenant,
} from '@resourcehub/contracts';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  schema,
  sql,
  type SQL,
  type Tx,
} from '@resourcehub/db';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import { ForHost } from '../../common/host-scope.js';
import { Idempotent } from '../../common/idempotency.interceptor.js';
import { problems } from '../../common/problem.js';
import { authOf } from '../../common/request.js';
import { DbService } from '../../infra/db.service.js';
import { TokenService } from '../auth/token.service.js';
import { DEFAULT_COLORS } from '../branding/branding.service.js';
import { decodeCursor, encodeCursor } from '../resources/resources.service.js';
import { TenantResolverService } from '../tenants/tenant-resolver.service.js';

class TenantListDto extends createZodDto(PlatformTenantList) {}
class CreateTenantDto extends createZodDto(CreateTenant) {}
class CreatedTenantDto extends createZodDto(CreatedTenant) {}
class UpdateTenantDto extends createZodDto(UpdateTenant) {}
class MembersDto extends createZodDto(PlatformMemberList) {}
class StartImpersonationDto extends createZodDto(StartImpersonation) {}
class TicketDto extends createZodDto(ImpersonationTicket) {}
class PlatformAuditDto extends createZodDto(PlatformAuditPage) {}
class AuditQueryDto extends createZodDto(
  z.object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
) {}
class TenantPlatformDto extends createZodDto(PlatformTenantList.shape.data.element) {}

export const IMPERSONATION_TICKET_TTL = 60;

const t = schema.tenants;

/**
 * Platform super-admin API. Only on the admin host, only with a platform token, and every
 * database call goes through withPlatformTx(), which writes an audit row first.
 */
@ApiTags('platform')
@Controller('platform')
@ForHost('platform')
export class PlatformController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly resolver: TenantResolverService,
  ) {}

  private tenantUrl(slug: string, path = '/'): string {
    const port = this.config.NODE_ENV === 'production' ? '' : ':5173';
    return `${this.config.PUBLIC_SCHEME}://${slug}.${this.config.ROOT_DOMAIN}${port}${path}`;
  }

  private async loadTenants(tx: Tx, ids?: string[]): Promise<PlatformTenant[]> {
    const rows = await tx
      .select()
      .from(t)
      .where(ids ? inArray(t.id, ids) : undefined)
      .orderBy(t.name);
    if (rows.length === 0) return [];
    const tenantIds = rows.map((r) => r.id);
    const members = await tx
      .select({ tenantId: schema.memberships.tenantId, n: count() })
      .from(schema.memberships)
      .where(inArray(schema.memberships.tenantId, tenantIds))
      .groupBy(schema.memberships.tenantId);
    const resources = await tx
      .select({ tenantId: schema.resources.tenantId, n: count() })
      .from(schema.resources)
      .where(inArray(schema.resources.tenantId, tenantIds))
      .groupBy(schema.resources.tenantId);
    const domains = await tx
      .select()
      .from(schema.tenantDomains)
      .where(inArray(schema.tenantDomains.tenantId, tenantIds));
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      plan: r.plan,
      createdAt: r.createdAt.toISOString(),
      memberCount: members.find((x) => x.tenantId === r.id)?.n ?? 0,
      resourceCount: resources.find((x) => x.tenantId === r.id)?.n ?? 0,
      domains: domains
        .filter((d) => d.tenantId === r.id)
        .map((d) => ({ hostname: d.hostname, verified: d.verifiedAt !== null })),
    }));
  }

  @Get('tenants')
  @ZodResponse({ status: 200, type: TenantListDto })
  async list(@Req() req: FastifyRequest) {
    const data = await this.db.withPlatformTx(
      { actorId: authOf(req).id, action: 'platform.tenants_listed', ip: req.ip },
      (tx) => this.loadTenants(tx),
    );
    return { data };
  }

  @Post('tenants')
  @Idempotent()
  @ZodResponse({ status: 201, type: CreatedTenantDto })
  async create(@Req() req: FastifyRequest, @Body() body: CreateTenantDto) {
    if (TenantResolverService.isReservedSlug(body.slug))
      throw problems.badRequest('That slug is reserved.');
    const actorId = authOf(req).id;
    const inviteToken = TokenService.randomToken();
    const tenant = await this.db.withPlatformTx(
      {
        actorId,
        action: 'platform.tenant_created',
        ip: req.ip,
        entity: 'tenant',
        entityId: body.slug,
        diff: { name: body.name, plan: body.plan },
      },
      async (tx) => {
        const [row] = await tx
          .insert(t)
          .values({ slug: body.slug, name: body.name, plan: body.plan })
          .returning()
          .catch((err: unknown) => {
            if ((err as { cause?: { code?: string } }).cause?.code === '23505')
              throw problems.conflict('That slug is taken.');
            throw err;
          });
        await tx
          .insert(schema.tenantBranding)
          .values({ tenantId: row!.id, hubTitle: body.name, colors: DEFAULT_COLORS });
        await tx.insert(schema.invitations).values({
          tenantId: row!.id,
          email: body.ownerEmail,
          role: 'owner',
          tokenHash: TokenService.hash(inviteToken),
          invitedBy: actorId,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        });
        await tx.insert(schema.auditLog).values({
          tenantId: row!.id,
          actorId,
          action: 'tenant.created_by_platform',
          entity: 'tenant',
          entityId: row!.id,
          diff: { ownerEmail: body.ownerEmail },
          ip: req.ip,
        });
        return (await this.loadTenants(tx, [row!.id]))[0]!;
      },
    );
    await this.resolver.invalidate(`${body.slug}.${this.config.ROOT_DOMAIN}`);
    return {
      tenant,
      url: this.tenantUrl(body.slug),
      ownerInviteUrl: this.tenantUrl(body.slug, `/invite/${inviteToken}`),
    };
  }

  @Patch('tenants/:id')
  @ZodResponse({ status: 200, type: TenantPlatformDto })
  async update(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTenantDto,
  ) {
    const action =
      body.status === 'suspended'
        ? 'platform.tenant_suspended'
        : body.status === 'active'
          ? 'platform.tenant_reactivated'
          : 'platform.tenant_updated';
    const tenant = await this.db.withPlatformTx(
      {
        actorId: authOf(req).id,
        action,
        ip: req.ip,
        tenantId: id,
        entity: 'tenant',
        entityId: id,
        diff: { name: body.name, status: body.status, plan: body.plan },
      },
      async (tx) => {
        const [row] = await tx.update(t).set(body).where(eq(t.id, id)).returning();
        if (!row) throw problems.notFound();
        // A suspended tenant's live sessions end immediately.
        if (body.status === 'suspended') {
          await tx
            .update(schema.sessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(schema.sessions.tenantId, id), isNull(schema.sessions.revokedAt)));
        }
        return (await this.loadTenants(tx, [id]))[0]!;
      },
    );
    // Host cache holds status; drop it so suspension takes effect now, not in 5 minutes.
    await this.resolver.invalidate(`${tenant.slug}.${this.config.ROOT_DOMAIN}`);
    for (const d of tenant.domains) await this.resolver.invalidate(d.hostname);
    return tenant;
  }

  @Get('tenants/:id/members')
  @ZodResponse({ status: 200, type: MembersDto })
  async members(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string) {
    const rows = await this.db.withPlatformTx(
      { actorId: authOf(req).id, action: 'platform.members_listed', ip: req.ip, tenantId: id },
      (tx) =>
        tx
          .select({
            userId: schema.users.id,
            name: schema.users.name,
            email: schema.users.email,
            role: schema.memberships.role,
          })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(eq(schema.memberships.tenantId, id))
          .orderBy(schema.users.name),
    );
    return { data: rows };
  }

  /**
   * Start impersonation: verify the target, record the reason, and hand back a one-time,
   * 60-second ticket URL on the TENANT host. The tenant host redeems it for a session that
   * carries impersonator_id, so every action taken is attributed to both people.
   */
  @Post('impersonations')
  @Idempotent()
  @ZodResponse({ status: 201, type: TicketDto })
  async impersonate(@Req() req: FastifyRequest, @Body() body: StartImpersonationDto) {
    const admin = authOf(req);
    const target = await this.db.withPlatformTx(
      {
        actorId: admin.id,
        action: 'platform.impersonation_requested',
        ip: req.ip,
        tenantId: body.tenantId,
        entity: 'user',
        entityId: body.userId,
        reason: body.reason,
      },
      async (tx) => {
        const [row] = await tx
          .select({ slug: t.slug, status: t.status, role: schema.memberships.role })
          .from(schema.memberships)
          .innerJoin(t, eq(t.id, schema.memberships.tenantId))
          .where(
            and(
              eq(schema.memberships.tenantId, body.tenantId),
              eq(schema.memberships.userId, body.userId),
            ),
          );
        if (!row) throw problems.notFound('That user is not a member of the tenant.');
        if (row.status !== 'active') throw problems.badRequest('The tenant is suspended.');
        return row;
      },
    );
    const ticket = await this.tokens.signEphemeral(
      'impersonation',
      {
        jti: randomUUID(),
        tid: body.tenantId,
        sub: body.userId,
        act: admin.id,
        actName: admin.name,
        reason: body.reason,
      },
      IMPERSONATION_TICKET_TTL,
    );
    return {
      url: this.tenantUrl(
        target.slug,
        `/api/v1/auth/impersonate?ticket=${encodeURIComponent(ticket)}`,
      ),
      expiresAt: new Date(Date.now() + IMPERSONATION_TICKET_TTL * 1000).toISOString(),
    };
  }

  @Get('audit')
  @ZodResponse({ status: 200, type: PlatformAuditDto })
  async audit(@Req() req: FastifyRequest, @Query() q: AuditQueryDto) {
    const a = schema.auditLog;
    const cursor = decodeCursor(q.cursor);
    const conds: SQL[] = [
      sql`(${a.action} LIKE 'platform.%' OR ${a.diff} ->> 'platform' = 'true')`,
    ];
    if (cursor)
      conds.push(
        or(
          lt(a.createdAt, new Date(cursor.u)),
          and(eq(a.createdAt, new Date(cursor.u)), lt(a.id, cursor.i)),
        )!,
      );
    const rows = await this.db.withPlatformTx(
      { actorId: authOf(req).id, action: 'platform.audit_viewed', ip: req.ip },
      (tx) =>
        tx
          .select({ entry: a, actorName: schema.users.name, slug: t.slug })
          .from(a)
          .leftJoin(schema.users, eq(schema.users.id, a.actorId))
          .leftJoin(t, eq(t.id, a.tenantId))
          .where(and(...conds))
          .orderBy(desc(a.createdAt), desc(a.id))
          .limit(q.limit + 1),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      data: page.map(({ entry, actorName, slug }) => ({
        id: entry.id,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        actor: entry.actorId ? { id: entry.actorId, name: actorName } : null,
        impersonator: entry.impersonatorId ? { id: entry.impersonatorId } : null,
        diff: entry.diff,
        ip: entry.ip,
        createdAt: entry.createdAt.toISOString(),
        tenant: entry.tenantId && slug ? { id: entry.tenantId, slug } : null,
      })),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ u: last.entry.createdAt.toISOString(), i: last.entry.id })
          : null,
    };
  }
}

/** Kept here so the redeeming side (auth controller) and the issuing side agree on the shape. */
export interface ImpersonationClaims {
  jti: string;
  tid: string;
  sub: string;
  act: string;
  actName: string;
  reason: string;
}
