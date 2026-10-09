import { describe, it, expect } from 'vitest';
import { inputMismatchNote, lostCharacters } from '../builder';

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

describe('lostCharacters', () => {
  it('fails a field that dropped spaces or the end of the text', () => {
    expect(lostCharacters('New project name', 'Newprojectname')).toBe(true);
    expect(lostCharacters('New project name', 'New proj')).toBe(true);
  });

  it('lets a field that reformats the text pass', () => {
    expect(lostCharacters('13800000000', '138 0000 0000')).toBe(false);
    expect(lostCharacters('beij', 'Beijing')).toBe(false);
    expect(lostCharacters('same text', ' same  text ')).toBe(false);
  });
});
