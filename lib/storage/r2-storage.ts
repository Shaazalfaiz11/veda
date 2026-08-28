import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getEnv } from '@/lib/config';
import { InternalError, NotFoundError } from '@/lib/errors';
import { assertSafeKey } from './keys';
import type { DocumentStorageProvider, PutOptions, StoredObject } from './types';

/**
 * Cloudflare R2, addressed through its S3-compatible API.
 *
 * This exists because the container filesystem does not survive a restart.
 * Redis kept the page metadata and the disk lost the pixels, so a reopened
 * assessment rendered its highlight overlay onto nothing. Both the original
 * upload and the prepared page bitmaps live here now; the keys are unchanged,
 * so nothing above this file knows the difference.
 *
 * R2 is not quite S3 and the differences all matter:
 *
 *   - `region` must be the literal "auto". R2 has no regions, but the S3
 *     signer refuses to sign without one.
 *   - Path-style addressing. Virtual-host style resolves a bucket subdomain
 *     that R2 does not serve on the account endpoint.
 *   - Flexible checksums off unless required. Recent SDK versions add a CRC32
 *     header to every upload that R2 rejects outright, which surfaces as an
 *     opaque 400 on `put` and nowhere else.
 */
export class R2DocumentStorage implements DocumentStorageProvider {
  readonly name = 'cloudflare-r2';

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const env = getEnv();

    // Validated at config load: the driver cannot be "r2" without all four.
    this.bucket = env.R2_BUCKET as string;
    this.client = new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT as string,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
      },
    });
  }

  async put(key: string, body: Buffer | Readable, options: PutOptions): Promise<StoredObject> {
    assertSafeKey(key);

    /*
     * A stream is collected before sending. S3 needs a length it cannot get
     * from an unbounded stream, and the alternative is a multipart uploader
     * and a second dependency. Every caller here already holds a Buffer, and
     * MAX_DOCUMENT_BYTES bounds what this can cost.
     */
    const data = Buffer.isBuffer(body) ? body : await collect(body);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: options.contentType,
          ContentLength: data.byteLength,
        }),
      );
    } catch (error) {
      throw this.translate(error, key);
    }

    return { key, sizeBytes: data.byteLength, contentType: options.contentType };
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      if (!response.Body) throw new NotFoundError(`Stored object ${key} was not found.`);

      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      throw this.translate(error, key);
    }
  }

  async getStream(key: string): Promise<Readable> {
    assertSafeKey(key);

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      if (!response.Body) throw new NotFoundError(`Stored object ${key} was not found.`);

      // Streamed rather than buffered: this is what the page-image route
      // pipes straight to the browser.
      return response.Body as Readable;
    } catch (error) {
      throw this.translate(error, key);
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    assertSafeKey(key);

    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      return {
        key,
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.translate(error, key);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  /** Absent keys are not an error, matching the local provider. */
  async delete(key: string): Promise<void> {
    assertSafeKey(key);

    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw this.translate(error, key);
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix);

    let token: string | undefined;

    // Listing is paginated and delete takes a thousand keys at a time; a
    // document has far fewer, but a prefix is not required to be small.
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: token,
        }),
      );

      const keys = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key));

      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }

      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }

  private translate(error: unknown, key: string): Error {
    if (error instanceof NotFoundError) return error;
    if (isNotFound(error)) return new NotFoundError(`Stored object ${key} was not found.`);

    // The endpoint and credentials are deliberately kept out of the message.
    return new InternalError(`Storage operation failed for key ${key}.`);
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };

  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
