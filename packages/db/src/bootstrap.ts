import pg from 'pg';

export interface BootstrapOptions {
  /** Server admin connection (Azure: the Flexible Server administrator), to the target database. */
  adminUrl: string;
  database: string;
  passwords: { migrator: string; app: string; platform: string };
}

/**
 * Idempotent cloud equivalent of sql/00-roles.sql + 01-database.sql. Run once per environment
 * (it is safe to re-run; passwords are rotated to the values passed in). Passwords come from
 * Key Vault via the migrate Container Apps Job's secret references.
 */
export async function bootstrapRoles(opts: BootstrapOptions): Promise<void> {
  const client = new pg.Client({ connectionString: opts.adminUrl });
  await client.connect();
  const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  try {
    const roles: [string, string, string][] = [
      ['resourcehub_migrator', opts.passwords.migrator, 'LOGIN'],
      ['resourcehub_app', opts.passwords.app, 'LOGIN NOBYPASSRLS NOINHERIT'],
      ['resourcehub_platform', opts.passwords.platform, 'LOGIN BYPASSRLS NOINHERIT'],
    ];
    for (const [name, password, attrs] of roles) {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
      const verb = exists.rowCount ? 'ALTER' : 'CREATE';
      await client.query(`${verb} ROLE ${ident(name)} WITH ${attrs} PASSWORD ${lit(password)}`);
    }
    await client.query('GRANT resourcehub_platform TO resourcehub_migrator');
    // Managed Postgres admins (Azure Flexible Server, Neon) are not superusers. Since PG16, handing
    // ownership to a role requires being able to SET ROLE to it, which a role's creator doesn't
    // get by default, so the admin grants itself membership first. Idempotent.
    await client.query('GRANT resourcehub_migrator TO CURRENT_USER');
    const db = ident(opts.database);
    await client.query(`ALTER DATABASE ${db} OWNER TO resourcehub_migrator`);
    await client.query('ALTER SCHEMA public OWNER TO resourcehub_migrator');
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query('GRANT USAGE ON SCHEMA public TO resourcehub_app, resourcehub_platform');
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT ON DATABASE ${db} TO resourcehub_app, resourcehub_platform, resourcehub_migrator`,
    );
  } finally {
    await client.end();
  }
}
