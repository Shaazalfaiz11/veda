import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDocumentStorage } from '@/lib/storage/local-storage';
import {
  assertSafeKey,
  documentPrefix,
  originalDocumentKey,
  preparedPageKey,
  sanitizeFilename,
} from '@/lib/storage/keys';
import { NotFoundError, ValidationError } from '@/lib/errors';

const ASSESSMENT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const DOCUMENT = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

describe('storage key generation', () => {
  it('builds keys only from ids and fixed literals', () => {
    expect(originalDocumentKey(ASSESSMENT, DOCUMENT)).toBe(
      `assessments/${ASSESSMENT}/${DOCUMENT}/original`,
    );
    expect(preparedPageKey(ASSESSMENT, DOCUMENT, 3)).toBe(
      `assessments/${ASSESSMENT}/${DOCUMENT}/pages/3.png`,
    );
    expect(documentPrefix(ASSESSMENT, DOCUMENT)).toBe(`assessments/${ASSESSMENT}/${DOCUMENT}`);
  });

  it('refuses to build a key from a non-UUID id', () => {
    expect(() => originalDocumentKey('../../etc', DOCUMENT)).toThrow(ValidationError);
    expect(() => preparedPageKey(ASSESSMENT, 'not-a-uuid', 1)).toThrow(ValidationError);
  });

  it('refuses a non-positive or fractional page number', () => {
    expect(() => preparedPageKey(ASSESSMENT, DOCUMENT, 0)).toThrow(ValidationError);
    expect(() => preparedPageKey(ASSESSMENT, DOCUMENT, -1)).toThrow(ValidationError);
    expect(() => preparedPageKey(ASSESSMENT, DOCUMENT, 1.5)).toThrow(ValidationError);
  });
});

describe('storage key validation', () => {
  it('accepts generated keys', () => {
    expect(() => assertSafeKey(originalDocumentKey(ASSESSMENT, DOCUMENT))).not.toThrow();
    expect(() => assertSafeKey(preparedPageKey(ASSESSMENT, DOCUMENT, 12))).not.toThrow();
  });

  it.each([
    ['traversal', 'assessments/../../etc/passwd'],
    ['single dot segment', 'assessments/./secret'],
    ['absolute posix', '/etc/passwd'],
    ['windows drive', 'C:/Windows/System32'],
    ['backslash', 'assessments\\..\\secret'],
    ['NUL byte', 'assessments/a\0b'],
    ['empty segment', 'assessments//original'],
    ['empty string', ''],
  ])('rejects %s', (_label, key) => {
    expect(() => assertSafeKey(key)).toThrow(ValidationError);
  });

  it('rejects an over-long key', () => {
    expect(() => assertSafeKey('a'.repeat(600))).toThrow(ValidationError);
  });
});

describe('filename sanitisation', () => {
  it('strips directory components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\me\\answers.pdf')).toBe('answers.pdf');
  });

  it('replaces characters that are not safe to echo back', () => {
    expect(sanitizeFilename('my answers (final).pdf')).toBe('my_answers__final_.pdf');
  });

  it('strips leading dots so nothing becomes a hidden file', () => {
    expect(sanitizeFilename('...hidden.pdf')).toBe('hidden.pdf');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeFilename('', 'answer_sheet')).toBe('answer_sheet');
    expect(sanitizeFilename('///')).toBe('document');
  });

  it('bounds the length', () => {
    expect(sanitizeFilename(`${'a'.repeat(400)}.pdf`).length).toBeLessThanOrEqual(255);
  });
});

describe('local filesystem storage', () => {
  let root: string;
  let storage: LocalDocumentStorage;

  const key = originalDocumentKey(ASSESSMENT, DOCUMENT);
  const body = Buffer.from('canonical page bytes');

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'veda-storage-'));
    storage = new LocalDocumentStorage(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports a missing object as absent', async () => {
    expect(await storage.exists(key)).toBe(false);
    expect(await storage.head(key)).toBeNull();
  });

  it('stores and reads a buffer', async () => {
    const stored = await storage.put(key, body, { contentType: 'application/pdf' });

    expect(stored.key).toBe(key);
    expect(stored.sizeBytes).toBe(body.byteLength);
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.get(key)).toEqual(body);
  });

  it('creates nested directories for a key', async () => {
    const pageKey = preparedPageKey(ASSESSMENT, DOCUMENT, 4);
    await storage.put(pageKey, Buffer.from('page 4'), { contentType: 'image/png' });

    expect(await readFile(join(root, pageKey))).toEqual(Buffer.from('page 4'));
  });

  it('accepts a stream without buffering the whole body', async () => {
    const streamKey = preparedPageKey(ASSESSMENT, DOCUMENT, 9);
    const chunks = ['alpha', 'beta', 'gamma'];

    await storage.put(streamKey, Readable.from(chunks), { contentType: 'image/png' });

    expect((await storage.get(streamKey)).toString()).toBe('alphabetagamma');
  });

  it('reads back as a stream', async () => {
    const stream = await storage.getStream(key);
    const collected: Buffer[] = [];

    for await (const chunk of stream) collected.push(Buffer.from(chunk));

    expect(Buffer.concat(collected)).toEqual(body);
  });

  it('overwrites an existing object', async () => {
    await storage.put(key, Buffer.from('replaced'), { contentType: 'application/pdf' });
    expect((await storage.get(key)).toString()).toBe('replaced');
  });

  it('throws NotFoundError reading an absent object', async () => {
    const absent = preparedPageKey(ASSESSMENT, randomUUID(), 1);
    await expect(storage.get(absent)).rejects.toThrow(NotFoundError);
    await expect(storage.getStream(absent)).rejects.toThrow(NotFoundError);
  });

  it('does not leak the absolute path in the error message', async () => {
    const absent = preparedPageKey(ASSESSMENT, randomUUID(), 1);

    await expect(storage.get(absent)).rejects.toThrow(
      // The key is named; the filesystem root is not.
      expect.objectContaining({ message: expect.not.stringContaining(root) }) as Error,
    );
  });

  it('treats deleting an absent object as a no-op', async () => {
    await expect(storage.delete(preparedPageKey(ASSESSMENT, randomUUID(), 1))).resolves
      .toBeUndefined();
  });

  it('removes every object under a prefix', async () => {
    await storage.deletePrefix(documentPrefix(ASSESSMENT, DOCUMENT));

    expect(await storage.exists(key)).toBe(false);
    expect(await storage.exists(preparedPageKey(ASSESSMENT, DOCUMENT, 4))).toBe(false);
  });

  it('refuses a key that would escape the storage root', async () => {
    await expect(
      storage.put('../escaped', Buffer.from('nope'), { contentType: 'text/plain' }),
    ).rejects.toThrow(ValidationError);

    await expect(storage.get('assessments/../../outside')).rejects.toThrow(ValidationError);
  });
});
