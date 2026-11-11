import { Injectable } from '@nestjs/common';
import type { Branding, UpdateBranding } from '@resourcehub/contracts';
import { eq, schema } from '@resourcehub/db';
import { DbService } from '../../infra/db.service.js';
import { StorageService } from '../../infra/storage.service.js';
import { TenantScopedCache } from '../../infra/tenant-cache.js';
import type { ResolvedTenant } from '../../common/site.js';
import { problems } from '../../common/problem.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';

const CACHE_KEY = 'branding';
const CACHE_TTL = 300;

export const DEFAULT_COLORS = {
  primary: '#2563eb',
  primaryForeground: '#ffffff',
  accent: '#f59e0b',
  background: '#f8fafc',
};

@Injectable()
export class BrandingService {
  constructor(
    private readonly db: DbService,
    private readonly cache: TenantScopedCache,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /** Theme tokens for the SPA's boot. Cached per tenant (key includes the tenant id). */
  async get(tenant: ResolvedTenant): Promise<Branding> {
    const cached = await this.cache.get<Branding>(tenant.id, CACHE_KEY).catch(() => undefined);
    if (cached) return cached;

    const row = await this.db.withTenantTx(async (tx) => {
      const [b] = await tx
        .select({ branding: schema.tenantBranding, logoPath: schema.files.blobPath })
        .from(schema.tenantBranding)
        .leftJoin(schema.files, eq(schema.files.id, schema.tenantBranding.logoFileId));
      return b;
    });
    const logoUrl = row?.logoPath
      ? (await this.storage.signedUrl(row.logoPath, 'read', 60 * 24)).url
      : null;
    const branding: Branding = {
      tenant: { name: tenant.name, slug: tenant.slug },
      hubTitle: row?.branding.hubTitle ?? tenant.name,
      tagline: row?.branding.tagline ?? null,
      colors: row?.branding.colors ?? DEFAULT_COLORS,
      font: (row?.branding.font as Branding['font'] | undefined) ?? 'Inter',
      logoUrl,
    };
    await this.cache.set(tenant.id, CACHE_KEY, branding, CACHE_TTL).catch(() => undefined);
    return branding;
  }

  async update(
    tenant: ResolvedTenant,
    actor: AuditActor,
    input: UpdateBranding,
  ): Promise<Branding> {
    await this.db.withTenantTx(async (tx) => {
      if (input.logoFileId) {
        const [file] = await tx
          .select()
          .from(schema.files)
          .where(eq(schema.files.id, input.logoFileId));
        if (!file || file.status !== 'ready' || !file.mime.startsWith('image/')) {
          throw problems.badRequest('Logo must be an uploaded image.');
        }
      }
      const [existing] = await tx.select().from(schema.tenantBranding);
      const values = {
        ...(input.hubTitle !== undefined ? { hubTitle: input.hubTitle } : {}),
        ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
        ...(input.colors ? { colors: input.colors } : {}),
        ...(input.font ? { font: input.font } : {}),
        ...(input.logoFileId !== undefined ? { logoFileId: input.logoFileId } : {}),
      };
      if (existing) {
        if (Object.keys(values).length) {
          await tx
            .update(schema.tenantBranding)
            .set(values)
            .where(eq(schema.tenantBranding.id, existing.id));
        }
      } else {
        await tx
          .insert(schema.tenantBranding)
          .values({ tenantId: tenant.id, colors: DEFAULT_COLORS, ...values });
      }
      await this.audit.record(tx, tenant.id, actor, {
        action: 'branding.updated',
        entity: 'branding',
        entityId: tenant.id,
        diff: { ...values },
      });
    });
    await this.cache.del(tenant.id, CACHE_KEY).catch(() => undefined);
    return this.get(tenant);
  }
}
