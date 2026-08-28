'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, startProcessing } from '@/lib/api-client/client';
import { useAssessmentStatus } from '@/lib/api-client/useAssessmentStatus';
import type { ProcessingStage } from '@/lib/api-client/types';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { AnalysingLoader } from './AnalysingLoader';
import styles from './ProcessingScreen.module.css';

/**
 * Processing (Figma `1:9959`).
 *
 * The frame shows one thing: a centred loader reading "Extracting…" over
 * "This may take a while". That is reproduced exactly, with the headline
 * driven by the stage the API actually reports rather than being fixed.
 *
 * Two blocks below are additions, because the frame has no equivalent and
 * the screen needs them: a six-segment stage indicator, and a failure state.
 * Both are built from the existing tokens and positioned so they cannot move
 * the loader off its measured centre.
 */

/**
 * The six stages the pipeline walks, in order. Mirrors `PROCESSING_STAGES`
 * in the domain — repeated here rather than imported because that module
 * pulls the config, the logger and Redis in with it, none of which belong in
 * a browser bundle.
 */
const STAGES: readonly ProcessingStage[] = [
  'PREPARING',
  'EXTRACTING_QUESTIONS',
  'EXTRACTING_ANSWERS',
  'MAPPING',
  'GRADING',
  'FINALIZING',
];

/** The headline for each stage. "Extracting…" is the design's own wording. */
const STAGE_HEADLINE: Record<ProcessingStage, string> = {
  PREPARING: 'Preparing...',
  EXTRACTING_QUESTIONS: 'Extracting...',
  EXTRACTING_ANSWERS: 'Reading answers...',
  MAPPING: 'Mapping...',
  GRADING: 'Grading...',
  FINALIZING: 'Finishing...',
};

const STAGE_CAPTION: Record<ProcessingStage, string> = {
  PREPARING: 'Rendering the uploaded pages',
  EXTRACTING_QUESTIONS: 'Reading the question paper',
  EXTRACTING_ANSWERS: 'Transcribing the answer sheet',
  MAPPING: 'Matching answers to questions',
  GRADING: 'Marking against the rubric',
  FINALIZING: 'Assembling the results',
};

