// Contract tests: each adapter against the committed WSDL / recorded fixtures, over real HTTP.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CountryInfoAdapter,
  PartnerDocsAdapter,
  PartnerFeedAdapter,
  type ExternalDocument,
} from '../src/index.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fastRetry = { attempts: 3, baseDelayMs: 5, maxDelayMs: 20 };

async function collect(it: AsyncIterable<ExternalDocument>): Promise<ExternalDocument[]> {
  const out: ExternalDocument[] = [];
  for await (const d of it) out.push(d);
  return out;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }),
  );
}

// ---- SOAP: PartnerDocumentService (the same mock docker-compose runs) ------------------------

describe('PartnerDocsAdapter (SOAP + WS-Security) against the mock built from the committed WSDL', () => {
  let proc: ChildProcess;
  let endpoint: string;
  const cfg = () => ({
    endpoint,
    username: 'partner-demo',
    passwordDigest: false,
    secret: 'partner-demo-password',
  });

  beforeAll(async () => {
    const port = 18000 + Math.floor(Math.random() * 1000);
    proc = spawn(process.execPath, [here('../mocks/soap-server/server.mjs')], {
      env: { ...process.env, PORT: String(port), WSDL_PATH: here('../wsdl/partner-docs.wsdl') },
      stdio: 'ignore',
    });
    endpoint = `http://127.0.0.1:${port}/soap/partner-docs`;
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('SOAP mock did not start');
  }, 20_000);

  afterAll(() => {
    proc.kill();
  });

  it('testConnection succeeds with valid UsernameToken credentials', async () => {
    expect((await new PartnerDocsAdapter({ retry: fastRetry }).testConnection(cfg())).ok).toBe(
      true,
    );
  });

  it('maps a bad password to a non-retryable auth error', async () => {
    const res = await new PartnerDocsAdapter({ retry: fastRetry }).testConnection({
      ...cfg(),
      secret: 'wrong',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatchObject({ code: 'auth', retryable: false });
  });

  it('fetchChanges follows PageToken across pages and yields Zod-validated domain records', async () => {
    const docs = await collect(
      new PartnerDocsAdapter({ retry: fastRetry }).fetchChanges(cfg(), new Date('2020-01-01')),
    );
    expect(docs).toHaveLength(6); // page size 4 -> two pages
    expect(docs[0]).toMatchObject({
      externalId: 'PD-1001',
      title: 'Cold chain handling SOP',
      category: 'Operations',
    });
    expect(docs[0]!.updatedAt).toBeInstanceOf(Date);
  });

  it('respects the since filter', async () => {
    const docs = await collect(
      new PartnerDocsAdapter({ retry: fastRetry }).fetchChanges(
        cfg(),
        new Date('2026-02-20T00:00:00Z'),
      ),
    );
    expect(docs.map((d) => d.externalId)).toEqual(['PD-1005', 'PD-1006']);
  });

  it('push submits a document and returns the partner reference', async () => {
    const res = await new PartnerDocsAdapter({ retry: fastRetry }).push(cfg(), {
      externalId: 'RH-1',
      title: 'Pushed from ResourceHub',
      summary: 's',
      body: 'b',
      category: 'Operations',
      url: null,
      updatedAt: new Date(),
    });
    expect(res.ok && res.value).toMatch(/^PDREF-/);
  });

  it('a down partner is retryable (unavailable), not a crash', async () => {
    const res = await new PartnerDocsAdapter({ retry: fastRetry }).testConnection({
      ...cfg(),
      endpoint: 'http://127.0.0.1:1/soap/partner-docs',
    });
    expect(!res.ok && res.error).toMatchObject({ code: 'unavailable', retryable: true });
  });
});

// ---- SOAP: public CountryInfoService, replaying a recorded response ---------------------------

describe('CountryInfoAdapter replaying a recorded FullCountryInfoAllCountries response', () => {
  let server: Server;
  let endpoint: string;
  beforeAll(async () => {
    const xml = readFileSync(here('fixtures/country-info.FullCountryInfoAllCountries.xml'));
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' }).end(xml);
    });
    endpoint = await listen(server);
  });
  afterAll(() => {
    server.close();
  });

  it('maps XML into country fact sheets', async () => {
    const docs = await collect(
      new CountryInfoAdapter({ retry: fastRetry }).fetchChanges({ endpoint }),
    );
    expect(docs.map((d) => d.externalId).sort()).toEqual(['BR', 'JP', 'NL']);
    const nl = docs.find((d) => d.externalId === 'NL')!;
    expect(nl.title).toBe('Country fact sheet: Netherlands');
    expect(nl.body).toContain('| Capital | Amsterdam |');
    expect(nl.category).toBe('Country profiles · Europe');
  });

  it('applies the continent filter', async () => {
    const docs = await collect(
      new CountryInfoAdapter({ retry: fastRetry }).fetchChanges({ endpoint, continent: 'AS' }),
    );
    expect(docs.map((d) => d.externalId)).toEqual(['JP']);
  });
});

// ---- REST: partner feed, replaying the WireMock fixtures -------------------------------------

describe('PartnerFeedAdapter (REST) replaying fixtures', () => {
  let server: Server;
  let baseUrl: string;
  let calls = 0;
  let mode: 'throttle-once' | 'down' | 'bad-payload' = 'throttle-once';
  const page1 = readFileSync(here('../mocks/wiremock/__files/articles-page-1.json'));
  const page2 = readFileSync(here('../mocks/wiremock/__files/articles-page-2.json'));

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls++;
      if (req.headers.authorization !== 'Bearer t0ken') return res.writeHead(401).end();
      if (mode === 'down') return res.writeHead(503).end();
      if (mode === 'bad-payload')
        return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":"nope"}');
      if (calls === 1) return res.writeHead(429, { 'retry-after': '0' }).end();
      const url = new URL(req.url ?? '/', 'http://x');
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(url.searchParams.get('cursor') === 'page-2' ? page2 : page1);
    });
    baseUrl = await listen(server);
  });
  afterAll(() => {
    server.close();
  });

  it('retries through a 429, then follows the cursor across pages', async () => {
    const docs = await collect(
      new PartnerFeedAdapter({ retry: fastRetry }).fetchChanges(
        { baseUrl, secret: 't0ken' },
        new Date(0),
      ),
    );
    expect(docs.map((d) => d.externalId)).toEqual([
      'art-2001',
      'art-2002',
      'art-2003',
      'art-2004',
      'art-2005',
    ]);
    expect(calls).toBe(3); // 429, page 1, page 2
  });

  it('wrong token -> auth error, no retries', async () => {
    calls = 0;
    const res = await new PartnerFeedAdapter({ retry: fastRetry }).testConnection({
      baseUrl,
      secret: 'bad',
    });
    expect(!res.ok && res.error.code).toBe('auth');
    expect(calls).toBe(1);
  });

  it('a payload that breaks the contract fails as invalid_response at the edge', async () => {
    mode = 'bad-payload';
    await expect(
      collect(
        new PartnerFeedAdapter({ retry: fastRetry }).fetchChanges(
          { baseUrl, secret: 't0ken' },
          new Date(0),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('a 503 exhausts retries and surfaces as retryable unavailable', async () => {
    mode = 'down';
    calls = 0;
    await expect(
      collect(
        new PartnerFeedAdapter({ retry: fastRetry }).fetchChanges(
          { baseUrl, secret: 't0ken' },
          new Date(0),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
    expect(calls).toBe(3);
  });
});
