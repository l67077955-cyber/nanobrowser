import { describe, it, expect } from 'vitest';
import type { EngineResult } from '../../engines/types';
import { decideWithEngineOrLLM } from '../navigator';

const llmOutput = { action: [{ done: {} }] };
const engineDecision = { action: [{ click_element: { index: 1 } }] };
const decided = { decision: engineDecision } as unknown as EngineResult;

/** Resolves after `ms`, or rejects as soon as the signal aborts, like a real request */
function after<T>(ms: number, value: T, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

describe('decideWithEngineOrLLM', () => {
  it('takes the engine decision and cancels the LLM call', async () => {
    let llmSignal: AbortSignal | undefined;
    const result = await decideWithEngineOrLLM(
      new AbortController().signal,
      signal => after(5, decided, signal),
      signal => {
        llmSignal = signal;
        return after(10000, llmOutput, signal);
      },
    );
    expect(result.modelOutput).toBe(engineDecision);
    expect(llmSignal?.aborted).toBe(true);
  });

  it('waits for the LLM when the engine defers', async () => {
    const deferred: EngineResult = { decision: null };
    const result = await decideWithEngineOrLLM(
      new AbortController().signal,
      signal => after(5, deferred, signal),
      signal => after(30, llmOutput, signal),
    );
    expect(result.engineResult).toBe(deferred);
    expect(result.modelOutput).toBe(llmOutput);
  });

  it('does not keep a finished LLM answer waiting for a stalled engine', async () => {
    let engineSignal: AbortSignal | undefined;
    const result = await decideWithEngineOrLLM(
      new AbortController().signal,
      signal => {
        engineSignal = signal;
        return after(10000, decided, signal);
      },
      signal => after(5, llmOutput, signal),
    );
    expect(result.engineResult.decision).toBeNull();
    expect(result.modelOutput).toBe(llmOutput);
    expect(engineSignal?.aborted).toBe(true);
  });

  it('leaves the step to the engine when the LLM call fails first', async () => {
    const result = await decideWithEngineOrLLM(
      new AbortController().signal,
      signal => after(30, decided, signal),
      () => Promise.reject(new Error('503')),
    );
    expect(result.modelOutput).toBe(engineDecision);
  });

  it('stops both when the task is cancelled', async () => {
    const task = new AbortController();
    const pending = decideWithEngineOrLLM(
      task.signal,
      signal => after(10000, { decision: null }, signal),
      signal => after(10000, llmOutput, signal),
    );
    task.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
