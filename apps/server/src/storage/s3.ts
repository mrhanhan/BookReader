import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '../config';
import type { StorageService, StoredObjectInfo } from './types';

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function toBuffer(body: unknown): Buffer {
  if (body instanceof Buffer) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error('S3 response body is not a byte stream');
}

/** S3-compatible object storage; `forcePathStyle` targets MinIO. */
export class S3Storage implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: AppConfig['s3']) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  async presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: response.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async readFirstBytes(key: string, length: number): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=0-${Math.max(0, length - 1)}`,
      }),
    );
    const body = response.Body as { transformToByteArray(): Promise<Uint8Array> } | undefined;
    if (!body) {
      throw new Error('S3 returned an empty body');
    }
    return Buffer.from(await body.transformToByteArray());
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body as { transformToByteArray(): Promise<Uint8Array> } | undefined;
    if (!body) {
      throw new Error('S3 returned an empty body');
    }
    return toBuffer(await body.transformToByteArray());
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
