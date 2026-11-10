import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../schema/index.js';
import { DEMO_TENANTS, DEMO_USERS } from './demo-data.js';

export type SeedDb = ReturnType<typeof drizzle<typeof schema>>;

/** Extra seeding steps registered by later phases (content, branding, integrations). */
export type SeedStep = (db: SeedDb) => Promise<void>;

/**
 * Reset and seed the demo tenants. Runs as resourcehub_platform (BYPASSRLS): seeding is a
 * cross-tenant operation, and FORCE RLS would block even the table owner.
 */
export async function seedDemo(platformUrl: string, steps: SeedStep[] = []): Promise<void> {
  const pool = new pg.Pool({ connectionString: platformUrl, max: 1 });
  const db = drizzle(pool, { schema });
  try {
    await db.transaction(async (tx) => {
      const tenantIds = Object.values(DEMO_TENANTS).map((t) => t.id);
      // Cascades to every tenant-owned table.
      await tx.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
      await tx.delete(schema.users).where(
        inArray(
          schema.users.id,
          DEMO_USERS.map((u) => u.id),
        ),
      );

      await tx.insert(schema.tenants).values(
        Object.values(DEMO_TENANTS).map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          plan: t.plan,
        })),
      );
      await tx.insert(schema.users).values(
        DEMO_USERS.map((u) => ({
          id: u.id,
          entraOid: u.oid,
          email: u.email,
          name: u.name,
          isPlatformAdmin: u.isPlatformAdmin ?? false,
        })),
      );
      await tx.insert(schema.memberships).values(
        DEMO_USERS.flatMap((u) =>
          u.memberships.map((m) => ({
            tenantId: DEMO_TENANTS[m.tenant as keyof typeof DEMO_TENANTS].id,
            userId: u.id,
            role: m.role,
          })),
        ),
      );
      for (const step of steps) await step(tx as unknown as SeedDb);
    });
  } finally {
    await pool.end();
  }
}
