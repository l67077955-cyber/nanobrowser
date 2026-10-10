import { describe, it, expect } from 'vitest';
import { DOMElementNode, DOMTextNode } from '../views';

function el(tagName: string, attributes: Record<string, string>, children: (DOMElementNode | DOMTextNode)[] = []) {
  const node = new DOMElementNode({
    tagName,
    xpath: `//${tagName}`,
    attributes,
    children,
    isVisible: true,
    isTopElement: true,
    highlightIndex: null,
  });
  children.forEach(child => (child.parent = node));
  return node;
}

describe('ratings drawn as icons', () => {
  it('names a rating the page shows only through its class', () => {
    const stars = el('p', { 'data-nb-rating': 'Five stars' }, [el('i', {}), el('i', {})]);
    const page = el('article', {}, [el('h3', {}, [new DOMTextNode('Sapiens', true)]), stars]);
    expect(page.clickableElementsToString()).toBe('Sapiens\n(rating: Five stars)');
  });

  it('leaves elements without a rating as they were', () => {
    expect(el('p', {}, [el('i', {})]).clickableElementsToString()).toBe('');
  });
});
