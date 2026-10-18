/**
 * Targets that belong to reader UI inside EPUB content (links, form controls,
 * labels, editable regions) must not be interpreted as page taps.
 */
export const INTERACTIVE_TARGET_SELECTOR =
  "a[href], button, input, select, textarea, label, [role='link'], [contenteditable]";

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);

/** Structural subset of `Element` that works across iframe realms. */
interface ElementLike {
  closest?: (selector: string) => unknown;
  tagName?: unknown;
  getAttribute?: (name: string) => string | null;
  hasAttribute?: (name: string) => boolean;
  isContentEditable?: unknown;
  parentElement?: ElementLike | null;
}

/**
 * True when the event target sits inside an interactive element. Uses the
 * selector walk when available and a tag/role walk otherwise. Never relies on
 * `instanceof`, because events from same-origin iframes use another realm's
 * constructors.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const element = target as ElementLike;

  if (typeof element.closest === 'function') {
    try {
      return element.closest(INTERACTIVE_TARGET_SELECTOR) !== null;
    } catch {
      // A detached or foreign node cannot run `closest`; use the fallback.
    }
  }

  let current: ElementLike | null = element;
  while (current) {
    if (typeof current.tagName === 'string' && INTERACTIVE_TAGS.has(current.tagName)) {
      return true;
    }
    if (
      typeof current.getAttribute === 'function' &&
      current.getAttribute('role') === 'link'
    ) {
      return true;
    }
    if (current.isContentEditable === true) return true;
    if (
      typeof current.hasAttribute === 'function' &&
      current.hasAttribute('contenteditable')
    ) {
      return true;
    }
    current = current.parentElement ?? null;
  }

  return false;
}
