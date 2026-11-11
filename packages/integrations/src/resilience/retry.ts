import { IntegrationError } from '../types.js';

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, err: IntegrationError) => void;
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 4, baseDelayMs: 300, maxDelayMs: 8_000 };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Exponential backoff with full jitter (AWS-style): delay = random(0, min(max, base * 2^n)).
 * A server-provided Retry-After wins when it is longer. Only retryable IntegrationErrors retry.
 */
export function backoffDelay(attempt: number, opts: RetryOptions, retryAfterMs?: number): number {
  const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  const jittered = Math.floor((opts.random ?? Math.random)() * ceiling);
  return Math.min(opts.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY,
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const error =
        e instanceof IntegrationError ? e : new IntegrationError('unavailable', String(e), true);
      if (!error.retryable || attempt + 1 >= opts.attempts) throw error;
      const delay = backoffDelay(attempt, opts, error.retryAfterMs);
      opts.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }
}
