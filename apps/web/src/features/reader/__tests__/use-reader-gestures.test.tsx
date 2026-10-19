import { useRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReaderGestures } from '../useReaderGestures';
import type {
  ReaderGestureOptions,
  ReaderSwipeHandlers,
  ReaderZoomHandlers,
} from '../useReaderGestures';

function createZoom(base = 1): ReaderZoomHandlers {
  return {
    baseScale: vi.fn(() => base),
    onZoom: vi.fn(),
    onZoomEnd: vi.fn(),
  };
}

function createSwipe(enabled = true): ReaderSwipeHandlers {
  return { enabled, onNext: vi.fn(), onPrevious: vi.fn() };
}

interface HarnessProps extends Omit<ReaderGestureOptions, 'targetRef'> {
  /** Renders a `.bookr-pdf-scroll` child so pan tests have a real scroller. */
  withScroll?: boolean;
  /** Sits on an ancestor, the way React delegates `onClick` at its root. */
  onSurfaceClick?: () => void;
}

function Harness({ withScroll = false, onSurfaceClick, ...props }: HarnessProps) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useReaderGestures({
    ...props,
    targetRef,
    pan: withScroll ? { container: () => scrollRef.current } : undefined,
  });
  return (
    <div onClick={onSurfaceClick}>
      <div ref={targetRef} data-testid="surface">
        <p data-testid="text">正文</p>
        {withScroll ? (
          <div ref={scrollRef} className="bookr-pdf-scroll" data-testid="scroll" />
        ) : null}
        <button type="button" data-testid="control">
          按钮
        </button>
      </div>
    </div>
  );
}

/** Gives a jsdom element the geometry overflow checks read. */
function sizeScroller(
  element: HTMLElement,
  box: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number },
): void {
  for (const [key, value] of Object.entries(box)) {
    Object.defineProperty(element, key, { value, configurable: true });
  }
}

function pointer(
  target: HTMLElement,
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  point: { clientX: number; clientY: number },
  init: { altKey?: boolean; pointerType?: string; button?: number; buttons?: number } = {},
): void {
  fireEvent[type](target, {
    clientX: point.clientX,
    clientY: point.clientY,
    pointerType: 'mouse',
    button: 0,
    // A held left button; a release outside the window shows up as 0.
    buttons: 1,
    ...init,
  });
}

function touch(
  target: HTMLElement,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: Array<{ clientX: number; clientY: number }>,
  changed: Array<{ clientX: number; clientY: number }> = points,
): void {
  fireEvent[type](target, { touches: points, changedTouches: changed });
}

