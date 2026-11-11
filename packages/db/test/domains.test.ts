import { describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { addVerifiedDomain } from '../src/domains.js';

const urls = inject('db');

async function rows<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: urls.platform });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

describe('addVerifiedDomain (operator map-domain)', () => {
  it('attaches a verified hostname to the tenant, normalised, with an audit row', async () => {
    await addVerifiedDomain(urls.platform, 'contoso', 'RH-Contoso.Vercel.App.');
    await addVerifiedDomain(urls.platform, 'contoso', 'rh-contoso.vercel.app'); // re-runnable

    const [d] = await rows<{ slug: string; verified: boolean }>(
      `SELECT t.slug, d.verified_at IS NOT NULL AS verified
         FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
        WHERE d.hostname = 'rh-contoso.vercel.app'`,
    );
    expect(d).toEqual({ slug: 'contoso', verified: true });
    const audit = await rows(
      `SELECT 1 FROM audit_log WHERE action = 'platform.domain_mapped' AND entity_id = $1`,
      ['rh-contoso.vercel.app'],
    );
    expect(audit).toHaveLength(2);
  });

  it('refuses to move a hostname that belongs to another tenant, and changes nothing', async () => {
    await addVerifiedDomain(urls.platform, 'northwind', 'rh-northwind.vercel.app');
    await expect(
      addVerifiedDomain(urls.platform, 'contoso', 'rh-northwind.vercel.app'),
    ).rejects.toThrow(/another tenant/);
    const [d] = await rows<{ slug: string }>(
      `SELECT t.slug FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
        WHERE d.hostname = 'rh-northwind.vercel.app'`,
    );
    expect(d?.slug).toBe('northwind');
  });

  it('rejects unknown tenants and malformed hostnames', async () => {
    await expect(addVerifiedDomain(urls.platform, 'nope', 'x.example.com')).rejects.toThrow(
      /No tenant/,
    );
    await expect(addVerifiedDomain(urls.platform, 'contoso', 'bad host')).rejects.toThrow(
      /valid hostname/,
    );
    await expect(addVerifiedDomain(urls.platform, 'contoso', 'localhost')).rejects.toThrow(
      /valid hostname/,
    );
  });
});
