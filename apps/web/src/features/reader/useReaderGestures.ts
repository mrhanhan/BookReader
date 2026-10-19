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
}

export interface ReaderGestureOptions {
  targetRef: RefObject<HTMLElement | null>;
  /** Null disables pinch and ctrl+wheel zoom (EPUB/reflow). */
  zoom: ReaderZoomHandlers | null;
  /** Null disables one-finger page swipes. */
  swipe: ReaderSwipeHandlers | null;
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
      if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return;
      if (Math.abs(dx) <= 1.5 * Math.abs(dy)) return;
      if (duration >= SWIPE_MAX_DURATION_MS) return;
      if (dx > 0) swipe.onPrevious();
      else swipe.onNext();
    };

    const onTouchCancel = (): void => {
      pinch = null;
      pinchLast = 0;
      pinchHappened = false;
      oneFinger = null;
    };

    target.addEventListener('wheel', onWheel, { passive: false });
    target.addEventListener('touchstart', onTouchStart, { passive: false });
    target.addEventListener('touchmove', onTouchMove, { passive: false });
    target.addEventListener('touchend', onTouchEnd, { passive: false });
    target.addEventListener('touchcancel', onTouchCancel, { passive: false });

    return () => {
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('touchstart', onTouchStart);
      target.removeEventListener('touchmove', onTouchMove);
      target.removeEventListener('touchend', onTouchEnd);
      target.removeEventListener('touchcancel', onTouchCancel);
      if (wheelTimer !== null) clearTimeout(wheelTimer);
    };
  }, [target]);
}
