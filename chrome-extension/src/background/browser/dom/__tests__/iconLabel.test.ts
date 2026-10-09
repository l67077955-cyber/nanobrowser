import { describe, it, expect } from 'vitest';
import { DOMElementNode, DOMTextNode } from '../views';

function make(tagName: string, attributes: Record<string, string>, parent?: DOMElementNode, text?: string) {
  const node = new DOMElementNode({
    tagName,
    xpath: `//${tagName}`,
    attributes,
    children: [],
    isVisible: true,
    highlightIndex: 5,
    parent,
  });
  if (text) node.children.push(new DOMTextNode(text, true, node));
  return node;
}

describe('icon fallback label', () => {
  it('uses the icon class name', () => {
    const node = make('i', { class: 'anticon anticon-delete' });
    expect(node.clickableElementsToString()).toBe('[5]<i icon=delete />');
    expect(String(node)).toBe('[5] <i> "delete"');
  });

  it('uses the image file name without hash, query or extension', () => {
    const node = make('img', { src: 'https://cdn.x.com/static/logo.3f9a2b1c.png?v=2' });
    expect(node.clickableElementsToString()).toBe('[5]<img icon=logo />');
    expect(make('img', { src: '/a/9f8e7d6c5b4a3f2e1d0c.svg' }).clickableElementsToString()).toBe('[5]<img  />');
  });

  it('falls back to a nearby ancestor title, at most three levels up', () => {
    const near = make('div', { title: 'Remove item' });
    const mid = make('span', {}, near);
    const icon = make('svg', {}, make('span', {}, mid));
    expect(icon.clickableElementsToString()).toBe('[5]<svg icon=Remove item />');
    const far = make('svg', {}, make('b', {}, make('b', {}, make('b', {}, near))));
    expect(far.clickableElementsToString()).toBe('[5]<svg  />');
  });

  it('leaves labelled or texted elements alone', () => {
    const labelled = make('i', { class: 'fa-trash', 'aria-label': 'Delete row' });
    expect(labelled.clickableElementsToString()).toBe('[5]<i aria-label=Delete row />');
    const texted = make('button', { class: 'icon-search' }, undefined, 'Search');
    expect(texted.clickableElementsToString()).toBe('[5]<button >Search />');
  });
});
