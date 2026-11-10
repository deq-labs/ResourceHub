import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';

const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Operator command: attach an already-verified hostname to a tenant. For hostnames whose owner
 * can't publish a DNS TXT record (e.g. free `*.vercel.app` aliases on the hosted demo), so the
 * in-app verification flow can't be used. Runs as the platform role and writes an audit row,
 * like every other cross-tenant action. Refuses a hostname that already belongs to another tenant.
 */
export async function addVerifiedDomain(
  platformUrl: string,
  slug: string,
  rawHostname: string,
): Promise<void> {
  const hostname = rawHostname.trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME_RE.test(hostname)) throw new Error(`Not a valid hostname: ${rawHostname}`);

  const client = new pg.Client({ connectionString: platformUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const tenant = await client.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [
      slug,
    ]);
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error(`No tenant with slug "${slug}"`);

    const existing = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenant_domains WHERE hostname = $1',
      [hostname],
    );
    const owner = existing.rows[0]?.tenant_id;
    if (owner && owner !== tenantId) {
      throw new Error(`${hostname} already belongs to another tenant`);
    }
    if (owner) {
      await client.query(
        'UPDATE tenant_domains SET verified_at = coalesce(verified_at, now()), updated_at = now() WHERE hostname = $1',
        [hostname],
      );
    } else {
      await client.query(
        `INSERT INTO tenant_domains (id, tenant_id, hostname, verification_token, verified_at)
         VALUES ($1, $2, $3, $4, now())`,
        [uuidv7(), tenantId, hostname, randomBytes(16).toString('hex')],
      );
    }
    await client.query(
      `INSERT INTO audit_log (id, tenant_id, action, entity, entity_id, diff)
       VALUES ($1, $2, 'platform.domain_mapped', 'tenant_domain', $3, $4)`,
      [uuidv7(), tenantId, hostname, JSON.stringify({ via: 'db-cli', verified: true })],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}
