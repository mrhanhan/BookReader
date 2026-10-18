import type { CacheManager } from './cacheManager';

/** Shown when the reader is offline and the book was never downloaded. */
export const OFFLINE_UNAVAILABLE_MESSAGE = '这本书尚未下载到本机';

/**
 * The book has no readable copy on this device. Separate from a generic
 * network failure so the reader can tell the user how to fix it.
 */
export class OfflineUnavailableError extends Error {
  constructor(message: string = OFFLINE_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'OfflineUnavailableError';
  }
}

/** URLs the reader should open for one book, plus where they came from. */
export interface ResolvedBookSource {
  /** Signed storage URL when online, cached object URL when offline. */
  fileUrl: string;
  /** Pack URL, or null when the book has no pack or it is not on this device. */
  reflowUrl: string | null;
  /** True when the URLs point at files downloaded to this device. */
  offline: boolean;
}

export interface ResolveBookSourceDeps {
  cache: CacheManager;
  online: () => boolean;
  userId: string;
  bookId: string;
  reflowAvailable: boolean;
  /** Test seam for the cached-copy refresh window; production uses `Date.now`. */
  now?: () => number;
  /** 生产传 api/reading 的 fetchReaderFile / fetchReflowFile；测试注入假实现。 */
  fetchFile: (bookId: string) => Promise<{ url: string }>;
  fetchReflow: (bookId: string) => Promise<{ url: string } | null>;
}

/**
 * How long a downloaded copy is trusted. Opening a cached book is the moment
 * its bytes may have drifted from the server (a re-converted file, an updated
 * pack), so it is refreshed once a day instead of on every open.
 */
export const CACHE_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** The cached pack URL, but only for books that actually have a pack. */
async function cachedReflowUrl(deps: ResolveBookSourceDeps): Promise<string | null> {
  if (!deps.reflowAvailable) return null;
  // A broken cache backend must never turn a signed URL into a failure page.
  return deps.cache.cachedUrl(deps.userId, deps.bookId, 'reflow').catch(() => null);
}

/**
 * True when the account already keeps this book on the device: either it is
 * pinned, or a cached file exists. The cache row itself is written with the
 * file, so a readable cached URL means the row is present. Probing failures
 * count as "not cached": a broken probe only makes the caller try a download,
 * which fails silently and leaves reading on the signed URL.
 */
async function hasCachedCopy(deps: ResolveBookSourceDeps): Promise<boolean> {
  if (await deps.cache.isPinned(deps.userId, deps.bookId).catch(() => false)) return true;
  const url = await deps.cache.cachedUrl(deps.userId, deps.bookId, 'book').catch(() => null);
  return url !== null;
}

/**
 * Downloads every copy this account should keep. Failures are collected rather
 * than propagated: the caller runs in the background and reading continues
 * with the signed URL.
 */
async function downloadCachedCopies(
  deps: ResolveBookSourceDeps,
  fileUrl: string,
  reflowUrl: string | null,
): Promise<void> {
  const writes: Promise<unknown>[] = [
    deps.cache.cacheFromUrl(deps.userId, deps.bookId, 'book', fileUrl),
  ];
  if (reflowUrl !== null) {
    writes.push(deps.cache.cacheFromUrl(deps.userId, deps.bookId, 'reflow', reflowUrl));
  }
  await Promise.allSettled(writes);
}

/**
 * Caches a book this account does not keep on the device yet, then puts it
 * into the recent-five window. Runs in the background: reading the freshly
 * signed URL must never wait for the download, and a failure only means the
 * book stays online-only.
 */
async function cacheNewCopy(
  deps: ResolveBookSourceDeps,
  fileUrl: string,
  reflowUrl: string | null,
): Promise<void> {
  await downloadCachedCopies(deps, fileUrl, reflowUrl);
  // The download created the row with a fresh timestamp; touching it again
  // keeps the LRU ordering explicit. Without `keepBookId` the five-slot window
  // is strict, and the just-downloaded (newest) book always survives.
  await deps.cache.touch(deps.userId, deps.bookId).catch(() => undefined);
  await deps.cache.enforceLru(deps.userId).catch(() => undefined);
}

