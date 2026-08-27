import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { getEnv } from '@/lib/config';
import { ConflictError, isAppError } from '@/lib/errors';
import type { Answer } from '@/lib/domain/answer';
import type { Question } from '@/lib/domain/question';
import {
  bandForConfidence,
  calculateFinalConfidence,
  deriveReasonCodes,
  statusForBand,
  type AdjudicationRecord,
  type AnswerMapping,
  type MappingMetadata,
  type MappingReasonCode,
} from '@/lib/domain/mapping';
import {
  ADJUDICATION_PROMPT_VERSION,
  type AIProvider,
  type MappingAdjudicationResult,
} from '@/lib/providers/ai';
import {
  EmbeddingCache,
  embeddingCacheKey,
  type EmbeddingProvider,
} from '@/lib/providers/embeddings';
import { getAssessmentStore } from '@/lib/services/assessment-store';
import { buildReviewQueue } from '@/lib/services/review/review-queue';
import { assignMaximumWeight } from './assignment';
import {
  answerEmbeddingText,
  generateCandidates,
  questionEmbeddingText,
  type CandidateSet,
  type EmbeddedAnswer,
  type EmbeddedQuestion,
} from './candidate-generation';

/**
 * Hybrid question-answer mapping.
 *
 * Five separable steps, in order, each doing one job:
 *
 *   1. embed        questions and answers, batched and cached
 *   2. generate     score every pair on cheap signals, keep the top K
 *   3. adjudicate   ask the model about those few, never about the whole paper
 *   4. score        compute the confidence *here*, not in the model
 *   5. assign       resolve one-to-one globally, not answer by answer
 *
 * Keeping them apart is what makes the result reviewable. A mapping arrives
 * with the signals that produced it, the candidates that lost, and what the
 * adjudicator said — so a wrong mapping can be seen to be wrong instead of
 * being taken on trust.
 *
 * Nothing here grades anything. The question it answers is "which answer
 * belongs to which question", not "is the answer right".
 */

export interface MappingContext {
  assessmentId: string;
  jobId: string;
  logger: Logger;
  provider: AIProvider;
  embeddings: EmbeddingProvider;
}

export interface MappingOutcome {
  mappings: AnswerMapping[];
  unmappedQuestionIds: string[];
  metadata: MappingMetadata;
  reused: boolean;
}

function now(): string {
  return new Date().toISOString();
}

