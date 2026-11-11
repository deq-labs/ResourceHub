import { z } from 'zod';
import type { CircuitBreaker } from '../resilience/circuit-breaker.js';
import type { RetryOptions } from '../resilience/retry.js';
import { RestClient } from '../rest/http.js';
import {
  err,
  ExternalDocument,
  IntegrationError,
  ok,
  type IntegrationAdapter,
  type WithSecret,
} from '../types.js';

type Deps = { breaker?: CircuitBreaker; retry?: RetryOptions; fetchImpl?: typeof fetch };

function wrap(e: unknown): IntegrationError {
  return e instanceof IntegrationError
    ? e
    : new IntegrationError('invalid_response', String(e), false);
}

// ---------------------------------------------------------------------------------------------
// Partner content feed: a private REST API with bearer auth and cursor pagination.
// Locally served by WireMock (which throttles the first call to exercise retry + Retry-After).
// ---------------------------------------------------------------------------------------------

export const PartnerFeedConfig = z.object({ baseUrl: z.url() });
export type PartnerFeedConfig = z.infer<typeof PartnerFeedConfig>;

const Article = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().default(''),
  topic: z.string().nullish(),
  url: z.url().nullish(),
  updated_at: z.iso.datetime({ offset: true }),
});
const ArticlePage = z.object({ data: z.array(Article), next_cursor: z.string().nullable() });

export function mapArticle(a: z.infer<typeof Article>): ExternalDocument {
  return ExternalDocument.parse({
    externalId: a.id,
    title: a.title.slice(0, 160),
    summary: a.summary.slice(0, 400),
    body: `${a.summary}\n\n[Read the original article](${a.url ?? '#'})\n\n_Synced from the partner content feed (REST)._`,
    category: a.topic ?? null,
    url: a.url ?? null,
    updatedAt: new Date(a.updated_at),
  });
}

export class PartnerFeedAdapter implements IntegrationAdapter<
  WithSecret<PartnerFeedConfig>,
  ExternalDocument
> {
  readonly kind = 'rest' as const;
  constructor(private readonly deps: Deps = {}) {}

  private client(cfg: WithSecret<PartnerFeedConfig>): RestClient {
    if (!cfg.secret)
      throw new IntegrationError('config', 'No API token configured (secret_ref)', false);
    return new RestClient({
      baseUrl: cfg.baseUrl,
      headers: { authorization: `Bearer ${cfg.secret}` },
      ...this.deps,
    });
  }

  async testConnection(cfg: WithSecret<PartnerFeedConfig>) {
    try {
      await this.client(cfg).request('GET', '/v1/health', z.object({ status: z.literal('ok') }));
      return ok(undefined);
    } catch (e) {
      return err(wrap(e));
    }
  }

  async *fetchChanges(
    cfg: WithSecret<PartnerFeedConfig>,
    since: Date,
  ): AsyncIterable<ExternalDocument> {
    const client = this.client(cfg);
    let cursor: string | null = null;
    do {
      const qs: URLSearchParams = new URLSearchParams({
        updated_since: since.toISOString(),
        ...(cursor ? { cursor } : {}),
      });
      const page: z.infer<typeof ArticlePage> = await client.request(
        'GET',
        `/v1/articles?${qs.toString()}`,
        ArticlePage,
      );
      for (const a of page.data) yield mapArticle(a);
      cursor = page.next_cursor;
    } while (cursor);
  }

  async push(cfg: WithSecret<PartnerFeedConfig>, record: ExternalDocument) {
    try {
      const res = await this.client(cfg).request(
        'POST',
        '/v1/articles',
        z.object({ id: z.string() }),
        {
          title: record.title,
          summary: record.summary,
          topic: record.category,
        },
      );
      return ok(res.id);
    } catch (e) {
      return err(wrap(e));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Spaceflight News API: a real public REST API (no key) with an updated-since filter.
// ---------------------------------------------------------------------------------------------

export const SpaceflightNewsConfig = z.object({
  baseUrl: z.url().default('https://api.spaceflightnewsapi.net'),
  maxItems: z.number().int().min(1).max(200).default(30),
});
export type SpaceflightNewsConfig = z.infer<typeof SpaceflightNewsConfig>;

const SnapiArticle = z.object({
  id: z.number(),
  title: z.string(),
  summary: z.string().default(''),
  url: z.url(),
  news_site: z.string().default('News'),
  updated_at: z.string(),
});
const SnapiPage = z.object({ next: z.string().nullable(), results: z.array(SnapiArticle) });

export function mapSnapi(a: z.infer<typeof SnapiArticle>): ExternalDocument {
  return ExternalDocument.parse({
    externalId: String(a.id),
    title: a.title.slice(0, 160),
    summary: a.summary.slice(0, 400),
    body: `${a.summary}\n\n[Read on ${a.news_site}](${a.url})`,
    category: 'Industry news',
    url: a.url,
    updatedAt: new Date(a.updated_at),
  });
}

export class SpaceflightNewsAdapter implements IntegrationAdapter<
  WithSecret<SpaceflightNewsConfig>,
  ExternalDocument
> {
  readonly kind = 'rest' as const;
  constructor(private readonly deps: Deps = {}) {}

  private client(cfg: SpaceflightNewsConfig) {
    return new RestClient({ baseUrl: cfg.baseUrl, timeoutMs: 15_000, ...this.deps });
  }

  async testConnection(cfg: WithSecret<SpaceflightNewsConfig>) {
    try {
      await this.client(cfg).request('GET', '/v4/info/', z.object({ version: z.string() }));
      return ok(undefined);
    } catch (e) {
      return err(wrap(e));
    }
  }

  async *fetchChanges(
    cfg: WithSecret<SpaceflightNewsConfig>,
    since: Date,
  ): AsyncIterable<ExternalDocument> {
    const client = this.client(cfg);
    let path: string | null =
      `/v4/articles/?${new URLSearchParams({ updated_at_gte: since.toISOString(), ordering: '-updated_at', limit: '20' }).toString()}`;
    let n = 0;
    while (path && n < cfg.maxItems) {
      const page: z.infer<typeof SnapiPage> = await client.request('GET', path, SnapiPage);
      for (const a of page.results) {
        if (n++ >= cfg.maxItems) return;
        yield mapSnapi(a);
      }
      path = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
    }
  }

  push() {
    return Promise.resolve(
      err(new IntegrationError('config', 'Spaceflight News API is read-only', false)),
    );
  }
}
