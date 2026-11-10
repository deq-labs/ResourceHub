import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { MeResponse, UpdateMe } from '@resourcehub/contracts';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { eq, schema } from '@resourcehub/db';
import { AllowNonMember } from '../../common/auth.guard.js';
import { ForHost } from '../../common/host-scope.js';
import { authOf } from '../../common/request.js';
import { problems } from '../../common/problem.js';
import { DbService } from '../../infra/db.service.js';
import { actorFrom, AuditService } from '../audit/audit.service.js';
import { IdentityService } from '../auth/identity.service.js';
import type { Role } from '@resourcehub/contracts';

class MeDto extends createZodDto(MeResponse) {}
class UpdateMeDto extends createZodDto(UpdateMe) {}

@Controller('me')
@ForHost('site')
@AllowNonMember()
export class MeController {
  constructor(
    private readonly identity: IdentityService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ZodResponse({ type: MeDto })
  async me(@Req() req: FastifyRequest) {
    const auth = authOf(req);
    const memberships = await this.identity.memberships(auth.id);
    return {
      user: {
        id: auth.id,
        email: auth.email,
        name: auth.name,
        role: (auth.role as Role | undefined) ?? null,
        isPlatformAdmin: auth.isPlatformAdmin || req.site.kind === 'platform',
        impersonatedBy: auth.impersonatorId
          ? { id: auth.impersonatorId, name: auth.impersonatorName ?? 'Platform admin' }
          : null,
      },
      workspaces: memberships
        .filter((m) => m.status === 'active')
        .map((m) => ({ tenantId: m.tenantId, slug: m.slug, name: m.name, role: m.role })),
    };
  }

  @Patch()
  @ZodResponse({ type: MeDto })
  async update(@Req() req: FastifyRequest, @Body() body: UpdateMeDto) {
    if (req.site.kind !== 'tenant') throw problems.notFound();
    const auth = authOf(req);
    const tenantId = req.site.tenant.id;
    await this.db.withTenantTx(async (tx) => {
      await tx.update(schema.users).set({ name: body.name }).where(eq(schema.users.id, auth.id));
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'user.profile_updated',
        entity: 'user',
        entityId: auth.id,
        diff: { name: body.name },
      });
    });
    req.auth = { ...auth, name: body.name };
    return this.me(req);
  }
}
