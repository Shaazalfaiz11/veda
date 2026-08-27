'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import {
  ApiError,
  createAssessment,
  startProcessing,
  uploadDocument,
} from '@/lib/api-client/client';
import type { DocumentType } from '@/lib/api-client/types';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { HeroAvatar } from './HeroAvatar';
import { UploadDropzone, type SelectedFile } from './UploadDropzone';
import styles from './UploadScreen.module.css';

/**
 * Upload → start processing (Figma `1:8744` empty, `1:8797` filled).
 *
 * Files are uploaded as soon as they are picked, rather than being held until
 * "Start Mapping". Two reasons: the design's filled state shows a page count,
 * which only the server can know once it has read the document; and a file
 * the server would reject should say so at the moment it is chosen, not after
 * the teacher has committed to the run.
 *
 * The assessment is created lazily on the first upload, so opening this screen
 * and leaving does not litter the store with empty assessments.
 */

type Slot = 'questionPaper' | 'answerSheet';

const SLOT_TO_TYPE: Record<Slot, DocumentType> = {
  questionPaper: 'QUESTION_PAPER',
  answerSheet: 'ANSWER_SHEET',
};

export function UploadScreen() {
  const router = useRouter();

  const [assessmentId, setAssessmentId] = useState<string | null>(null);

  /*
   * The assessment is created on demand by whichever upload starts first, and
   * both uploads can start before either finishes.
   *
   * Reading `assessmentId` from state is not enough to prevent a second
   * creation: both callbacks close over the value as it was when they were
   * made, so both see null and both create one — and the two files end up on
   * two different assessments, with the run started against whichever won.
   * The ref is read at call time rather than captured, and the in-flight
   * promise is shared so the second caller awaits the first rather than
   * racing it.
   */
  const idRef = useRef<string | null>(null);
  const creatingRef = useRef<Promise<string> | null>(null);
  const [files, setFiles] = useState<Record<Slot, SelectedFile | null>>({
    questionPaper: null,
    answerSheet: null,
  });
  const [errors, setErrors] = useState<Record<Slot, string | null>>({
    questionPaper: null,
    answerSheet: null,
  });
  /*
   * Slots currently uploading — a set, not a single slot.
   *
   * With one slot, two overlapping uploads clobber each other: the first to
   * finish clears the marker while the second is still in flight, "Start
   * Mapping" enables early, and processing begins against an assessment whose
   * answer sheet has not arrived. That produces a run that fails a stage later
   * for a reason with no visible connection to the upload.
   */
  const [uploading, setUploading] = useState<ReadonlySet<Slot>>(new Set());
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  /** Creates the assessment at most once, however many uploads ask for it. */
  const ensureAssessment = useCallback(async (): Promise<string> => {
    if (idRef.current) return idRef.current;

    creatingRef.current ??= createAssessment('Assessment')
      .then((created) => {
        idRef.current = created.assessmentId;
        setAssessmentId(created.assessmentId);
        return created.assessmentId;
      })
      .catch((error: unknown) => {
        // Clear it, or a single failure would poison every later attempt.
        creatingRef.current = null;
        throw error;
      });

    return creatingRef.current;
  }, []);

  const handleSelect = useCallback(
    async (slot: Slot, file: File) => {
      setErrors((current) => ({ ...current, [slot]: null }));
      setStartError(null);
      // Show the file immediately; the page count arrives with the response.
      setFiles((current) => ({ ...current, [slot]: { file, pageCount: null } }));
      setUploading((current) => new Set(current).add(slot));

      try {
        const id = await ensureAssessment();
        const document = await uploadDocument(id, SLOT_TO_TYPE[slot], file);

        setFiles((current) => ({
          ...current,
          [slot]: { file, pageCount: document.pageCount },
        }));
      } catch (error) {
        // The server rejected it — drop the optimistic card and say why.
        setFiles((current) => ({ ...current, [slot]: null }));
        setErrors((current) => ({
          ...current,
          [slot]:
            error instanceof ApiError
              ? error.message
              : 'The file could not be uploaded. Please try again.',
        }));
      } finally {
        setUploading((current) => {
          const next = new Set(current);
          next.delete(slot);
          return next;
        });
      }
    },
    [ensureAssessment],
  );

  const handleRemove = useCallback((slot: Slot) => {
    // Local only. The uploaded document stays on the assessment and is
    // replaced when a new file is chosen for the same slot — the backend
    // treats a second upload of a type as the current one.
    setFiles((current) => ({ ...current, [slot]: null }));
    setErrors((current) => ({ ...current, [slot]: null }));
  }, []);

  const bothReady =
    files.questionPaper !== null && files.answerSheet !== null && uploading.size === 0;

  async function handleStart() {
    if (!assessmentId || !bothReady) return;

    setStarting(true);
    setStartError(null);

    try {
      await startProcessing(assessmentId);
      router.push(`/assessments/${assessmentId}/processing`);
    } catch (error) {
      setStartError(
        error instanceof ApiError
          ? error.message
          : 'Processing could not be started. Please try again.',
      );
      setStarting(false);
    }
  }

  return (
    <div className={styles.screen}>
      <span className={`${styles.glow} ${styles.glowBack}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-16.svg" alt="" width={1113} height={428} />
      </span>
      <span className={`${styles.glow} ${styles.glowFront}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-17.svg" alt="" width={1318} height={428} />
      </span>

      <div className={styles.stack}>
        <div className={styles.heading}>
          <h1 className={styles.titleRow}>
            <span className={styles.title}>Upload</span>
            <span className={styles.titleChip}>
              <span>Question Paper &amp; Answer Sheets</span>
            </span>
          </h1>
          <p className={styles.subtitle}>Upload both files to get started</p>
        </div>

        <HeroAvatar />

        <UploadDropzone
          questionPaper={files.questionPaper}
          answerSheet={files.answerSheet}
          errors={errors}
          disabled={starting}
          onSelect={handleSelect}
          onRemove={handleRemove}
        />
      </div>

      <div className={styles.footer}>
        <PrimaryButton onClick={handleStart} disabled={!bothReady} busy={starting}>
          Start Mapping
        </PrimaryButton>
        <p className={`${styles.hint} ${startError ? styles.hintError : ''}`}>
          {startError ??
            'Once both files are uploaded, you’ll able to map answers with questions'}
        </p>
      </div>
    </div>
  );
}
