import { describe, it, expect } from 'vitest';
import { DOMElementNode, DOMTextNode } from '../dom/views';

function element(attributes: Record<string, string>, text?: string, highlightIndex: number | null = 21) {
  const node = new DOMElementNode({
    tagName: 'input',
    xpath: '//input',
    attributes,
    children: [],
    isVisible: true,
    highlightIndex,
  });
  if (text) node.children.push(new DOMTextNode(text, true, node));
  return node;
}

describe('DOMElementNode in a message', () => {
  it('reads as its index, tag and label', () => {
    expect(`Failed to input text into element: ${element({ placeholder: 'Keyword' })}`).toBe(
      'Failed to input text into element: [21] <input> "Keyword"',
    );
    expect(String(element({}, '  Search\n jobs '))).toBe('[21] <input> "Search jobs"');
  });

  it('does without the parts it has not got', () => {
    expect(String(element({}, undefined, null))).toBe('<input>');
  });
});
