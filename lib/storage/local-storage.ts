import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { getEnv } from '@/lib/config';
import { InternalError, NotFoundError, ValidationError } from '@/lib/errors';
import { assertSafeKey } from './keys';
import { R2DocumentStorage } from './r2-storage';
import type { DocumentStorageProvider, PutOptions, StoredObject } from './types';

/**
 * Local filesystem storage, for development and test.
 *
 * Every key is validated and then re-checked after resolution: even if key
 * construction were subverted, a path that escapes the root is refused
 * before any I/O happens. Absolute paths never leave this module.
 */
export class LocalDocumentStorage implements DocumentStorageProvider {
  readonly name = 'local-filesystem';

  private readonly root: string;

  constructor(root?: string) {
    const configured = root ?? getEnv().STORAGE_ROOT;
    this.root = isAbsolute(configured) ? resolve(configured) : resolve(process.cwd(), configured);
  }

  /**
   * Resolves a key to an absolute path, refusing anything that lands outside
   * the storage root. The containment check compares resolved paths, so it
   * holds even against symlink-free traversal that survives key validation.
   */
  private pathFor(key: string): string {
    assertSafeKey(key);

    const candidate = resolve(join(this.root, key));
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep;

    if (candidate !== this.root && !candidate.startsWith(rootWithSep)) {
      throw new ValidationError('Storage key resolves outside the storage root.');
    }

    return candidate;
  }

  async put(key: string, body: Buffer | Readable, options: PutOptions): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });

    if (Buffer.isBuffer(body)) {
      await pipeline(Readable.from(body), createWriteStream(path));
    } else {
      // Streamed straight to disk — the file is never fully buffered.
      await pipeline(body, createWriteStream(path));
    }

    const info = await stat(path);

    return { key, sizeBytes: info.size, contentType: options.contentType };
  }

  async get(key: string): Promise<Buffer> {
    const path = this.pathFor(key);

    try {
      return await readFile(path);
    } catch (error) {
      throw this.translate(error, key);
    }
  }

  async getStream(key: string): Promise<Readable> {
    const path = this.pathFor(key);

    if (!(await this.exists(key))) {
      throw new NotFoundError(`Stored object ${key} was not found.`);
    }

    return createReadStream(path);
  }

  async head(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);

    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      return { key, sizeBytes: info.size, contentType: 'application/octet-stream' };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.translate(error, key);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const path = this.pathFor(prefix);
    await rm(path, { recursive: true, force: true });
  }

  private translate(error: unknown, key: string): Error {
    if (isNotFound(error)) {
      return new NotFoundError(`Stored object ${key} was not found.`);
    }
    // The absolute path is deliberately not propagated into the message.
    return new InternalError(`Storage operation failed for key ${key}.`);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

let storageOverride: DocumentStorageProvider | null = null;
let r2Singleton: DocumentStorageProvider | null = null;

/**
 * The storage provider this deployment uses.
 *
 * `local` is the filesystem, for development and test. `r2` is Cloudflare R2,
 * which is what a deployment on an ephemeral container needs: the disk there
 * is replaced on every restart, and an assessment whose page bitmaps vanished
 * still had its metadata in Redis, so the review screen drew its overlay onto
 * a broken image.
 *
 * The R2 provider is memoised. The local one is cheap to construct, but an
 * S3 client carries a connection pool that should not be rebuilt per call.
 */
export function getDocumentStorage(): DocumentStorageProvider {
  if (storageOverride) return storageOverride;

  if (getEnv().STORAGE_DRIVER === 'r2') {
    r2Singleton ??= new R2DocumentStorage();
    return r2Singleton;
  }

  return new LocalDocumentStorage();
}

/** Test seam: swap the provider, or pass null to restore the default. */
export function setDocumentStorage(provider: DocumentStorageProvider | null): void {
  storageOverride = provider;
  r2Singleton = null;
}
