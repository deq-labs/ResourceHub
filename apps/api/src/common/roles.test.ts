import { describe, expect, it } from 'vitest';
import { roleAtLeast } from './roles.js';

describe('roleAtLeast', () => {
  it('is hierarchical', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('editor', 'admin')).toBe(false);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
  });

  it('denies unknown or missing roles', () => {
    expect(roleAtLeast(undefined, 'viewer')).toBe(false);
    expect(roleAtLeast('superuser', 'viewer')).toBe(false);
    expect(roleAtLeast('__proto__', 'viewer')).toBe(false);
  });
});
