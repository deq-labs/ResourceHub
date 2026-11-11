export * as schema from './schema/index.js';
export { newId, ROLES, TENANT_PLANS, TENANT_STATUSES, type Role } from './schema/index.js';
export {
  createDatabase,
  type Database,
  type DatabaseOptions,
  type Db,
  type PlatformAuditEntry,
  type PlatformAuditSink,
  type Tx,
} from './database.js';
export {
  currentTenantContext,
  requireTenantContext,
  runWithTenant,
  type TenantContext,
} from './context.js';
export { runMigrations, MIGRATIONS_FOLDER } from './migrate.js';
export { checkRlsCoverage, type RlsViolation } from './rls-check.js';
export { seedDemo, type SeedDb, type SeedStep } from './seed/seed.js';
export {
  DEMO_TENANTS,
  DEMO_USERS,
  type DemoTenant,
  type DemoTenantKey,
  type DemoUser,
} from './seed/demo-data.js';
export { sql, eq, and, or, desc, asc, gt, lt, ilike, inArray, isNull, count } from 'drizzle-orm';
