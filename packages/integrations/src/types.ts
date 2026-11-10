import { z } from 'zod';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type IntegrationErrorCode =
  | 'auth'
  | 'timeout'
  | 'unavailable'
  | 'rate_limited'
  | 'invalid_response'
  | 'rejected'
  | 'circuit_open'
  | 'config';

/** The only error type that leaves an adapter. No XML, no HTTP objects, no stack traces. */
export class IntegrationError extends Error {
  constructor(
    readonly code: IntegrationErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

/**
 * Every outside system implements this. Domain code only ever sees TRecord, never transport.
 * `fetchChanges` is an async iterator so large feeds stream page by page.
 */
export interface IntegrationAdapter<TConfig, TRecord> {
  readonly kind: 'rest' | 'soap';
  testConnection(cfg: TConfig): Promise<Result<void, IntegrationError>>;
  fetchChanges(cfg: TConfig, since: Date): AsyncIterable<TRecord>;
  push(cfg: TConfig, record: TRecord): Promise<Result<string, IntegrationError>>;
}

/**
 * The domain record all document-style integrations map into. Validated with Zod at the edge,
 * so a partner changing its payload fails loudly in the adapter, not deep in the app.
 */
export const ExternalDocument = z.object({
  externalId: z.string().min(1).max(200),
  title: z.string().min(1).max(160),
  summary: z.string().max(400),
  body: z.string().max(100_000),
  category: z.string().max(80).nullable(),
  url: z.url().nullable(),
  updatedAt: z.date(),
});
export type ExternalDocument = z.infer<typeof ExternalDocument>;

/** Runtime config = the stored (non-secret) config + the secret resolved from its secret_ref. */
export type WithSecret<T> = T & { secret?: string };
