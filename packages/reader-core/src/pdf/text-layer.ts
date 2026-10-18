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
 * Character offset of a range's start inside the text layer, counting every
 * text node that precedes it. Returns 0 when the range starts outside the
 * layer, which lets callers treat foreign selections as unusable.
 */
export function charOffsetForRange(layer: HTMLElement, range: Range): number {
  const start = range.startContainer;
  if (start !== layer && !layer.contains(start)) {
    return 0;
  }

  const nodes = layer.ownerDocument?.createTreeWalker(layer, 4 /* NodeFilter.SHOW_TEXT */)
    ?? document.createTreeWalker(layer, 4);
  let offset = 0;
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    if (node === start) {
      return offset + range.startOffset;
    }
    offset += (node as Text).data.length;
  }

  // The start boundary is an element inside the layer; it has no character of
  // its own, so the offset is wherever the walk has reached.
  return start === layer ? 0 : offset;
}
