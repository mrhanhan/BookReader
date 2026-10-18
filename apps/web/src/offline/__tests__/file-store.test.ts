import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  createDefaultStore,
  createIndexedDbStore,
  createMemoryStore,
  createOpfsStore,
} from '../fileStore';

const blob = (text: string): Blob => new Blob([text], { type: 'application/octet-stream' });

let counter = 0;

function uniqueName(): string {
  counter += 1;
  return `bookr-cache-test-${counter}`;
}

describe('cacheKey', () => {
  it('joins the user, book and kind with slashes', () => {
    expect(cacheKey('user-reader', 'book-1', 'book')).toBe('user-reader/book-1/book');
    expect(cacheKey('user-reader', 'book-1', 'reflow')).toBe('user-reader/book-1/reflow');
  });
});

describe('createMemoryStore', () => {
  it('stores, deletes, counts and clears blobs', async () => {
    const store = createMemoryStore();

    expect(await store.has('user/book/book')).toBe(false);
    expect(await store.get('user/book/book')).toBeNull();

    await store.put('user/book/book', blob('hello'));
    await store.put('user/book/reflow', blob('reflow!'));

    expect((await store.get('user/book/book'))?.size).toBe(5);
    expect(await store.has('user/book/book')).toBe(true);
    expect((await store.keys()).sort()).toEqual(['user/book/book', 'user/book/reflow']);
    expect(await store.totalBytes()).toBe(12);

    await store.delete('user/book/book');
    expect(await store.get('user/book/book')).toBeNull();
    expect(await store.totalBytes()).toBe(7);

    await store.clear();
    expect(await store.keys()).toEqual([]);
    expect(await store.totalBytes()).toBe(0);
  });
});

describe('createIndexedDbStore', () => {
  it('round-trips blobs through IndexedDB', async () => {
    const store = createIndexedDbStore(uniqueName());

    expect(await store.get('user/book/book')).toBeNull();
    await store.put('user/book/book', blob('pdf-bytes'));
    await store.put('user/book/reflow', blob('reflow'));

    expect((await store.get('user/book/book'))?.size).toBe(9);
    expect(await store.has('user/book/reflow')).toBe(true);
    expect((await store.keys()).sort()).toEqual(['user/book/book', 'user/book/reflow']);
    expect(await store.totalBytes()).toBe(15);

    await store.delete('user/book/book');
    expect(await store.get('user/book/book')).toBeNull();
    expect(await store.totalBytes()).toBe(6);

    await store.clear();
    expect(await store.keys()).toEqual([]);
    expect(await store.totalBytes()).toBe(0);
  });

  it('shares data between stores opened under the same name', async () => {
    const name = uniqueName();
    const first = createIndexedDbStore(name);
    await first.put('user/book/book', blob('shared'));

    const second = createIndexedDbStore(name);
    expect((await second.get('user/book/book'))?.size).toBe(6);

    await second.clear();
    expect(await first.has('user/book/book')).toBe(false);
  });
});

describe('createOpfsStore', () => {
  it('throws when OPFS is unavailable in this environment', () => {
    expect(typeof navigator.storage?.getDirectory).not.toBe('function');
    expect(() => createOpfsStore()).toThrow(/not available/i);
  });
});

describe('createDefaultStore', () => {
  it('skips OPFS when unavailable and still works through IndexedDB', async () => {
    const store = await createDefaultStore();
    await store.clear();

    await store.put('user/book/book', blob('offline'));
    expect((await store.get('user/book/book'))?.size).toBe(7);

    // Reopening the default IndexedDB database proves the bytes really landed
    // in persistence rather than the in-memory fallback.
    const reopened = createIndexedDbStore('bookr-cache');
    expect((await reopened.get('user/book/book'))?.size).toBe(7);

    await reopened.clear();
  });
});