export async function mapAnswersToQuestions(
  context: MappingContext,
): Promise<MappingOutcome> {
  const { assessmentId, provider, embeddings, logger } = context;
  const env = getEnv();

  const store = getAssessmentStore();
  const assessment = await store.get(assessmentId);

  assertReadyToMap(assessment.questions, assessment.answers);

  const log = logger.child({
    provider: provider.name,
    model: provider.model,
    embeddingModel: embeddings.model,
  });

  // Within-run reuse on top of the stage record: a retry must never repeat
  // the embedding and adjudication cost for work that already landed.
  if (assessment.mappings.length > 0 && assessment.mapping !== null) {
    log.info(
      { status: 'REUSED', mappingCount: assessment.mappings.length },
      'assessment.mapping.reused',
    );

    return {
      mappings: assessment.mappings,
      unmappedQuestionIds: unmappedQuestions(assessment.questions, assessment.mappings),
      metadata: assessment.mapping,
      reused: true,
    };
  }

  const { questions, answers } = assessment;

  log.info(
    { status: 'STARTED', questionCount: questions.length, answerCount: answers.length },
    'assessment.mapping.started',
  );

  const started = Date.now();

  // --- 1. Embed -----------------------------------------------------------
  const cache = new EmbeddingCache();
  const embeddedQuestions = await embedQuestions(questions, embeddings, cache);
  const embeddedAnswers = await embedAnswers(answers, embeddings, cache);

  // --- 2. Generate candidates --------------------------------------------
  const candidateSets = embeddedAnswers.map((embeddedAnswer) =>
    generateCandidates(embeddedAnswer, embeddedQuestions, {
      topK: env.MAPPING_TOP_K,
      answerCount: embeddedAnswers.length,
    }),
  );

  // --- 3. Adjudicate the shortlist ---------------------------------------
  const adjudications = new Map<string, AdjudicationRecord | null>();
  const skipped = new Set<string>();
  /** Consultations that produced a decision — what the metadata reports. */
  let adjudicationCalls = 0;
  /** Requests sent, decision or not — what pacing has to be measured against. */
  let adjudicationAttempts = 0;

  for (const set of candidateSets) {
    const answer = answers.find((entry) => entry.id === set.answerId)!;

    if (isDecisive(set, env.MAPPING_SKIP_ADJUDICATION_ABOVE)) {
      skipped.add(set.answerId);
      adjudications.set(set.answerId, null);
      log.debug(
        { answerId: set.answerId, status: 'SKIPPED' },
        'assessment.mapping.adjudication_unnecessary',
      );
      continue;
    }

    /*
     * Pacing, not retrying: constrained tiers reject a burst of calls that
     * they would accept spread out. Retry remains the queue's job.
     *
     * This counts attempts rather than successes on purpose. Counting
     * successes meant the first refusal left the counter at zero, so every
     * remaining call fired with no delay at all — the whole stage emptied
     * itself into the window that had just rejected it, and not one
     * adjudication survived. A run that is being rate limited is precisely
     * the run that needs the gap.
     */
    if (adjudicationAttempts > 0 && env.MAPPING_ADJUDICATION_DELAY_MS > 0) {
      await delay(env.MAPPING_ADJUDICATION_DELAY_MS);
    }

    adjudicationAttempts += 1;

    const record = await adjudicate(answer, set, questions, provider, log);

    if (record) adjudicationCalls += 1;
    adjudications.set(set.answerId, record);
  }

  // --- 4. Final confidence per pair ---------------------------------------
  for (const set of candidateSets) {
    const record = adjudications.get(set.answerId) ?? null;

    for (const candidate of set.candidates) {
      const selected = record?.decision === 'MATCH' && record.questionId === candidate.questionId;

      candidate.llmSelected = selected;
      candidate.llmConfidence = record ? record.modelConfidence : null;
      candidate.finalConfidence = calculateFinalConfidence({
        signals: candidate.signals,
        candidateScore: candidate.candidateScore,
        llmSelected: selected,
        llmConfidence: record?.modelConfidence ?? null,
        llmConsulted: record !== null,
      });
    }

    // Re-rank: adjudication can promote a candidate the shortlist ranked second.
    set.candidates.sort((a, b) => b.finalConfidence - a.finalConfidence);
  }

  // --- 5. Global one-to-one assignment ------------------------------------
  const assignment = assignGlobally(candidateSets, questions, env.MAPPING_MIN_ASSIGNMENT_SCORE);

  const mappings = buildMappings(candidateSets, answers, adjudications, assignment, skipped);

  const metadata: MappingMetadata = {
    provider: provider.name,
    model: provider.model,
    embeddingModel: embeddings.model,
    promptVersion: ADJUDICATION_PROMPT_VERSION,
    mappedAt: now(),
    questionCount: questions.length,
    answerCount: answers.length,
    topK: env.MAPPING_TOP_K,
    autoMappedCount: mappings.filter((m) => m.status === 'AUTO_MAPPED').length,
    reviewRequiredCount: mappings.filter((m) => m.status === 'REVIEW_REQUIRED').length,
    humanReviewCount: mappings.filter((m) => m.status === 'HUMAN_REVIEW').length,
    unmappedCount: mappings.filter((m) => m.status === 'UNMAPPED').length,
    adjudicationCalls,
    embeddingCalls: cache.misses,
    weights: {
      label: env.MAPPING_WEIGHT_LABEL,
      semantic: env.MAPPING_WEIGHT_SEMANTIC,
      position: env.MAPPING_WEIGHT_POSITION,
      structure: env.MAPPING_WEIGHT_STRUCTURE,
      llm: env.MAPPING_WEIGHT_LLM,
    },
    thresholds: {
      high: env.MAPPING_CONFIDENCE_HIGH,
      medium: env.MAPPING_CONFIDENCE_MEDIUM,
      minAssignment: env.MAPPING_MIN_ASSIGNMENT_SCORE,
    },
  };

  await persist(assessmentId, mappings, metadata);

  const unmapped = unmappedQuestions(questions, mappings);

  log.info(
    {
      status: 'COMPLETED',
      questionCount: questions.length,
      answerCount: answers.length,
      autoMapped: metadata.autoMappedCount,
      reviewRequired: metadata.reviewRequiredCount,
      humanReview: metadata.humanReviewCount,
      unmapped: metadata.unmappedCount,
      unmappedQuestions: unmapped.length,
      adjudicationCalls,
      embeddingCalls: cache.misses,
      embeddingCacheHits: cache.hits,
      durationMs: Date.now() - started,
    },
    'assessment.mapping.completed',
  );

  return { mappings, unmappedQuestionIds: unmapped, metadata, reused: false };
}

