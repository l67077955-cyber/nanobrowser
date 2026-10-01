import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../../packages/storage/lib/base/base', () => ({
  createStorage: () => ({ get: async () => ({ tasks: [] }), set: async () => {}, subscribe: () => () => {} }),
}));

import { describeRepeat, nextRun, parseRepeat } from '../../../../../packages/storage/lib/schedule';

// Thursday 1 October 2026, 10:00 local time
const now = new Date(2026, 9, 1, 10, 0).getTime();
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();

describe('parseRepeat', () => {
  it('reads the forms the planner writes', () => {
    expect(parseRepeat('daily 9:00', now)).toEqual({ kind: 'daily', time: '09:00' });
    expect(parseRepeat('weekdays 08:30', now)).toEqual({ kind: 'weekdays', time: '08:30' });
    expect(parseRepeat('weekly Friday 18:00', now)).toEqual({ kind: 'weekly', day: 5, time: '18:00' });
    expect(parseRepeat('every 2h', now)).toEqual({ kind: 'interval', minutes: 120 });
    expect(parseRepeat('in 20m', now)).toEqual({ kind: 'once', at: now + 20 * 60_000 });
    expect(parseRepeat('once 2026-10-02 07:15', now)).toEqual({ kind: 'once', at: at(2, 7, 15) });
  });

  it('keeps intervals from getting too short and refuses what it cannot read', () => {
    expect(parseRepeat('every 1m', now)).toEqual({ kind: 'interval', minutes: 5 });
    expect(parseRepeat('daily 25:00', now)).toBeNull();
    expect(parseRepeat('sometimes', now)).toBeNull();
    expect(parseRepeat('', now)).toBeNull();
  });
});

describe('nextRun', () => {
  it('finds the next matching time in local time', () => {
    expect(nextRun({ kind: 'daily', time: '09:00' }, now)).toBe(at(2, 9));
    expect(nextRun({ kind: 'daily', time: '11:00' }, now)).toBe(at(1, 11));
    // Saturday and Sunday are skipped: from Friday evening the next weekday is Monday
    expect(nextRun({ kind: 'weekdays', time: '09:00' }, at(2, 20))).toBe(at(5, 9));
    expect(nextRun({ kind: 'weekly', day: 3, time: '09:00' }, now)).toBe(at(7, 9));
    expect(nextRun({ kind: 'interval', minutes: 30 }, now)).toBe(now + 30 * 60_000);
  });

  it('has nothing more for a one-off that has passed', () => {
    expect(nextRun({ kind: 'once', at: now - 1 }, now)).toBeNull();
    expect(nextRun({ kind: 'once', at: now + 1 }, now)).toBe(now + 1);
  });
});

describe('describeRepeat', () => {
  it('says it the way a person would', () => {
    expect(describeRepeat({ kind: 'weekdays', time: '08:30' })).toBe('Every weekday at 08:30');
    expect(describeRepeat({ kind: 'weekly', day: 1, time: '09:00' })).toBe('Every Monday at 09:00');
    expect(describeRepeat({ kind: 'interval', minutes: 60 })).toBe('Every hour');
    expect(describeRepeat({ kind: 'interval', minutes: 45 })).toBe('Every 45 minutes');
  });
});