/**
 * True when the downloaded copy must be replaced: its row is older than the
 * refresh window, the row is missing (a pinned placeholder that never landed),
 * or the file itself disappeared while the row survived.
 */
async function needsRefresh(deps: ResolveBookSourceDeps): Promise<boolean> {
  const cachedAt = await deps.cache
    .cachedAt(deps.userId, deps.bookId)
    .catch(() => null);
  const now = deps.now?.() ?? Date.now();
  if (cachedAt !== null && now - cachedAt < CACHE_REFRESH_AFTER_MS) {
    const fileUrl = await deps.cache
      .cachedUrl(deps.userId, deps.bookId, 'book')
      .catch(() => null);
    return fileUrl === null;
  }
  return true;
}

/**
 * Refreshes the downloaded copies from fresh signed URLs. Runs in the
 * background: reading the freshly signed URL must never wait for the download,
 * and a failed refresh leaves the previous copy usable.
 */
async function refreshCachedCopy(
  deps: ResolveBookSourceDeps,
  fileUrl: string,
  reflowUrl: string | null,
): Promise<void> {
  if (!(await needsRefresh(deps))) return;
  await downloadCachedCopies(deps, fileUrl, reflowUrl);
}

async function resolveOnline(deps: ResolveBookSourceDeps): Promise<ResolvedBookSource> {
  const { cache, userId, bookId, reflowAvailable } = deps;

  let file: { url: string };
  try {
    file = await deps.fetchFile(bookId);
  } catch (error) {
    // The connection may drop between the online check and the request. A
    // downloaded copy is still readable; without one the request error (which
    // carries the API code) is the useful failure to report. A broken cache
    // backend is treated as "no copy" rather than masking the request error.
    const fileUrl = await cache.cachedUrl(userId, bookId, 'book').catch(() => null);
    if (fileUrl === null) throw error;
    return { fileUrl, reflowUrl: await cachedReflowUrl(deps), offline: true };
  }

  const reflow = reflowAvailable ? await deps.fetchReflow(bookId).catch(() => null) : null;
  // A failed pack request falls back to a downloaded pack; the original stays
  // readable either way. Probing the cache is best-effort.
  const reflowUrl =
    reflow?.url ??
    (reflowAvailable
      ? await cache.cachedUrl(userId, bookId, 'reflow').catch(() => null)
      : null);

  if (await hasCachedCopy(deps)) {
    // The account keeps this book on the device: only an aged or missing copy
    // needs downloading again, so a normal re-open reads the cached bytes.
    void refreshCachedCopy(deps, file.url, reflow?.url ?? null);
  } else {
    // First online open: cache it silently and count it among the recent five.
    void cacheNewCopy(deps, file.url, reflow?.url ?? null);
  }

  return { fileUrl: file.url, reflowUrl, offline: false };
}

async function resolveOffline(deps: ResolveBookSourceDeps): Promise<ResolvedBookSource> {
  const fileUrl = await deps.cache.cachedUrl(deps.userId, deps.bookId, 'book');
  if (fileUrl === null) throw new OfflineUnavailableError();
  return {
    fileUrl,
    reflowUrl: await cachedReflowUrl(deps),
    offline: true,
  };
}

/**
 * Picks the URL the reader should open: a signed URL while online (falling
 * back to the downloaded copy), and only the downloaded copy while offline.
 * A successful online open keeps a copy on the device: a book this account
 * does not have yet is downloaded silently and joins the recent-five LRU,
 * while an existing copy is refreshed only when it is old or missing. A
 * successful open also refreshes the book's position in the offline LRU.
 */
export async function resolveBookSource(
  deps: ResolveBookSourceDeps,
): Promise<ResolvedBookSource> {
  const resolved = deps.online() ? await resolveOnline(deps) : await resolveOffline(deps);

  // Cache bookkeeping never blocks reading: a failure here only means the
  // book's place in the recent-five window is stale.
  await deps.cache.touch(deps.userId, deps.bookId).catch(() => undefined);
  await deps.cache.enforceLru(deps.userId, deps.bookId).catch(() => undefined);
  return resolved;
}