/** Both sides must exist before any provider is contacted. */
function assertReadyToMap(questions: readonly Question[], answers: readonly Answer[]): void {
  if (questions.length === 0) {
    throw new ConflictError(
      'No questions have been extracted. Mapping cannot run before question extraction.',
    );
  }

  if (answers.length === 0) {
    throw new ConflictError(
      'No answers have been extracted. Mapping cannot run before answer extraction.',
    );
  }
}

async function embedQuestions(
  questions: readonly Question[],
  embeddings: EmbeddingProvider,
  cache: EmbeddingCache,
): Promise<EmbeddedQuestion[]> {
  const texts = questions.map((question) => questionEmbeddingText(question, questions));
  const vectors = await embedCached(texts, embeddings, cache);

  return questions.map((question, index) => ({
    question,
    vector: vectors[index]!,
    index,
  }));
}

async function embedAnswers(
  answers: readonly Answer[],
  embeddings: EmbeddingProvider,
  cache: EmbeddingCache,
): Promise<EmbeddedAnswer[]> {
  const texts = answers.map(answerEmbeddingText);
  const vectors = await embedCached(texts, embeddings, cache);

  return answers.map((answer, index) => ({
    answer,
    vector: vectors[index]!,
    index,
  }));
}

/**
 * Embeds a batch, skipping anything already cached.
 *
 * Only the misses are sent, in one request, and the results are stitched back
 * into the original order — so repeated text costs nothing and the provider
 * still sees a single call.
 */
async function embedCached(
  texts: readonly string[],
  embeddings: EmbeddingProvider,
  cache: EmbeddingCache,
): Promise<number[][]> {
  const keys = texts.map((text) =>
    embeddingCacheKey(text, embeddings.model, embeddings.dimensions),
  );

  const results = new Array<number[] | undefined>(texts.length);
  const missingIndexes: number[] = [];
  const missingTexts: string[] = [];
  const seen = new Map<string, number>();

  for (let index = 0; index < texts.length; index += 1) {
    const key = keys[index]!;
    const cached = cache.get(key);

    if (cached) {
      results[index] = cached;
      continue;
    }

    // Duplicate text within one batch is embedded once, not twice.
    const alreadyQueued = seen.get(key);
    if (alreadyQueued !== undefined) {
      missingIndexes.push(index);
      missingTexts.push('');
      continue;
    }

    seen.set(key, index);
    missingIndexes.push(index);
    missingTexts.push(texts[index]!);
  }

  const toEmbed = missingTexts.filter((text) => text.length > 0);

  if (toEmbed.length > 0) {
    const vectors = await embeddings.embed(toEmbed);

    let cursor = 0;
    for (let position = 0; position < missingIndexes.length; position += 1) {
      if (missingTexts[position]!.length === 0) continue;

      const index = missingIndexes[position]!;
      const vector = vectors[cursor]!;
      cursor += 1;

      results[index] = vector;
      cache.set(keys[index]!, vector);
    }
  }

  // Fill any duplicates from the cache now that their twin has been stored.
  for (let index = 0; index < texts.length; index += 1) {
    if (results[index]) continue;
    results[index] = cache.get(keys[index]!) ?? [];
  }

  return results.map((vector) => vector ?? []);
}

/**
 * Asks the adjudicator about one answer's shortlist.
 *
 * A returned id that was not on the shortlist is rejected outright — the
 * model is not permitted to introduce a question, and a hallucinated id
 * silently accepted would be a mapping to something that was never a
 * candidate. A provider outage degrades to "not consulted" rather than
 * failing the run: the deterministic signals still stand.
 */
