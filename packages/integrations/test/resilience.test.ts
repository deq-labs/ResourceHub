import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  CircuitBreaker,
  IntegrationError,
  MemoryBreakerStore,
  withRetry,
} from '../src/index.js';

describe('withRetry', () => {
  const opts = {
    attempts: 4,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  };

  it('retries retryable errors with jittered exponential backoff, then succeeds', async () => {
    const delays: number[] = [];
    let n = 0;
    const result = await withRetry(
      () => {
        if (n++ < 2) throw new IntegrationError('unavailable', '503', true);
        return Promise.resolve('ok');
      },
      { ...opts, onRetry: (_a, d) => delays.push(d) },
    );
    expect(result).toBe('ok');
    expect(delays).toEqual([50, 100]); // random(0.5) * 100*2^0, * 100*2^1
  });

  it('never retries non-retryable errors (bad credentials, rejected payloads)', async () => {
    let n = 0;
    await expect(
      withRetry(() => {
        n++;
        throw new IntegrationError('auth', 'nope', false);
      }, opts),
    ).rejects.toThrow('nope');
    expect(n).toBe(1);
  });

  it('honours a longer Retry-After and caps at maxDelay', () => {
    expect(backoffDelay(0, opts, 700)).toBe(700);
    expect(backoffDelay(10, opts)).toBeLessThanOrEqual(1000);
  });

  it('gives up after the configured attempts', async () => {
    let n = 0;
    await expect(
      withRetry(() => {
        n++;
        throw new IntegrationError('timeout', 't', true);
      }, opts),
    ).rejects.toThrow();
    expect(n).toBe(4);
  });
});

describe('CircuitBreaker', () => {
  it('opens after N consecutive failures, fails fast, then half-opens and closes on success', async () => {
    let now = 1_000;
    const breaker = new CircuitBreaker(new MemoryBreakerStore(), 'partner-1', {
      failureThreshold: 3,
      openMs: 10_000,
      now: () => now,
    });
    const fail = () => Promise.reject(new IntegrationError('unavailable', 'down', true));
    for (let i = 0; i < 3; i++) await expect(breaker.exec(fail)).rejects.toThrow('down');
    expect(await breaker.state()).toBe('open');

    let called = false;
    await expect(
      breaker.exec(() => {
        called = true;
        return Promise.resolve(1);
      }),
    ).rejects.toMatchObject({ code: 'circuit_open' });
    expect(called).toBe(false);

    now += 10_001;
    expect(await breaker.state()).toBe('half-open');
    expect(await breaker.exec(() => Promise.resolve('back'))).toBe('back');
    expect(await breaker.state()).toBe('closed');
  });

  it('does not trip on non-retryable errors', async () => {
    const breaker = new CircuitBreaker(new MemoryBreakerStore(), 'p', {
      failureThreshold: 1,
      openMs: 1000,
    });
    await expect(
      breaker.exec(() => Promise.reject(new IntegrationError('auth', 'bad creds', false))),
    ).rejects.toThrow();
    expect(await breaker.state()).toBe('closed');
  });
});
