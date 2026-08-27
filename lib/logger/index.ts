import pino from 'pino';
import { getEnv } from '@/lib/config';

/**
 * Structured logging.
 *
 * Every processing log carries assessmentId, jobId, stage and status as
 * fields rather than interpolated text, so they stay queryable. Event names
 * are dotted and past-tense — `assessment.questions.extraction.completed`.
 *
 * Never log document contents or secrets: the redact list below is a
 * backstop, not a licence to pass sensitive values in.
 */
function resolveLevel(): string {
  try {
    return getEnv().LOG_LEVEL;
  } catch {
    // Logging must survive an unparseable environment — otherwise the very
    // error explaining the misconfiguration cannot be reported.
    return 'info';
  }
}

// Pretty output only in local development. Under test the transport would
// spawn a worker thread and keep the process alive after the suite ends.
const usePrettyTransport = process.env.NODE_ENV === 'development';

export const logger = pino({
  level: resolveLevel(),
  base: undefined,
  redact: {
    paths: [
      'REDIS_URL',
      'redisUrl',
      'password',
      'token',
      'apiKey',
      '*.password',
      '*.token',
      '*.apiKey',
      'content',
      'transcript',
      'dataUrl',
    ],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport: usePrettyTransport
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined,
});

/** Fields present on every job-scoped log line. */
export interface JobLogContext {
  assessmentId: string;
  jobId: string;
  stage: string;
  status: string;
  [key: string]: unknown;
}

export function jobLogger(context: JobLogContext) {
  return logger.child(context);
}
