import {
  StorageObjectNotFoundError,
  type PresignedPost,
  type StorageService,
  type StoredObjectInfo,
} from './types';

/** In-memory storage used by tests and the initial server skeleton. */
export class FakeStorage implements StorageService {
  readonly objects = new Map<string, Buffer>();
  readonly contentTypes = new Map<string, string>();

  async presignPost(
    key: string,
    contentType: string,
    size: number,
    expiresInSeconds: number,
  ): Promise<PresignedPost> {
    return {
      url: `https://fake-s3.local/bookr/${key}`,
      fields: {
        key,
        'Content-Type': contentType,
        'X-Amz-Expires': String(expiresInSeconds),
        'X-Amz-Content-Length-Range': `${size}-${size}`,
      },
    };
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return `https://fake-s3.local/bookr/${key}?X-Amz-Expires=${expiresInSeconds}`;
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    const body = this.objects.get(key);
    return body ? { size: body.length } : null;
  }

  async checkBucket(): Promise<void> {
    // The in-memory store is always "reachable".
  }

  async readFirstBytes(key: string, length: number): Promise<Buffer> {
    return Buffer.from(this.requireObject(key).subarray(0, length));
  }

  async getObject(key: string): Promise<Buffer> {
    return Buffer.from(this.requireObject(key));
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, Buffer.from(body));
    this.contentTypes.set(key, contentType);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.contentTypes.delete(key);
  }

  clear(): void {
    this.objects.clear();
    this.contentTypes.clear();
  }

  private requireObject(key: string): Buffer {
    const body = this.objects.get(key);
    if (!body) {
      throw new StorageObjectNotFoundError(key);
    }
    return body;
  }
}
