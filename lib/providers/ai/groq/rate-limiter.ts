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
 * So the stage delays keep the spacing, and this keeps the two things they
 * cannot.
 *
 * The first is a refusal: when Groq actually says no, every caller in the
 * process holds off for as long as it asked, rather than the next stage
 * walking into the same wall a moment later. Admission is serialised so that
 * hold is universal.
 *
 * The second is the budget Groq reports unprompted. Every response carries the
 * tokens it has left and when they return, which is the figure a local window
 * could never be reconciled with -- and it was being parsed and dropped. An
 * answer-extraction call issued 0.8 seconds after question extraction returned
 * was refused for 44 seconds, on a run whose total was 201. Groq had already
 * said it would not fit. Nothing asked.
 *
 * That reading gates admission now. The locally accumulated spend record still
 * does not: predicting admission from it is what measured slower, and it is
 * kept only because it costs nothing and makes the debug log worth reading.
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

  /*
   * What Groq last said was left in its window, and when that statement stops
   * describing it.
   *
   * This is not a local budget and must not be treated as one. It is a reading
   * taken at the moment of a response, decremented as calls are admitted
   * against it, and discarded once the window it described has rolled. Holding
   * it any longer would block on a window that has already refilled.
   */
  private remaining: number | null = null;
  private remainingExpiresAt = 0;

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
  private waitFor(estimate: number, now: number): number {
    if (now < this.blockedUntil) return this.blockedUntil - now;

    // The reading has aged out: the window it described has rolled, so it says
    // nothing about the one we are in now.
    if (this.remaining !== null && now >= this.remainingExpiresAt) {
      this.remaining = null;
    }

    /*
     * Groq states its own remaining budget on every response, which is the one
     * number a local window could never reconcile itself with. Sending a call
     * it has already said will not fit buys a refusal and the full reset --
     * measured at 44 seconds for an answer-extraction request issued 0.8s
     * after question extraction returned.
     *
     * Waiting until the stated reset is bounded by construction: the reading
     * expires at that same moment, so the next pass through clears it and
     * admits. There is no path here that waits forever.
     */
    if (this.remaining !== null && estimate > this.remaining) {
      return this.remainingExpiresAt - now;
    }

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

      // Spend it against the provider's reading too. Two calls admitted in one
      // window would otherwise both measure themselves against the same
      // headroom and the second would take room the first had already claimed.
      if (this.remaining !== null) {
        this.remaining = Math.max(0, this.remaining - estimate);
      }

      return (actual, headers) => {
        // Replace the estimate with what the call really cost.
        booking.tokens = actual ?? estimate;

        if (headers.limitTokens !== null && headers.limitTokens > 0) {
          this.limit = headers.limitTokens;
        }

        if (headers.remainingTokens !== null) {
          this.remaining = headers.remainingTokens;
          /*
           * Good only until the window rolls. Groq reports the reset alongside
           * it; without one, a full window is the safe assumption -- too long
           * and a caller waits for nothing, too short and it walks into the
           * refusal this exists to avoid.
           */
          this.remainingExpiresAt = Date.now() + (headers.resetTokensMs ?? WINDOW_MS);
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
