import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEnv, resetEnvCache } from '@/lib/config';

const ORIGINAL = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>): void {
  const env = process.env as Record<string, string | undefined>;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  resetEnvCache();
}

beforeEach(() => {
  resetEnvCache();
});

afterEach(() => {
  const env = process.env as Record<string, string | undefined>;
  for (const key of Object.keys(env)) {
    if (!(key in ORIGINAL)) delete env[key];
  }
  Object.assign(env, ORIGINAL);
  resetEnvCache();
});

describe('environment validation', () => {
  it('requires REDIS_URL', () => {
    setEnv({ REDIS_URL: undefined });
    expect(() => getEnv()).toThrow(/REDIS_URL/);
  });

  it('names the offending key in the error', () => {
    setEnv({ JOB_MAX_ATTEMPTS: 'not-a-number' });
    expect(() => getEnv()).toThrow(/JOB_MAX_ATTEMPTS/);
  });

  it('coerces numeric values from strings', () => {
    setEnv({ WORKER_CONCURRENCY: '4', PREPARED_PAGE_MAX_DIMENSION: '1500' });

    const env = getEnv();
    expect(env.WORKER_CONCURRENCY).toBe(4);
    expect(env.PREPARED_PAGE_MAX_DIMENSION).toBe(1500);
  });

  it('caches the parsed result', () => {
    expect(getEnv()).toBe(getEnv());
  });
});

describe('Gemini configuration', () => {
  it('treats a blank API key as absent, not as an invalid value', () => {
    // Copying .env.example produces `GEMINI_API_KEY=`, which must mean
    // "not configured" rather than failing every command at config load.
    setEnv({ GEMINI_API_KEY: '' });
    expect(() => getEnv()).not.toThrow();
    expect(getEnv().GEMINI_API_KEY).toBeUndefined();
  });

  it('treats a whitespace-only API key as absent', () => {
    setEnv({ GEMINI_API_KEY: '   ' });
    expect(getEnv().GEMINI_API_KEY).toBeUndefined();
  });

  it('accepts a real key', () => {
    setEnv({ GEMINI_API_KEY: 'test-key-value' });
    expect(getEnv().GEMINI_API_KEY).toBe('test-key-value');
  });

  it('centralises the model name with a current default', () => {
    setEnv({ GEMINI_MODEL: undefined });
    expect(getEnv().GEMINI_MODEL).toBe('gemini-3.6-flash');
  });

  it('allows the model to be overridden', () => {
    setEnv({ GEMINI_MODEL: 'gemini-3.6-pro' });
    expect(getEnv().GEMINI_MODEL).toBe('gemini-3.6-pro');
  });

  it('bounds the pages sent in one request', () => {
    setEnv({ GEMINI_MAX_PAGES_PER_REQUEST: undefined });
    expect(getEnv().GEMINI_MAX_PAGES_PER_REQUEST).toBe(20);

    setEnv({ GEMINI_MAX_PAGES_PER_REQUEST: '500' });
    expect(() => getEnv()).toThrow(/GEMINI_MAX_PAGES_PER_REQUEST/);
  });
});
