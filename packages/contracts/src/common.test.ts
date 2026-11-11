import { describe, expect, it } from 'vitest';
import { PageQuery } from './common.js';

describe('PageQuery', () => {
  it('defaults limit to 20 and coerces strings', () => {
    expect(PageQuery.parse({})).toEqual({ limit: 20 });
    expect(PageQuery.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps limit at 100', () => {
    expect(PageQuery.safeParse({ limit: '101' }).success).toBe(false);
  });
});
