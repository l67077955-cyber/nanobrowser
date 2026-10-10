import { describe, it, expect } from 'vitest';
import { type DOMBaseNode, DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import { buildActionSpace, groupCandidates, shortlistCandidates, targetFloor } from '../jev';

function el(
  tagName: string,
  attributes: Record<string, string>,
  highlightIndex: number | null,
  children: DOMBaseNode[] = [],
) {
  const node = new DOMElementNode({
    tagName,
    xpath: tagName,
    attributes,
    children,
    isVisible: true,
    isInteractive: highlightIndex !== null,
    highlightIndex,
  });
  node.children.forEach(child => (child.parent = node));
  return node;
}

function text(value: string) {
  return new DOMTextNode(value, true);
}

/** n visible buttons with highlight indices 1..n; returns their CLICK candidates in page order. */
function buttonCandidates(n: number) {
  const selectorMap = new Map<number, DOMElementNode>();
  for (let i = 1; i <= n; i++) selectorMap.set(i, el('button', {}, i, [text(`Button ${i}`)]));
  const space = buildActionSpace(selectorMap);
  return space.targets.CLICK!;
}

const keysOf = (candidates: Record<string, unknown> | null) => (candidates ? Object.keys(candidates) : null);

describe('targetFloor', () => {
  it('equals min at and below 10 options', () => {
    for (const n of [0, 1, 2, 5, 9, 10]) {
      expect(targetFloor(0.6, n)).toBe(0.6);
    }
  });

  it('is continuous at the anchor: 11 options sit just under min', () => {
    const at11 = targetFloor(0.6, 11);
    expect(at11).toBeLessThan(0.6);
    expect(at11).toBeCloseTo(0.6, 1);
    expect(at11).toBeCloseTo(0.6 ** (Math.log(11) / Math.log(10)), 12);
  });

  it('matches the documented values: 0.6 at 10, about 0.36 at 100, about 0.29 at 255', () => {
    expect(targetFloor(0.6, 10)).toBe(0.6);
    expect(targetFloor(0.6, 100)).toBeCloseTo(0.36, 2);
    expect(targetFloor(0.6, 255)).toBeCloseTo(0.29, 2);
  });

  it('decreases monotonically as the option count grows', () => {
    let previous = Infinity;
    for (let n = 1; n <= 255; n++) {
      const floor = targetFloor(0.6, n);
      expect(floor).toBeLessThanOrEqual(previous);
      previous = floor;
    }
    expect(targetFloor(0.6, 255)).toBeLessThan(targetFloor(0.6, 11));
  });

  it('leaves edge mins 0 and 1 unchanged at any option count', () => {
    for (const n of [1, 10, 11, 100, 255]) {
      expect(targetFloor(0, n)).toBe(0);
      expect(targetFloor(1, n)).toBe(1);
    }
  });

  it('gives a stricter floor for a stricter min at the same option count', () => {
    for (const n of [11, 50, 255]) {
      expect(targetFloor(0.7, n)).toBeGreaterThan(targetFloor(0.6, n));
      expect(targetFloor(0.8, n)).toBeGreaterThan(targetFloor(0.7, n));
    }
  });
});

describe('shortlistCandidates', () => {
  it('keeps the top-K by probability, returned in page order', () => {
    const candidates = buttonCandidates(12);
    const probabilities = { '7': 0.5, '2': 0.3, '11': 0.15, '4': 0.05 };
    const result = shortlistCandidates(candidates, probabilities, 255, 3);
    expect(keysOf(result)).toEqual(['2', '7', '11']);
    expect(result!['7'].label).toBe('Button 7');
  });

  it('never includes the none option', () => {
    const candidates = buttonCandidates(5);
    const probabilities = { none: 0.9, '1': 0.05, '3': 0.04, '5': 0.01 };
    const result = shortlistCandidates(candidates, probabilities, 255, 2);
    expect(keysOf(result)).toEqual(['1', '3']);
  });

  it('ignores zero-probability candidates', () => {
    const candidates = buttonCandidates(5);
    const probabilities = { '1': 0.5, '2': 0.5, '3': 0, '4': 0, '5': 0 };
    expect(keysOf(shortlistCandidates(candidates, probabilities, 255))).toEqual(['1', '2']);
  });

  it('returns null when all offered candidates would remain', () => {
    const candidates = buttonCandidates(3);
    const probabilities = { '1': 0.5, '2': 0.3, '3': 0.2 };
    expect(shortlistCandidates(candidates, probabilities, 255)).toBeNull();
  });

  it('returns null when fewer than two remain', () => {
    const candidates = buttonCandidates(5);
    expect(shortlistCandidates(candidates, { '4': 1 }, 255)).toBeNull();
    expect(shortlistCandidates(candidates, { none: 0.9, '4': 0.1 }, 255)).toBeNull();
    expect(shortlistCandidates(candidates, {}, 255)).toBeNull();
  });

  it('expands group ids to all their member candidates', () => {
    const candidates = buttonCandidates(25);
    const groups = groupCandidates(candidates, 6);
    expect(Object.keys(groups!)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);

    const result = shortlistCandidates(candidates, { g2: 0.7, g4: 0.2, g1: 0.1 }, 6, 2);
    expect(keysOf(result)).toEqual(['6', '7', '8', '9', '10', '16', '17', '18', '19', '20']);
  });

  it('returns group members in page order even when groups are ranked out of order', () => {
    const candidates = buttonCandidates(25);
    const result = shortlistCandidates(candidates, { g5: 0.6, g1: 0.4 }, 6, 2);
    expect(keysOf(result)).toEqual(['1', '2', '3', '4', '5', '21', '22', '23', '24', '25']);
  });

  it('returns null for grouped candidates when all groups would remain', () => {
    const candidates = buttonCandidates(25);
    const probabilities = { g1: 0.2, g2: 0.2, g3: 0.2, g4: 0.2, g5: 0.2 };
    expect(shortlistCandidates(candidates, probabilities, 6)).toBeNull();
  });

  it('does not crash on tied probabilities and still keeps exactly size candidates', () => {
    const candidates = buttonCandidates(5);
    const probabilities = { '1': 0.2, '2': 0.2, '3': 0.2, '4': 0.2, '5': 0.2 };
    const result = shortlistCandidates(candidates, probabilities, 255, 2);
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toHaveLength(2);
    const keys = Object.keys(result!);
    expect(keys).toEqual([...keys].sort((a, b) => Number(a) - Number(b)));
  });
});
