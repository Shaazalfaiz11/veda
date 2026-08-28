import { getEnv } from '@/lib/config';
import { logger } from '@/lib/logger';

/**
 * The shared backstop for Groq's per-minute token limit.
 *
 * This began as a scheduler: a rolling local window that would admit a call
 * the moment there was room, replacing the fixed per-stage delays. Measured on
 * the same 5-page pair, that was slower, not faster — question extraction
 * 4m33s to 7m01s, answer extraction 3m00s to 8m19s. The reason is structural.
 * A local window cannot be reconciled with the provider's without erring
 * conservative, and on a 60-second window erring conservative costs a whole
 * window per call. The fixed delays, crude as they are, happen to sit close to
 * what an 8,000 TPM ceiling allows for a page image.
 *
 * So the stage delays keep the spacing, and this keeps the one thing they
 * cannot: when Groq actually refuses, every caller in the process holds off
 * for as long as it asked, rather than the next stage walking into the same
 * wall a moment later. Admission is serialised so that hold is universal.
 *
 * The spend record is kept because it costs nothing and makes the debug log
 * worth reading. Nothing gates on it.
 */

interface Spend {
  at: number;
  tokens: number;
}

const WINDOW_MS = 60_000;

/** What Groq reports about the token budget, when it reports it. */
export interface RateLimitHeaders {
  limitTokens: number | null;
  remainingTokens: number | null;
  resetTokensMs: number | null;
}

export class GroqRateLimiter {
  private readonly spends: Spend[] = [];

  /** Set from headers once seen; until then the configured ceiling stands. */
  private limit: number;

  /** Wall-clock time before which nothing may be sent, after a refusal. */
  private blockedUntil = 0;

  /** Serialises admission so two callers cannot both claim the same room. */
  private gate: Promise<void> = Promise.resolve();

  constructor(limitTokens: number) {
    this.limit = limitTokens;
  }

  /** Tokens spent inside the rolling window, pruning what has aged out. */
  private used(now: number): number {
    while (this.spends.length > 0 && now - this.spends[0]!.at >= WINDOW_MS) {
      this.spends.shift();
    }

    return this.spends.reduce((total, spend) => total + spend.tokens, 0);
  }

  /**
   * How long this call must hold off.
   *
   * Only a refusal gates a call. Predicting admission locally was tried and
   * measured worse than the fixed pacing it replaced: question extraction went
   * from 4m33s to 7m01s and answer extraction from 3m00s to 8m19s on the same
   * 5-page pair. The local window cannot be reconciled with the provider's
   * without erring conservative, and erring conservative on a 60-second window
   * costs a whole window per call.
   *
   * So the stage delays stay in charge of spacing, and this stays in charge of
   * what they cannot see: once Groq has actually refused, nothing goes out
   * until the time it named has passed. The spend record is kept for the
   * observability, not to gate on.
   */
  private waitFor(_estimate: number, now: number): number {
    if (now < this.blockedUntil) return this.blockedUntil - now;
    return 0;
  }

  /**
   * Blocks until this request fits, then provisionally charges the estimate.
   *
   * The estimate is booked immediately rather than after the response: a
   * request in flight has already committed those tokens, and a second caller
   * admitted against a window that ignores it would push both over.
   * `settle` replaces it with the real figure.
   */
  async acquire(estimate: number, label: string): Promise<(actual: number | null, headers: RateLimitHeaders) => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.gate;
    this.gate = this.gate.then(() => mine);
    await previous;

    try {
      let waited = 0;

      for (;;) {
        const now = Date.now();
        const wait = this.waitFor(estimate, now);
        if (wait === 0) break;

        waited += wait;
        await delay(wait);
      }

      if (waited > 0) {
        logger.debug(
          { label, waitedMs: waited, estimate, used: this.used(Date.now()), limit: this.limit },
          'groq.ratelimit.waited',
        );
      }

      const booking: Spend = { at: Date.now(), tokens: estimate };
      this.spends.push(booking);

      return (actual, headers) => {
        // Replace the estimate with what the call really cost.
        booking.tokens = actual ?? estimate;

        if (headers.limitTokens !== null && headers.limitTokens > 0) {
          this.limit = headers.limitTokens;
        }
      };
    } finally {
      release();
    }
  }

  /** Groq refused. Nothing goes out until the window it named has passed. */
  penalise(retryAfterMs: number | null): void {
    const wait = retryAfterMs ?? 5_000;
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + wait);

    logger.warn({ waitMs: wait }, 'groq.ratelimit.refused');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let shared: GroqRateLimiter | null = null;

/** The process-wide limiter. Every Groq call goes through this one. */
export function getGroqRateLimiter(): GroqRateLimiter {
  // The same ceiling the output reservation is sized against, so the two
  // cannot disagree about how big the budget is.
  shared ??= new GroqRateLimiter(getEnv().GROQ_TPM_BUDGET);
  return shared;
}

/** Test seam: forget the accumulated window between cases. */
export function resetGroqRateLimiter(): void {
  shared = null;
}

/** Reads the token-budget headers Groq attaches to every response. */
export function readRateLimitHeaders(response: Response): RateLimitHeaders {
  return {
    limitTokens: readInt(response.headers.get('x-ratelimit-limit-tokens')),
    remainingTokens: readInt(response.headers.get('x-ratelimit-remaining-tokens')),
    resetTokensMs: readDuration(response.headers.get('x-ratelimit-reset-tokens')),
  };
}

function readInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Groq reports these as durations like "19.65s" or "2m52.8s". */
function readDuration(value: string | null): number | null {
  if (!value) return null;

  const match = /^(?:(\d+)m)?([\d.]+)s$/.exec(value.trim());
  if (!match) return null;

  const minutes = Number.parseInt(match[1] ?? '0', 10);
  const seconds = Number.parseFloat(match[2] ?? '0');

  return Math.round((minutes * 60 + seconds) * 1000);
}
