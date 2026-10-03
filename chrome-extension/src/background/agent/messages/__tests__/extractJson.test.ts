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

  it('still fails when there is no JSON', () => {
    expect(() => extractJsonFromModelOutput('<planner_output>no json here</planner_output>')).toThrow();
  });
});
