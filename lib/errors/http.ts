import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AppError, isAppError } from './app-error';
import { logger } from '@/lib/logger';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

function body(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Flatten a Zod failure into something an API client can act on. */
export function zodErrorDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/**
 * Single exit point for Route Handler failures, so every error response
 * carries the same shape regardless of where it originated.
 */
export function toErrorResponse(error: unknown): NextResponse<ErrorBody> {
  if (error instanceof ZodError) {
    return NextResponse.json(
      body('VALIDATION_ERROR', 'Request failed validation.', zodErrorDetails(error)),
      { status: 400 },
    );
  }

  if (isAppError(error)) {
    const appError = error as AppError;
    return NextResponse.json(
      body(appError.code, appError.message, appError.details),
      { status: appError.httpStatus },
    );
  }

  // Anything unrecognised is logged in full but reported opaquely — internal
  // messages can leak implementation detail to callers.
  logger.error(
    { err: error instanceof Error ? { message: error.message, stack: error.stack } : error },
    'http.unhandled_error',
  );

  return NextResponse.json(
    body('INTERNAL_ERROR', 'An unexpected error occurred.'),
    { status: 500 },
  );
}
