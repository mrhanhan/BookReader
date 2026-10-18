/**
 * Concatenates the text nodes inside a pdf.js text layer in document order.
 *
 * Marked-content wrappers, line breaks and other element nodes contribute no
 * characters, which matches how the text layer is laid out. A scanned PDF has
 * an empty layer, so this returns an empty string.
 */
export function pageTextOf(layer: HTMLElement): string {
  const nodes = layer.ownerDocument?.createTreeWalker(layer, 4 /* NodeFilter.SHOW_TEXT */)
    ?? document.createTreeWalker(layer, 4);
  let text = '';
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    text += node.nodeValue ?? '';
  }
  return text;
}

/**
 * Character offset of a range's start inside the text layer.
 *
 * The prefix is measured with the Range API instead of walking nodes, which
 * also handles a start boundary that is an element (for example
 * `range.selectNodeContents(span)`). Returns 0 when the start lies outside the
 * layer or the boundary cannot be measured.
 */
export function charOffsetForRange(layer: HTMLElement, range: Range): number {
  const start = range.startContainer;
  if (start !== layer && !layer.contains(start)) {
    return 0;
  }

  const doc = layer.ownerDocument;
  if (!doc) {
    return 0;
  }

  try {
    const prefix = doc.createRange();
    prefix.selectNodeContents(layer);
    prefix.setEnd(start, range.startOffset);
    return prefix.toString().length;
  } catch {
    // A detached node or an out-of-bounds offset cannot be measured.
    return 0;
  }
}
