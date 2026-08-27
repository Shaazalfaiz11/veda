import { Redis, type RedisOptions } from 'ioredis';
import { getEnv } from '@/lib/config';
import { logger } from '@/lib/logger';

/**
 * Redis connections.
 *
 * One shared connection serves the queue producer and the state store. The
 * worker gets its own via `createRedisConnection` — BullMQ workers issue
 * blocking commands (BRPOPLPUSH), which monopolise a connection, so sharing
 * would stall every other command on it. That is the only duplication here.
 *
 * In development Next.js re-evaluates modules on hot reload, so the
 * singleton is parked on globalThis to stop each reload leaking a socket.
 */
const globalForRedis = globalThis as unknown as { __vedaRedis?: Redis };

function baseOptions(): RedisOptions {
  return {
    // Required by BullMQ: it manages its own retry semantics, and a
    // per-request retry cap makes blocking commands fail spuriously.
    maxRetriesPerRequest: null,
    lazyConnect: true,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 3000),
  };
}

function attachDiagnostics(client: Redis, role: string): Redis {
  // Without an error listener an ioredis failure escalates to an unhandled
  // 'error' event and takes the process down.
  client.on('error', (error: Error) => {
    logger.error({ role, err: { message: error.message } }, 'redis.connection.error');
  });
  client.on('end', () => logger.warn({ role }, 'redis.connection.closed'));
  client.on('ready', () => logger.info({ role }, 'redis.connection.ready'));

  return client;
}

/** A dedicated connection. Use only where a blocking client is required. */
export function createRedisConnection(role = 'worker'): Redis {
  const { REDIS_URL } = getEnv();
  return attachDiagnostics(new Redis(REDIS_URL, baseOptions()), role);
}

/** The shared connection used by the queue producer and the state store. */
export function getRedisConnection(): Redis {
  if (!globalForRedis.__vedaRedis) {
    globalForRedis.__vedaRedis = createRedisConnection('shared');
  }
  return globalForRedis.__vedaRedis;
}

/** Namespaced key builder, so one Redis can host several environments. */
export function redisKey(...parts: string[]): string {
  return [getEnv().REDIS_KEY_PREFIX, ...parts].join(':');
}

export async function closeRedisConnection(): Promise<void> {
  const client = globalForRedis.__vedaRedis;
  if (!client) return;

  globalForRedis.__vedaRedis = undefined;
  try {
    await client.quit();
  } catch {
    // A connection that never opened has nothing to close cleanly.
    client.disconnect();
  }
}

/** Liveness probe used by the worker at boot and by the health check. */
export async function pingRedis(client: Redis = getRedisConnection()): Promise<boolean> {
  try {
    const reply = await client.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}
