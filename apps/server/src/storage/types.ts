/** Size information for a stored object. */
export interface StoredObjectInfo {
  size: number;
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
