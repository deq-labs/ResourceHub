import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AuditPage,
  AuditQuery,
  Member,
  MemberList,
  UpdateMember,
  type Role,
} from '@resourcehub/contracts';
import { and, desc, eq, like, lt, or, schema, type SQL } from '@resourcehub/db';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { problems } from '../../common/problem.js';
import { authOf, tenantOf } from '../../common/request.js';
import { Roles } from '../../common/roles.js';
import { DbService } from '../../infra/db.service.js';
import { actorFrom, AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import { decodeCursor, encodeCursor } from '../resources/resources.service.js';

class MemberListDto extends createZodDto(MemberList) {}
class MemberDto extends createZodDto(Member) {}
class UpdateMemberDto extends createZodDto(UpdateMember) {}
class AuditPageDto extends createZodDto(AuditPage) {}
class AuditQueryDto extends createZodDto(AuditQuery) {}

const m = schema.memberships;
const u = schema.users;
const a = schema.auditLog;

/** Tenant admin: people, roles and the audit trail. Owners outrank admins. */
@ApiTags('admin')
@Controller()
@Roles('admin')
export class AdminController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  @Get('members')
  @ZodResponse({ status: 200, type: MemberListDto })
  async members() {
    const rows = await this.db.withTenantTx((tx) =>
      tx
        .select({
          userId: u.id,
          name: u.name,
          email: u.email,
          role: m.role,
          joinedAt: m.createdAt,
          lastLoginAt: u.lastLoginAt,
        })
        .from(m)
        .innerJoin(u, eq(u.id, m.userId))
        .orderBy(u.name),
    );
    return {
      data: rows.map((r) => ({
        ...r,
        joinedAt: r.joinedAt.toISOString(),
        lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
      })),
    };
  }

  @Patch('members/:userId')
  @ZodResponse({ status: 200, type: MemberDto })
  async updateMember(
    @Req() req: FastifyRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateMemberDto,
  ) {
    const auth = authOf(req);
    const tenantId = tenantOf(req).id;
    if (userId === auth.id) throw problems.badRequest("You can't change your own role.");
    return this.db.withTenantTx(async (tx) => {
      const [current] = await tx
        .select({
          role: m.role,
          name: u.name,
          email: u.email,
          joinedAt: m.createdAt,
          lastLoginAt: u.lastLoginAt,
        })
        .from(m)
        .innerJoin(u, eq(u.id, m.userId))
        .where(eq(m.userId, userId))
        .for('update', { of: m });
      if (!current) throw problems.notFound();
      this.assertCanManage(auth.role, current.role, body.role);
      if (current.role === 'owner' && body.role !== 'owner') await this.assertNotLastOwner(tx);
      await tx.update(m).set({ role: body.role }).where(eq(m.userId, userId));
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'membership.role_changed',
        entity: 'user',
        entityId: userId,
        diff: { from: current.role, to: body.role, email: current.email },
      });
      return {
        userId,
        name: current.name,
        email: current.email,
        role: body.role,
        joinedAt: current.joinedAt.toISOString(),
        lastLoginAt: current.lastLoginAt?.toISOString() ?? null,
      };
    });
  }

  @Delete('members/:userId')
  @HttpCode(204)
  async removeMember(
    @Req() req: FastifyRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    const auth = authOf(req);
    const tenantId = tenantOf(req).id;
    if (userId === auth.id) throw problems.badRequest("You can't remove yourself.");
    await this.db.withTenantTx(async (tx) => {
      const [current] = await tx
        .select({ role: m.role })
        .from(m)
        .where(eq(m.userId, userId))
        .for('update');
      if (!current) throw problems.notFound();
      this.assertCanManage(auth.role, current.role, current.role);
      if (current.role === 'owner') await this.assertNotLastOwner(tx);
      await tx.delete(m).where(eq(m.userId, userId));
      // Removed members can't mint new access tokens: kill their refresh sessions here.
      await this.sessions.revokeUserSessions(tx, userId);
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'membership.removed',
        entity: 'user',
        entityId: userId,
        diff: { role: current.role },
      });
    });
  }

  @Get('audit')
  @ZodResponse({ status: 200, type: AuditPageDto })
  async auditLog(@Query() q: AuditQueryDto) {
    const cursor = decodeCursor(q.cursor);
    const conds: SQL[] = [];
    if (q['filter[action]'])
      conds.push(like(a.action, `${q['filter[action]'].replace(/[%_\\]/g, '\\$&')}%`));
    if (q['filter[actor]']) conds.push(eq(a.actorId, q['filter[actor]']));
    if (cursor) {
      conds.push(
        or(
          lt(a.createdAt, new Date(cursor.u)),
          and(eq(a.createdAt, new Date(cursor.u)), lt(a.id, cursor.i)),
        )!,
      );
    }
    const rows = await this.db.withTenantTx((tx) =>
      tx
        .select({ entry: a, actorName: u.name })
        .from(a)
        .leftJoin(u, eq(u.id, a.actorId))
        .where(and(...conds))
        .orderBy(desc(a.createdAt), desc(a.id))
        .limit(q.limit + 1),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      data: page.map(({ entry, actorName }) => ({
        id: entry.id,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        actor: entry.actorId ? { id: entry.actorId, name: actorName } : null,
        impersonator: entry.impersonatorId ? { id: entry.impersonatorId } : null,
        diff: entry.diff,
        ip: entry.ip,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ u: last.entry.createdAt.toISOString(), i: last.entry.id })
          : null,
    };
  }

  /** Only owners may touch owners or grant ownership. */
  private assertCanManage(actorRole: string | undefined, targetRole: Role, newRole: Role): void {
    if ((targetRole === 'owner' || newRole === 'owner') && actorRole !== 'owner') {
      throw problems.forbidden('Only an owner can change an owner, or make someone an owner.');
    }
  }

  private async assertNotLastOwner(
    tx: Parameters<Parameters<DbService['withTenantTx']>[0]>[0],
  ): Promise<void> {
    const owners = await tx.select({ id: m.id }).from(m).where(eq(m.role, 'owner'));
    if (owners.length <= 1) throw problems.conflict('A workspace must keep at least one owner.');
  }
}
