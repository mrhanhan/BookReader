/** One selected character range inside a single reflow text block. */
export interface ReflowRangeRef {
  blockId: string;
  charRange: [number, number];
  /**
   * Source page of the element the range came from. Internal only: block ids
   * are unique per page, so callers cannot recover the page from the id. This
   * field is never persisted in a locator's `ranges`.
   */
  sourcePage?: number;
}

export interface ReflowSelectionResult {
  refs: ReflowRangeRef[];
  text: string;
  /** Viewport CSS pixels, for positioning the floating menu. */
  rect: { left: number; top: number; width: number; height: number };
}

const TEXT_BLOCK_SELECTOR = '[data-block-type="heading"], [data-block-type="paragraph"]';
const ZERO_RECT = { left: 0, top: 0, width: 0, height: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Character offset of a DOM boundary inside a text block, counted in UTF-16
 * code units (so a surrogate pair, such as 𠮷, contributes two units — the
 * same unit used by `String.prototype.length` and locator char ranges).
 *
 * The prefix is measured with the Range API instead of walking text nodes,
 * which also handles element boundaries and ignored subtrees.
 */
export function charOffsetWithin(block: HTMLElement, node: Node, offset: number): number {
  const document = block.ownerDocument;
  if (!document) {
    return 0;
  }
  if (node !== block && !block.contains(node)) {
    return 0;
  }

  try {
    const prefix = document.createRange();
    prefix.selectNodeContents(block);
    prefix.setEnd(node, offset);
    return prefix.toString().length;
  } catch {
    // Detached nodes and out-of-bounds offsets cannot be measured.
    return 0;
  }
}

/** Nearest heading/paragraph block above `node`, without leaving the root. */
function textBlockFor(node: Node | null, root: HTMLElement): HTMLElement | null {
  let element: Element | null = node === null
    ? null
    : node.nodeType === 1
      ? (node as Element)
      : node.parentElement;

  while (element) {
    if (element === root) {
      return null;
    }
    const type = element.getAttribute('data-block-type');
    const blockId = element.getAttribute('data-block-id');
    if (blockId && (type === 'heading' || type === 'paragraph')) {
      return element as HTMLElement;
    }
    element = element.parentElement;
  }
  return null;
}

/** Source page of a rendered block, or undefined when the attribute is unusable. */
function sourcePageOf(block: HTMLElement): number | undefined {
  const page = Number(block.dataset.sourcePage);
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : undefined;
}

/** Builds one range ref, tagging it with the page it was selected on. */
function rangeRefFor(block: HTMLElement, charRange: [number, number]): ReflowRangeRef {
  const ref: ReflowRangeRef = { blockId: block.dataset.blockId as string, charRange };
  const sourcePage = sourcePageOf(block);
  if (sourcePage !== undefined) {
    ref.sourcePage = sourcePage;
  }
  return ref;
}

function viewportRectOf(range: Range): ReflowSelectionResult['rect'] {
  const candidate = range as unknown as { getBoundingClientRect?: () => DOMRect };
  if (typeof candidate.getBoundingClientRect !== 'function') {
    return { ...ZERO_RECT };
  }
  try {
    const rect = candidate.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  } catch {
    return { ...ZERO_RECT };
  }
}

/**
 * Converts a DOM selection into reflow locator ranges.
 *
 * Only selections inside `root` whose boundaries sit in heading/paragraph
 * blocks count. A selection crossing several blocks yields one range per text
 * block, clamped to the block's text and with empty segments dropped. Each ref
 * also carries the `data-source-page` of the element it came from, because a
 * block id alone cannot identify a page when ids repeat across pages. Reversed
 * selections are normalized because `Range` boundaries are always ordered.
 */
export function selectionToReflow(
  selection: Selection,
  root: HTMLElement,
): ReflowSelectionResult | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  if (ancestor !== root && !root.contains(ancestor)) {
    return null;
  }

  const startBlock = textBlockFor(range.startContainer, root);
  const endBlock = textBlockFor(range.endContainer, root);
  if (!startBlock || !endBlock) {
    return null;
  }

  const blocks = Array.from(root.querySelectorAll<HTMLElement>(TEXT_BLOCK_SELECTOR));
  const startIndex = blocks.indexOf(startBlock);
  const endIndex = blocks.indexOf(endBlock);
  if (startIndex === -1 || endIndex === -1) {
    return null;
  }

  // A backward selection still produces ordered range boundaries, so the
  // start boundary always belongs to an earlier block. Swap defensively.
  const forward = startIndex <= endIndex;
  const firstBlock = forward ? startBlock : endBlock;
  const firstNode = forward ? range.startContainer : range.endContainer;
  const firstOffset = forward ? range.startOffset : range.endOffset;
  const lastBlock = forward ? endBlock : startBlock;
  const lastNode = forward ? range.endContainer : range.startContainer;
  const lastOffset = forward ? range.endOffset : range.startOffset;
  const firstIndex = Math.min(startIndex, endIndex);
  const lastIndex = Math.max(startIndex, endIndex);

  const refs: ReflowRangeRef[] = [];
  const firstLength = (firstBlock.textContent ?? '').length;
  const firstStart = clamp(charOffsetWithin(firstBlock, firstNode, firstOffset), 0, firstLength);

  if (firstBlock === lastBlock) {
    const end = clamp(charOffsetWithin(lastBlock, lastNode, lastOffset), 0, firstLength);
    if (end > firstStart && firstBlock.dataset.blockId) {
      refs.push(rangeRefFor(firstBlock, [firstStart, end]));
    }
  } else {
    if (firstLength > firstStart && firstBlock.dataset.blockId) {
      refs.push(rangeRefFor(firstBlock, [firstStart, firstLength]));
    }
    for (let index = firstIndex + 1; index < lastIndex; index += 1) {
      const middle = blocks[index];
      const blockId = middle?.dataset.blockId;
      const length = (middle?.textContent ?? '').length;
      if (middle && blockId && length > 0) {
        refs.push(rangeRefFor(middle, [0, length]));
      }
    }
    const lastLength = (lastBlock.textContent ?? '').length;
    const end = clamp(charOffsetWithin(lastBlock, lastNode, lastOffset), 0, lastLength);
    if (end > 0 && lastBlock.dataset.blockId) {
      refs.push(rangeRefFor(lastBlock, [0, end]));
    }
  }

  const text = selection.toString().trim();
  if (refs.length === 0 || text.length === 0) {
    return null;
  }

  return { refs, text, rect: viewportRectOf(range) };
}
