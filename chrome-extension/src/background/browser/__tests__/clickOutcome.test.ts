import { describe, it, expect } from 'vitest';
import { describeControlChanges } from '../controlState';

describe('what a click left behind', () => {
  it('reads a progress indicator as a request still on its way', () => {
    const outcome = describeControlChanges(['appeared: a progressbar']);
    expect(outcome.pending).toBe(true);
    expect(outcome.text).toContain('has not shown the result yet');
  });

  it('reads a control that changed as the click having taken effect', () => {
    const outcome = describeControlChanges(['the radio "Male": unchecked → checked']);
    expect(outcome.pending).toBe(false);
    expect(outcome.text).toContain('The click took effect');
  });

  it('does not call a click that changed something a pending one', () => {
    const outcome = describeControlChanges([
      'appeared: a progressbar',
      'the field "Email": value:"" → value:"a@b.com"',
    ]);
    expect(outcome.pending).toBe(false);
    expect(outcome.text).toContain('The click took effect');
  });

  it('says nothing about a click that changed nothing', () => {
    const outcome = describeControlChanges([]);
    expect(outcome.pending).toBe(false);
    expect(outcome.text).toContain('it changed ');
  });
});
