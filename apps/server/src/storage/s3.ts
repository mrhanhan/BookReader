import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { AppConfig } from '../config';
import {
  StorageObjectNotFoundError,
  type PresignedPost,
  type StorageService,
  type StoredObjectInfo,
} from './types';

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

function createClient(config: AppConfig['s3'], endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}

/** True when a bucket creation lost a race with another owner of the same bucket. */
function isAlreadyOwned(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}

/**
 * Creates the configured bucket when it does not exist yet. MinIO (and S3)
 * answer a create for an existing bucket with an "already owned" error, which
 * means the deployment is ready; every other failure is fatal at startup.
 */
export async function ensureBucket(config: AppConfig['s3']): Promise<void> {
  const client = createClient(config, config.endpoint);
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  } catch (error) {
    if (!isAlreadyOwned(error)) {
      throw error;
    }
  } finally {
    client.destroy();
  }
}

/** S3-compatible object storage; `forcePathStyle` targets MinIO. */
export class S3Storage implements StorageService {
  private readonly client: S3Client;
  /** Signs URLs against the endpoint browsers can reach; may be the same client. */
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor(config: AppConfig['s3']) {
    this.bucket = config.bucket;
    this.client = createClient(config, config.endpoint);
    this.presignClient =
      config.publicEndpoint === config.endpoint
        ? this.client
        : createClient(config, config.publicEndpoint);
  }

  async presignPost(
    key: string,
    contentType: string,
    size: number,
    expiresInSeconds: number,
  ): Promise<PresignedPost> {
    // The policy pins both the exact byte range and the content type. The
    // server checks HeadObject again before completing, but the policy is what
    // stops a client from parking an oversized object in the bucket.
    const post = await createPresignedPost(this.presignClient, {
      Bucket: this.bucket,
      Key: key,
      Expires: expiresInSeconds,
      Fields: { 'Content-Type': contentType },
      Conditions: [
        { 'Content-Type': contentType },
        ['content-length-range', size, size],
      ],
    });
    return { url: post.url, fields: post.fields };
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.presignClient,
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
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${Math.max(0, length - 1)}`,
        }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageObjectNotFoundError(key, { cause: error });
      }
      throw error;
    }
    const body = response.Body as { transformToByteArray(): Promise<Uint8Array> } | undefined;
    if (!body) {
      throw new Error('S3 returned an empty body');
    }
    return Buffer.from(await body.transformToByteArray());
  }

  async getObject(key: string): Promise<Buffer> {
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageObjectNotFoundError(key, { cause: error });
      }
      throw error;
    }
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
