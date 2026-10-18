/**
 * Blob storage for books that are kept on the device.
 *
 * Three backends share one interface so the cache manager never cares where the
 * bytes live: OPFS is preferred in the browser, IndexedDB is the fallback for
 * environments without it, and the memory store exists for tests and as a last
 * resort when no persistent backend is available.
 */

export type CacheKind = 'book' | 'reflow';

export interface CachedFileStore {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  totalBytes(): Promise<number>;
  clear(): Promise<void>;
}

/** Cache keys mirror the on-disk layout: one folder per user and book. */
export function cacheKey(userId: string, bookId: string, kind: CacheKind): string {
  return `${userId}/${bookId}/${kind}`;
}

function segmentsOf(key: string): string[] {
  return key.split('/').filter((segment) => segment.length > 0);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'NotFoundError'
  );
}

/** In-memory store; the default backend in jsdom, where OPFS does not exist. */
export function createMemoryStore(): CachedFileStore {
  const files = new Map<string, Blob>();

  return {
    async put(key, data) {
      files.set(key, data);
    },
    async get(key) {
      return files.get(key) ?? null;
    },
    async has(key) {
      return files.has(key);
    },
    async delete(key) {
      files.delete(key);
    },
    async keys() {
      return [...files.keys()];
    },
    async totalBytes() {
      let total = 0;
      for (const blob of files.values()) total += blob.size;
      return total;
    },
    async clear() {
      files.clear();
    },
  };
}

