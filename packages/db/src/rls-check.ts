import pg from 'pg';

export interface RlsViolation {
  table: string;
  problem: string;
}

/**
 * Every table in `public` must have RLS enabled AND forced, plus at least one policy.
 * Every table with a tenant_id column must also have a policy keyed on app_current_tenant().
 * CI runs this against a freshly migrated database and fails on any violation.
 */
export async function checkRlsCoverage(connectionString: string): Promise<RlsViolation[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{
      table_name: string;
      rls: boolean;
      forced: boolean;
      has_tenant_id: boolean;
      policies: number;
      tenant_policies: number;
    }>(`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS forced,
             EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_schema = 'public' AND col.table_name = c.relname
                        AND col.column_name = 'tenant_id') AS has_tenant_id,
             (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies,
             (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname
                 AND (p.qual ILIKE '%app_current_tenant()%' OR p.with_check ILIKE '%app_current_tenant()%')
             ) AS tenant_policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`);

    const violations: RlsViolation[] = [];
    for (const r of rows) {
      if (!r.rls) violations.push({ table: r.table_name, problem: 'RLS is not enabled' });
      if (!r.forced) violations.push({ table: r.table_name, problem: 'RLS is not FORCED' });
      if (r.policies === 0) violations.push({ table: r.table_name, problem: 'no policies' });
      if (r.has_tenant_id && r.tenant_policies === 0) {
        violations.push({
          table: r.table_name,
          problem: 'has tenant_id but no policy on app_current_tenant()',
        });
      }
    }

    // A tenant table must also have an index that leads with tenant_id.
    const { rows: unindexed } = await client.query<{ table_name: string }>(`
      SELECT col.table_name
        FROM information_schema.columns col
       WHERE col.table_schema = 'public' AND col.column_name = 'tenant_id'
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
             JOIN pg_class t ON t.oid = i.indrelid
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
            WHERE t.relname = col.table_name AND a.attname = 'tenant_id')`);
    for (const r of unindexed) {
      violations.push({ table: r.table_name, problem: 'no index leading with tenant_id' });
    }
    return violations;
  } finally {
    await client.end();
  }
}
