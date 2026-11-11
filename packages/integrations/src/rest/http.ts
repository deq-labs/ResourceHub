import type { z } from 'zod';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { DEFAULT_RETRY, withRetry, type RetryOptions } from '../resilience/retry.js';
import { IntegrationError } from '../types.js';
import { assertEgressAllowed } from '../resilience/egress.js';

export interface RestClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: RetryOptions;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * JSON over HTTP with the resilience the spec asks for: per-request timeout, retry with
 * jittered backoff on 429/5xx/network errors (honouring Retry-After), and a circuit breaker
 * wrapped around the whole retried call. Responses are Zod-parsed at the edge.
 */
export class RestClient {
  constructor(private readonly opts: RestClientOptions) {}

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    await assertEgressAllowed(new URL(path, this.opts.baseUrl));
    const call = () =>
      withRetry(async () => {
        let res: Response;
        try {
          res = await (this.opts.fetchImpl ?? fetch)(new URL(path, this.opts.baseUrl), {
            method,
            headers: {
              accept: 'application/json',
              ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...this.opts.headers,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
          });
        } catch (e) {
          const timeout =
            e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
          throw new IntegrationError(
            timeout ? 'timeout' : 'unavailable',
            timeout ? 'Partner timed out' : 'Partner unreachable',
            true,
          );
        }
        if (res.status === 401 || res.status === 403)
          throw new IntegrationError('auth', `Partner rejected credentials (${res.status})`, false);
        if (res.status === 429)
          throw new IntegrationError(
            'rate_limited',
            'Partner rate limit',
            true,
            parseRetryAfter(res.headers.get('retry-after')),
          );
        if (res.status >= 500)
          throw new IntegrationError(
            'unavailable',
            `Partner error ${res.status}`,
            true,
            parseRetryAfter(res.headers.get('retry-after')),
          );
        if (!res.ok)
          throw new IntegrationError('rejected', `Partner returned ${res.status}`, false);
        const json: unknown = await res.json().catch(() => {
          throw new IntegrationError('invalid_response', 'Partner returned invalid JSON', false);
        });
        const parsed = schema.safeParse(json);
        if (!parsed.success)
          throw new IntegrationError(
            'invalid_response',
            `Unexpected partner payload: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
            false,
          );
        return parsed.data;
      }, this.opts.retry ?? DEFAULT_RETRY);
    return this.opts.breaker ? this.opts.breaker.exec(call) : call();
  }
}
