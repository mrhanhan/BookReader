import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export interface ReaderZoomHandlers {
  /** Current effective scale (engine.currentScale() or the numeric setting). */
  baseScale(): number;
  /** Live feedback while the gesture runs; must not persist. */
  onZoom(scale: number): void;
  /** Called once when the gesture settles; may persist. */
  onZoomEnd(scale: number): void;
}

export interface ReaderSwipeHandlers {
  enabled: boolean;
  onNext(): void;
  onPrevious(): void;
  /**
   * Whether the content can still scroll along `axis` in `direction`
   * (1 = forward/right/down, -1 = backward/left/up). A drag the content can
   * follow stays a scroll or a pan instead of turning the page. Omit it when
   * nothing inside the reading surface scrolls.
   */
  canScroll?(axis: 'x' | 'y', direction: 1 | -1): boolean;
}

export interface ReaderGestureOptions {
  targetRef: RefObject<HTMLElement | null>;
  /** Null disables pinch and ctrl+wheel zoom (EPUB/reflow). */
  zoom: ReaderZoomHandlers | null;
  /** Null disables one-finger page swipes. */
  swipe: ReaderSwipeHandlers | null;
  /**
   * Scroll container for mouse drag-to-pan. When it overflows, dragging moves
   * the page instead of selecting text; holding Alt keeps native selection.
   */
  pan?: { container(): HTMLElement | null };
  onDoubleTap?: () => void;
  minScale?: number;
  maxScale?: number;
}

export const GESTURE_MIN_SCALE = 0.5;
export const GESTURE_MAX_SCALE = 4;

const WHEEL_SETTLE_MS = 350;
const WHEEL_ZOOM_RATE = 0.002;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 30;
/** A tap must end quickly; otherwise a long press is not a double-tap half. */
const TAP_MAX_DURATION_MS = 300;
const SWIPE_MIN_DISTANCE = 60;
const SWIPE_MAX_DURATION_MS = 800;
/** Pointer travel before a mouse press becomes a pan rather than a click. */
const PAN_START_DISTANCE = 3;
/** How often the grab cursor may re-measure the scroll container. */
const PAN_CURSOR_INTERVAL_MS = 200;
/** A click this soon after a pan belongs to the pan, not to the reader. */
const CLICK_AFTER_PAN_MS = 400;

/**
 * Layout and chrome regions own their own gestures. The text layer is
 * deliberately not excluded: pinch-to-zoom over rendered PDF text is normal.
 */
const EXCLUDED_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'label',
  'summary',
  '[contenteditable="true"]',
  '.reader-chrome',
  '.reader-panel',
  '.reader-selection-menu',
  'dialog',
].join(',');

interface Point {
  clientX: number;
  clientY: number;
}

function touchDistance(a: Point, b: Point): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function isElementLike(target: EventTarget | null): target is Element {
  if (typeof target !== 'object' || target === null) return false;
  const candidate = target as { closest?: unknown };
  return typeof candidate.closest === 'function';
}

function insideExcluded(target: EventTarget | null): boolean {
  if (!isElementLike(target)) return false;
  try {
    return target.closest(EXCLUDED_SELECTOR) !== null;
  } catch {
    // A detached or foreign node cannot be matched; treat it as content.
    return false;
  }
}

/** A drag over text is a selection gesture, not a zoom or page turn. */
function hasTextSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return false;
  }
  try {
    const selection = window.getSelection();
    return selection !== null && !selection.isCollapsed;
  } catch {
    return false;
  }
}

function firstTouch(list: TouchList): Touch | null {
  return list.length > 0 ? list[0] ?? null : null;
}

/**
 * A page wider than the viewport is the zoomed-in case. Only then does a mouse
 * drag pan: at fit-width nothing overflows sideways, so dragging stays the
 * browser's own text selection. Continuous mode is always taller than the
 * viewport, so keying the pan off height instead would take selection away in
 * the default mode.
 */
function overflowsSideways(container: HTMLElement): boolean {
  return container.scrollWidth - container.clientWidth > 1;
}

