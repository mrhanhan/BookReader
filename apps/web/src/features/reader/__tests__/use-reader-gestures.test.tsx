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

function Harness(props: Omit<ReaderGestureOptions, 'targetRef'>) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useReaderGestures({ ...props, targetRef });
  return (
    <div ref={targetRef} data-testid="surface">
      <p data-testid="text">正文</p>
      <button type="button" data-testid="control">
        按钮
      </button>
    </div>
  );
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
});
