import '../workers/load-env';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../lib/logger';
import { LocalDocumentStorage, setDocumentStorage } from '../lib/storage/local-storage';
import { setAssessmentStore, InMemoryAssessmentStore } from '../lib/services/assessment-store';
import { createAssessment, getAssessment } from '../lib/services/assessment-service';
import { uploadDocument } from '../lib/services/document/document-service';
import { prepareAssessmentDocuments } from '../lib/services/document/document-preparation-service';
import { extractQuestions } from '../lib/services/question/question-extraction-service';
import { extractAnswers } from '../lib/services/answer/answer-extraction-service';
import { mapAnswersToQuestions } from '../lib/services/mapping/mapping-service';
import {
  acceptReview,
  getReviewSummary,
  listAuditEvents,
  listReviews,
  rejectReview,
  remapReview,
  skipReview,
} from '../lib/services/review';
import { resolveEffectiveMapping } from '../lib/domain/review';
import { FakeAIProvider } from '../lib/providers/ai';
import { FakeEmbeddingProvider } from '../lib/providers/embeddings';
import { A4_PORTRAIT, makePdf } from '../tests/fixtures/documents';
import type { ExtractedAnswerCandidate, ExtractedQuestionCandidate } from '../lib/providers/ai';

/**
 * Walks the Phase 6 review workflow over real pipeline output.
 *
 *   npm run walkthrough:review
 *
 * Uses scripted providers so it costs no quota and is deterministic. The
 * thing being demonstrated is the review layer, not the model.
 */
const QP = 'Which organelle is primarily involved in photosynthesis?';
const HQ = 'Describe the flow of blood through the human heart.';
const OQ = 'Define osmosis and give one example.';

const CA = 'The chloroplast is the organelle responsible for photosynthesis.';
const AA = 'It happens inside the cell where the green parts are.';
const UA = 'Levers and pulleys are examples of simple machines.';
const OA = 'Water moves through a membrane from weak to strong solution.';

const QUESTIONS: ExtractedQuestionCandidate[] = [
  {
    labelRaw: 'Q1',
    text: QP,
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.15, width: 0.75, height: 0.06 }],
  },
  {
    labelRaw: 'Q2',
    text: HQ,
    marks: 4,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.3, width: 0.75, height: 0.06 }],
  },
  {
    labelRaw: 'Q3',
    text: OQ,
    marks: 3,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.45, width: 0.75, height: 0.06 }],
  },
];

