import { readFile } from 'node:fs/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrations } from './migrate.js';

export interface TestDatabaseUrls {
  superuser: string;
  migrator: string;
  app: string;
  platform: string;
}

export interface TestDatabase {
  urls: TestDatabaseUrls;
  stop(): Promise<void>;
}

const sqlFile = (name: string) => readFile(new URL(`../sql/${name}`, import.meta.url), 'utf8');

async function exec(connectionString: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // One statement at a time: CREATE DATABASE can't run inside the implicit multi-statement tx.
    const statements = sql
      .split(/;\s*$/m)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

function withCredentials(url: string, user: string, password: string, database: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Start a real Postgres 16 in Docker, create the three roles exactly like docker-compose and
 * Azure do, and run every migration as resourcehub_migrator.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withUsername('postgres')
    .withPassword('postgres')
    .withDatabase('postgres')
    .start();

  const superuser = container.getConnectionUri();
  const urls: TestDatabaseUrls = {
    superuser,
    migrator: withCredentials(superuser, 'resourcehub_migrator', 'migrator_dev_pw', 'resourcehub'),
    app: withCredentials(superuser, 'resourcehub_app', 'app_dev_pw', 'resourcehub'),
    platform: withCredentials(superuser, 'resourcehub_platform', 'platform_dev_pw', 'resourcehub'),
  };

  await exec(superuser, await sqlFile('00-roles.sql'));
  await exec(
    withCredentials(superuser, 'postgres', 'postgres', 'resourcehub'),
    await sqlFile('01-database.sql'),
  );
  await runMigrations(urls.migrator);

  return {
    urls,
    stop: async () => {
      await container.stop();
    },
  };
}
