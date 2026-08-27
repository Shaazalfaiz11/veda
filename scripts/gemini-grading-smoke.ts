import '../workers/load-env';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnv } from '../lib/config';
import { logger } from '../lib/logger';
import { LocalDocumentStorage, setDocumentStorage } from '../lib/storage/local-storage';
import { setAssessmentStore, InMemoryAssessmentStore } from '../lib/services/assessment-store';
import { createAssessment, getAssessment } from '../lib/services/assessment-service';
import { uploadDocument } from '../lib/services/document/document-service';
import { prepareAssessmentDocuments } from '../lib/services/document/document-preparation-service';
import { extractQuestions } from '../lib/services/question/question-extraction-service';
import { extractAnswers } from '../lib/services/answer/answer-extraction-service';
import { mapAnswersToQuestions } from '../lib/services/mapping/mapping-service';
import { buildReviewQueue, remapReview } from '../lib/services/review';
import { gradeAssessment, summariseGrades } from '../lib/services/grading';
import { GeminiProvider } from '../lib/providers/ai';
import { GeminiEmbeddingProvider } from '../lib/providers/embeddings';
import { parseQuestionLabel } from '../lib/domain/question';
import type { Question } from '../lib/domain/question';
import type { Answer } from '../lib/domain/answer';
import type { AnswerMapping } from '../lib/domain/mapping';

/**
 * Opt-in end-to-end smoke test: extraction through mapping to grading,
 * against the real Gemini and embedding APIs.
 *
 *   npm run smoke:grading -- question-paper.pdf answer-sheet.pdf
 *
 * Add `--remap` to correct the least confident mapping to a question no
 * answer reached, then re-grade. That is the case worth watching by hand: the
 * marks must follow the teacher's question, and the superseded grade must
 * still be on the record afterwards.
 *
 * Kept out of the normal suite so CI never depends on provider availability.
 * Prints a concise report — never the key, never page data, and never a
 * student's answer in full.
 */

