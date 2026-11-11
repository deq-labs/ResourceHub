// The cloud role bootstrap must work as a NON-superuser admin, which is what managed Postgres
// gives you (Azure Flexible Server's admin, Neon's `neondb_owner`). Postgres 17 here, because
// PG16+ is where creating a role stopped implying the right to SET ROLE to it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { bootstrapRoles } from '../src/bootstrap.js';
import { runMigrations } from '../src/migrate.js';
import { checkRlsCoverage } from '../src/rls-check.js';

let container: StartedPostgreSqlContainer;
const url = (user: string, password: string, database = 'appdb') => {
  const u = new URL(container.getConnectionUri());
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
};

async function query<T extends pg.QueryResultRow>(connectionString: string, sql: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

const opts = () => ({
  adminUrl: url('managed_admin', 'admin'),
  database: 'appdb',
  passwords: { migrator: 'm-pw', app: 'a-pw', platform: 'p-pw' },
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withUsername('postgres')
    .withPassword('postgres')
    .withDatabase('postgres')
    .start();
  // Shaped like a managed-service admin: powerful, but not a superuser.
  const su = container.getConnectionUri();
  await query(su, `CREATE ROLE managed_admin LOGIN PASSWORD 'admin' CREATEDB CREATEROLE BYPASSRLS`);
  await query(su, 'CREATE DATABASE appdb OWNER managed_admin');
});

afterAll(async () => {
  await container.stop();
});

describe('bootstrapRoles as a non-superuser admin', () => {
  it('creates the three roles, hands the database to the migrator, and is re-runnable', async () => {
    await bootstrapRoles(opts());
    await bootstrapRoles(opts()); // idempotent: second run rotates passwords, no errors

    const roles = await query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      url('managed_admin', 'admin'),
      `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname LIKE 'resourcehub_%' ORDER BY rolname`,
    );
    expect(roles).toEqual([
      { rolname: 'resourcehub_app', rolbypassrls: false, rolsuper: false },
      { rolname: 'resourcehub_migrator', rolbypassrls: false, rolsuper: false },
      { rolname: 'resourcehub_platform', rolbypassrls: true, rolsuper: false },
    ]);
    const [owner] = await query<{ owner: string }>(
      url('managed_admin', 'admin'),
      `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'appdb'`,
    );
    expect(owner?.owner).toBe('resourcehub_migrator');
  });

  it('migrations then run as the migrator with full RLS coverage', async () => {
    await runMigrations(url('resourcehub_migrator', 'm-pw'));
    expect(await checkRlsCoverage(url('resourcehub_migrator', 'm-pw'))).toEqual([]);
    const [own] = await query<{ n: number }>(
      url('managed_admin', 'admin'),
      `SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = 'public' AND tableowner <> 'resourcehub_migrator'`,
    );
    expect(own?.n).toBe(0); // the app role owns nothing, so RLS always applies to it
  });
});
