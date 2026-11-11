import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateDomain, Domain, DomainList } from '@resourcehub/contracts';
import { eq, schema } from '@resourcehub/db';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import { Idempotent } from '../../common/idempotency.interceptor.js';
import { problems } from '../../common/problem.js';
import { tenantOf } from '../../common/request.js';
import { Roles } from '../../common/roles.js';
import { DbService } from '../../infra/db.service.js';
import { actorFrom, AuditService } from '../audit/audit.service.js';
import { TenantResolverService } from '../tenants/tenant-resolver.service.js';

class DomainDto extends createZodDto(Domain) {}
class DomainListDto extends createZodDto(DomainList) {}
class CreateDomainDto extends createZodDto(CreateDomain) {}

const d = schema.tenantDomains;
type DomainRow = typeof d.$inferSelect;

export const challengeName = (hostname: string) => `_resourcehub-challenge.${hostname}`;
export const challengeValue = (token: string) => `resourcehub-verify=${token}`;

const toDto = (row: DomainRow) => ({
  id: row.id,
  hostname: row.hostname,
  verified: row.verifiedAt !== null,
  verifiedAt: row.verifiedAt?.toISOString() ?? null,
  isPrimary: row.isPrimary,
  verification: {
    type: 'TXT' as const,
    name: challengeName(row.hostname),
    value: challengeValue(row.verificationToken),
  },
});

/**
 * Custom domains. A domain routes traffic only after its owner proves control with a DNS TXT
 * record; until then app_resolve_tenant() ignores it. Every change invalidates the host cache.
 */
@ApiTags('domains')
@Controller('domains')
@Roles('admin')
export class DomainsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly resolver: TenantResolverService,
  ) {}

  @Get()
  @ZodResponse({ status: 200, type: DomainListDto })
  async list() {
    const rows = await this.db.withTenantTx((tx) => tx.select().from(d).orderBy(d.createdAt));
    return { data: rows.map(toDto) };
  }

  @Post()
  @Idempotent()
  @ZodResponse({ status: 201, type: DomainDto })
  async create(@Req() req: FastifyRequest, @Body() body: CreateDomainDto) {
    const { hostname } = body;
    const root = this.config.ROOT_DOMAIN;
    // `{slug}.{root}` hosts belong to the platform; deeper names (a.b.{root}) are fine for demos.
    const label = hostname.endsWith(`.${root}`) ? hostname.slice(0, -root.length - 1) : null;
    if (
      hostname === root ||
      hostname === this.config.PLATFORM_HOST ||
      (label !== null && !label.includes('.'))
    ) {
      throw problems.badRequest(`Use your own domain, not a *.${root} address.`);
    }
    const tenantId = tenantOf(req).id;
    return this.db.withTenantTx(async (tx) => {
      const [row] = await tx
        .insert(d)
        .values({ tenantId, hostname, verificationToken: randomBytes(16).toString('hex') })
        .returning()
        .catch((err: unknown) => {
          // Hostnames are globally unique; don't reveal which tenant holds it.
          if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
            throw problems.conflict('That hostname is already registered.');
          }
          throw err;
        });
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'domain.added',
        entity: 'domain',
        entityId: row!.id,
        diff: { hostname },
      });
      return toDto(row!);
    });
  }

  @Post(':id/verify')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: DomainDto })
  async verify(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string) {
    const tenantId = tenantOf(req).id;
    const row = await this.db.withTenantTx(async (tx) => {
      const [found] = await tx.select().from(d).where(eq(d.id, id));
      return found;
    });
    if (!row) throw problems.notFound();
    if (row.verifiedAt) return toDto(row);

    const ok = await this.checkTxt(row.hostname, challengeValue(row.verificationToken));
    if (!ok) {
      throw problems.badRequest(
        `TXT record not found. Add ${challengeName(row.hostname)} = "${challengeValue(row.verificationToken)}" and try again (DNS can take a few minutes).`,
      );
    }
    const updated = await this.db.withTenantTx(async (tx) => {
      const [u] = await tx
        .update(d)
        .set({ verifiedAt: new Date() })
        .where(eq(d.id, id))
        .returning();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'domain.verified',
        entity: 'domain',
        entityId: id,
        diff: { hostname: row.hostname },
      });
      return u!;
    });
    await this.resolver.invalidate(row.hostname);
    return toDto(updated);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const tenantId = tenantOf(req).id;
    const row = await this.db.withTenantTx(async (tx) => {
      const [deleted] = await tx.delete(d).where(eq(d.id, id)).returning();
      if (!deleted) throw problems.notFound();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'domain.removed',
        entity: 'domain',
        entityId: id,
        diff: { hostname: deleted.hostname },
      });
      return deleted;
    });
    await this.resolver.invalidate(row.hostname);
  }

  private async checkTxt(hostname: string, expected: string): Promise<boolean> {
    if (this.config.DOMAIN_VERIFICATION_MODE === 'dev' && /\.(localhost|test)$/.test(hostname))
      return true;
    try {
      const records = await resolveTxt(challengeName(hostname));
      return records.some((chunks) => chunks.join('') === expected);
    } catch {
      return false;
    }
  }
}
