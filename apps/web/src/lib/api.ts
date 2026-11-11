import { createApiClient, type ProblemDetails, type SessionResponse } from '@resourcehub/contracts';

/**
 * The access token lives ONLY in this module's memory (never localStorage/sessionStorage).
 * A page reload starts with no token; the HttpOnly refresh cookie mints a new one.
 */
let accessToken: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<SessionResponse | null> | null = null;
const listeners = new Set<(s: SessionResponse | null) => void>();

export function onSessionChange(fn: (s: SessionResponse | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(session: SessionResponse | null): void {
  accessToken = session?.accessToken ?? null;
  clearTimeout(refreshTimer);
  if (session) {
    // Refresh at 80% of the token lifetime so requests never see an expired token.
    refreshTimer = setTimeout(() => void refreshSession(), session.expiresIn * 800);
  }
  for (const l of listeners) l(session);
}

/** Single-flight: concurrent callers (tabs, StrictMode, parallel 401s) share one refresh. */
export function refreshSession(): Promise<SessionResponse | null> {
  inflight ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const session = res.ok ? ((await res.json()) as SessionResponse) : null;
      publish(session);
      return session;
    } catch {
      publish(null);
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function signOut(): Promise<void> {
  await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(
    () => undefined,
  );
  publish(null);
}

export function signInUrl(returnTo = window.location.pathname + window.location.search): string {
  return `/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export const api = createApiClient({
  getAccessToken: () => accessToken,
  onUnauthorized: async () => (await refreshSession()) !== null,
});

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
  }
}

/** Unwrap an openapi-fetch result: return data or throw the RFC 9457 problem. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const p = (result.error ?? {}) as Partial<ProblemDetails>;
    throw new ApiError({
      type: p.type ?? 'about:blank',
      title: p.title ?? result.response.statusText,
      status: p.status ?? result.response.status,
      ...(p.detail ? { detail: p.detail } : {}),
      ...(p.errors ? { errors: p.errors } : {}),
      ...(p.traceId ? { traceId: p.traceId } : {}),
    });
  }
  return result.data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const fields = err.problem.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
    return fields ? `${err.message} (${fields})` : err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Explicit Idempotency-Key for creating POSTs (one key per user action). */
export function idempotent() {
  return { header: { 'Idempotency-Key': crypto.randomUUID() } };
}