const ANSWERS: ExtractedAnswerCandidate[] = [
  {
    claimedLabelRaw: 'Q1',
    text: CA,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.1, width: 0.8, height: 0.1, kind: 'text' }],
  },
  {
    claimedLabelRaw: null,
    text: AA,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.35, width: 0.8, height: 0.1, kind: 'text' }],
  },
  {
    claimedLabelRaw: null,
    text: UA,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.6, width: 0.8, height: 0.1, kind: 'text' }],
  },
  {
    claimedLabelRaw: null,
    text: OA,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.8, width: 0.8, height: 0.1, kind: 'text' }],
  },
];

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'veda-p6-walk-'));

  setAssessmentStore(new InMemoryAssessmentStore());
  setDocumentStorage(new LocalDocumentStorage(root));

  const ai = new FakeAIProvider({ candidates: QUESTIONS, answerCandidates: ANSWERS });
  const embeddings = new FakeEmbeddingProvider({
    dimensions: 4,
    vectors: {
      [QP]: [1, 0, 0, 0.1],
      [CA]: [0.97, 0.05, 0, 0.1],
      [HQ]: [0, 1, 0, 0.1],
      [OQ]: [0, 0, 1, 0.1],
      // Moderately close to the heart question, and Q1 is already taken
      // by a stronger answer — so this lands as a real but uncertain mapping
      // a teacher should confirm rather than one the system settles alone.
      [AA]: [0.15, 0.82, 0.1, 0.3],
      [UA]: [0.05, 0.05, 0.05, 1],
      // Genuinely about osmosis, but Q3 is contested — this one ends up
      // needing a human to place it.
      [OA]: [0.1, 0.1, 0.78, 0.3],
    },
  });

  try {
    const assessment = await createAssessment({ title: 'phase 6 walkthrough' });

    for (const type of ['QUESTION_PAPER', 'ANSWER_SHEET'] as const) {
      await uploadDocument({
        assessmentId: assessment.id,
        type,
        filename: `${type}.pdf`,
        declaredMimeType: 'application/pdf',
        data: makePdf([A4_PORTRAIT]),
      });
    }

    await prepareAssessmentDocuments({ assessmentId: assessment.id, jobId: 'walk', logger });
    await extractQuestions({ assessmentId: assessment.id, jobId: 'walk', logger, provider: ai });
    await extractAnswers({ assessmentId: assessment.id, jobId: 'walk', logger, provider: ai });
    await mapAnswersToQuestions({
      assessmentId: assessment.id,
      jobId: 'walk',
      logger,
      provider: ai,
      embeddings,
    });

    const state = await getAssessment(assessment.id);
    const label = (id: string | null) =>
      state.questions.find((q) => q.id === id)?.labelRaw ?? '(none)';

    console.log('=== AI mappings after Phase 5 ===');
    for (const m of state.mappings) {
      console.log(
        `  ${m.answerId.slice(0, 8)}  -> ${label(m.questionId).padEnd(7)} ` +
          `${m.confidence.toFixed(3)} ${m.confidenceBand.padEnd(6)} ${m.status}`,
      );
    }

    const reviews = await listReviews(assessment.id);
    console.log('');
    console.log(`=== review queue: ${reviews.length} item(s) ===`);
    for (const r of reviews) {
      console.log(
        `  ${r.id.slice(0, 8)}  answer ${r.answerId.slice(0, 8)}  ` +
          `${r.trigger.padEnd(18)} ${r.status}`,
      );
    }

    const snapshot = JSON.stringify(state.mappings);

    console.log('');
    console.log('=== conflict check ===');

    // Run before anything is resolved: contesting a question needs both a
    // holder and an unresolved review to contest with.
    const held = state.mappings.find((m) => m.questionId !== null);
    const contender = reviews.find((r) => r.answerId !== held?.answerId);

    if (held?.questionId && contender) {
      try {
        await remapReview({
          assessmentId: assessment.id,
          reviewId: contender.id,
          questionId: held.questionId,
        });
        console.log('  UNEXPECTED: the conflicting remap was allowed');
      } catch (error) {
        const details = (error as { details?: Record<string, unknown> }).details;
        console.log(
          `  ${contender.answerId.slice(0, 8)} -> ${label(held.questionId)} refused: ` +
            `${String(details?.['code'])} ` +
            `(held by ${String(details?.['existingAnswerId']).slice(0, 8)})`,
        );
      }
    } else {
      console.log('  (no holder and unresolved review pair available)');
    }

    console.log('');
    console.log('=== actions ===');

    // A teacher working the queue: confirm one, overturn one, place the
    // orphan into the question the overturned one released, defer the rest.
    const mapped = reviews.filter((r) => r.original.questionId !== null);
    const orphan = reviews.find((r) => r.original.questionId === null);

    const toAccept = mapped[0];
    const toReject = mapped[1];

    if (toAccept) {
      await acceptReview({
        assessmentId: assessment.id,
        reviewId: toAccept.id,
        reviewerId: 'teacher-1',
      });
      console.log(
        `  ACCEPT  ${toAccept.id.slice(0, 8)} (band ${toAccept.original.confidenceBand})`,
      );
    }

    if (toReject) {
      await rejectReview({
        assessmentId: assessment.id,
        reviewId: toReject.id,
        reason: 'This is not an answer to that question.',
        reviewerId: 'teacher-1',
      });
      console.log(
        `  REJECT  ${toReject.id.slice(0, 8)} (releases ` +
          `${label(toReject.original.questionId)})`,
      );
    }

    // Rejecting released a question, so the orphan now has somewhere to go.
    if (orphan && toReject?.original.questionId) {
      await remapReview({
        assessmentId: assessment.id,
        reviewId: orphan.id,
        questionId: toReject.original.questionId,
        reason: 'Belongs to this question instead.',
        reviewerId: 'teacher-1',
      });
      console.log(
        `  REMAP   ${orphan.id.slice(0, 8)} -> ${label(toReject.original.questionId)}`,
      );
    }

    const skippable = (await getAssessment(assessment.id)).reviews.find(
      (r) => r.status === 'PENDING',
    );

    if (skippable) {
      await skipReview({
        assessmentId: assessment.id,
        reviewId: skippable.id,
        reviewerId: 'teacher-1',
      });
      console.log(`  SKIP    ${skippable.id.slice(0, 8)} (left unresolved)`);
    }

    const final = await getAssessment(assessment.id);

    console.log('');
    console.log('=== three layers ===');
    for (const m of final.mappings) {
      const review = final.reviews.find((x) => x.answerId === m.answerId) ?? null;
      const effective = resolveEffectiveMapping(m, review);

      console.log(
        `  ${m.answerId.slice(0, 8)}  AI=${label(m.questionId).padEnd(7)} ` +
          `human=${(review?.decision?.action ?? '-').padEnd(7)} ` +
          `effective=${label(effective.questionId).padEnd(7)} (${effective.source})`,
      );
    }

    console.log('');
    console.log('=== immutability ===');
    console.log(
      `  AI mappings byte-identical after review: ${JSON.stringify(final.mappings) === snapshot}`,
    );

    console.log('');
    console.log('=== audit ===');
    for (const event of await listAuditEvents(assessment.id)) {
      console.log(
        `  ${event.action.padEnd(7)} ${label(event.originalQuestionId).padEnd(7)} -> ` +
          `${label(event.finalQuestionId).padEnd(7)} by ${event.reviewerId ?? '(none)'}`,
      );
    }

    console.log('');
    console.log('=== summary ===');
    const summary = await getReviewSummary(assessment.id);
    console.log(
      `  answers=${summary.totalAnswers} auto=${summary.autoMapped} ` +
        `reviewReq=${summary.reviewRequired} humanReview=${summary.humanReview} ` +
        `unmapped=${summary.unmapped}`,
    );
    console.log(
      `  reviews=${summary.totalReviews} pending=${summary.pending} ` +
        `resolved=${summary.resolved} skipped=${summary.skipped}`,
    );
    console.log(
      `  effectivelyMapped=${summary.effectivelyMapped} ` +
        `effectivelyUnmapped=${summary.effectivelyUnmapped} ` +
        `humanOverridden=${summary.humanOverridden}`,
    );
  } finally {
    setAssessmentStore(null);
    setDocumentStorage(null);
    await rm(root, { recursive: true, force: true });
  }
}

void main();
