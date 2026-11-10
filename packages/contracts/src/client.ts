import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths } from './generated/api.js';

export type { paths } from './generated/api.js';
export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  /** Origin of the API. The SPA uses '' (same origin; /api is proxied or routed). */
  baseUrl?: string;
  /** Returns the current in-memory access token, if any. */
  getAccessToken: () => string | null;
  /** Called once on a 401 so the caller can refresh; return true to retry the request. */
  onUnauthorized?: () => Promise<boolean>;
}

let idempotencySeq = 0;
const newIdempotencyKey = () =>
  `${Date.now().toString(36)}-${(idempotencySeq++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Typed client generated from the API's OpenAPI document. Paths, params, bodies and responses
 * are all checked at compile time against `generated/api.ts`.
 */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  const client = createClient<paths>({ baseUrl: opts.baseUrl ?? '', credentials: 'same-origin' });

  const auth: Middleware = {
    onRequest({ request }) {
      const token = opts.getAccessToken();
      if (token) request.headers.set('authorization', `Bearer ${token}`);
      // Every creating POST carries an Idempotency-Key, so a retried request is safe.
      if (request.method === 'POST' && !request.headers.has('idempotency-key')) {
        request.headers.set('idempotency-key', newIdempotencyKey());
      }
      return request;
    },
    async onResponse({ request, response }) {
      // Only idempotent reads are replayed; a consumed POST body cannot be re-sent.
      if (
        response.status !== 401 ||
        !opts.onUnauthorized ||
        request.method !== 'GET' ||
        request.headers.has('x-retried')
      ) {
        return response;
      }
      if (!(await opts.onUnauthorized())) return response;
      const retry = new Request(request, { headers: new Headers(request.headers) });
      retry.headers.set('x-retried', '1');
      const token = opts.getAccessToken();
      if (token) retry.headers.set('authorization', `Bearer ${token}`);
      return fetch(retry);
    },
  };
  client.use(auth);
  return client;
}
