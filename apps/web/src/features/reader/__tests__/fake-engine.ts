import { vi } from 'vitest';
import type { ReaderEngine, ReaderEventMap } from '@bookr/reader-core';
import type { ReaderKind } from '@bookr/shared';

/**
 * Recording reader engine shared by the reader UI suites. Every engine method
 * is a spy, and `emit` drives the event listeners the page subscribed to.
 */
export function createFakeEngine(kind: ReaderKind = 'pdf') {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const engine = {
    kind,
    open: vi.fn(async (..._args: Parameters<ReaderEngine['open']>) => ({
      kind,
      title: '测试书',
      pageCount: kind === 'pdf' ? 10 : null,
      toc: [],
    })),
    goTo: vi.fn(async (..._args: Parameters<ReaderEngine['goTo']>) => {}),
    goToPercent: vi.fn(async (..._args: Parameters<ReaderEngine['goToPercent']>) => {}),
    next: vi.fn(async () => {}),
    previous: vi.fn(async () => {}),
    currentLocator: vi.fn(() => ({ kind: 'pdf' as const, page: 2, percent: 0.42 })),
    setSettings: vi.fn((..._args: Parameters<ReaderEngine['setSettings']>) => {}),
    setHighlights: vi.fn((..._args: Parameters<ReaderEngine['setHighlights']>) => {}),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set<(payload: unknown) => void>();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    }),
    destroy: vi.fn(async () => {}),
    emit<K extends keyof ReaderEventMap>(event: K, payload: ReaderEventMap[K]): void {
      listeners.get(event)?.forEach((listener) => listener(payload));
    },
  };

  // The intersection keeps the mock methods available to assertions while the
  // object still satisfies the page's `ReaderEngine` factory prop.
  return engine as unknown as typeof engine & ReaderEngine;
}

export type FakeReaderEngine = ReturnType<typeof createFakeEngine>;
