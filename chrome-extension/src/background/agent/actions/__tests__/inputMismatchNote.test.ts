import { describe, it, expect } from 'vitest';
import { inputMismatchNote } from '../builder';

describe('inputMismatchNote', () => {
  it('says nothing when the field holds the text', () => {
    expect(inputMismatchNote('Hangzhou, China', 'Hangzhou, China')).toBe('');
    expect(inputMismatchNote('line one\nline two', 'line one\r\nline two ')).toBe('');
  });

  it('says nothing when the field is gone from the page', () => {
    expect(inputMismatchNote('GitHub', null)).toBe('');
  });

  it('reports what the field holds when it is not the text', () => {
    expect(inputMismatchNote('sign-in', 'GitHubsign-in')).toContain('"GitHubsign-in"');
    expect(inputMismatchNote('13800001111', '138 0000 1111')).toContain('"138 0000 1111"');
  });

  it('shortens a long field content', () => {
    const note = inputMismatchNote('short', 'x'.repeat(500));
    expect(note.length).toBeLessThan(300);
    expect(note).toContain('…');
  });
});
