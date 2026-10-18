/** Size information for a stored object. */
export interface StoredObjectInfo {
  size: number;
}

/**
 * Raised when an object does not exist. Callers may treat this as a user
 * error (the upload never arrived), unlike transport or server failures from
 * the storage backend, which are retryable.
 */
export class StorageObjectNotFoundError extends Error {
  constructor(
    readonly key: string,
    options?: { cause?: unknown },
  ) {
    super(`Object not found: ${key}`, options);
    this.name = 'StorageObjectNotFoundError';
  }
}

/** Object storage used for book files and generated artifacts. */
export interface StorageService {
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  head(key: string): Promise<StoredObjectInfo | null>;
  readFirstBytes(key: string, length: number): Promise<Buffer>;
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}
