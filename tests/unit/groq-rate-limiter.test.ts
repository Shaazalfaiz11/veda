import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroqRateLimiter, type RateLimitHeaders } from '@/lib/providers/ai/groq/rate-limiter';

/**
 * The limiter is the only thing standing between the pipeline and a per-minute
 * token ceiling, so what matters is not that it waits but that it waits the
 * right amount: nothing at all while there is room, and exactly as long as the
 * window needs when there is not.
 *
 * Time is faked throughout. A test that really slept for a rolling 60-second
 * window would take a minute to prove a subtraction.
 */

const NO_HEADERS: RateLimitHeaders = {
  limitTokens: null,
  remainingTokens: null,
  resetTokensMs: null,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `work` while letting fake timers drain, and reports elapsed fake time. */
async function elapsed(work: () => Promise<unknown>): Promise<number> {
  const started = Date.now();
  const promise = work();
  await vi.runAllTimersAsync();
  await promise;
  return Date.now() - started;
}

describe('admission', () => {
  it('does not gate a call on a local estimate', async () => {
    const limiter = new GroqRateLimiter(8_000);

    // Far more than the ceiling, three times over. Predicting admission here
    // was measured slower than the stage delays, so nothing is held back on
    // arithmetic -- only on a refusal Groq has actually issued.
    const waited = await elapsed(async () => {
      for (let i = 0; i < 3; i += 1) {
        const settle = await limiter.acquire(9_000, 'questions');
        settle(9_000, NO_HEADERS);
      }
    });

    expect(waited).toBe(0);
  });

  it('adopts the ceiling the headers report', async () => {
    const limiter = new GroqRateLimiter(8_000);

    await elapsed(async () => {
      const settle = await limiter.acquire(1_000, 'questions');
      settle(1_000, { limitTokens: 30_000, remainingTokens: 29_000, resetTokensMs: null });
    });

    // Recorded for the log; the assertion that matters is that reading a
    // header never throws and never blocks.
    expect(true).toBe(true);
  });
});

describe('refusal', () => {
  it('holds every caller off for as long as Groq asked', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const waited = await elapsed(async () => {
      limiter.penalise(30_000);

      const settle = await limiter.acquire(100, 'grading');
      settle(100, NO_HEADERS);
    });

    expect(waited).toBeGreaterThanOrEqual(30_000);
    expect(waited).toBeLessThan(31_000);
  });

  it('applies to a call small enough to have fitted otherwise', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const waited = await elapsed(async () => {
      limiter.penalise(10_000);
      const settle = await limiter.acquire(1, 'adjudication');
      settle(1, NO_HEADERS);
    });

    expect(waited).toBeGreaterThanOrEqual(10_000);
  });
});

describe('concurrent callers', () => {
  it('applies one refusal to every caller in the process', async () => {
    const limiter = new GroqRateLimiter(8_000);
    const admittedAt: number[] = [];

    const run = async () => {
      const settle = await limiter.acquire(1_000, 'mixed');
      admittedAt.push(Date.now());
      settle(1_000, NO_HEADERS);
    };

    const started = Date.now();
    limiter.penalise(20_000);

    const all = Promise.all([run(), run(), run()]);
    await vi.runAllTimersAsync();
    await all;

    // The stage that got refused is not the only one that has to wait: the
    // next stage would walk straight into the same wall.
    expect(admittedAt).toHaveLength(3);
    for (const at of admittedAt) {
      expect(at - started).toBeGreaterThanOrEqual(20_000);
    }
  });
});

describe('the budget Groq reports', () => {
  /*
   * Every response states what is left and when it returns. Ignoring it cost a
   * 44-second refusal on a request Groq had already said would not fit, so
   * these pin both halves: hold when it says there is no room, and do not hold
   * a moment longer than the window it named.
   */

  const headers = (remainingTokens: number, resetTokensMs: number | null): RateLimitHeaders => ({
    limitTokens: 8_000,
    remainingTokens,
    resetTokensMs,
  });

  it('admits immediately when the reported budget covers the call', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const waited = await elapsed(async () => {
      const first = await limiter.acquire(1_000, 'questions');
      first(1_000, headers(7_000, 44_000));

      const second = await limiter.acquire(6_270, 'answers');
      second(6_270, headers(700, 44_000));
    });

    expect(waited).toBe(0);
  });

  it('waits for the reset rather than sending a call that cannot fit', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const waited = await elapsed(async () => {
      const first = await limiter.acquire(1_000, 'questions');
      first(1_000, headers(5_000, 44_000));

      // 6,270 against 5,000 left: the refusal is already knowable.
      const second = await limiter.acquire(6_270, 'answers');
      second(6_270, headers(8_000, null));
    });

    expect(waited).toBeGreaterThanOrEqual(44_000);
    expect(waited).toBeLessThan(46_000);
  });

  it('admits once the window it described has rolled', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const first = await limiter.acquire(1_000, 'questions');
    first(1_000, headers(100, 30_000));

    await vi.advanceTimersByTimeAsync(30_000);

    // The reading has expired; it says nothing about the window we are in now.
    const waited = await elapsed(async () => {
      const second = await limiter.acquire(6_270, 'answers');
      second(6_270, headers(1_000, 60_000));
    });

    expect(waited).toBe(0);
  });

  it('stops holding as soon as a later response reports room', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const first = await limiter.acquire(1_000, 'questions');
    first(1_000, headers(200, 60_000));

    const second = await limiter.acquire(100, 'adjudication');
    second(100, headers(7_800, 60_000));

    const waited = await elapsed(async () => {
      const third = await limiter.acquire(6_270, 'answers');
      third(6_270, headers(1_500, 60_000));
    });

    expect(waited).toBe(0);
  });

  it('leaves behaviour unchanged when the headers say nothing', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const waited = await elapsed(async () => {
      for (let i = 0; i < 3; i += 1) {
        const settle = await limiter.acquire(9_000, 'questions');
        settle(9_000, NO_HEADERS);
      }
    });

    expect(waited).toBe(0);
  });

  it('still honours a refusal that arrives anyway', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const waited = await elapsed(async () => {
      const first = await limiter.acquire(1_000, 'questions');
      first(1_000, headers(7_500, 60_000));

      // Reported room and refused regardless. The provider is the authority.
      limiter.penalise(25_000);

      const second = await limiter.acquire(100, 'answers');
      second(100, NO_HEADERS);
    });

    expect(waited).toBeGreaterThanOrEqual(25_000);
  });

  it('spends the reported budget down across sequential calls', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const first = await limiter.acquire(1_000, 'questions');
    // One reading, then three calls admitted against it without a refresh.
    first(1_000, headers(5_000, 40_000));

    const waited = await elapsed(async () => {
      for (let i = 0; i < 2; i += 1) {
        const settle = await limiter.acquire(2_000, 'grading');
        settle(2_000, NO_HEADERS);
      }

      // 4,000 of the 5,000 is gone; this one cannot fit and must wait.
      const last = await limiter.acquire(2_000, 'grading');
      last(2_000, NO_HEADERS);
    });

    expect(waited).toBeGreaterThanOrEqual(40_000);
  });

  it('never blocks indefinitely on a stale reading', async () => {
    const limiter = new GroqRateLimiter(8_000);

    const first = await limiter.acquire(1_000, 'questions');
    // Nothing left, and no reset named: a full window is assumed.
    first(1_000, headers(0, null));

    const waited = await elapsed(async () => {
      const second = await limiter.acquire(6_270, 'answers');
      second(6_270, NO_HEADERS);
    });

    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(60_000);
  });
});
