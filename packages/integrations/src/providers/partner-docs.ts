import { z } from 'zod';
import type { CircuitBreaker } from '../resilience/circuit-breaker.js';
import type { RetryOptions } from '../resilience/retry.js';
import { callSoap, type SoapCallOptions } from '../soap/client.js';
import {
  err,
  ExternalDocument,
  IntegrationError,
  ok,
  type IntegrationAdapter,
  type WithSecret,
} from '../types.js';

/** Non-secret config stored in `integrations.config`. The password comes from secret_ref. */
export const PartnerDocsConfig = z.object({
  endpoint: z.url(),
  username: z.string().min(1).max(100),
  passwordDigest: z.boolean().default(false),
});
export type PartnerDocsConfig = z.infer<typeof PartnerDocsConfig>;

// --- XML-shaped types live only in this file. Everything is Zod-validated on the way in. ---
const SoapDocument = z.object({
  DocumentId: z.string(),
  Title: z.string(),
  Summary: z.string().default(''),
  Category: z.string().nullish(),
  Revision: z.coerce.number().int().default(1),
  UpdatedAt: z.union([z.string(), z.date()]).transform((v) => new Date(v)),
});
const GetDocumentsSinceResult = z.object({
  Documents: z
    .object({ Document: z.union([SoapDocument, z.array(SoapDocument)]).optional() })
    .nullish(),
  NextPageToken: z.string().nullish(),
});

export function mapPartnerDocument(d: z.infer<typeof SoapDocument>): ExternalDocument {
  return ExternalDocument.parse({
    externalId: d.DocumentId,
    title: d.Title.slice(0, 160),
    summary: d.Summary.slice(0, 400),
    body: `${d.Summary}\n\n_Revision ${d.Revision} · synced from the partner document library (SOAP)._`,
    category: d.Category ?? null,
    url: null,
    updatedAt: d.UpdatedAt,
  });
}

/**
 * PartnerDocumentService (SOAP 1.1, document/literal, WS-Security UsernameToken).
 * Stands in for the legacy EHR/ERP/regulatory systems that only speak SOAP.
 */
export class PartnerDocsAdapter implements IntegrationAdapter<
  WithSecret<PartnerDocsConfig>,
  ExternalDocument
> {
  readonly kind = 'soap' as const;

  constructor(private readonly deps: { breaker?: CircuitBreaker; retry?: RetryOptions } = {}) {}

  private opts(cfg: WithSecret<PartnerDocsConfig>): SoapCallOptions {
    if (!cfg.secret)
      throw new IntegrationError('config', 'No password configured (secret_ref)', false);
    return {
      wsdl: 'partner-docs.wsdl',
      endpoint: cfg.endpoint,
      security: {
        type: 'username-token',
        username: cfg.username,
        password: cfg.secret,
        digest: cfg.passwordDigest,
      },
      ...(this.deps.breaker ? { breaker: this.deps.breaker } : {}),
      ...(this.deps.retry ? { retry: this.deps.retry } : {}),
    };
  }

  async testConnection(cfg: WithSecret<PartnerDocsConfig>) {
    try {
      const res = z
        .object({ Status: z.string() })
        .parse(await callSoap(this.opts(cfg), 'Ping', {}));
      return res.Status === 'OK'
        ? ok(undefined)
        : err(new IntegrationError('unavailable', `Partner status ${res.Status}`, true));
    } catch (e) {
      return err(
        e instanceof IntegrationError
          ? e
          : new IntegrationError('invalid_response', String(e), false),
      );
    }
  }

  async *fetchChanges(
    cfg: WithSecret<PartnerDocsConfig>,
    since: Date,
  ): AsyncIterable<ExternalDocument> {
    let pageToken: string | undefined;
    do {
      const raw = await callSoap(this.opts(cfg), 'GetDocumentsSince', {
        Since: since.toISOString(),
        ...(pageToken ? { PageToken: pageToken } : {}),
      });
      const parsed = GetDocumentsSinceResult.safeParse(raw);
      if (!parsed.success)
        throw new IntegrationError(
          'invalid_response',
          'Unexpected GetDocumentsSince payload',
          false,
        );
      const docs = parsed.data.Documents?.Document;
      for (const d of Array.isArray(docs) ? docs : docs ? [docs] : []) yield mapPartnerDocument(d);
      pageToken = parsed.data.NextPageToken ?? undefined;
    } while (pageToken);
  }

  async push(cfg: WithSecret<PartnerDocsConfig>, record: ExternalDocument) {
    try {
      const raw = await callSoap(this.opts(cfg), 'SubmitDocument', {
        Document: {
          DocumentId: record.externalId,
          Title: record.title,
          Summary: record.summary,
          Category: record.category ?? 'General',
          Revision: 1,
          UpdatedAt: record.updatedAt.toISOString(),
        },
      });
      return ok(z.object({ ReferenceId: z.string() }).parse(raw).ReferenceId);
    } catch (e) {
      return err(
        e instanceof IntegrationError
          ? e
          : new IntegrationError('invalid_response', String(e), false),
      );
    }
  }
}
