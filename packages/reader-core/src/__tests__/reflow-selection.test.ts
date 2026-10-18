import { afterEach, describe, expect, it } from 'vitest';

import { charOffsetWithin, selectionToReflow } from '../reflow/selection';

interface SelectionFixture {
  root: HTMLElement;
  first: HTMLElement;
  second: HTMLElement;
  outside: HTMLElement;
}

function makeFixture(): SelectionFixture {
  const root = document.createElement('article');
  const first = document.createElement('p');
  first.dataset.blockId = 'b1';
  first.dataset.blockType = 'paragraph';
  first.textContent = '第一段文字';
  const second = document.createElement('p');
  second.dataset.blockId = 'b2';
  second.dataset.blockType = 'paragraph';
  second.textContent = '第二段文字';
  root.append(first, second);

  const outside = document.createElement('p');
  outside.textContent = '外部文字';

  document.body.append(root, outside);
  return { root, first, second, outside };
}

function selectionOf(range: Range): Selection {
  const selection = window.getSelection();
  if (!selection) {
    throw new Error('jsdom has no document selection');
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function rangeBetween(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): Range {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe('selectionToReflow', () => {
  it('returns one ref per text block a selection crosses', () => {
    const { root, first, second } = makeFixture();
    const range = rangeBetween(
      first.firstChild as Node,
      2,
      second.firstChild as Node,
      2,
    );

    const result = selectionToReflow(selectionOf(range), root);

    expect(result).not.toBeNull();
    expect(result?.refs).toEqual([
      { blockId: 'b1', charRange: [2, (first.textContent as string).length] },
      { blockId: 'b2', charRange: [0, 2] },
    ]);
    expect(result?.text).toBe(range.toString().trim());
    expect(result?.rect).toEqual(
      expect.objectContaining({ left: expect.any(Number), top: expect.any(Number) }),
    );
  });

  it('returns a single ref for a selection inside one block', () => {
    const { root, first } = makeFixture();
    const range = rangeBetween(first.firstChild as Node, 1, first.firstChild as Node, 4);

    const result = selectionToReflow(selectionOf(range), root);

    expect(result?.refs).toEqual([{ blockId: 'b1', charRange: [1, 4] }]);
  });

  it('returns null for selections outside the reflow root', () => {
    const { root, outside } = makeFixture();
    const range = rangeBetween(outside.firstChild as Node, 0, outside.firstChild as Node, 2);

    expect(selectionToReflow(selectionOf(range), root)).toBeNull();
  });

  it('returns null for collapsed and whitespace-only selections', () => {
    const { root, first } = makeFixture();
    const collapsed = rangeBetween(first.firstChild as Node, 2, first.firstChild as Node, 2);
    expect(selectionToReflow(selectionOf(collapsed), root)).toBeNull();

    const padded = document.createElement('p');
    padded.dataset.blockId = 'b3';
    padded.dataset.blockType = 'paragraph';
    padded.textContent = '   ';
    root.append(padded);
    const whitespace = rangeBetween(padded.firstChild as Node, 0, padded.firstChild as Node, 3);
    expect(selectionToReflow(selectionOf(whitespace), root)).toBeNull();
  });

  it('normalizes reversed anchors into document order', () => {
    const { root, first, second } = makeFixture();
    const selection = window.getSelection();
    if (!selection) {
      throw new Error('jsdom has no document selection');
    }

    const extended = selection as Selection & {
      setBaseAndExtent?: (
        anchorNode: Node,
        anchorOffset: number,
        focusNode: Node,
        focusOffset: number,
      ) => void;
    };
    if (typeof extended.setBaseAndExtent === 'function') {
      extended.setBaseAndExtent(second.firstChild as Node, 2, first.firstChild as Node, 3);
    } else {
      // jsdom versions without setBaseAndExtent still expose the normalized
      // boundaries through Range; directionality lives only in anchor/focus.
      selectionOf(rangeBetween(first.firstChild as Node, 3, second.firstChild as Node, 2));
    }

    const result = selectionToReflow(selection, root);

    expect(result?.refs.map((ref) => ref.blockId)).toEqual(['b1', 'b2']);
    expect(result?.refs[0]?.charRange[0]).toBe(3);
    expect(result?.refs[1]?.charRange[1]).toBe(2);
  });
});

describe('charOffsetWithin', () => {
  it('counts UTF-16 code units, so a surrogate pair is two offsets', () => {
    const block = document.createElement('p');
    block.textContent = 'a𠮷b';
    const node = block.firstChild as Node;

    expect(charOffsetWithin(block, node, 0)).toBe(0);
    expect(charOffsetWithin(block, node, 3)).toBe(3);
    expect(charOffsetWithin(block, node, 4)).toBe(4);
  });

  it('returns 0 for nodes outside the block', () => {
    const block = document.createElement('p');
    block.textContent = 'inside';
    const other = document.createElement('p');
    other.textContent = 'outside';

    expect(charOffsetWithin(block, other.firstChild as Node, 2)).toBe(0);
  });
});