/**
 * A press on a classic scrollbar must keep driving the scrollbar. The content
 * box ends at `clientWidth`, so a press past it sits on the scrollbar.
 *
 * jsdom reports a zero rect and `clientWidth` 0, which makes this reject every
 * press: a test that wants a pan must stub the metrics, as `sizeScroller` does.
 */
function isOverScrollbar(event: PointerEvent, container: HTMLElement): boolean {
  const rect = container.getBoundingClientRect();
  const localX = event.clientX - rect.left - container.clientLeft;
  const localY = event.clientY - rect.top - container.clientTop;
  return localX > container.clientWidth || localY > container.clientHeight;
}

interface PanState {
  container: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  /** Set once the press travels far enough to count as a drag. */
  active: boolean;
  previousUserSelect: string;
}

/**
 * Touch and wheel gestures for the reading surface: ctrl/⌘+wheel and pinch
 * zoom, one-finger page swipes, and double-tap zoom. Handlers read the latest
 * options through a ref, so changing a handler never rebinds listeners.
 */
export function useReaderGestures(options: ReaderGestureOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // The host (ReaderPage) does not render the reading surface until the book
  // metadata resolves, so the ref is still null when the first effect would
  // run. Resolve it on every commit and attach once the node exists.
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (options.targetRef.current !== target) {
      setTarget(options.targetRef.current);
    }
  });

  useEffect(() => {
    if (!target) return;

    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    let lastWheelZoom = 0;
    let pinch: { start: number; base: number } | null = null;
    let pinchLast = 0;
    let pinchHappened = false;
    let oneFinger: { x: number; y: number; time: number } | null = null;
    let lastTap: { x: number; y: number; time: number } | null = null;
    let pan: PanState | null = null;
    /** When the last pan ended, so its trailing click can be swallowed. */
    let panEndedAt = 0;
    /**
     * Scroll room sampled when a touch starts. The drag itself scrolls the
     * content, so asking again at `touchend` would turn a page that the reader
     * only meant to scroll.
     */
    let swipeRoom: Record<'x' | 'y', { forward: boolean; backward: boolean }> = {
      x: { forward: false, backward: false },
      y: { forward: false, backward: false },
    };

    const sampleSwipeRoom = (): void => {
      const canScroll = optionsRef.current.swipe?.canScroll;
      swipeRoom = canScroll
        ? {
            x: { forward: canScroll('x', 1), backward: canScroll('x', -1) },
            y: { forward: canScroll('y', 1), backward: canScroll('y', -1) },
          }
        : {
            x: { forward: false, backward: false },
            y: { forward: false, backward: false },
          };
    };

    const clampScale = (scale: number): number => {
      const min = optionsRef.current.minScale ?? GESTURE_MIN_SCALE;
      const max = optionsRef.current.maxScale ?? GESTURE_MAX_SCALE;
      if (!Number.isFinite(scale)) return min;
      return Math.min(max, Math.max(min, scale));
    };

    const currentBaseScale = (): number => {
      const zoom = optionsRef.current.zoom;
      if (!zoom) return 1;
      const value = zoom.baseScale();
      return Number.isFinite(value) && value > 0 ? value : 1;
    };

    const onWheel = (event: WheelEvent): void => {
      const zoom = optionsRef.current.zoom;
      if (!zoom || !(event.ctrlKey || event.metaKey)) return;
      if (insideExcluded(event.target) || hasTextSelection()) return;

      event.preventDefault();
      const next = clampScale(currentBaseScale() * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE));
      lastWheelZoom = next;
      zoom.onZoom(next);

      if (wheelTimer !== null) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        wheelTimer = null;
        optionsRef.current.zoom?.onZoomEnd(lastWheelZoom);
      }, WHEEL_SETTLE_MS);
    };

    const onTouchStart = (event: TouchEvent): void => {
      if (insideExcluded(event.target) || hasTextSelection()) {
        oneFinger = null;
        return;
      }

      if (event.touches.length >= 2) {
        if (!optionsRef.current.zoom) return;
        const first = firstTouch(event.touches);
        const second = event.touches[1] ?? null;
        if (!first || !second) return;
        const start = touchDistance(first, second);
        const base = currentBaseScale();
        pinch = { start, base };
        pinchLast = base;
        pinchHappened = true;
        oneFinger = null;
        lastTap = null;
        return;
      }

      if (event.touches.length === 1 && pinch === null) {
        const touch = firstTouch(event.touches);
        if (!touch) return;
        pinchHappened = false;
        sampleSwipeRoom();
        oneFinger = { x: touch.clientX, y: touch.clientY, time: Date.now() };
      }
    };

    const onTouchMove = (event: TouchEvent): void => {
      const zoom = optionsRef.current.zoom;
      if (!pinch || !zoom || event.touches.length < 2) return;
      if (insideExcluded(event.target) || hasTextSelection()) return;

      const first = firstTouch(event.touches);
      const second = event.touches[1] ?? null;
      if (!first || !second || pinch.start <= 0) return;

      event.preventDefault();
      const next = clampScale(pinch.base * (touchDistance(first, second) / pinch.start));
      pinchLast = next;
      zoom.onZoom(next);
    };

    const onTouchEnd = (event: TouchEvent): void => {
      if (insideExcluded(event.target) || hasTextSelection()) {
        oneFinger = null;
        if (event.touches.length < 2) pinch = null;
        if (event.touches.length === 0) pinchHappened = false;
        return;
      }

      // A pinch settles as soon as fewer than two fingers remain; the finger
      // still on the glass must not turn into a page swipe.
      if (pinch !== null && event.touches.length < 2) {
        const settled = pinchLast;
        pinch = null;
        oneFinger = null;
        optionsRef.current.zoom?.onZoomEnd(settled);
        if (event.touches.length === 0) pinchHappened = false;
        return;
      }

      const start = oneFinger;
      if (!start || event.touches.length > 0) return;
      oneFinger = null;

      const touch = firstTouch(event.changedTouches);
      if (!touch) {
        pinchHappened = false;
        return;
      }

      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const travel = Math.hypot(dx, dy);
      const duration = Date.now() - start.time;
      const wasPinch = pinchHappened;
      pinchHappened = false;
      if (wasPinch) return;

      const now = Date.now();
      const previousTap = lastTap;
      const isTap = travel <= DOUBLE_TAP_DISTANCE && duration <= TAP_MAX_DURATION_MS;
      if (isTap) {
        lastTap = { x: touch.clientX, y: touch.clientY, time: now };
        if (
          previousTap !== null
          && now - previousTap.time <= DOUBLE_TAP_MS
          && Math.hypot(touch.clientX - previousTap.x, touch.clientY - previousTap.y)
            <= DOUBLE_TAP_DISTANCE
        ) {
          lastTap = null;
          optionsRef.current.onDoubleTap?.();
          return;
        }
      } else {
        lastTap = null;
      }

      const swipe = optionsRef.current.swipe;
      if (!swipe?.enabled) return;
      if (duration >= SWIPE_MAX_DURATION_MS) return;

      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const horizontal = absX >= SWIPE_MIN_DISTANCE && absX > 1.5 * absY;
      const vertical = absY >= SWIPE_MIN_DISTANCE && absY > 1.5 * absX;

      // A drag the content can follow belongs to scrolling or panning: a zoomed
      // page is dragged sideways, and a page taller than the viewport is
      // dragged up before it turns. Only the edges of the content turn pages.
      if (horizontal) {
        const forward = dx < 0;
        if (forward ? swipeRoom.x.forward : swipeRoom.x.backward) return;
        if (forward) swipe.onNext();
        else swipe.onPrevious();
        return;
      }

      if (vertical) {
        // Finger up carries the text forward, matching a scroll.
        const forward = dy < 0;
        if (forward ? swipeRoom.y.forward : swipeRoom.y.backward) return;
        if (forward) swipe.onNext();
        else swipe.onPrevious();
      }
    };

    const onTouchCancel = (): void => {
      pinch = null;
      pinchLast = 0;
      pinchHappened = false;
      oneFinger = null;
    };

    /** Drops a drag that never travelled far enough to pan. */
    const endPan = (): void => {
      const current = pan;
      pan = null;
      if (!current?.active) return;
      current.container.style.userSelect = current.previousUserSelect;
      delete current.container.dataset.panning;
      // A drag still ends with a click on the surface, which the reader reads
      // as a tap: releasing on the right quarter would turn the page and throw
      // away the pan that just happened.
      panEndedAt = Date.now();
    };

    /**
     * Swallows the click a pan leaves behind. Capture on the surface runs
     * before the event bubbles to React's root listener, so `stopPropagation`
     * keeps the reader's own tap handler out of it.
     */
    const onClickCapture = (event: MouseEvent): void => {
      if (panEndedAt === 0 || Date.now() - panEndedAt > CLICK_AFTER_PAN_MS) return;
      panEndedAt = 0;
      event.stopPropagation();
      event.preventDefault();
    };

    /**
     * Keeps the grab cursor honest: it only appears while the page really
     * overflows sideways. The check reads layout, so it runs at most a few
     * times a second rather than on every mouse move.
     */
    let cursorCheckedAt = 0;
    const refreshPanCursor = (): void => {
      const now = Date.now();
      if (now - cursorCheckedAt < PAN_CURSOR_INTERVAL_MS) return;
      cursorCheckedAt = now;
      const container = optionsRef.current.pan?.container();
      if (!container) return;
      if (overflowsSideways(container)) container.dataset.pannable = 'true';
      else delete container.dataset.pannable;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      // Alt is the escape hatch back to selecting text inside a zoomed page.
      if (event.altKey) return;
      if (insideExcluded(event.target) || hasTextSelection()) return;

      const container = optionsRef.current.pan?.container();
      if (!container || !overflowsSideways(container)) return;
      if (isOverScrollbar(event, container)) return;

      pan = {
        container,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: container.scrollLeft,
        startTop: container.scrollTop,
        active: false,
        previousUserSelect: container.style.userSelect,
      };
      // Without capture the drag dies as soon as the cursor leaves the
      // surface, which is exactly where a pan towards the edge ends up.
      if (typeof target.setPointerCapture === 'function') {
        target.setPointerCapture(event.pointerId);
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      const current = pan;
      if (!current || event.pointerId !== current.pointerId) {
        refreshPanCursor();
        return;
      }
      // Releasing outside the window never delivers a pointerup; the button
      // state on the next move is the only notice that the drag is over.
      if (event.buttons === 0) {
        endPan();
        return;
      }

      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (!current.active) {
        if (Math.hypot(dx, dy) < PAN_START_DISTANCE) return;
        current.active = true;
        // A press that turns into a pan must not leave a half-dragged
        // selection behind on the text layer underneath.
        current.container.style.userSelect = 'none';
        current.container.dataset.panning = 'true';
        window.getSelection()?.removeAllRanges();
      }

      event.preventDefault();
      current.container.scrollLeft = current.startLeft - dx;
      current.container.scrollTop = current.startTop - dy;
    };

    target.addEventListener('wheel', onWheel, { passive: false });
    target.addEventListener('touchstart', onTouchStart, { passive: false });
    target.addEventListener('touchmove', onTouchMove, { passive: false });
    target.addEventListener('touchend', onTouchEnd, { passive: false });
    target.addEventListener('touchcancel', onTouchCancel, { passive: false });
    target.addEventListener('pointerdown', onPointerDown);
    target.addEventListener('pointermove', onPointerMove, { passive: false });
    target.addEventListener('pointerup', endPan);
    target.addEventListener('pointercancel', endPan);
    target.addEventListener('click', onClickCapture, true);

    return () => {
      endPan();
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('touchstart', onTouchStart);
      target.removeEventListener('touchmove', onTouchMove);
      target.removeEventListener('touchend', onTouchEnd);
      target.removeEventListener('touchcancel', onTouchCancel);
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', endPan);
      target.removeEventListener('pointercancel', endPan);
      target.removeEventListener('click', onClickCapture, true);
      if (wheelTimer !== null) clearTimeout(wheelTimer);
    };
  }, [target]);
}