export function ProcessingScreen({ assessmentId }: { assessmentId: string }) {
  const router = useRouter();
  const { status, loading, error, notFound } = useAssessmentStatus(assessmentId);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Hand off to mapping as soon as the run settles. `replace` rather than
  // `push` so Back returns to upload, not to a finished progress screen.
  useEffect(() => {
    if (status?.status === 'COMPLETED') {
      router.replace(`/assessments/${assessmentId}/mapping`);
    }
  }, [status?.status, assessmentId, router]);

  async function handleRetry() {
    setRetrying(true);
    setRetryError(null);

    try {
      await startProcessing(assessmentId);
      // The poller is still mounted and will pick the new run up on its next
      // tick, so there is nothing to reload.
      router.refresh();
    } catch (cause) {
      setRetryError(
        cause instanceof ApiError
          ? cause.message
          : 'Processing could not be restarted. Please try again.',
      );
    } finally {
      setRetrying(false);
    }
  }

  if (notFound) {
    return (
      <div className={styles.screen}>
        <Glows />
        <div className={styles.failure}>
          <FailureMark />
          <div className={styles.failureText}>
            <p className={styles.failureTitle}>Assessment not found</p>
            <p className={styles.failureMessage}>
              {error ?? 'This assessment does not exist, or it has expired.'}
            </p>
          </div>
          <div className={styles.actions}>
            <PrimaryButton onClick={() => router.push('/')}>Start over</PrimaryButton>
          </div>
        </div>
      </div>
    );
  }

  if (status?.status === 'FAILED') {
    const failedStage = status.failure?.stage;

    /*
     * A NOT_FOUND here means the stored bytes this run needs are gone, not
     * that something went wrong reading them. Nothing in the pipeline
     * recreates an upload, so retrying re-queues a job that must fail the
     * same way — the button was a dead end that reported a storage key at
     * someone who can only fix it by uploading again. Say that instead, and
     * offer the action that actually works.
     */
    const uploadsLost = status.failure?.code === 'NOT_FOUND';

    return (
      <div className={styles.screen}>
        <Glows />
        <div className={styles.failure}>
          <FailureMark />
          <div className={styles.failureText}>
            <p className={styles.failureTitle}>
              {uploadsLost ? 'Uploads are no longer available' : 'Processing failed'}
            </p>
            <p className={styles.failureMessage}>
              {uploadsLost
                ? 'The server restarted before this assessment finished, and restarts clear uploaded files. Upload the question paper and answer sheet again to start a fresh run.'
                : (status.failure?.message ?? 'The run stopped before it finished.')}
            </p>
            {failedStage ? (
              <p className={styles.failureStage}>
                Stopped at {STAGE_CAPTION[failedStage].toLowerCase()} · {status.failure?.code}
              </p>
            ) : null}
          </div>
          <div className={styles.actions}>
            {uploadsLost ? (
              <PrimaryButton onClick={() => router.push('/')}>Upload again</PrimaryButton>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => router.push('/')}
                >
                  Back to upload
                </button>
                <PrimaryButton onClick={handleRetry} busy={retrying}>
                  Try again
                </PrimaryButton>
              </>
            )}
          </div>
          {retryError ? <p className={styles.notice}>{retryError}</p> : null}
        </div>

        {/* The segments freeze where it broke, so how far it got stays visible. */}
        <StageProgress stage={failedStage ?? null} failed />
      </div>
    );
  }

  // QUEUED and CREATED have no stage yet; the run has not entered the
  // pipeline, so nothing is claimed about which step it is on.
  const stage = status?.stage ?? null;
  const headline = stage ? STAGE_HEADLINE[stage] : 'Queued...';
  const subtext = loading ? 'Checking status' : 'This may take a while';

  return (
    <div className={styles.screen}>
      <Glows />
      <AnalysingLoader headline={headline} subtext={subtext} />
      <StageProgress
        stage={stage}
        progress={status?.progress ?? 0}
        caption={stage ? STAGE_CAPTION[stage] : 'Waiting for a worker'}
        notice={error}
      />
    </div>
  );
}

/** NOT IN FIGMA — six segments, one per pipeline stage. */
function StageProgress({
  stage,
  progress,
  caption,
  notice,
  failed = false,
}: {
  stage: ProcessingStage | null;
  progress?: number;
  caption?: string;
  notice?: string | null;
  failed?: boolean;
}) {
  // Derived from the stage rather than the percentage: the first stage
  // reports 0% progress but is genuinely under way.
  const currentIndex = stage ? STAGES.indexOf(stage) : -1;

  return (
    <div className={styles.progress}>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress ?? 0}
        aria-label="Processing progress"
      >
        {STAGES.map((entry, index) => {
          let tone = '';
          if (index < currentIndex) tone = styles.segmentDone!;
          else if (index === currentIndex) {
            tone = failed ? styles.segmentFailed! : styles.segmentActive!;
          }

          return <span key={entry} className={`${styles.segment} ${tone}`} />;
        })}
      </div>

      {caption ? (
        <p className={styles.caption}>
          {currentIndex >= 0
            ? `Step ${currentIndex + 1} of ${STAGES.length} · ${caption}`
            : caption}
          {progress !== undefined && currentIndex >= 0 ? ` · ${progress}%` : ''}
        </p>
      ) : null}

      {notice ? <p className={styles.notice}>{notice}</p> : null}
    </div>
  );
}

function Glows() {
  return (
    <>
      <span className={`${styles.glow} ${styles.glowTop}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-17.svg" alt="" width={1113} height={428} />
      </span>
      <span className={`${styles.glow} ${styles.glowBottom}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-16.svg" alt="" width={1318} height={428} />
      </span>
    </>
  );
}

function FailureMark() {
  return (
    <span className={styles.failureMark} aria-hidden="true">
      <svg width={28} height={28} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 8v5m0 3.5h.01M10.3 3.9 2.6 17.1A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
