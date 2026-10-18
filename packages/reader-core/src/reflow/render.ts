import type { LocatorRect, ReflowBlock, ReflowPack } from '@bookr/shared';

import type { ReaderSettings } from '../types';

/** One visual block, together with the source region it stands in for. */
export interface RenderedVisualBlock {
  element: HTMLElement;
  /** Source PDF page number. */
  page: number;
  /** Normalized region of the source page this block covers. */
  rect: LocatorRect;
}

/** The DOM produced for one reflow pack. */
export interface RenderedReflowDocument {
  /** `.bookr-reflow-scroll`; the element that owns scrolling. */
  host: HTMLElement;
  /** `.bookr-reflow`; the element that owns typography. */
  article: HTMLElement;
  /** Every rendered block, keyed by its pack block id. */
  blockElements: Map<string, HTMLElement>;
  /** Visual placeholders in document order, for original-page painting. */
  visualBlocks: RenderedVisualBlock[];
  /** Blocks dropped because their id or rect was unusable. */
  skippedBlocks: number;
}

const DEFAULT_FONT_SIZE = 19;
const DEFAULT_LINE_HEIGHT = 1.9;
const DEFAULT_MARGIN = 7;

const SERIF_STACK = "Georgia, 'Songti SC', 'Times New Roman', serif";
const SANS_STACK = "'Helvetica Neue', Helvetica, 'PingFang SC', 'Microsoft YaHei', sans-serif";

const TEXT_TYPES = new Set(['heading', 'paragraph']);
const VISUAL_TYPES = new Set(['image', 'table', 'formula', 'fallback']);

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A block can be rendered when it has an id other blocks can address and a
 * rect that describes where it came from. Everything else is skipped instead
 * of aborting the whole document.
 */
function isRenderable(block: ReflowBlock | null | undefined): block is ReflowBlock {
  if (!block || typeof block !== 'object') {
    return false;
  }
  if (typeof block.id !== 'string' || block.id.length === 0) {
    return false;
  }
  const rect = block.rect as unknown;
  if (!rect || typeof rect !== 'object') {
    return false;
  }
  const candidate = rect as Record<string, unknown>;
  return (['x', 'y', 'w', 'h'] as const).every(
    (key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key]),
  );
}

function setBlockAttributes(element: HTMLElement, block: ReflowBlock, sourcePage: number): void {
  element.dataset.blockId = block.id;
  element.dataset.blockType = block.type;
  element.dataset.sourcePage = String(sourcePage);
}

function createTextElement(
  document: Document,
  block: ReflowBlock,
): HTMLElement | null {
  if (typeof block.text !== 'string') {
    return null;
  }
  let tag = 'p';
  if (block.type === 'heading') {
    const level = Math.min(6, Math.max(1, Math.round(finiteOr(block.level, 1))));
    tag = `h${level}`;
  }
  const element = document.createElement(tag);
  // Text always lands in a text node: pack content must never be parsed as markup.
  element.textContent = block.text;
  return element;
}

function createVisualElement(document: Document, block: ReflowBlock): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'bookr-reflow-visual';
  figure.setAttribute('aria-label', '原文图像');
  figure.append(document.createElement('canvas'));
  return figure;
}

/**
 * Renders a validated reflow pack into `container`.
 *
 * `container` is emptied first; the returned host owns scrolling and the
 * article owns typography. Blocks render in pack order (pages, then blocks) as
 * either heading/paragraph prose or a visual placeholder canvas. A block whose
 * id or rect is unusable is skipped and counted in `skippedBlocks` rather than
 * throwing, so one damaged block cannot blank the book.
 */
export function renderReflowDocument(
  pack: ReflowPack,
  container: HTMLElement,
): RenderedReflowDocument {
  const document = container.ownerDocument;
  container.replaceChildren();

  const host = document.createElement('div');
  host.className = 'bookr-reflow-scroll';
  const article = document.createElement('article');
  article.className = 'bookr-reflow';
  host.append(article);

  const blockElements = new Map<string, HTMLElement>();
  const visualBlocks: RenderedVisualBlock[] = [];
  let skippedBlocks = 0;

  for (const page of pack.pages) {
    for (const block of page.blocks) {
      if (!isRenderable(block)) {
        skippedBlocks += 1;
        continue;
      }

      let element: HTMLElement | null;
      if (TEXT_TYPES.has(block.type)) {
        element = createTextElement(document, block);
      } else if (VISUAL_TYPES.has(block.type)) {
        element = createVisualElement(document, block);
      } else {
        element = null;
      }
      if (!element) {
        skippedBlocks += 1;
        continue;
      }

      setBlockAttributes(element, block, page.page);
      article.append(element);
      if (VISUAL_TYPES.has(block.type)) {
        visualBlocks.push({ element, page: page.page, rect: block.rect });
      }
      // Ids only have to be unique within a page; keep the first occurrence so
      // lookups stay deterministic, matching the pack index.
      if (!blockElements.has(block.id)) {
        blockElements.set(block.id, element);
      }
    }
  }

  container.append(host);
  return { host, article, blockElements, visualBlocks, skippedBlocks };
}

/**
 * Applies reflow typography through custom properties so changing settings
 * never rewrites the document and never disturbs the scroll position.
 */
export function applyReflowStyles(article: HTMLElement, settings: ReaderSettings): void {
  const reflow = settings?.reflow;
  const fontSize = finiteOr(reflow?.fontSize, DEFAULT_FONT_SIZE);
  const lineHeight = finiteOr(reflow?.lineHeight, DEFAULT_LINE_HEIGHT);
  const margin = finiteOr(reflow?.margin, DEFAULT_MARGIN);
  const family = reflow?.fontFamily === 'sans' ? SANS_STACK : SERIF_STACK;

  article.style.setProperty('--reflow-font-size', `${fontSize}px`);
  article.style.setProperty('--reflow-line-height', String(lineHeight));
  article.style.setProperty('--reflow-margin', `${margin}%`);
  article.style.setProperty('--reflow-font-family', family);
}
