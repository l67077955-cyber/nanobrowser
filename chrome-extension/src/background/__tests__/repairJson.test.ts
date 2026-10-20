import { describe, it, expect, vi } from 'vitest';
import { repairJsonString, withActionKey } from '../utils';

vi.mock('@src/background/log', () => ({ createLogger: () => ({ info: vi.fn(), warning: vi.fn() }) }));

describe('repairJsonString', () => {
  it('puts back the action key a model left out', () => {
    const broken =
      '{"current_state": {"memory": "提示\\"图片验证码错误\\",{x}", "next_goal": "重新识别"}, {"solve_captcha": {"index": 8, "refresh": true}}]}';
    expect(JSON.parse(repairJsonString(broken))).toEqual({
      current_state: { memory: '提示"图片验证码错误",{x}', next_goal: '重新识别' },
      action: [{ solve_captcha: { index: 8, refresh: true } }],
    });
  });

  it('drops the extra brace when the model wrapped the action key in an object', () => {
    const broken =
      '{"current_state": {"next_goal": "Open {Keys}"}, {"action": [{"click_element": {"intent": "Open Keys view", "index": 3}}]}]}';
    expect(JSON.parse(repairJsonString(broken))).toEqual({
      current_state: { next_goal: 'Open {Keys}' },
      action: [{ click_element: { intent: 'Open Keys view', index: 3 } }],
    });
  });

  it('leaves well-formed output alone', () => {
    const fine = '{"current_state": {"memory": "m"}, "action": [{"done": {"text": "ok"}}]}';
    expect(withActionKey(fine)).toBe(fine);
    expect(withActionKey('{"a": 1}')).toBe('{"a": 1}');
  });

  it('puts back the colon a model replaced with attributes', () => {
    // a model wrote "action" string="false"> instead of "action":
    const broken =
      '{"current_state": {"next_goal": "Reading the full README text"}, "action" string="false">[{"read_page": {"intent": "Read the README"}}]}';
    expect(JSON.parse(repairJsonString(broken))).toEqual({
      current_state: { next_goal: 'Reading the full README text' },
      action: [{ read_page: { intent: 'Read the README' } }],
    });
  });

  it('keeps well-formed output untouched when attributes are repaired', () => {
    const fine = '{"current_state": {"memory": "a > b"}, "action": [{"done": {"text": "ok"}}]}';
    expect(repairJsonString(fine)).toBe(fine);
  });
});
