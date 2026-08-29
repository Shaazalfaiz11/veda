import { logger } from '@/lib/logger';

/**
 * TEMPORARY DIAGNOSTIC — remove once the stall investigation concludes.
 *
 * Four benchmark runs were re-delivered mid-MAPPING at 58.7s, 58.9s, 61.2s
 * and ~59s after the stage began. BullMQ's defaults are a 30s lock renewed on
 * a 15s timer and a 30s stalled sweep, so 60s is exactly what a lock that was
 * never renewed once looks like. Renewal is an ordinary event-loop timer:
 * memory has nothing to do with it if the loop itself is blocked.
 *
 * The probe is a self-rescheduling timer. Its value is not the sample it
 * writes but the sample it *cannot* write: while the loop is blocked nothing
 * fires, and the first tick afterwards reports the whole pause as drift. A
 * 30-second block therefore appears as a single line with lagMs near 30000.
 */

const INTERVAL_MS = 2_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let maxLagMs = 0;
let stage = 'UNKNOWN';

function mb(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}

export function markStage(next: string): void {
  stage = next;
}

export function startLoopProbe(): void {
  if (timer) return;

  let expectedAt = Date.now() + INTERVAL_MS;

  const tick = (): void => {
    const now = Date.now();
    const lagMs = Math.max(0, now - expectedAt);
    maxLagMs = Math.max(maxLagMs, lagMs);

    const memory = process.memoryUsage();

    logger.info(
      {
        stage,
        lagMs,
        maxLagMs,
        rssMb: mb(memory.rss),
        heapUsedMb: mb(memory.heapUsed),
        heapTotalMb: mb(memory.heapTotal),
        externalMb: mb(memory.external),
        arrayBuffersMb: mb(memory.arrayBuffers),
      },
      'diag.loop',
    );

    expectedAt = Date.now() + INTERVAL_MS;
    timer = setTimeout(tick, INTERVAL_MS);
  };

  timer = setTimeout(tick, INTERVAL_MS);
  timer.unref?.();
}

export function stopLoopProbe(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
