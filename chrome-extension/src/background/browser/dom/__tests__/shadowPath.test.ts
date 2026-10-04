import { describe, it, expect } from 'vitest';
import { findThroughShadowRoots } from '../shadowPath';

interface FakeNode {
  nodeName: string;
  children: FakeNode[];
  shadowRoot?: { children: FakeNode[] };
}

const el = (nodeName: string, children: FakeNode[] = [], shadow?: FakeNode[]): FakeNode => ({
  nodeName: nodeName.toUpperCase(),
  children,
  ...(shadow ? { shadowRoot: { children: shadow } } : {}),
});

const find = (paths: string[], doc: { children: FakeNode[] }) =>
  findThroughShadowRoots(paths, doc as unknown as ParentNode) as unknown as FakeNode | null;

describe('findThroughShadowRoots', () => {
  // <faceplate-row> holds the button in its shadow root and a light <span> slotted into it
  const button = el('button');
  const slotted = el('span');
  const row = el('faceplate-row', [slotted], [el('div', [el('span'), button])]);
  const doc = { children: [el('html', [el('body', [el('div'), el('div', [row])])])] };

  it('finds an element inside a shadow root from its path relative to that root', () => {
    expect(find(['html/body/div[2]/faceplate-row', 'div/button'], doc)).toBe(button);
  });

  it('finds a light child of a shadow host from its document path', () => {
    expect(find(['html/body/div[2]/faceplate-row', 'html/body/div[2]/faceplate-row/span'], doc)).toBe(slotted);
  });

  it('returns null when a step is missing', () => {
    expect(find(['html/body/div[2]/faceplate-row', 'div/button[2]'], doc)).toBeNull();
    expect(find(['html/body/div[3]/faceplate-row', 'div/button'], doc)).toBeNull();
  });
});
