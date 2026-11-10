import { IntegrationError } from '../types.js';

export interface BreakerState {
  failures: number;
  openUntil: number;
}

/** Where breaker state lives. Memory for tests; Redis in the worker so replicas share it. */
export interface BreakerStore {
  get(key: string): Promise<BreakerState | undefined>;
  set(key: string, state: BreakerState): Promise<void>;
}

export class MemoryBreakerStore implements BreakerStore {
  private readonly map = new Map<string, BreakerState>();
  get(key: string): Promise<BreakerState | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  set(key: string, state: BreakerState): Promise<void> {
    this.map.set(key, state);
    return Promise.resolve();
  }
}

export interface BreakerOptions {
  failureThreshold: number;
  openMs: number;
  now?: () => number;
}

export const DEFAULT_BREAKER: BreakerOptions = { failureThreshold: 5, openMs: 60_000 };

/**
 * One breaker per integration. After `failureThreshold` consecutive retryable failures it opens
 * and fails fast for `openMs`; then one trial call is let through (half-open). A success closes it.
 * Non-retryable errors (bad credentials, rejected payloads) don't trip it: the partner is up.
 */
export class CircuitBreaker {
  constructor(
    private readonly store: BreakerStore,
    private readonly key: string,
    private readonly opts: BreakerOptions = DEFAULT_BREAKER,
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async state(): Promise<'closed' | 'open' | 'half-open'> {
    const s = await this.store.get(this.key);
    if (!s || s.failures < this.opts.failureThreshold) return 'closed';
    return s.openUntil > this.now() ? 'open' : 'half-open';
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if ((await this.state()) === 'open') {
      const s = await this.store.get(this.key);
      throw new IntegrationError(
        'circuit_open',
        'Partner marked unavailable after repeated failures',
        true,
        Math.max(0, (s?.openUntil ?? 0) - this.now()),
      );
    }
    try {
      const result = await fn();
      await this.store.set(this.key, { failures: 0, openUntil: 0 });
      return result;
    } catch (e) {
      if (e instanceof IntegrationError && !e.retryable) throw e;
      const s = (await this.store.get(this.key)) ?? { failures: 0, openUntil: 0 };
      const failures = s.failures + 1;
      await this.store.set(this.key, {
        failures,
        openUntil: failures >= this.opts.failureThreshold ? this.now() + this.opts.openMs : 0,
      });
      throw e;
    }
  }
}
