import { describe, expect, it } from 'vitest';
import { describeNotices } from '../notices';

describe('describeNotices', () => {
  it('is null when the page showed nothing', () => {
    expect(describeNotices([])).toBeNull();
  });

  it('quotes each message once, in the order shown', () => {
    expect(describeNotices(['Password must be at least 8 characters', 'Login failed', 'Login failed'])).toBe(
      '"Password must be at least 8 characters"; "Login failed"',
    );
  });
});
