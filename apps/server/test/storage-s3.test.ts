import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { S3Client } from '@aws-sdk/client-s3';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config';
import { S3Storage } from '../src/storage/s3';

interface RecordedRequest {
  method: string;
  url: string;
  host: string;
}

/**
 * Regression guard for the deployment bug the E2E caught: presigned URLs were
 * signed against the container-internal MinIO host, so browsers could not use
 * them. Presigning must use the public endpoint while server-side operations
 * stay on the internal one.
 */
describe('S3Storage endpoints', () => {
  const requests: RecordedRequest[] = [];
  let server: ReturnType<typeof createServer>;
  let internalOrigin: string;
  let storage: S3Storage;

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        host: request.headers.host ?? '',
      });
      request.resume();

      if (request.method === 'HEAD') {
        response.writeHead(200, { 'content-length': '3' });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    internalOrigin = `http://127.0.0.1:${port}`;

    const s3: AppConfig['s3'] = {
      endpoint: internalOrigin,
      // The .invalid TLD never resolves: a server-side call accidentally using
      // the presign client fails fast instead of reaching a real MinIO.
      publicEndpoint: 'http://public.invalid:9200',
      region: 'us-east-1',
      accessKey: 'test-access-key',
      secretKey: 'test-secret-key',
      bucket: 'bookr',
    };
    storage = new S3Storage(s3);
  });

  afterAll(async () => {
    const clients = storage as unknown as { client: S3Client; presignClient: S3Client };
    clients.client.destroy();
    clients.presignClient.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  it('signs upload and cover URLs against the public endpoint', async () => {
    const post = await storage.presignPost('library/book.pdf', 'application/pdf', 1024, 60);
    const url = new URL(post.url);
    expect(url.origin).toBe('http://public.invalid:9200');
    expect(url.pathname).toBe('/bookr');
    expect(post.fields.key).toBe('library/book.pdf');
    expect(post.fields['Content-Type']).toBe('application/pdf');

    // The signed policy must pin the declared size and content type.
    const policy = JSON.parse(Buffer.from(post.fields.Policy!, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toContainEqual(['content-length-range', 1024, 1024]);
    expect(policy.conditions).toContainEqual({ 'Content-Type': 'application/pdf' });
    expect(post.fields['X-Amz-Signature']).toBeTruthy();

    const get = new URL(await storage.presignGet('library/book.pdf', 60));
    expect(get.origin).toBe('http://public.invalid:9200');
    expect(get.pathname).toBe('/bookr/library/book.pdf');
    expect(get.searchParams.get('X-Amz-Signature')).toBeTruthy();

    // Signing is local; neither endpoint may receive a request.
    expect(requests).toHaveLength(0);
  });

  it('keeps server-side reads and writes on the internal endpoint', async () => {
    await storage.putObject('library/book.pdf', Buffer.from('abc'), 'application/pdf');
    await expect(storage.head('library/book.pdf')).resolves.toEqual({ size: 3 });

    expect(requests.map(({ method, url }) => `${method} ${url.split('?')[0]}`)).toEqual([
      'PUT /bookr/library/book.pdf',
      'HEAD /bookr/library/book.pdf',
    ]);
    const internalHost = new URL(internalOrigin).host;
    expect(requests.every(({ host }) => host === internalHost)).toBe(true);
  });

  it('checkBucket fails when the bucket is missing', async () => {
    const client = (
      storage as unknown as { client: { send: (command: unknown) => Promise<unknown> } }
    ).client;
    const originalSend = client.send;
    const sent: unknown[] = [];
    try {
      const noSuchBucket = Object.assign(new Error('bucket missing'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      });
      client.send = async (command: unknown) => {
        sent.push(command);
        throw noSuchBucket;
      };
      await expect(storage.checkBucket()).rejects.toBe(noSuchBucket);
      // A list (GET) probe is what makes a missing bucket observable; HEAD
      // responses have no body and surface as a generic NotFound.
      expect(sent).toHaveLength(1);
      expect(sent[0]).toBeInstanceOf(ListObjectsV2Command);
      expect((sent[0] as ListObjectsV2Command).input).toMatchObject({
        Bucket: 'bookr',
        MaxKeys: 1,
      });
    } finally {
      client.send = originalSend;
    }
  });
});