/** OPFS keeps the original path shape, so keys can be rebuilt by walking it. */
export function createOpfsStore(rootName = 'bookr-cache'): CachedFileStore {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage || typeof storage.getDirectory !== 'function') {
    throw new Error('The Origin Private File System is not available');
  }
  const manager = storage;

  async function root(create: boolean): Promise<FileSystemDirectoryHandle> {
    const origin = await manager.getDirectory();
    return origin.getDirectoryHandle(rootName, { create });
  }

  async function directoryFor(
    folder: readonly string[],
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await root(create);
    } catch (error) {
      if (!create && isMissing(error)) return null;
      throw error;
    }

    for (const segment of folder) {
      try {
        directory = await directory.getDirectoryHandle(segment, { create });
      } catch (error) {
        if (!create && isMissing(error)) return null;
        throw error;
      }
    }
    return directory;
  }

  function splitKey(key: string): { folder: string[]; name: string } {
    const segments = segmentsOf(key);
    const name = segments.at(-1);
    if (name === undefined) throw new Error(`Invalid cache key: ${key}`);
    return { folder: segments.slice(0, -1), name };
  }

  interface WalkEntry {
    key: string;
    size: number;
  }

  // `entries()` is declared in lib.dom.asynciterable, which the app does not
  // include; the runtime handle still exposes it, so walk with a local shape.
  function entryIterator(
    directory: FileSystemDirectoryHandle,
  ): AsyncIterableIterator<[string, FileSystemHandle]> {
    return (
      directory as unknown as {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries();
  }

  async function collect(
    directory: FileSystemDirectoryHandle,
    prefix: readonly string[],
  ): Promise<WalkEntry[]> {
    const found: WalkEntry[] = [];
    for await (const [name, handle] of entryIterator(directory)) {
      if (handle.kind === 'directory') {
        found.push(...(await collect(handle as FileSystemDirectoryHandle, [...prefix, name])));
        continue;
      }
      const file = await (handle as FileSystemFileHandle).getFile();
      found.push({ key: [...prefix, name].join('/'), size: file.size });
    }
    return found;
  }

  async function allFiles(): Promise<WalkEntry[]> {
    const directory = await directoryFor([], false);
    return directory ? collect(directory, []) : [];
  }

  async function readFile(key: string): Promise<Blob | null> {
    const { folder, name } = splitKey(key);
    const directory = await directoryFor(folder, false);
    if (!directory) return null;
    try {
      const handle = await directory.getFileHandle(name);
      return await handle.getFile();
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  return {
    async put(key, data) {
      const { folder, name } = splitKey(key);
      const directory = await directoryFor(folder, true);
      if (!directory) throw new Error(`Unable to create cache folder for ${key}`);
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(data);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
    },
    async get(key) {
      return readFile(key);
    },
    async has(key) {
      return (await readFile(key)) !== null;
    },
    async delete(key) {
      const { folder, name } = splitKey(key);
      const directory = await directoryFor(folder, false);
      if (!directory) return;
      try {
        await directory.removeEntry(name);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
    async keys() {
      return (await allFiles()).map((file) => file.key);
    },
    async totalBytes() {
      const files = await allFiles();
      return files.reduce((total, file) => total + file.size, 0);
    },
    async clear() {
      const origin = await manager.getDirectory();
      try {
        await origin.removeEntry(rootName, { recursive: true });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}

const IDB_STORE = 'files';
const IDB_VERSION = 1;

/**
 * jsdom's Blob is not structured-cloneable through fake-indexeddb (it degrades
 * to `{}`), so the IndexedDB backend serializes bytes and MIME type itself.
 * Real browsers clone Uint8Array just as cheaply and this keeps tests honest.
 */
interface StoredFile {
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
}

function isStoredFile(value: unknown): value is StoredFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { bytes?: unknown; type?: unknown };
  return ArrayBuffer.isView(candidate.bytes) && typeof candidate.type === 'string';
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openIndexedDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, IDB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(IDB_STORE)) {
        database.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error(`IndexedDB "${name}" is blocked`));
  });
}

/** IndexedDB fallback: one object store keyed by the cache key. */
export function createIndexedDbStore(name = 'bookr-cache'): CachedFileStore {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available');
  }

  let database: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    database ??= openIndexedDb(name);
    return database;
  };

  async function run<T>(
    mode: IDBTransactionMode,
    action: (files: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const connection = await open();
    const transaction = connection.transaction(IDB_STORE, mode);
    const done = transactionDone(transaction);
    const result = requestResult(action(transaction.objectStore(IDB_STORE)));
    const [value] = await Promise.all([result, done]);
    return value;
  }

  return {
    async put(key, data) {
      // Store bytes rather than Blobs: every structured-clone implementation
      // can round-trip those, while Blob support varies (jsdom in tests).
      const stored: StoredFile = {
        bytes: new Uint8Array(await data.arrayBuffer()),
        type: data.type,
      };
      await run('readwrite', (files) => files.put(stored, key));
    },
    async get(key) {
      const value: unknown = await run('readonly', (files) => files.get(key));
      if (!isStoredFile(value)) return null;
      return new Blob([value.bytes], { type: value.type });
    },
    async has(key) {
      const count: number = await run('readonly', (files) => files.count(key));
      return count > 0;
    },
    async delete(key) {
      await run('readwrite', (files) => files.delete(key));
    },
    async keys() {
      const keys = await run('readonly', (files) => files.getAllKeys());
      return keys.filter((key): key is string => typeof key === 'string');
    },
    async totalBytes() {
      const records: unknown[] = await run('readonly', (files) => files.getAll());
      return records.reduce<number>((total, record) => {
        if (!isStoredFile(record)) return total;
        return total + record.bytes.byteLength;
      }, 0);
    },
    async clear() {
      await run('readwrite', (files) => files.clear());
    },
  };
}

/**
 * Picks the best backend available: OPFS, then IndexedDB, then memory. Each
 * candidate is probed before it is handed out so a partially supported browser
 * cannot break caching at the first write.
 */
export async function createDefaultStore(): Promise<CachedFileStore> {
  try {
    const store = createOpfsStore();
    await store.totalBytes();
    return store;
  } catch {
    // OPFS is missing or blocked (private mode); try the next backend.
  }

  if (typeof indexedDB !== 'undefined') {
    try {
      const store = createIndexedDbStore();
      await store.keys();
      return store;
    } catch {
      // IndexedDB is disabled; fall back to memory.
    }
  }

  return createMemoryStore();
}
