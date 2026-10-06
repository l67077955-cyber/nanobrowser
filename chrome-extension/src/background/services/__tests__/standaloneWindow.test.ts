import { beforeAll, describe, it, expect, vi } from 'vitest';

vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } });
vi.mock('@extension/storage', () => ({ generalSettingsStore: {} }));
vi.mock('../../log', () => ({ createLogger: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn() }) }));

// imported once the mocks above are in place
let fitBounds: typeof import('../standaloneWindow').fitBounds;
beforeAll(async () => {
  ({ fitBounds } = await import('../standaloneWindow'));
});

describe('fitBounds', () => {
  const screen = { left: 0, top: 0, width: 1366, height: 728 };

  it('makes a window taller than the screen fit, so its bottom stays in sight', () => {
    expect(fitBounds({ width: 440, height: 760 }, screen)).toEqual({ width: 440, height: 728 });
  });

  it('brings back a window left off the screen', () => {
    expect(fitBounds({ left: 2400, top: 600, width: 440, height: 600 }, screen)).toEqual({
      left: 926,
      top: 128,
      width: 440,
      height: 600,
    });
  });

  it('leaves a window that fits alone', () => {
    const bounds = { left: 100, top: 50, width: 440, height: 600 };
    expect(fitBounds(bounds, screen)).toEqual(bounds);
  });
});
