import { randomUUID } from 'node:crypto';
import { ConflictError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  assertTransition,
  isTerminal,
  progressFor,
  type Assessment,
  type AssessmentStatus,
  type ProcessingStage,
} from '@/lib/domain/assessment';
import type { DocumentStatus, DocumentType } from '@/lib/domain/document';
import { enqueueAssessmentProcessing } from '@/lib/queue/queues';
import { getAssessmentStore } from './assessment-store';

export interface CreateAssessmentInput {
  title?: string | null;
}

/** Per-document summary carried on the status response. */
export interface AssessmentStatusDocument {
  id: string;
  type: DocumentType;
  status: DocumentStatus;
  pageCount: number | null;
}

export interface AssessmentStatusView {
  assessmentId: string;
  status: AssessmentStatus;
  stage: ProcessingStage | null;
  progress: number;
  jobId: string | null;
  documents: AssessmentStatusDocument[];
  failure: Assessment['failure'];
  updatedAt: string;
}

export interface ProcessingTicket {
  assessmentId: string;
  jobId: string;
  status: Extract<AssessmentStatus, 'QUEUED'>;
}

function now(): string {
  return new Date().toISOString();
}

export async function createAssessment(input: CreateAssessmentInput): Promise<Assessment> {
  const timestamp = now();

  const assessment: Assessment = {
    id: randomUUID(),
    status: 'CREATED',
    stage: null,
    jobId: null,
    title: input.title ?? null,
    // Documents arrive through the upload endpoint, not at creation.
    documents: [],
    questions: [],
    questionExtraction: null,
    answers: [],
    answerExtraction: null,
    mappings: [],
    mapping: null,
    reviews: [],
    reviewAudit: [],
    markSchemes: null,
    grades: [],
    grading: null,
    completedStages: [],
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await getAssessmentStore().create(assessment);

  logger.info(
    {
      assessmentId: assessment.id,
      jobId: null,
      stage: null,
      status: assessment.status,
    },
    'assessment.created',
  );

  return assessment;
}

export async function getAssessment(assessmentId: string): Promise<Assessment> {
  return getAssessmentStore().get(assessmentId);
}

export async function getAssessmentStatus(assessmentId: string): Promise<AssessmentStatusView> {
  const assessment = await getAssessmentStore().get(assessmentId);

  return {
    assessmentId: assessment.id,
    status: assessment.status,
    stage: assessment.stage,
    progress: progressFor(assessment.status, assessment.stage),
    jobId: assessment.jobId,
    // Document status is a separate concept from assessment status: the
    // assessment can be PROCESSING while one document is READY and another
    // is still PREPARING. Storage keys are deliberately not included.
    documents: assessment.documents.map((document) => ({
      id: document.id,
      type: document.type,
      status: document.status,
      pageCount: document.pageCount,
    })),
    failure: assessment.failure,
    updatedAt: assessment.updatedAt,
  };
}

/**
 * Queue a processing run.
 *
 * The state transition is committed before the job is enqueued, so a worker
 * that picks the job up instantly can never observe a stale CREATED status.
 * If the enqueue then fails, the assessment is rolled back rather than left
 * stranded in QUEUED with no job behind it.
 */
export async function requestProcessing(assessmentId: string): Promise<ProcessingTicket> {
  const store = getAssessmentStore();
  const existing = await store.get(assessmentId);

  if (existing.status === 'QUEUED' || existing.status === 'PROCESSING') {
    throw new ConflictError(
      `Assessment ${assessmentId} is already ${existing.status.toLowerCase()}.`,
      { status: existing.status, jobId: existing.jobId },
    );
  }

  assertTransition(existing.status, 'QUEUED');

  const jobId = randomUUID();
  const previousStatus = existing.status;

  await store.update(assessmentId, (current) => ({
    ...current,
    status: 'QUEUED',
    stage: null,
    jobId,
    failure: null,
    // A fresh run re-earns every stage, so last run's extraction is cleared
    // too — otherwise reprocessing would silently reuse stale questions.
    questions: [],
    questionExtraction: null,
    answers: [],
    answerExtraction: null,
    mappings: [],
    mapping: null,
    // A fresh run re-earns its mappings, so the reviews attached to the old
    // ones go too. The audit trail does not: it records what people did, and
    // reprocessing does not un-happen that.
    reviews: [],
    completedStages: [],
    updatedAt: now(),
  }));

  try {
    await enqueueAssessmentProcessing({ assessmentId, jobId });
  } catch (error) {
    await store.update(assessmentId, (current) => ({
      ...current,
      status: previousStatus,
      jobId: null,
      updatedAt: now(),
    }));
    throw error;
  }

  return { assessmentId, jobId, status: 'QUEUED' };
}

export async function markProcessing(
  assessmentId: string,
  stage: ProcessingStage,
): Promise<Assessment> {
  return getAssessmentStore().update(assessmentId, (current) => {
    if (current.status === 'QUEUED') assertTransition(current.status, 'PROCESSING');
    return { ...current, status: 'PROCESSING', stage, updatedAt: now() };
  });
}

export async function markStageCompleted(
  assessmentId: string,
  stage: ProcessingStage,
): Promise<Assessment> {
  return getAssessmentStore().update(assessmentId, (current) => {
    if (current.completedStages.some((record) => record.stage === stage)) return current;
    return {
      ...current,
      completedStages: [...current.completedStages, { stage, completedAt: now() }],
      updatedAt: now(),
    };
  });
}

export async function markCompleted(assessmentId: string): Promise<Assessment> {
  return getAssessmentStore().update(assessmentId, (current) => {
    // Replaying a finished run is a no-op, not a conflict. A duplicate job
    // delivery would otherwise be recorded as a failure despite the work
    // having succeeded.
    if (current.status === 'COMPLETED') return current;

    assertTransition(current.status, 'COMPLETED');
    return { ...current, status: 'COMPLETED', stage: null, failure: null, updatedAt: now() };
  });
}

export async function markFailed(
  assessmentId: string,
  failure: { code: string; message: string; stage: ProcessingStage | null },
): Promise<Assessment> {
  return getAssessmentStore().update(assessmentId, (current) => {
    // A terminal assessment stays as it is; a late failure from an abandoned
    // run must not reopen something already resolved.
    if (isTerminal(current.status)) return current;

    return {
      ...current,
      status: 'FAILED',
      stage: failure.stage ?? current.stage,
      failure: { ...failure, failedAt: now() },
      updatedAt: now(),
    };
  });
}
