import { Injectable } from '@nestjs/common';
import { newId, sql } from '@resourcehub/db';
import type { Role } from '@resourcehub/contracts';
import { DbService } from '../../infra/db.service.js';
import type { OidcIdentity } from './oidc.client.js';

export interface IdentityUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

export interface UserMembership {
  tenantId: string;
  slug: string;
  name: string;
  role: Role;
  status: 'active' | 'suspended';
}

/**
 * Global identity lookups that happen before (or across) tenants. Both go through narrow
 * SECURITY DEFINER functions, so the app role never needs BYPASSRLS.
 */
@Injectable()
export class IdentityService {
  constructor(private readonly db: DbService) {}

  async upsertFromIdp(identity: OidcIdentity): Promise<IdentityUser> {
    return this.db.withAppConnection(async (db) => {
      const res = await db.execute<{
        id: string;
        email: string;
        name: string;
        is_platform_admin: boolean;
      }>(
        sql`select * from app_upsert_user(${newId()}, ${identity.oid}, ${identity.email}, ${identity.name})`,
      );
      const row = res.rows[0];
      if (!row) throw new Error('app_upsert_user returned no row');
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        isPlatformAdmin: row.is_platform_admin,
      };
    });
  }

  async memberships(userId: string): Promise<UserMembership[]> {
    return this.db.withAppConnection(async (db) => {
      const res = await db.execute<{
        tenant_id: string;
        slug: string;
        name: string;
        role: Role;
        status: 'active' | 'suspended';
      }>(sql`select * from app_user_memberships(${userId})`);
      return res.rows.map((r) => ({
        tenantId: r.tenant_id,
        slug: r.slug,
        name: r.name,
        role: r.role,
        status: r.status,
      }));
    });
  }
}
