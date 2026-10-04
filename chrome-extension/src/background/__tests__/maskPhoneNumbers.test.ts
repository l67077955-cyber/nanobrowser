import { describe, expect, it } from 'vitest';
import { maskPhoneNumbers } from '../log';

describe('maskPhoneNumbers', () => {
  it('masks a phone number in text and in logged JSON', () => {
    expect(maskPhoneNumbers('Input 13588030144 into index 7')).toBe('Input 135****0144 into index 7');
    expect(maskPhoneNumbers('{"memory":"手机号 13588030144[7] 已填"}')).toBe('{"memory":"手机号 135****0144[7] 已填"}');
  });

  it('leaves other numbers, data URLs and non-strings alone', () => {
    expect(maskPhoneNumbers('tab 130097754 at 1759580000000')).toBe('tab 130097754 at 1759580000000');
    expect(maskPhoneNumbers('code 846532, id 12345678901234')).toBe('code 846532, id 12345678901234');
    expect(maskPhoneNumbers('data:image/png;base64,13588030144')).toBe('data:image/png;base64,13588030144');
    expect(maskPhoneNumbers(13588030144)).toBe(13588030144);
  });
});
