'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, getStatus } from './client';
import type { AssessmentStatusView } from './types';

/**
 * Polls `GET /api/assessments/:id/status` until the run settles.
 *
 * A `setTimeout` chain rather than `setInterval`: the next request is only
 * scheduled once the previous one has resolved, so a slow response can never
 * stack requests on top of each other. The effect owns a `cancelled` flag so
 * an unmount stops both the timer and any in-flight response from writing
 * state.
 *
 * Polling stops on COMPLETED and FAILED — those are terminal, and continuing
 * would hammer Redis for an answer that cannot change.
 */

const POLL_INTERVAL_MS = 1200;
/** Consecutive network failures tolerated before the UI says so. */
const ERROR_GRACE = 3;
const MAX_BACKOFF_MS = 10_000;

export interface AssessmentStatusState {
  status: AssessmentStatusView | null;
  /** True until the first response — success or failure — has landed. */
  loading: boolean;
  /** Set once transient failures stop looking transient. */
  error: string | null;
  /** A 404 or malformed id: retrying will not help. */
  notFound: boolean;
}

export function useAssessmentStatus(assessmentId: string): AssessmentStatusState {
  const [state, setState] = useState<AssessmentStatusState>({
    status: null,
    loading: true,
    error: null,
    notFound: false,
  });

  // Kept in a ref so a re-render never restarts the polling loop.
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const status = await getStatus(assessmentId);
        if (cancelled) return;

        failures.current = 0;
        setState({ status, loading: false, error: null, notFound: false });

        // Terminal: leave the timer unscheduled.
        if (status.status === 'COMPLETED' || status.status === 'FAILED') return;
      } catch (error) {
        if (cancelled) return;

        // An assessment that does not exist will never appear, so stop.
        if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
          setState({
            status: null,
            loading: false,
            error: error.message,
            notFound: true,
          });
          return;
        }

        failures.current += 1;

        setState((current) => ({
          ...current,
          loading: false,
          error:
            failures.current >= ERROR_GRACE
              ? 'Lost contact with the server. Still retrying…'
              : null,
        }));
      }

      if (cancelled) return;

      // Back off while the server is unreachable so a dropped connection does
      // not turn into a request flood.
      const delay = Math.min(
        POLL_INTERVAL_MS * 2 ** Math.max(0, failures.current - 1),
        MAX_BACKOFF_MS,
      );

      timer = setTimeout(tick, delay);
    }

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [assessmentId]);

  return state;
}
