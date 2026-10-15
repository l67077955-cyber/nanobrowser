import { describe, it, expect } from 'vitest';
import { extractJsonFromModelOutput } from '../utils';

describe('extractJsonFromModelOutput', () => {
  it('parses plain JSON', () => {
    expect(extractJsonFromModelOutput('{"done":true}')).toEqual({ done: true });
  });

  it('parses JSON inside a code block', () => {
    expect(extractJsonFromModelOutput('```json\n{"done":false}\n```')).toEqual({ done: false });
  });

  it('parses JSON wrapped in tags the model made up', () => {
    const content = '<planner_output>\n{"observation":"shop page {open}","done":false}\n</planner_output>';
    expect(extractJsonFromModelOutput(content)).toEqual({ observation: 'shop page {open}', done: false });
  });

  it('parses a plan whose final answer holds a code block', () => {
    const plan = { done: true, final_answer: '# 验签\n```python\nverify(key, {"sig": sig})\n```\n完成' };
    expect(extractJsonFromModelOutput(`<plan>${JSON.stringify(plan)}</plan>`)).toEqual(plan);
  });

  it('parses a plan with unescaped quotes inside a string', () => {
    // deepseek-flash, 2026-10-15: the planner quoted the page's "1-1 of 1" without escaping it
    const content =
      '<plan>{"observation":"one server, no termination date, "1-1 of 1", Notification Center empty. Open "Support".","done":false,"next_steps":"1. Click "More"\n2. Read","web_task":true}</plan>';
    expect(extractJsonFromModelOutput(content)).toEqual({
      observation: 'one server, no termination date, "1-1 of 1", Notification Center empty. Open "Support".',
      done: false,
      next_steps: '1. Click "More"\n2. Read',
      web_task: true,
    });
  });

  it('keeps quotes that end strings in arrays and nested objects', () => {
    const content = '{"actions":[{"click":{"intent":"Open the "Unpaid Orders" tab","index":40}},"x"],"done":true}';
    expect(extractJsonFromModelOutput(content)).toEqual({
      actions: [{ click: { intent: 'Open the "Unpaid Orders" tab', index: 40 } }, 'x'],
      done: true,
    });
  });

  it('still fails when there is no JSON', () => {
    expect(() => extractJsonFromModelOutput('<planner_output>no json here</planner_output>')).toThrow();
  });
});
