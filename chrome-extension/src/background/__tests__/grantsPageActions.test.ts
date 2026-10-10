import { describe, expect, it } from 'vitest';
import { grantsPageActions } from '../utils';

describe('grantsPageActions', () => {
  it('takes a go-ahead to click as leave to act', () => {
    for (const text of [
      'u can click rn',
      'You can click now',
      'go ahead and fill it in',
      'clicking is fine',
      '可以点了',
      '你可以操作了',
    ])
      expect(grantsPageActions(text), text).toBe(true);
  });

  it('does not take a refusal or an unrelated message as one', () => {
    for (const text of [
      "don't click anything",
      'you can not click',
      '不要点',
      'find the branch first',
      'can you click it?',
      '可以点吗?',
      '你能点一下吗',
      '可以点吗？',
    ])
      expect(grantsPageActions(text), text).toBe(false);
  });
});
