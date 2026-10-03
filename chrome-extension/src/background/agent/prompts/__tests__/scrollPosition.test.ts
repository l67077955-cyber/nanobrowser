import { describe, it, expect, vi } from 'vitest';

vi.mock('@extension/i18n', () => ({ t: (key: string, args: string[] = []) => [key, ...args].join(' ') }));

import { scrollPosition } from '../base';

describe('scrollPosition', () => {
  it('says how far down the page is, not how much of it the screen covers', () => {
    // from a log: the model took "8%" for its progress while it was 80% down
    expect(scrollPosition(6467.8, 601.9, 8053)).toBe(
      '87% of the way down: 6468px above and 983px below the visible part (screen height 602px, page height 8053px)',
    );
  });

  it('names the top and the bottom', () => {
    expect(scrollPosition(0, 600, 3000)).toMatch(/^at the top: 0px above and 2400px below/);
    expect(scrollPosition(2400, 600, 3000)).toMatch(/^at the bottom: 2400px above and 0px below/);
  });

  it('says when there is nothing to scroll', () => {
    expect(scrollPosition(0, 600, 600)).toBe('the whole page fits on screen, there is nothing to scroll');
  });
});