const PREVIEW = 54;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 3)}...` : flat;
}

function marks(awarded: number | null, maximum: number | null): string {
  if (awarded === null || maximum === null) return '  -  ';
  return `${String(awarded).padStart(2)}/${String(maximum).padEnd(2)}`;
}

async function main(): Promise<void> {
  const env = getEnv();

  if (!env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set. Add it to .env.local and try again.');
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const withRemap = args.includes('--remap');
  const gradeOnly = args.includes('--grade-only');
  const [paperPath, sheetPath] = args.filter((arg) => !arg.startsWith('--'));

  if (gradeOnly) {
    await gradeOnlyRun(withRemap, parseOnly(args));
    return;
  }

  if (!paperPath || !sheetPath) {
    console.error('Usage: npm run smoke:grading -- <question-paper> <answer-sheet> [--remap]');
    console.error('       npm run smoke:grading -- --grade-only [--only 1,2] [--remap]');
    process.exitCode = 1;
    return;
  }

  const storageRoot = await mkdtemp(join(tmpdir(), 'veda-grading-smoke-'));
  const store = new InMemoryAssessmentStore();

  setAssessmentStore(store);
  setDocumentStorage(new LocalDocumentStorage(storageRoot));

  try {
    const assessment = await createAssessment({ title: 'grading smoke test' });

    for (const [type, path] of [
      ['QUESTION_PAPER', paperPath],
      ['ANSWER_SHEET', sheetPath],
    ] as const) {
      await uploadDocument({
        assessmentId: assessment.id,
        type,
        filename: path.split(/[\\/]/).pop()!,
        declaredMimeType: null,
        data: await readFile(path),
      });
    }

    console.log(`question paper : ${paperPath}`);
    console.log(`answer sheet   : ${sheetPath}`);

    await prepareAssessmentDocuments({ assessmentId: assessment.id, jobId: 'smoke', logger });

    const provider = new GeminiProvider();
    const embeddings = new GeminiEmbeddingProvider();

    console.log('');
    console.log(`model          : ${provider.model}`);
    console.log(`embeddings     : ${embeddings.model} (${embeddings.dimensions}d)`);
    console.log('');

    console.log('extracting questions...');
    const questionRun = await extractQuestions({
      assessmentId: assessment.id,
      jobId: 'smoke',
      logger,
      provider,
    });
    console.log(`  ${questionRun.questions.length} questions`);

    console.log('extracting answers...');
    const answerRun = await extractAnswers({
      assessmentId: assessment.id,
      jobId: 'smoke',
      logger,
      provider,
    });
    console.log(`  ${answerRun.answers.length} answers`);

    console.log('mapping...');
    const mappingRun = await mapAnswersToQuestions({
      assessmentId: assessment.id,
      jobId: 'smoke',
      logger,
      provider,
      embeddings,
    });
    console.log(
      `  ${mappingRun.metadata.autoMappedCount} auto-mapped, ` +
        `${mappingRun.metadata.reviewRequiredCount + mappingRun.metadata.humanReviewCount} for review`,
    );

    // The review queue is normally built by the review layer on demand; the
    // smoke test needs it present so a correction can be applied below.
    await store.update(assessment.id, (current) => ({
      ...current,
      reviews:
        current.reviews.length > 0
          ? current.reviews
          : buildReviewQueue(assessment.id, current.mappings, []),
    }));

    console.log('grading...');
    const started = Date.now();
    const gradingRun = await gradeAssessment({
      assessmentId: assessment.id,
      jobId: 'smoke',
      logger,
      provider,
    });

    await report(assessment.id, Date.now() - started);

    if (withRemap) {
      await correctAndRegrade(assessment.id, provider);
    }

    console.log('');
    console.log('--- boundary check ---');
    const stored = await getAssessment(assessment.id);
    console.log(
      `  mappings carry no marks     : ${!JSON.stringify(stored.mappings).includes('awarded')}`,
    );
    console.log(
      `  reviews carry no marks      : ${!JSON.stringify(stored.reviews).includes('awarded')}`,
    );
    console.log(
      `  totals are computed locally : ${gradingRun.grades
        .filter((grade) => grade.awardedMarks !== null)
        .every(
          (grade) =>
            grade.awardedMarks ===
            grade.criteria.reduce((total, criterion) => total + criterion.awardedMarks, 0),
        )}`,
    );
    console.log('');
    console.log('smoke test completed.');
  } finally {
    setDocumentStorage(null);
    setAssessmentStore(null);
    await rm(storageRoot, { recursive: true, force: true });
  }
}

async function report(assessmentId: string, elapsedMs: number): Promise<void> {
  const stored = await getAssessment(assessmentId);
  const questionById = new Map(stored.questions.map((question) => [question.id, question]));
  const answerById = new Map(stored.answers.map((answer) => [answer.id, answer]));
  const summary = summariseGrades(stored);

  console.log('');
  console.log('--- grading summary ---');
  console.log(`graded            : ${summary.graded}`);
  console.log(`review required   : ${summary.reviewRequired}`);
  console.log(`not gradeable     : ${summary.notGradeable}`);
  console.log(`marks             : ${summary.awardedMarks}/${summary.availableMarks}`);
  console.log(`percentage        : ${summary.percentage ?? '-'}`);
  console.log(`marks unaccounted : ${summary.ungradedMarks}`);
  console.log(`grading calls     : ${stored.grading?.gradingCalls ?? 0}`);
  console.log(`elapsed           : ${elapsedMs} ms`);

  console.log('');
  console.log('--- grades ---');

  for (const grade of stored.grades.filter((entry) => entry.isCurrent)) {
    const question = grade.questionId ? questionById.get(grade.questionId) : null;
    const answer = answerById.get(grade.answerId);

    console.log(
      `  ${(question?.labelRaw ?? '(unmapped)').padEnd(8)} ` +
        `${marks(grade.awardedMarks, grade.maximumMarks)}  ` +
        `${grade.status.padEnd(15)} conf ${grade.confidence.toFixed(3)}  ` +
        `${grade.notGradeableReason ?? (grade.reviewReasons.join(', ') || '-')}`,
    );

    if (answer) console.log(`           answer: "${preview(answer.text)}"`);

    for (const criterion of grade.criteria) {
      console.log(
        `           ${criterion.criterionId.padEnd(10)} ` +
          `${marks(criterion.awardedMarks, criterion.maximumMarks)} ` +
          `${criterion.outcome.padEnd(14)} ${preview(criterion.reason)}`,
      );
    }

    if (grade.feedback) console.log(`           feedback: "${preview(grade.feedback)}"`);
  }

  const unresolved = stored.markSchemes?.unresolved ?? [];

  if (unresolved.length > 0) {
    console.log('');
    console.log('--- rubrics that could not be tied to a question ---');
    for (const entry of unresolved) {
      console.log(`  "${entry.labelRaw}": ${entry.reason}`);
    }
  }
}

/**
 * Applies the correction a teacher would make, then re-grades.
 *
 * The two things to look at in the output: the new grade is against the
 * teacher's question, and the old one is still there, marked superseded.
 */
async function correctAndRegrade(
  assessmentId: string,
  provider: GeminiProvider,
): Promise<void> {
  const stored = await getAssessment(assessmentId);

  const pending = stored.reviews.filter((review) => review.status === 'PENDING');
  const taken = new Set(
    stored.mappings
      .map((mapping) => mapping.questionId)
      .filter((id): id is string => id !== null),
  );
  const free = stored.questions.find(
    (question) => !taken.has(question.id) && question.marks !== null,
  );

  if (pending.length === 0 || !free) {
    console.log('');
    console.log('--remap skipped: no pending review, or no free question with printed marks.');
    return;
  }

  const target = pending[0]!;

  console.log('');
  console.log(`correcting: answer ${target.answerId.slice(0, 8)} -> ${free.labelRaw}`);

  await remapReview({
    assessmentId,
    reviewId: target.id,
    questionId: free.id,
    reviewerId: 'smoke-teacher',
  });

  console.log('re-grading...');
  const started = Date.now();
  await gradeAssessment({ assessmentId, jobId: 'smoke-regrade', logger, provider });

  await report(assessmentId, Date.now() - started);

  const after = await getAssessment(assessmentId);
  const history = after.grades.filter(
    (grade) => grade.answerId === target.answerId && !grade.isCurrent,
  );

  console.log('');
  console.log('--- history for the corrected answer ---');
  for (const grade of history) {
    const question = grade.questionId
      ? after.questions.find((entry) => entry.id === grade.questionId)
      : null;

    console.log(
      `  ${(question?.labelRaw ?? '(none)').padEnd(8)} ` +
        `${marks(grade.awardedMarks, grade.maximumMarks)}  superseded: ${grade.supersededReason}`,
    );
  }
}

/**
 * Grading only, against a fixed set of answers.
 *
 * Extraction and mapping are skipped entirely — they have their own live
 * smoke tests, and re-running them costs quota that grading then cannot use.
 * What this exercises is the part Phase 7 added: the grading prompt, the
 * structured response, and the checks the application runs over it.
 *
 * The six answers are the six kinds worth watching by hand: fully correct,
 * partially correct, plainly wrong, off-topic, illegible in places, and one
 * that answers with a drawing the grader cannot see.
 */
/**
 * Which of the fixture answers to grade, as 1-based indices.
 *
 * Present because a constrained free tier allows only a handful of calls a
 * day: `--only 3,5` lets one kind be validated now and the rest later,
 * instead of the run dying part-way through every time.
 */
function parseOnly(args: string[]): number[] | null {
  const flag = args.find((arg) => arg.startsWith('--only'));

  if (!flag) return null;

  const raw = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : args[args.indexOf(flag) + 1];

  const indices = (raw ?? '')
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);

  return indices.length > 0 ? indices : null;
}

async function gradeOnlyRun(withRemap: boolean, only: number[] | null): Promise<void> {
  const store = new InMemoryAssessmentStore();
  setAssessmentStore(store);

  try {
    const assessment = await createAssessment({ title: 'grading smoke test (grade only)' });
    const { questions, answers, mappings } = gradingFixture(only);

    await store.update(assessment.id, (current) => ({
      ...current,
      questions,
      answers,
      mappings,
      reviews: buildReviewQueue(assessment.id, mappings, []),
    }));

    const provider = new GeminiProvider();

    console.log(`model          : ${provider.model}`);
    console.log(`questions      : ${questions.length}`);
    console.log(`answers        : ${answers.length}`);
    console.log('');
    console.log('grading...');

    const started = Date.now();
    await gradeAssessment({
      assessmentId: assessment.id,
      jobId: 'smoke-grade-only',
      logger,
      provider,
    });

    await report(assessment.id, Date.now() - started);

    if (withRemap) await correctAndRegrade(assessment.id, provider);

    const stored = await getAssessment(assessment.id);

    console.log('');
    console.log('--- boundary check ---');
    console.log(
      `  totals are computed locally : ${stored.grades
        .filter((grade) => grade.awardedMarks !== null)
        .every(
          (grade) =>
            grade.awardedMarks ===
            grade.criteria.reduce((total, criterion) => total + criterion.awardedMarks, 0),
        )}`,
    );
    console.log(
      `  no mark exceeds its ceiling : ${stored.grades.every(
        (grade) =>
          grade.maximumMarks === null || (grade.awardedMarks ?? 0) <= grade.maximumMarks,
      )}`,
    );
    console.log('');
    console.log('smoke test completed.');
  } finally {
    setAssessmentStore(null);
  }
}

function gradingFixture(only: number[] | null): {
  questions: Question[];
  answers: Answer[];
  mappings: AnswerMapping[];
} {
  const specs: Array<{ label: string; text: string; marks: number | null }> = [
    { label: 'Q1', text: 'Which organelle is primarily involved in photosynthesis?', marks: 2 },
    { label: 'Q2', text: 'Describe the flow of blood through the human heart.', marks: 4 },
    { label: 'Q3', text: 'Define osmosis and give one example.', marks: 3 },
    { label: 'Q4', text: 'State Newton’s second law of motion.', marks: 2 },
    { label: 'Q5', text: 'Explain why a solution conducts electricity.', marks: 3 },
    { label: 'Q6', text: 'Draw and label a diagram of the water cycle.', marks: 4 },
  ];

  const questions: Question[] = specs.map((spec, index) => {
    const parsed = parseQuestionLabel(spec.label);

    return {
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      labelRaw: spec.label,
      normalizedLabel: parsed.normalizedLabel,
      sortKey: parsed.sortKey,
      parentLabel: parsed.parentLabel,
      isSubQuestion: parsed.isSubQuestion,
      text: spec.text,
      marks: spec.marks,
      pageNumber: 1,
      rects: [{ pageNumber: 1, x: 0.1, y: 0.1 + index * 0.1, width: 0.7, height: 0.05 }],
      pageNumbers: [1],
    };
  });

  const bodies: Array<{ kind: string; text: string; overrides?: Partial<Answer> }> = [
    {
      kind: 'fully correct',
      text: 'The chloroplast. It contains chlorophyll, which absorbs light energy and uses it to convert carbon dioxide and water into glucose.',
    },
    {
      kind: 'partially correct',
      text: 'Blood comes into the right atrium from the body and then goes to the lungs. After that it comes back and is pumped out again.',
    },
    {
      kind: 'plainly wrong',
      text: 'Osmosis is when a solid turns straight into a gas, for example ice melting on a warm day.',
    },
    {
      kind: 'off-topic',
      text: 'Levers and pulleys are examples of simple machines that make work easier.',
    },
    {
      kind: 'illegible in places',
      text: 'Force equals [unclear] times acceleration, so a [unclear] object needs more force to speed up at the same rate.',
      overrides: { hasUncertainSegments: true },
    },
    {
      kind: 'answered with a drawing',
      text: 'See diagram below. [diagram: labelled arrows showing evaporation, condensation and precipitation]',
      overrides: { containsDiagram: true },
    },
  ];

  const answers: Answer[] = bodies.map((body, index) => ({
    id: `10000000-0000-4000-8000-00000000000${index + 1}`,
    claimedLabelRaw: null,
    claimedLabelNormalized: null,
    text: body.text,
    regions: [
      {
        pageNumber: 1,
        x: 0.08,
        y: 0.1 + index * 0.12,
        width: 0.8,
        height: 0.1,
        kind: body.overrides?.containsDiagram ? ('diagram' as const) : ('text' as const),
      },
    ],
    pageNumbers: [1],
    spansPages: false,
    hasUncertainSegments: false,
    containsDiagram: false,
    documentPosition: index,
    ...body.overrides,
  }));

  // Q1..Q6 in order; the fourth answer is deliberately off-topic but still
  // mapped, which is what a low-confidence mapping looks like in practice.
  const mappings: AnswerMapping[] = answers.map((answer, index) => ({
    id: `20000000-0000-4000-8000-00000000000${index + 1}`,
    answerId: answer.id,
    questionId: questions[index]!.id,
    status: index === 3 ? 'HUMAN_REVIEW' : 'AUTO_MAPPED',
    confidence: index === 3 ? 0.42 : 0.91,
    confidenceBand: index === 3 ? 'LOW' : 'HIGH',
    signals: null,
    reasonCodes: [],
    candidates: [],
    verification: null,
    createdAt: new Date().toISOString(),
  }));

  if (!only) return { questions, answers, mappings };

  // Questions are all kept: the paper is what it is, and dropping the
  // unanswered ones would misreport what marks went unaccounted for.
  const wanted = new Set(only.map((index) => index - 1));
  const selectedAnswers = answers.filter((_, index) => wanted.has(index));
  const selectedIds = new Set(selectedAnswers.map((answer) => answer.id));

  return {
    questions,
    answers: selectedAnswers,
    mappings: mappings.filter((mapping) => selectedIds.has(mapping.answerId)),
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