async function adjudicate(
  answer: Answer,
  set: CandidateSet,
  questions: readonly Question[],
  provider: AIProvider,
  log: Logger,
): Promise<AdjudicationRecord | null> {
  if (set.candidates.length === 0) return null;

  const permitted = new Set(set.candidates.map((candidate) => candidate.questionId));

  let result: MappingAdjudicationResult;

  try {
    result = await provider.adjudicateMapping({
      answerText: answer.text,
      claimedLabelRaw: answer.claimedLabelRaw,
      candidates: set.candidates.map((candidate) => {
        const question = questions.find((entry) => entry.id === candidate.questionId)!;

        return {
          questionId: question.id,
          labelRaw: question.labelRaw,
          text: question.text,
          marks: question.marks,
          parentContext: parentContextFor(question, questions),
        };
      }),
    });
  } catch (error) {
    // Permanent failures are the caller's problem; a transient one leaves the
    // deterministic signals to carry the mapping on their own.
    if (isAppError(error) && !error.retryable) throw error;

    log.warn(
      { answerId: answer.id, code: isAppError(error) ? error.code : 'UNKNOWN' },
      'assessment.mapping.adjudication_unavailable',
    );

    // Not consulted, which the confidence model already understands — the
    // deterministic signals decide this pair on their own. Rethrowing here
    // discarded a whole mapping stage because one call hit a per-minute token
    // ceiling, which is the opposite of what this function promises above.
    return null;
  }

  if (result.decision === 'MATCH' && result.questionId !== null) {
    if (!permitted.has(result.questionId)) {
      log.warn(
        { answerId: answer.id, returnedQuestionId: result.questionId },
        'assessment.mapping.adjudication_invalid_candidate',
      );

      return {
        decision: 'NO_MATCH',
        questionId: null,
        reasonCode: 'INVALID_CANDIDATE_ID',
        modelConfidence: 0,
        provider: provider.name,
        model: provider.model,
        promptVersion: ADJUDICATION_PROMPT_VERSION,
      };
    }
  }

  return {
    decision: result.decision,
    questionId: result.decision === 'MATCH' ? result.questionId : null,
    reasonCode: result.reasonCode,
    modelConfidence: result.confidence,
    provider: provider.name,
    model: provider.model,
    promptVersion: ADJUDICATION_PROMPT_VERSION,
  };
}

function parentContextFor(
  question: Question,
  questions: readonly Question[],
): string | null {
  if (!question.isSubQuestion || !question.parentLabel) return null;

  const parent = questions.find(
    (candidate) =>
      !candidate.isSubQuestion && String(candidate.sortKey.major) === question.parentLabel,
  );

  return parent?.text ?? null;
}

interface GlobalAssignment {
  questionIdByAnswerId: Map<string, string>;
  contestedAnswerIds: Set<string>;
}

/**
 * Resolves the whole board at once.
 *
 * Answers are not processed independently: two answers both favouring Q2
 * would otherwise overwrite each other, and the second one to be handled
 * would win for no better reason than its position in a loop. The optimiser
 * looks at every pairing together and maximises the total, which is how the
 * documented conflict case comes out right.
 */
function assignGlobally(
  candidateSets: readonly CandidateSet[],
  questions: readonly Question[],
  minimumScore: number,
): GlobalAssignment {
  const questionIndex = new Map(questions.map((question, index) => [question.id, index]));

  const matrix = candidateSets.map((set) => {
    const row = new Array<number>(questions.length).fill(Number.NEGATIVE_INFINITY);

    for (const candidate of set.candidates) {
      const column = questionIndex.get(candidate.questionId);
      if (column !== undefined) row[column] = candidate.finalConfidence;
    }

    return row;
  });

  const result = assignMaximumWeight(matrix, { minimumScore });

  const questionIdByAnswerId = new Map<string, string>();

  for (const pair of result.pairs) {
    const set = candidateSets[pair.rowIndex]!;
    const question = questions[pair.columnIndex]!;
    questionIdByAnswerId.set(set.answerId, question.id);
  }

  // An answer whose own best candidate was taken by someone else was
  // contested — worth recording, because it changes how a reviewer reads it.
  const contestedAnswerIds = new Set<string>();

  for (const set of candidateSets) {
    const best = set.candidates[0];
    if (!best) continue;

    const assigned = questionIdByAnswerId.get(set.answerId);
    if (assigned && assigned !== best.questionId) contestedAnswerIds.add(set.answerId);
  }

  return { questionIdByAnswerId, contestedAnswerIds };
}

