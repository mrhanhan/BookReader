import type { StorageService, StoredObjectInfo } from './types';

/** In-memory storage used by tests and the initial server skeleton. */
export class FakeStorage implements StorageService {
  readonly objects = new Map<string, Buffer>();
  readonly contentTypes = new Map<string, string>();

  async presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    const type = encodeURIComponent(contentType);
    return `https://fake-s3.local/bookr/${key}?X-Amz-Expires=${expiresInSeconds}&X-Amz-Content-Type=${type}`;
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return `https://fake-s3.local/bookr/${key}?X-Amz-Expires=${expiresInSeconds}`;
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    const body = this.objects.get(key);
    return body ? { size: body.length } : null;
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
      throw new Error(`Object not found: ${key}`);
    }
    return body;
  }
}
