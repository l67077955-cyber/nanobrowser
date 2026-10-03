import { describe, expect, it } from 'vitest';
import { isAbortedError, isAuthenticationError, ModelTimeoutError, withModelTimeout } from '../errors';

/** A model call that never answers and only ends when its signal aborts, like LangChain does */
const hangingCall = (signal: AbortSignal) =>
  new Promise<string>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  });

describe('withModelTimeout', () => {
  it('returns the answer of a call that finishes in time', async () => {
    const result = await withModelTimeout('test-model', new AbortController().signal, async () => 'plan', 1000);
    expect(result).toBe('plan');
  });

  it('fails a call that never answers with a timeout the user can act on', async () => {
    const error = await withModelTimeout('test-model', new AbortController().signal, hangingCall, 20).catch(e => e);
    expect(error).toBeInstanceOf(ModelTimeoutError);
    expect(error.message).toContain('test-model');
    // must not be mistaken for a cancelled task or a bad key
    expect(isAbortedError(error)).toBe(false);
    expect(isAuthenticationError(error)).toBe(false);
  });

  it('times out a call that ignores its signal', async () => {
    const deaf = () => new Promise<string>(() => {});
    const error = await withModelTimeout('test-model', new AbortController().signal, deaf, 20).catch(e => e);
    expect(error).toBeInstanceOf(ModelTimeoutError);
  });

  it('ends a call that ignores its signal when the task is cancelled', async () => {
    const task = new AbortController();
    const call = withModelTimeout('test-model', task.signal, () => new Promise<string>(() => {}), 1000);
    task.abort();
    const error = await call.catch(e => e);
    expect(isAbortedError(error)).toBe(true);
  });

  it('keeps the abort error when the task itself is cancelled', async () => {
    const task = new AbortController();
    const call = withModelTimeout('test-model', task.signal, hangingCall, 1000);
    task.abort();
    const error = await call.catch(e => e);
    expect(error).not.toBeInstanceOf(ModelTimeoutError);
    expect(isAbortedError(error)).toBe(true);
  });

  it('passes other failures through unchanged', async () => {
    const failure = new Error('Connection error.');
    const call = withModelTimeout('test-model', new AbortController().signal, () => Promise.reject(failure), 1000);
    await expect(call).rejects.toBe(failure);
  });
});