/**
 * Whether the cheap signals already settle it.
 *
 * An exact written label, matched to exactly one question, with the content
 * agreeing, leaves nothing for an adjudicator to decide. Calling the model
 * there spends a request — and, on a constrained tier, a slice of the rate
 * limit — on a conclusion already reached, while genuinely ambiguous answers
 * queue behind it.
 */
function isDecisive(set: CandidateSet, threshold: number): boolean {
  const best = set.candidates[0];
  if (!best) return false;

  const exactLabel =
    best.signals.labelKind === 'EXACT_NORMALIZED_LABEL' ||
    best.signals.labelKind === 'EXACT_PARENT_AND_SUBQUESTION';

  return exactLabel && best.candidateScore >= threshold;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildMappings(
  candidateSets: readonly CandidateSet[],
  answers: readonly Answer[],
  adjudications: ReadonlyMap<string, AdjudicationRecord | null>,
  assignment: GlobalAssignment,
  skipped: ReadonlySet<string>,
): AnswerMapping[] {
  const createdAt = now();

  return candidateSets.map((set) => {
    const record = adjudications.get(set.answerId) ?? null;
    const assignedQuestionId = assignment.questionIdByAnswerId.get(set.answerId) ?? null;

    const assigned = assignedQuestionId
      ? set.candidates.find((candidate) => candidate.questionId === assignedQuestionId)
      : undefined;

    if (!assigned) {
      const reasonCodes: MappingReasonCode[] = [];

      if (set.candidates.length === 0) reasonCodes.push('NO_CANDIDATES');
      else if (record?.decision === 'NO_MATCH') reasonCodes.push('LLM_NO_MATCH');
      else reasonCodes.push('BELOW_ASSIGNMENT_THRESHOLD');

      reasonCodes.push('NO_MATCH');

      return {
        id: randomUUID(),
        answerId: set.answerId,
        questionId: null,
        status: 'UNMAPPED',
        // Confidence in the *mapping*, and there is no mapping — so it is
        // zero. Reporting the best candidate's score here would contradict
        // the LOW band beside it and read as "84% sure of nothing". The
        // score that was actually reached stays visible on `candidates`,
        // which is where a reviewer looks for the alternatives anyway.
        confidence: 0,
        confidenceBand: 'LOW',
        signals: null,
        reasonCodes,
        candidates: set.candidates,
        verification: record,
        createdAt,
      } satisfies AnswerMapping;
    }

    const band = bandForConfidence(assigned.finalConfidence);

    return {
      id: randomUUID(),
      answerId: set.answerId,
      questionId: assigned.questionId,
      status: statusForBand(band),
      confidence: assigned.finalConfidence,
      confidenceBand: band,
      signals: assigned.signals,
      reasonCodes: deriveReasonCodes({
        signals: assigned.signals,
        llmSelected: assigned.llmSelected,
        llmConsulted: record !== null,
        llmDecidedNoMatch: record?.decision === 'NO_MATCH',
        band,
        conflictResolved: assignment.contestedAnswerIds.has(set.answerId),
        adjudicationSkipped: skipped.has(set.answerId),
      }),
      candidates: set.candidates,
      verification: record,
      createdAt,
    } satisfies AnswerMapping;
  });
}

function unmappedQuestions(
  questions: readonly Question[],
  mappings: readonly AnswerMapping[],
): string[] {
  const mapped = new Set(
    mappings.map((mapping) => mapping.questionId).filter((id): id is string => id !== null),
  );

  return questions.filter((question) => !mapped.has(question.id)).map((question) => question.id);
}

async function persist(
  assessmentId: string,
  mappings: AnswerMapping[],
  metadata: MappingMetadata,
): Promise<void> {
  await getAssessmentStore().update(assessmentId, (current) => ({
    ...current,
    mappings,
    mapping: metadata,
    // Queue the items a human needs to look at. Existing reviews are carried
    // through untouched, so a decision already made is never discarded by a
    // later mapping run.
    reviews: buildReviewQueue(assessmentId, mappings, current.reviews),
    updatedAt: now(),
  }));
}
