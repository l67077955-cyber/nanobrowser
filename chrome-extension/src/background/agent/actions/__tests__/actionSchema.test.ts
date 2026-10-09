import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext } from '../../types';
import { ActionBuilder, buildDynamicActionSchema } from '../builder';
import { convertZodToJsonSchema } from '@src/background/utils';

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));

const actions = new ActionBuilder({} as AgentContext, {} as BaseChatModel, null).buildDefaultActions();
const schema = buildDynamicActionSchema(actions);

describe('action item schema', () => {
  it('takes one named action and drops the null keys around it', () => {
    expect(schema.parse({ click_element: null, input_text: { intent: 'type', index: 4, text: 'Acme' } })).toEqual({
      input_text: { intent: 'type', index: 4, text: 'Acme' },
    });
  });

  it('refuses an item with no known action', () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ action: [{ click_element: { intent: 'Open Keys', index: 3 } }] }).success).toBe(false);
    expect(schema.safeParse({ click_element: null }).success).toBe(false);
  });

  it('refuses two actions in one item', () => {
    const two = { click_element: { intent: 'a', index: 1 }, input_text: { intent: 'b', index: 2, text: 'x' } };
    expect(schema.safeParse(two).success).toBe(false);
  });

  it('still converts to a JSON schema listing every action', () => {
    const json = JSON.stringify(convertZodToJsonSchema(schema, 'Item'));
    expect(json).toContain('click_element');
    expect(json).toContain('read_page');
  });
});
