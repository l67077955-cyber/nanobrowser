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

  it('parses a plan whose final answer holds a code block of its own', () => {
    const plan = {
      done: true,
      final_answer: '先跑:\n```bash\nsource /etc/network_turbo\npip install ultralytics\n```\n用完关机',
    };
    expect(extractJsonFromModelOutput(`<plan>${JSON.stringify(plan)}</plan>`)).toEqual(plan);
    expect(extractJsonFromModelOutput(JSON.stringify(plan))).toEqual(plan);
  });

  it('parses a code block JSON followed by prose with braces', () => {
    expect(extractJsonFromModelOutput('```json\n{"done":true}\n```\nnote: {not json}')).toEqual({ done: true });
  });

  it('still fails when there is no JSON', () => {
    expect(() => extractJsonFromModelOutput('<planner_output>no json here</planner_output>')).toThrow();
  });
});
