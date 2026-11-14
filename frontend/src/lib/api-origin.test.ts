import { describe, expect, it } from 'vitest';
import { resolveApiOrigin } from './api-origin';

describe('deployment-specific API configuration', () => {
  it('uses runtime configuration with the same compiled application', () => {
    expect(resolveApiOrigin('https://api.bankaisecurity.com', 'https://api-nonprod.bankaisecurity.com')).toBe('https://api.bankaisecurity.com');
    expect(resolveApiOrigin('https://api-nonprod.bankaisecurity.com')).toBe('https://api-nonprod.bankaisecurity.com');
  });
  it('preserves same-origin and local development', () => {
    expect(resolveApiOrigin(undefined)).toBe('');
    expect(resolveApiOrigin(undefined, 'http://localhost:4000')).toBe('http://localhost:4000');
  });
  it.each(['http://example.com', 'https://user:password@example.com', 'https://example.com/api', 'https://example.com?q=1', 'javascript:alert(1)', 42])('rejects invalid configuration %s', value => {
    expect(() => resolveApiOrigin(value)).toThrow();
  });
});
