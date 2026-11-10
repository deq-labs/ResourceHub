import pg from 'pg';
import { newId } from './schema/columns.js';

const PREFIX = 'perf-';

/**
 * Synthetic scale data for EXPLAIN checks: N tenants x M resources (runs as the platform role).
 * Everything is tagged with the `perf-` slug prefix so `perfClean` can remove it.
 */
export async function perfSeed(
  platformUrl: string,
  migratorUrl: string,
  tenants = 200,
  perTenant = 250,
): Promise<void> {
  const c = new pg.Client({ connectionString: platformUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (let t = 0; t < tenants; t++) {
      const tenantId = newId();
      await c.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [
        tenantId,
        `${PREFIX}${t}`,
        `Perf tenant ${t}`,
      ]);
      const catId = newId();
      await c.query('INSERT INTO categories (id, tenant_id, name, slug) VALUES ($1, $2, $3, $4)', [
        catId,
        tenantId,
        'General',
        'general',
      ]);
      const values: unknown[] = [];
      const rows: string[] = [];
      for (let i = 0; i < perTenant; i++) {
        const b = values.length;
        rows.push(
          `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, now() - ($${b + 8} || ' minutes')::interval)`,
        );
        values.push(
          newId(),
          tenantId,
          `Synthetic resource ${i} for tenant ${t}`,
          `r-${i}`,
          JSON.stringify({
            format: 'markdown',
            content: `Body ${i} about cold chain, safety and onboarding.`,
          }),
          i % 4 === 0 ? 'draft' : 'published',
          catId,
          String(i * 7),
        );
      }
      await c.query(
        `INSERT INTO resources (id, tenant_id, title, slug, body, status, category_id, updated_at) VALUES ${rows.join(',')}`,
        values,
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
  // Statistics need the table owner (the platform role can read everything but owns nothing).
  const owner = new pg.Client({ connectionString: migratorUrl });
  await owner.connect();
  await owner.query('ANALYZE tenants, categories, resources');
  await owner.end();
}

export async function perfClean(platformUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: platformUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.audit_purge', 'on', true)`);
    await c.query(`DELETE FROM tenants WHERE slug LIKE '${PREFIX}%'`);
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
}

/** The hot queries, exactly as the app runs them: as resourcehub_app, inside SET LOCAL tenant. */
const QUERIES: Record<string, string> = {
  'list published (home / resources page)': `
    SELECT r.id, r.title FROM resources r
     WHERE r.status = 'published'
     ORDER BY r.updated_at DESC, r.id DESC LIMIT 21`,
  'filter by category': `
    SELECT r.id FROM resources r
     WHERE r.status = 'published' AND r.category_id IN (SELECT id FROM categories WHERE slug = 'general')
     ORDER BY r.updated_at DESC LIMIT 21`,
  'full-text search': `
    SELECT r.id FROM resources r
     WHERE r.status = 'published' AND r.search @@ websearch_to_tsquery('english', 'cold chain')
     ORDER BY r.updated_at DESC LIMIT 21`,
  'count by category (taxonomy)': `
    SELECT c.id, count(r.id) FROM categories c
      LEFT JOIN resources r ON r.category_id = c.id AND r.status = 'published'
     GROUP BY c.id`,
};

export async function explainHotQueries(appUrl: string, tenantSlug: string): Promise<string> {
  const c = new pg.Client({ connectionString: appUrl });
  await c.connect();
  const out: string[] = [];
  try {
    const { rows } = await c.query<{ id: string }>('SELECT id FROM app_resolve_tenant($1, NULL)', [
      tenantSlug,
    ]);
    const tenantId = rows[0]?.id;
    if (!tenantId) throw new Error(`No tenant ${tenantSlug}`);
    const total = await c.query<{ n: string }>(
      'SELECT reltuples::bigint::text AS n FROM pg_class WHERE relname = $1',
      ['resources'],
    );
    // (reltuples is table-wide: what the planner believes before RLS narrows to one tenant)
    out.push(
      `# EXPLAIN as resourcehub_app, tenant ${tenantSlug}, ~${total.rows[0]?.n ?? '?'} resources in the table\n`,
    );
    for (const [name, sqlText] of Object.entries(QUERIES)) {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const plan = await c.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) ${sqlText}`,
      );
      await c.query('ROLLBACK');
      out.push(
        `## ${name}\n\n\`\`\`\n${plan.rows.map((r) => r['QUERY PLAN']).join('\n')}\n\`\`\`\n`,
      );
    }
  } finally {
    await c.end();
  }
  return out.join('\n');
}
