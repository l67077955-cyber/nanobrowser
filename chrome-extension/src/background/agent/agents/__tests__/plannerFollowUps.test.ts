import { describe, it, expect } from 'vitest';
import { cleanedPlanFollowUps } from '../planner';

describe('cleanedPlanFollowUps', () => {
  it('turns lines into tasks, dropping numbering and bullets', () => {
    expect(cleanedPlanFollowUps('1. Open the cheapest one\n- Compare shipping\n• Save it')).toEqual([
      'Open the cheapest one',
      'Compare shipping',
      'Save it',
    ]);
  });

  it('reads escaped line breaks, skips blank lines and keeps three at most', () => {
    expect(cleanedPlanFollowUps('a\\n\\nb\\nc\\nd')).toEqual(['a', 'b', 'c']);
  });

  it('gives nothing for an empty field', () => {
    expect(cleanedPlanFollowUps('')).toEqual([]);
  });
});