describe('useReaderGestures', () => {
  it('ignores wheel events without ctrl or meta', () => {
    const zoom = createZoom();
    render(<Harness zoom={zoom} swipe={null} />);

    fireEvent.wheel(screen.getByTestId('surface'), { deltaY: -120 });

    expect(zoom.onZoom).not.toHaveBeenCalled();
    expect(zoom.onZoomEnd).not.toHaveBeenCalled();
  });

  it('zooms on ctrl+wheel and settles once after the debounce', async () => {
    const zoom = createZoom(1);
    render(<Harness zoom={zoom} swipe={null} />);

    const surface = screen.getByTestId('surface');
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: -100 });
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: -100 });

    const expected = Math.exp(0.2);
    expect(zoom.onZoom).toHaveBeenCalledTimes(2);
    expect(zoom.onZoom).toHaveBeenLastCalledWith(expect.closeTo(expected, 5));
    expect(zoom.onZoomEnd).not.toHaveBeenCalled();

    await waitFor(() => expect(zoom.onZoomEnd).toHaveBeenCalledTimes(1), { timeout: 1500 });
    expect(zoom.onZoomEnd).toHaveBeenLastCalledWith(expect.closeTo(expected, 5));
  });

  it('zooms with a two-finger pinch and settles with the last scale', () => {
    const zoom = createZoom(1);
    render(<Harness zoom={zoom} swipe={null} />);
    const surface = screen.getByTestId('surface');

    touch(surface, 'touchStart', [
      { clientX: 0, clientY: 0 },
      { clientX: 100, clientY: 0 },
    ]);
    touch(surface, 'touchMove', [
      { clientX: 0, clientY: 0 },
      { clientX: 200, clientY: 0 },
    ]);

    expect(zoom.onZoom).toHaveBeenLastCalledWith(2);
    expect(zoom.onZoomEnd).not.toHaveBeenCalled();

    touch(surface, 'touchEnd', [], [{ clientX: 200, clientY: 0 }]);

    expect(zoom.onZoomEnd).toHaveBeenCalledTimes(1);
    expect(zoom.onZoomEnd).toHaveBeenLastCalledWith(2);
  });

  it('turns pages with a horizontal swipe only when enabled', () => {
    const swipe = createSwipe(true);
    const { unmount } = render(<Harness zoom={null} swipe={swipe} />);
    const surface = screen.getByTestId('surface');

    touch(surface, 'touchStart', [{ clientX: 200, clientY: 100 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 100, clientY: 100 }]);
    expect(swipe.onNext).toHaveBeenCalledTimes(1);
    expect(swipe.onPrevious).not.toHaveBeenCalled();

    touch(surface, 'touchStart', [{ clientX: 100, clientY: 100 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 200, clientY: 100 }]);
    expect(swipe.onPrevious).toHaveBeenCalledTimes(1);
    unmount();

    const disabled = createSwipe(false);
    render(<Harness zoom={null} swipe={disabled} />);
    const surfaceAgain = screen.getByTestId('surface');
    touch(surfaceAgain, 'touchStart', [{ clientX: 200, clientY: 100 }]);
    touch(surfaceAgain, 'touchEnd', [], [{ clientX: 100, clientY: 100 }]);
    expect(disabled.onNext).not.toHaveBeenCalled();
    expect(disabled.onPrevious).not.toHaveBeenCalled();
  });

  it('calls onDoubleTap for two taps close in time and place', () => {
    const onDoubleTap = vi.fn();
    render(<Harness zoom={null} swipe={null} onDoubleTap={onDoubleTap} />);
    const surface = screen.getByTestId('surface');

    touch(surface, 'touchStart', [{ clientX: 80, clientY: 80 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 80, clientY: 80 }]);
    expect(onDoubleTap).not.toHaveBeenCalled();

    touch(surface, 'touchStart', [{ clientX: 82, clientY: 80 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 82, clientY: 80 }]);

    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('ignores gestures that start on a control', () => {
    const zoom = createZoom();
    const swipe = createSwipe(true);
    const onDoubleTap = vi.fn();
    render(
      <Harness zoom={zoom} swipe={swipe} onDoubleTap={onDoubleTap} />,
    );
    const control = screen.getByTestId('control');

    fireEvent.wheel(control, { ctrlKey: true, deltaY: -100 });
    touch(control, 'touchStart', [{ clientX: 80, clientY: 80 }]);
    touch(control, 'touchEnd', [], [{ clientX: 0, clientY: 80 }]);
    touch(control, 'touchStart', [{ clientX: 80, clientY: 80 }]);
    touch(control, 'touchEnd', [], [{ clientX: 80, clientY: 80 }]);
    touch(control, 'touchStart', [{ clientX: 80, clientY: 80 }]);
    touch(control, 'touchEnd', [], [{ clientX: 80, clientY: 80 }]);

    expect(zoom.onZoom).not.toHaveBeenCalled();
    expect(swipe.onNext).not.toHaveBeenCalled();
    expect(swipe.onPrevious).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('turns pages on a vertical swipe when the content cannot scroll', () => {
    const swipe = createSwipe(true);
    swipe.canScroll = vi.fn(() => false);
    render(<Harness zoom={null} swipe={swipe} />);
    const surface = screen.getByTestId('surface');

    // Finger up advances; finger down goes back.
    touch(surface, 'touchStart', [{ clientX: 100, clientY: 200 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 100, clientY: 100 }]);
    expect(swipe.onNext).toHaveBeenCalledTimes(1);

    touch(surface, 'touchStart', [{ clientX: 100, clientY: 100 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 100, clientY: 200 }]);
    expect(swipe.onPrevious).toHaveBeenCalledTimes(1);
  });

  it('leaves vertical drags to native scrolling when the content can still scroll', () => {
    const swipe = createSwipe(true);
    // Only forward Y has room left; backward already sits at the top.
    swipe.canScroll = vi.fn((axis, direction) => axis === 'y' && direction > 0);
    render(<Harness zoom={null} swipe={swipe} />);
    const surface = screen.getByTestId('surface');

    touch(surface, 'touchStart', [{ clientX: 100, clientY: 200 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 100, clientY: 100 }]);
    expect(swipe.onNext).not.toHaveBeenCalled();

    // At the top, a downward drag cannot scroll, so it turns back a page.
    touch(surface, 'touchStart', [{ clientX: 100, clientY: 100 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 100, clientY: 200 }]);
    expect(swipe.onPrevious).toHaveBeenCalledTimes(1);
  });

  it('leaves horizontal drags to panning when the page is wider than the viewport', () => {
    const swipe = createSwipe(true);
    swipe.canScroll = vi.fn((axis, direction) => axis === 'x' && direction > 0);
    render(<Harness zoom={null} swipe={swipe} />);
    const surface = screen.getByTestId('surface');

    touch(surface, 'touchStart', [{ clientX: 200, clientY: 100 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 100, clientY: 100 }]);
    expect(swipe.onNext).not.toHaveBeenCalled();

    // Dragging back past the left edge cannot scroll, so it turns the page.
    touch(surface, 'touchStart', [{ clientX: 100, clientY: 100 }]);
    touch(surface, 'touchEnd', [], [{ clientX: 200, clientY: 100 }]);
    expect(swipe.onPrevious).toHaveBeenCalledTimes(1);
  });

  it('reads scrollability when the gesture starts, not when it ends', () => {
    const swipe = createSwipe(true);
    const canScroll = vi.fn(() => true);
    swipe.canScroll = canScroll;
    render(<Harness zoom={null} swipe={swipe} />);
    const surface = screen.getByTestId('surface');

    touch(surface, 'touchStart', [{ clientX: 100, clientY: 200 }]);
    // The drag itself would change the answer; the hook must not ask again.
    canScroll.mockReturnValue(false);
    touch(surface, 'touchEnd', [], [{ clientX: 100, clientY: 100 }]);

    expect(canScroll).toHaveBeenCalledWith('y', 1);
    expect(swipe.onNext).not.toHaveBeenCalled();
  });

  it('pans an overflowing PDF with a mouse drag', () => {
    const swipe = createSwipe(true);
    render(<Harness zoom={null} swipe={swipe} withScroll />);
    const scroll = screen.getByTestId('scroll');
    sizeScroller(scroll, {
      scrollWidth: 1200,
      clientWidth: 400,
      scrollHeight: 900,
      clientHeight: 800,
    });
    scroll.scrollLeft = 100;
    scroll.scrollTop = 50;

    pointer(scroll, 'pointerDown', { clientX: 200, clientY: 200 });
    pointer(scroll, 'pointerMove', { clientX: 150, clientY: 180 });
    pointer(scroll, 'pointerUp', { clientX: 150, clientY: 180 });

    expect(scroll.scrollLeft).toBe(150);
    expect(scroll.scrollTop).toBe(70);
    // Panning is not a page turn.
    expect(swipe.onNext).not.toHaveBeenCalled();
    expect(swipe.onPrevious).not.toHaveBeenCalled();
  });

  it('keeps native selection when the page fits the viewport', () => {
    render(<Harness zoom={null} swipe={null} withScroll />);
    const scroll = screen.getByTestId('scroll');
    sizeScroller(scroll, {
      scrollWidth: 400,
      clientWidth: 400,
      scrollHeight: 800,
      clientHeight: 800,
    });
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;

    pointer(scroll, 'pointerDown', { clientX: 200, clientY: 200 });
    pointer(scroll, 'pointerMove', { clientX: 120, clientY: 120 });
    pointer(scroll, 'pointerUp', { clientX: 120, clientY: 120 });

    expect(scroll.scrollLeft).toBe(0);
    expect(scroll.scrollTop).toBe(0);
  });

  it('leaves selection alone when Alt is held during a mouse drag', () => {
    render(<Harness zoom={null} swipe={null} withScroll />);
    const scroll = screen.getByTestId('scroll');
    sizeScroller(scroll, {
      scrollWidth: 1200,
      clientWidth: 400,
      scrollHeight: 900,
      clientHeight: 800,
    });
    scroll.scrollLeft = 100;
    scroll.scrollTop = 50;

    pointer(scroll, 'pointerDown', { clientX: 200, clientY: 200 }, { altKey: true });
    pointer(scroll, 'pointerMove', { clientX: 150, clientY: 180 }, { altKey: true });
    pointer(scroll, 'pointerUp', { clientX: 150, clientY: 180 }, { altKey: true });

    expect(scroll.scrollLeft).toBe(100);
    expect(scroll.scrollTop).toBe(50);
  });

  it('stops panning when the button is released outside the window', () => {
    render(<Harness zoom={null} swipe={null} withScroll />);
    const scroll = screen.getByTestId('scroll');
    sizeScroller(scroll, {
      scrollWidth: 1200,
      clientWidth: 400,
      scrollHeight: 900,
      clientHeight: 800,
    });
    scroll.scrollLeft = 100;
    scroll.scrollTop = 50;

    pointer(scroll, 'pointerDown', { clientX: 200, clientY: 200 });
    pointer(scroll, 'pointerMove', { clientX: 150, clientY: 180 });
    expect(scroll.scrollLeft).toBe(150);

    // The release happened off-window, so no pointerup arrives.
    pointer(scroll, 'pointerMove', { clientX: 100, clientY: 100 }, { buttons: 0 });
    pointer(scroll, 'pointerMove', { clientX: 60, clientY: 60 }, { buttons: 0 });

    expect(scroll.scrollLeft).toBe(150);
    expect(scroll.scrollTop).toBe(70);
  });

  it('swallows the click a pan leaves behind so a drag never turns the page', () => {
    const onSurfaceClick = vi.fn();
    render(
      <Harness zoom={null} swipe={null} withScroll onSurfaceClick={onSurfaceClick} />,
    );
    const scroll = screen.getByTestId('scroll');
    sizeScroller(scroll, {
      scrollWidth: 1200,
      clientWidth: 400,
      scrollHeight: 900,
      clientHeight: 800,
    });
    scroll.scrollLeft = 100;
    scroll.scrollTop = 50;

    pointer(scroll, 'pointerDown', { clientX: 200, clientY: 200 });
    pointer(scroll, 'pointerMove', { clientX: 150, clientY: 180 });
    pointer(scroll, 'pointerUp', { clientX: 150, clientY: 180 });
    // The browser still fires a click on the surface the drag started from.
    fireEvent.click(scroll, { clientX: 150, clientY: 180 });

    expect(onSurfaceClick).not.toHaveBeenCalled();
  });

  it('lets an ordinary click through when nothing was panned', () => {
    const onSurfaceClick = vi.fn();
    render(
      <Harness zoom={null} swipe={null} withScroll onSurfaceClick={onSurfaceClick} />,
    );
    const scroll = screen.getByTestId('scroll');
    sizeScroller(scroll, {
      scrollWidth: 1200,
      clientWidth: 400,
      scrollHeight: 900,
      clientHeight: 800,
    });

    pointer(scroll, 'pointerDown', { clientX: 200, clientY: 200 });
    pointer(scroll, 'pointerUp', { clientX: 200, clientY: 200 });
    fireEvent.click(scroll, { clientX: 200, clientY: 200 });

    expect(onSurfaceClick).toHaveBeenCalledTimes(1);
  });

  it('keeps native selection when only the height overflows, as continuous mode does', () => {
    render(<Harness zoom={null} swipe={null} withScroll />);
    const scroll = screen.getByTestId('scroll');
    sizeScroller(scroll, {
      scrollWidth: 400,
      clientWidth: 400,
      scrollHeight: 3000,
      clientHeight: 800,
    });
    scroll.scrollLeft = 0;
    scroll.scrollTop = 500;

    pointer(scroll, 'pointerDown', { clientX: 200, clientY: 200 });
    pointer(scroll, 'pointerMove', { clientX: 180, clientY: 120 });
    pointer(scroll, 'pointerUp', { clientX: 180, clientY: 120 });

    expect(scroll.scrollTop).toBe(500);
    expect(scroll.scrollLeft).toBe(0);
  });
});
