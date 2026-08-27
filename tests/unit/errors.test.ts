import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DependencyUnavailableError,
  InternalError,
  NotFoundError,
  ValidationError,
  isAppError,
  isRetryable,
} from '@/lib/errors';

describe('error taxonomy', () => {
  it('never retries permanent failures', () => {
    expect(isRetryable(new ValidationError('bad input'))).toBe(false);
    expect(isRetryable(new NotFoundError('missing'))).toBe(false);
    expect(isRetryable(new ConflictError('already running'))).toBe(false);
  });

  it('retries transient failures', () => {
    expect(isRetryable(new DependencyUnavailableError('redis down'))).toBe(true);
    expect(isRetryable(new InternalError('boom'))).toBe(true);
  });

  it('treats unknown errors as retryable so a genuine blip is not discarded', () => {
    expect(isRetryable(new Error('unclassified'))).toBe(true);
    expect(isRetryable('a bare string')).toBe(true);
  });

  it('carries an HTTP status and code for the API layer', () => {
    const error = new ValidationError('bad input', { field: 'title' });
    expect(error.httpStatus).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual({ field: 'title' });
    expect(isAppError(error)).toBe(true);
  });

  it('does not classify plain errors as app errors', () => {
    expect(isAppError(new Error('plain'))).toBe(false);
  });
});
