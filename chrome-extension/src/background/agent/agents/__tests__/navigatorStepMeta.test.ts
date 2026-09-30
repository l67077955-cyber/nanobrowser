import { describe, it, expect } from 'vitest';
import { ActionResult } from '../../types';
import { navigatorStepMeta } from '../navigator';

const jevTrace = {
  model: 'typesafe/jev-1.13:latest',
  latencyMs: 640,
  operation: 'CLICK',
  target: '[83] More',
  confidence: 0.68,
  targetConfidence: 0.86,
  margin: 0.74,
  alternatives: [{ label: '[83] More', p: 0.86 }],
};

describe('navigatorStepMeta', () => {
  it('credits Jev and its model when Jev decided', () => {
    const meta = navigatorStepMeta({
      engineResult: { decision: { current_state: {} as never, action: [] }, trace: jevTrace },
      llmModel: 'deepseek-flash',
      decisionMs: 640,
      goal: '[jev 640ms] CLICK [83] More',
      actions: [{ click_element: { intent: 'CLICK [83] More', index: 83 } }],
      results: [new ActionResult({ extractedContent: 'Clicked' })],
    });
    expect(meta).toEqual({
      kind: 'navigator',
      engine: 'jev',
      model: 'typesafe/jev-1.13:latest',
      latencyMs: 640,
      goal: undefined,
      jev: jevTrace,
      actions: [{ name: 'click_element', target: '[83]', detail: 'CLICK [83] More', ok: true, error: undefined }],
    });
  });

  it('credits the LLM, keeps the deferred Jev trace, and never records typed text', () => {
    const meta = navigatorStepMeta({
      engineResult: { decision: null, trace: { ...jevTrace, deferred: 'unsure which element' } },
      llmModel: 'deepseek-flash',
      decisionMs: 4200,
      goal: 'Log in',
      actions: [
        { input_text: { intent: 'Enter password', index: 8, text: 'hunter2' } },
        { click_element: { index: 12 } },
      ],
      results: [new ActionResult({}), new ActionResult({ error: 'Element not found' })],
    });
    expect(meta).toMatchObject({ engine: 'llm', model: 'deepseek-flash', goal: 'Log in' });
    expect(meta.kind === 'navigator' && meta.jev?.deferred).toBe('unsure which element');
    expect(JSON.stringify(meta)).not.toContain('hunter2');
    expect(meta.kind === 'navigator' && meta.actions[1]).toEqual({
      name: 'click_element',
      target: '[12]',
      detail: undefined,
      ok: false,
      error: 'Element not found',
    });
  });
});
