import { describe, it, expect } from 'vitest';
import { RepeatedActionTracker } from '../navigator';

const click = (intent: string) => [{ click_element: { intent, index: 1 } }];

describe('RepeatedActionTracker', () => {
  it('warns on the third identical action on an unchanged page, however the intent is worded', () => {
    const tracker = new RepeatedActionTracker();
    expect(tracker.record(click('Focus the search box'), 'page A')).toBeNull();
    expect(tracker.record(click('Click search'), 'page A')).toBeNull();
    expect(tracker.record(click('Open the search box'), 'page A')).toContain('3 times');
    expect(tracker.record(click('Again'), 'page A')).toContain('4 times');
  });

  it('counts a page that flips between two states', () => {
    const tracker = new RepeatedActionTracker();
    const notes = ['open', 'closed', 'open', 'closed', 'open'].map(page => tracker.record(click('toggle'), page));
    expect(notes.slice(0, 4)).toEqual([null, null, null, null]);
    expect(notes[4]).not.toBeNull();
  });

  it('stays quiet when the page changes between identical actions', () => {
    const tracker = new RepeatedActionTracker();
    const scroll = [{ scroll_to_bottom: {} }];
    for (const page of ['y=0', 'y=600', 'y=1200', 'y=1800']) expect(tracker.record(scroll, page)).toBeNull();
  });

  it('starts over after a reset', () => {
    const tracker = new RepeatedActionTracker();
    tracker.record(click('a'), 'page A');
    tracker.record(click('a'), 'page A');
    tracker.reset();
    expect(tracker.record(click('a'), 'page A')).toBeNull();
  });
});
