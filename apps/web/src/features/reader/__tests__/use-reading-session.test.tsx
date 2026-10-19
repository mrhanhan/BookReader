import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRepository } from '../../../../test/memory-repository';
import { useReadingSession } from '../useReadingSession';
import { createFakeEngine } from './fake-engine';

const USER = 'user-reading';
const BOOK = 'book-reading';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
  // jsdom reports an unfocused document; a freshly opened reader tab is focused.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(enabled = true) {
  const repo = createMemoryRepository();
  const save = vi.spyOn(repo, 'saveReadingSession');
  const requestSync = vi.fn();
  const engine = createFakeEngine();
  const view = renderHook(() =>
    useReadingSession({
      userId: USER,
      bookId: BOOK,
      enabled,
      engine,
      repo,
      requestSync,
    }),
  );
  return { ...view, repo, save, requestSync, engine };
}

it('persists every thirty seconds under the same session id', async () => {
  const { save, requestSync } = setup();

  await advance(30_000);
  expect(save).toHaveBeenCalledTimes(1);
  const first = save.mock.calls[0]![1];
  expect(first).toMatchObject({ bookId: BOOK, activeSeconds: 30 });
  expect(requestSync).toHaveBeenCalledWith('reading_session');

  await advance(30_000);
  expect(save).toHaveBeenCalledTimes(2);
  const second = save.mock.calls[1]![1];
  expect(second.id).toBe(first.id);
  expect(second.activeSeconds).toBe(60);
});

it('does not persist while disabled', async () => {
  const { save, requestSync } = setup(false);

  await advance(60_000);
  expect(save).not.toHaveBeenCalled();
  expect(requestSync).not.toHaveBeenCalled();
});

it('flushes and closes the session when the page becomes hidden', async () => {
  const { save } = setup();

  await advance(30_000);
  const first = save.mock.calls[0]![1];

  // Ten seconds after the heartbeat, with no new tick yet.
  await advance(10_000);
  act(() => {
    setVisibility('hidden');
  });
  // The flush includes the time since the last tick (30→40 seconds).
  const hidden = save.mock.calls.at(-1)![1];
  expect(hidden.id).toBe(first.id);
  expect(hidden.activeSeconds).toBe(40);
  const closedId = hidden.id;

  act(() => {
    setVisibility('visible');
  });
  await advance(30_000);
  const resumed = save.mock.calls.at(-1)![1];
  expect(resumed.id).not.toBe(closedId);
  expect(resumed.bookId).toBe(BOOK);
});

it('does not accrue time while hidden', async () => {
  const { save } = setup();

  await advance(30_000);
  act(() => {
    setVisibility('hidden');
  });
  const afterHide = save.mock.calls.at(-1)![1].activeSeconds;

  await advance(120_000);
  expect(save.mock.calls.at(-1)![1].activeSeconds).toBe(afterHide);
});

it('counts page turns with the next heartbeat', async () => {
  const { save, engine } = setup();

  act(() => {
    engine.emit('relocated', {
      locator: { kind: 'pdf', page: 2, percent: 0.2 },
      percent: 0.2,
    });
  });
  await advance(30_000);

  expect(save.mock.calls.at(-1)![1].pagesRead).toBeGreaterThanOrEqual(1);
});
