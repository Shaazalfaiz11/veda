import type { Redis } from 'ioredis';
import { getEnv } from '@/lib/config';
import { getRedisConnection, redisKey } from '@/lib/queue/connection';
import { ConflictError, NotFoundError } from '@/lib/errors';
import type { Assessment } from '@/lib/domain/assessment';

/**
 * Assessment state store.
 *
 * The API and the worker are separate processes, so a module-level Map in
 * either one would be invisible to the other and the status endpoint would
 * never reflect the worker's progress. Redis is already a hard dependency of
 * the queue, so it holds the state too — still in-memory storage, no
 * database, and no infrastructure beyond what the queue already requires.
 */
export interface AssessmentStore {
  create(assessment: Assessment): Promise<Assessment>;
  find(id: string): Promise<Assessment | null>;
  get(id: string): Promise<Assessment>;
  update(id: string, mutate: (current: Assessment) => Assessment): Promise<Assessment>;
  delete(id: string): Promise<void>;
}

function keyFor(id: string): string {
  return redisKey('assessment', id);
}

/** Max optimistic-update attempts before surfacing contention to the caller. */
const MAX_UPDATE_ATTEMPTS = 5;

/**
 * Serialises updates per assessment across the whole process.
 *
 * Module scope, not instance scope, and that distinction is the entire point:
 * `getAssessmentStore()` returns a *new* store on every call, so an
 * instance-level map would be empty for every request and lock nothing.
 *
 * The lock is needed because WATCH is connection state, not key state, and
 * every store shares one connection. Two overlapping updates interleave on
 * it: both WATCH, both GET the same snapshot, and the first EXEC clears the
 * watch for the whole connection — so the second EXEC succeeds
 * unconditionally and silently discards the first write. Uploading two
 * documents at once loses one of them, with a 201 for each.
 *
 * WATCH still earns its place for the cross-process case, where the API and
 * the worker write over different connections. This closes the in-process
 * hole WATCH cannot see.
 */
const updateLocks = new Map<string, Promise<unknown>>();

export class RedisAssessmentStore implements AssessmentStore {
  constructor(private readonly client: Redis = getRedisConnection()) {}

  async create(assessment: Assessment): Promise<Assessment> {
    const key = keyFor(assessment.id);
    const ttl = getEnv().ASSESSMENT_TTL_SECONDS;

    // NX so a colliding id is a conflict rather than a silent overwrite.
    const result = await this.client.set(key, JSON.stringify(assessment), 'EX', ttl, 'NX');

    if (result === null) {
      throw new ConflictError(`Assessment ${assessment.id} already exists.`);
    }

    return assessment;
  }

  async find(id: string): Promise<Assessment | null> {
    const raw = await this.client.get(keyFor(id));
    return raw ? (JSON.parse(raw) as Assessment) : null;
  }

  async get(id: string): Promise<Assessment> {
    const found = await this.find(id);
    if (!found) throw new NotFoundError(`Assessment ${id} was not found.`);
    return found;
  }

  /**
   * Read-modify-write guarded by WATCH, so a concurrent write from the other
   * process causes a retry rather than a lost update.
   */
  async update(id: string, mutate: (current: Assessment) => Assessment): Promise<Assessment> {
    const previous = updateLocks.get(id) ?? Promise.resolve();

    // Keep the chain alive even if the previous update rejected.
    const run = previous.catch(() => undefined).then(() => this.updateNow(id, mutate));

    updateLocks.set(id, run);

    try {
      return await run;
    } finally {
      // Only clear when this update is the tail, or a later one is dropped.
      if (updateLocks.get(id) === run) updateLocks.delete(id);
    }
  }

  private async updateNow(
    id: string,
    mutate: (current: Assessment) => Assessment,
  ): Promise<Assessment> {
    const key = keyFor(id);
    const ttl = getEnv().ASSESSMENT_TTL_SECONDS;

    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      await this.client.watch(key);

      const raw = await this.client.get(key);
      if (!raw) {
        await this.client.unwatch();
        throw new NotFoundError(`Assessment ${id} was not found.`);
      }

      const next = mutate(JSON.parse(raw) as Assessment);

      const applied = await this.client
        .multi()
        .set(key, JSON.stringify(next), 'EX', ttl)
        .exec();

      // exec() resolves to null when a watched key changed underneath us.
      if (applied !== null) return next;
    }

    throw new ConflictError(
      `Assessment ${id} could not be updated after ${MAX_UPDATE_ATTEMPTS} attempts.`,
    );
  }

  async delete(id: string): Promise<void> {
    await this.client.del(keyFor(id));
  }
}

/** Process-local store. Used by unit tests that must not touch Redis. */
export class InMemoryAssessmentStore implements AssessmentStore {
  private readonly items = new Map<string, string>();

  /**
   * Serialises updates per assessment.
   *
   * The Redis store guards read-modify-write with WATCH/MULTI and retries.
   * Without an equivalent here the double would be *less* safe than the thing
   * it stands in for: two concurrent updates would both read the same
   * snapshot and the second write would silently discard the first. Every
   * test relying on this store would then be quietly optimistic about
   * concurrency the real system actually handles.
   */
  private readonly updateLocks = new Map<string, Promise<unknown>>();

  async create(assessment: Assessment): Promise<Assessment> {
    if (this.items.has(assessment.id)) {
      throw new ConflictError(`Assessment ${assessment.id} already exists.`);
    }
    this.items.set(assessment.id, JSON.stringify(assessment));
    return assessment;
  }

  async find(id: string): Promise<Assessment | null> {
    const raw = this.items.get(id);
    return raw ? (JSON.parse(raw) as Assessment) : null;
  }

  async get(id: string): Promise<Assessment> {
    const found = await this.find(id);
    if (!found) throw new NotFoundError(`Assessment ${id} was not found.`);
    return found;
  }

  async update(id: string, mutate: (current: Assessment) => Assessment): Promise<Assessment> {
    const previous = updateLocks.get(id) ?? Promise.resolve();

    // Chain onto whatever is already in flight for this assessment, and keep
    // the chain alive even if that update rejected.
    const run = previous.catch(() => undefined).then(() => {
      const raw = this.items.get(id);
      if (!raw) throw new NotFoundError(`Assessment ${id} was not found.`);

      const next = mutate(JSON.parse(raw) as Assessment);
      this.items.set(id, JSON.stringify(next));
      return next;
    });

    updateLocks.set(id, run);

    try {
      return await run;
    } finally {
      // Release the lock once this is the last update queued.
      if (updateLocks.get(id) === run) updateLocks.delete(id);
    }
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
    this.updateLocks.clear();
  }
}

let storeOverride: AssessmentStore | null = null;

export function getAssessmentStore(): AssessmentStore {
  return storeOverride ?? new RedisAssessmentStore();
}

/** Test seam: swap in the in-memory store, or pass null to restore Redis. */
export function setAssessmentStore(store: AssessmentStore | null): void {
  storeOverride = store;
}
