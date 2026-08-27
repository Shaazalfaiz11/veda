import type {
  AIProvider,
  AnswerExtractionResult,
  ExtractedAnswerCandidate,
  ExtractedQuestionCandidate,
  GradingRequest,
  GradingResult,
  MappingAdjudicationRequest,
  MappingAdjudicationResult,
  PageImage,
  ProviderUsage,
  QuestionExtractionResult,
} from './types';

/**
 * Scripted AI provider for tests.
 *
 * Lets a test decide exactly what the "model" returns — including responses
 * no real model should produce — so validation can be exercised against
 * hostile output without a network call or an API key.
 */
export interface FakeAIProviderOptions {
  candidates?: ExtractedQuestionCandidate[];
  usage?: ProviderUsage | null;
  /** Thrown instead of returning, to simulate a provider failure. */
  error?: Error;
  /** Invoked per call, for asserting how many pages were sent. */
  onExtractQuestions?: (pages: PageImage[]) => void;

  /**
   * Scripted answers. A function receives the pages of the call, so a test
   * covering chunked extraction can answer differently per chunk — which is
   * the only way to exercise page translation, overlap and merging.
   */
  answerCandidates?:
    | ExtractedAnswerCandidate[]
    | ((pages: PageImage[]) => ExtractedAnswerCandidate[]);
  answerUsage?: ProviderUsage | null;
  /**
   * Thrown instead of returning. A function may return null to let a
   * particular call succeed, so a test can fail one chunk and not the rest.
   */
  answerError?: Error | ((pages: PageImage[]) => Error | null);
  onExtractAnswers?: (pages: PageImage[]) => void;

  /**
   * Scripted adjudication. A function receives the request so a test can
   * decide per answer — picking a candidate, choosing a different one than
   * the shortlist favoured, or declining.
   */
  adjudication?:
    | MappingAdjudicationResult
    | ((request: MappingAdjudicationRequest) => MappingAdjudicationResult);
  adjudicationError?: Error;
  onAdjudicate?: (request: MappingAdjudicationRequest) => void;

  /**
   * Scripted grading. A function receives the request so a test can respond
   * to the actual rubric — awarding partial credit, citing an id that was
   * never on the rubric, or reporting a total that does not add up.
   */
  grading?: GradingResult | ((request: GradingRequest) => GradingResult);
  gradingError?: Error;
  onGrade?: (request: GradingRequest) => void;
}

export class FakeAIProvider implements AIProvider {
  readonly name = 'fake';
  readonly model = 'fake-model-v1';

  /** Call counters — the idempotency and cost probes. */
  extractQuestionsCalls = 0;
  extractAnswersCalls = 0;
  adjudicateCalls = 0;
  gradeCalls = 0;
  lastAdjudication: MappingAdjudicationRequest | null = null;
  lastGrading: GradingRequest | null = null;
  lastPages: PageImage[] = [];
  lastAnswerPages: PageImage[] = [];
  /** Pages sent on each call, in order — one entry per chunk. */
  answerCallPages: PageImage[][] = [];

  constructor(private options: FakeAIProviderOptions = {}) {}

  configure(options: FakeAIProviderOptions): void {
    this.options = options;
  }

  reset(): void {
    this.extractQuestionsCalls = 0;
    this.extractAnswersCalls = 0;
    this.adjudicateCalls = 0;
    this.gradeCalls = 0;
    this.lastPages = [];
    this.lastAnswerPages = [];
    this.answerCallPages = [];
    this.lastAdjudication = null;
    this.lastGrading = null;
  }

  async extractQuestions(pages: PageImage[]): Promise<QuestionExtractionResult> {
    this.extractQuestionsCalls += 1;
    this.lastPages = pages;
    this.options.onExtractQuestions?.(pages);

    if (this.options.error) throw this.options.error;

    return {
      candidates: this.options.candidates ?? [],
      usage: this.options.usage ?? null,
    };
  }

  async extractAnswers(pages: PageImage[]): Promise<AnswerExtractionResult> {
    this.extractAnswersCalls += 1;
    this.lastAnswerPages = pages;
    this.answerCallPages.push(pages);
    this.options.onExtractAnswers?.(pages);

    const error =
      typeof this.options.answerError === 'function'
        ? this.options.answerError(pages)
        : this.options.answerError;

    if (error) throw error;

    const scripted = this.options.answerCandidates;

    return {
      candidates:
        typeof scripted === 'function' ? scripted(pages) : (scripted ?? []),
      usage: this.options.answerUsage ?? null,
    };
  }

  async adjudicateMapping(
    request: MappingAdjudicationRequest,
  ): Promise<MappingAdjudicationResult> {
    this.adjudicateCalls += 1;
    this.lastAdjudication = request;
    this.options.onAdjudicate?.(request);

    if (this.options.adjudicationError) throw this.options.adjudicationError;

    const scripted = this.options.adjudication;

    if (typeof scripted === 'function') return scripted(request);
    if (scripted) return scripted;

    // Default: agree with the shortlist's own favourite, confidently. Tests
    // that care about disagreement script it explicitly.
    return {
      decision: 'MATCH',
      questionId: request.candidates[0]?.questionId ?? null,
      reasonCode: 'SUBJECT_MATCH',
      confidence: 0.9,
      usage: null,
    };
  }

  async gradeAnswer(request: GradingRequest): Promise<GradingResult> {
    this.gradeCalls += 1;
    this.lastGrading = request;
    this.options.onGrade?.(request);

    if (this.options.gradingError) throw this.options.gradingError;

    const scripted = this.options.grading;

    if (typeof scripted === 'function') return scripted(request);
    if (scripted) return scripted;

    // Default: full marks on every criterion, confidently. Tests that care
    // about partial credit or disagreement script it explicitly.
    const criteria = request.criteria.map((criterion) => ({
      criterionId: criterion.id,
      awardedMarks: criterion.maxMarks,
      reason: `Fully satisfies: ${criterion.description}`,
    }));

    return {
      criteria,
      totalAwardedMarks: criteria.reduce((total, c) => total + c.awardedMarks, 0),
      confidence: 0.9,
      feedback: 'A complete and accurate response.',
      usage: null,
    };
  }
}
