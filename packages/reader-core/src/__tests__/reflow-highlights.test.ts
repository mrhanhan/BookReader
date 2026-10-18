import type { AnnotationColor } from '@bookr/shared';
import { describe, expect, it } from 'vitest';

import { marksForHighlights, renderBlockText, type ReflowMark } from '../reflow/highlights';
import { HIGHLIGHT_HEX } from '../settings';
import type { ReaderHighlight } from '../types';

function mark(
  id: string,
  charRange: [number, number],
  color: AnnotationColor = 'yellow',
  hasNote = false,
  blockId = 'b1',
): ReflowMark {
  return { id, blockId, charRange, color, hasNote };
}

function highlight(
  id: string,
  locator: ReaderHighlight['locator'],
  color: AnnotationColor = 'yellow',
  hasNote = false,
): ReaderHighlight {
  return { id, locator, color, hasNote };
}

describe('renderBlockText', () => {
  it('splits text into segments and lets the last covering mark win', () => {
    const block = document.createElement('p');

    renderBlockText(block, 'abcde', [
      mark('one', [0, 2], 'yellow'),
      mark('two', [1, 3], 'green', true),
    ]);

    const children = Array.from(block.childNodes);
    expect(children).toHaveLength(4);

    // [0, 1) is covered only by the first mark.
    const first = children[0] as HTMLElement;
    expect(first.tagName).toBe('MARK');
    expect(first.dataset.highlightId).toBe('one');
    expect(first.style.backgroundColor).toBe(toCssColor(HIGHLIGHT_HEX.yellow));
    expect(first.textContent).toBe('a');

    // [1, 3) is covered by both marks; the later one wins on every segment.
    const second = children[1] as HTMLElement;
    expect(second.tagName).toBe('MARK');
    expect(second.className).toContain('bookr-reflow-mark');
    expect(second.dataset.highlightId).toBe('two');
    expect(second.style.backgroundColor).toBe(
      // jsdom normalizes hex colors to rgb() in inline styles.
      toCssColor(HIGHLIGHT_HEX.green),
    );
    expect(second.classList.contains('has-note')).toBe(true);
    expect(second.textContent).toBe('b');

    const third = children[2] as HTMLElement;
    expect(third.tagName).toBe('MARK');
    expect(third.dataset.highlightId).toBe('two');
    expect(third.textContent).toBe('c');

    expect(children[3]?.nodeType).toBe(Node.TEXT_NODE);
    expect(children[3]?.textContent).toBe('de');
  });

  it('marks the whole block when a highlight is wider than the text', () => {
    const block = document.createElement('p');

    renderBlockText(block, 'abc', [mark('wide', [-5, 99])]);

    const marks = block.querySelectorAll<HTMLElement>('mark.bookr-reflow-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.dataset.highlightId).toBe('wide');
    expect(block.textContent).toBe('abc');
  });

  it('ignores inverted and fully out-of-range marks', () => {
    const block = document.createElement('p');

    renderBlockText(block, 'abc', [mark('inverted', [3, 1]), mark('outside', [10, 20])]);

    expect(block.querySelector('mark')).toBeNull();
    expect(block.childNodes).toHaveLength(1);
    expect(block.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(block.textContent).toBe('abc');
  });

  it('renders a block without marks as a single text node', () => {
    const block = document.createElement('p');

    renderBlockText(block, 'plain text', []);

    expect(block.childNodes).toHaveLength(1);
    expect(block.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(block.textContent).toBe('plain text');
  });

  it('never interprets pack text as markup', () => {
    const block = document.createElement('p');
    const hostile = '<img src=x onerror=alert(1)>';

    renderBlockText(block, hostile, []);

    expect(block.querySelector('img')).toBeNull();
    expect(block.textContent).toBe(hostile);
  });
});

describe('marksForHighlights', () => {
  it('expands reflow ranges and groups them per block', () => {
    const marks = marksForHighlights([
      highlight('multi', {
        kind: 'reflow',
        sourcePage: 1,
        percent: 0.1,
        blockId: 'b1',
        charRange: [0, 2],
        ranges: [
          { blockId: 'b1', charRange: [0, 2] },
          { blockId: 'b2', charRange: [3, 5] },
        ],
      }, 'blue', true),
      highlight('single', {
        kind: 'reflow',
        sourcePage: 1,
        percent: 0.2,
        blockId: 'b1',
        charRange: [1, 4],
      }, 'pink'),
    ]);

    expect(marks.get('b1')).toEqual([
      { id: 'multi', blockId: 'b1', charRange: [0, 2], color: 'blue', hasNote: true },
      { id: 'single', blockId: 'b1', charRange: [1, 4], color: 'pink', hasNote: false },
    ]);
    expect(marks.get('b2')).toEqual([
      { id: 'multi', blockId: 'b2', charRange: [3, 5], color: 'blue', hasNote: true },
    ]);
  });

  it('ignores non-reflow highlights and locators without a range', () => {
    const marks = marksForHighlights([
      highlight('pdf', { kind: 'pdf', page: 1, percent: 0, rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }),
      highlight('epub', { kind: 'epub', cfi: 'epubcfi(/6/2)', percent: 0 }),
      highlight('no-range', { kind: 'reflow', sourcePage: 1, percent: 0, blockId: 'b1' }),
      highlight('nan', { kind: 'reflow', sourcePage: 1, percent: 0, blockId: 'b1', charRange: [Number.NaN, 2] }),
    ]);

    expect(marks.size).toBe(0);
  });
});

/** jsdom serializes inline colors as `rgb(...)`; mirror that for comparisons. */
function toCssColor(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}
