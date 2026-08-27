import type { Readable } from 'node:stream';

/**
 * Storage provider contract.
 *
 * Domain and service code addresses bytes by opaque key and never learns
 * where they physically live. Swapping the local filesystem for object
 * storage later is a new implementation of this interface and nothing else.
 */
export interface StoredObject {
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface PutOptions {
  contentType: string;
}

export interface DocumentStorageProvider {
  readonly name: string;

  /**
   * Writes an object, replacing any existing one at the same key. Accepts a
   * stream so a large upload never has to be fully resident in memory.
   */
  put(key: string, body: Buffer | Readable, options: PutOptions): Promise<StoredObject>;

  /** Reads an object in full. Use `getStream` for anything large. */
  get(key: string): Promise<Buffer>;

  /** Reads an object as a stream. */
  getStream(key: string): Promise<Readable>;

  /** Object metadata without transferring the body. */
  head(key: string): Promise<StoredObject | null>;

  exists(key: string): Promise<boolean>;

  /** Removes one object. Absent keys are not an error. */
  delete(key: string): Promise<void>;

  /** Removes every object under a prefix. Used to discard a whole document. */
  deletePrefix(prefix: string): Promise<void>;
}
