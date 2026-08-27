import type { PageRegion } from '@/lib/domain/document';
import type { AnswerRegion } from '@/lib/domain/answer';

/**
 * AI provider contract.
 *
 * Deliberately expressed in domain terms rather than in any vendor's
 * request shape, so swapping Gemini for another model — or splitting
 * geometry onto a dedicated OCR engine — is a new implementation of this
 * interface and nothing else.
 */
/**
 * What a model claims it found. Deliberately *not* a domain Question: it has
 * no id, nothing is normalised, and nothing is trusted until validation has
 * run over it.
 *
 * `pageNumber` is 1-based, matching PreparedPage. The system uses a single
 * page-numbering convention end to end so a region can never be attributed
 * to the wrong page by an off-by-one.
 */
export interface ExtractedQuestionCandidate {
  labelRaw: string;
  text: string;
  marks: number | null;
  /** 1-based page the question starts on. */
  pageNumber: number;
  /**
   * Regions bounding the question. Each carries its own page, so a question
   * whose text continues onto the next page is one candidate with rects on
   * two pages rather than two unrelated candidates.
   */
  rects: PageRegion[];
}

/** Non-sensitive usage counters, when the provider reports them. */
export interface ProviderUsage {
  promptTokens: number | null;
  responseTokens: number | null;
  totalTokens: number | null;
}

export interface QuestionExtractionResult {
  candidates: ExtractedQuestionCandidate[];
  usage: ProviderUsage | null;
}

/**
 * What a model claims a student wrote, and where.
 *
 * Carries no question reference by design: the label is recorded as a claim,
 * never as a resolved identity. Nothing here is trusted until validation has
 * run over it.
 */
export interface ExtractedAnswerCandidate {
  /** The label the student wrote, verbatim. Null when they wrote none. */
  claimedLabelRaw: string | null;
  /** Faithful transcription; illegible stretches carry UNCLEAR_MARKER. */
  text: string;
  /** One or more regions, each bound to the page it lies on. */
  regions: AnswerRegion[];
}

export interface AnswerExtractionResult {
  candidates: ExtractedAnswerCandidate[];
  usage: ProviderUsage | null;
}

/**
 * A canonical prepared page, ready to hand to a vision model. `data` is the
 * exact bitmap Phase 2 produced — the same pixels the teacher will see and
 * that normalized coordinates are measured against.
 */
export interface PageImage {
  /** 1-based, matching PreparedPage. */
  pageNumber: number;
  /** Base64-encoded page bitmap. Never logged, never returned by an API. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * One bounded adjudication: an answer against a shortlist of questions the
 * application already narrowed down.
 *
 * The direction matters. Asking "which of these few questions does this
 * answer address?" is answerable; asking a model to map a whole paper is not
 * checkable, and this codebase never does it.
 */
export interface MappingAdjudicationCandidate {
  questionId: string;
  labelRaw: string;
  text: string;
  marks: number | null;
  /** Parent question text, when the candidate is a sub-question. */
  parentContext: string | null;
}

export interface MappingAdjudicationRequest {
  answerText: string;
  claimedLabelRaw: string | null;
  candidates: MappingAdjudicationCandidate[];
}

export interface MappingAdjudicationResult {
  decision: 'MATCH' | 'NO_MATCH';
  /** Always one of the supplied candidate ids, or null. Verified by the caller. */
  questionId: string | null;
  reasonCode: string;
  /** The model's own confidence. One signal; never the final confidence. */
  confidence: number;
  usage: ProviderUsage | null;
}

/**
 * One bounded grading request: one answer, one question, one rubric.
 *
 * Everything the grader needs and nothing more — the whole assessment is
 * never sent, because judging this answer does not require the others.
 */
export interface GradingCriterionSpec {
  id: string;
  description: string;
  maxMarks: number;
  acceptableConcepts: string[];
  allowsPartialCredit: boolean;
}

export interface GradingRequest {
  questionLabel: string;
  questionText: string;
  /** Parent question wording, when grading a sub-question. */
  parentContext: string | null;
  totalMarks: number;
  granularity: 'WHOLE' | 'HALF';

  answerText: string;
  /** From Phase 4: the transcription admitted an illegible stretch. */
  answerHasUncertainSegments: boolean;
  answerContainsDiagram: boolean;

  criteria: GradingCriterionSpec[];
  modelAnswer: string | null;
  /** True when the rubric was derived rather than supplied by an examiner. */
  rubricIsGenerated: boolean;
}

/**
 * What the model recommends. Not a result: the application verifies the ids,
 * the ceilings and the arithmetic, and computes the total itself.
 */
export interface GradingCriterionRecommendation {
  criterionId: string;
  awardedMarks: number;
  reason: string;
}

export interface GradingResult {
  criteria: GradingCriterionRecommendation[];
  /** The model's own total. Checked against its criteria, never trusted. */
  totalAwardedMarks: number;
  /** The model's own confidence. One signal; never the final confidence. */
  confidence: number;
  feedback: string;
  usage: ProviderUsage | null;
}

export interface AIProvider {
  readonly name: string;
  /** Model identifier, for extraction metadata. */
  readonly model: string;

  extractQuestions(pages: PageImage[]): Promise<QuestionExtractionResult>;
  /**
   * Reads a whole answer sheet in one call. All pages go together because an
   * answer that continues onto the next page can only be recognised as one
   * answer by something that can see both.
   */
  extractAnswers(pages: PageImage[]): Promise<AnswerExtractionResult>;
  adjudicateMapping(request: MappingAdjudicationRequest): Promise<MappingAdjudicationResult>;
  /**
   * Marks one answer against one question and its rubric. The provider
   * returns a recommendation; deciding what it is worth is the service's job.
   */
  gradeAnswer(request: GradingRequest): Promise<GradingResult>;
}
