import type { Logger } from 'pino';
import { isAppError } from '@/lib/errors';
import type { ProcessingStage } from '@/lib/domain/assessment';
import type { ProviderRegistry } from '@/lib/providers';
import { JOB_NAMES, type JobName } from '@/lib/queue/jobs';
import { prepareAssessmentDocuments } from '@/lib/services/document/document-preparation-service';
import { extractQuestions } from '@/lib/services/question/question-extraction-service';
import { extractAnswers } from '@/lib/services/answer/answer-extraction-service';
import { mapAnswersToQuestions } from '@/lib/services/mapping/mapping-service';
import { gradeAssessment } from '@/lib/services/grading/grading-service';

/**
 * Stage handlers.
 *
 * One thin function per stage: each delegates to a service and logs what came
 * back. Providers are injected rather than imported, so swapping the model —
 * or running the whole pipeline against a fake — touches the registry and
 * nothing here.
 *
 * FINALIZING is still a placeholder; everything before it is implemented.
 */
export interface StageContext {
  assessmentId: string;
  jobId: string;
  jobName: JobName;
  stage: ProcessingStage;
  providers: ProviderRegistry;
  logger: Logger;
}

export type StageHandler = (context: StageContext) => Promise<void>;

function placeholder(description: string): StageHandler {
  return async ({ logger, jobName }) => {
    logger.debug({ jobName, description }, 'assessment.stage.placeholder');
  };
}

export const STAGE_HANDLERS: Record<JobName, StageHandler> = {
  /**
   * The only stage implemented so far. Turns every uploaded document into
   * canonical prepared pages; the remaining stages consume those.
   */
  [JOB_NAMES.PREPARE]: async ({ assessmentId, jobId, logger }) => {
    const summary = await prepareAssessmentDocuments({ assessmentId, jobId, logger });

    logger.info(
      {
        documentCount: summary.documents.length,
        totalPages: summary.totalPages,
        renderedPages: summary.documents.reduce((n, d) => n + d.renderedPages, 0),
        reusedPages: summary.documents.reduce((n, d) => n + d.reusedPages, 0),
      },
      'assessment.documents.prepared',
    );
  },
  /**
   * Reads the question paper into validated, ordered question objects. The
   * provider comes from the injected registry, so this stage has no
   * knowledge of Gemini.
   */
  [JOB_NAMES.EXTRACT_QUESTIONS]: async ({ assessmentId, jobId, logger, providers }) => {
    const outcome = await extractQuestions({
      assessmentId,
      jobId,
      logger,
      provider: providers.ai,
    });

    logger.info(
      {
        questionCount: outcome.questions.length,
        reused: outcome.reused,
        promptVersion: outcome.metadata.promptVersion,
      },
      'assessment.questions.extracted',
    );
  },
  /**
   * Reads the handwritten answer sheet into located, transcribed blocks. It
   * deliberately does not look at the extracted questions — deciding which
   * question an answer belongs to is the next stage's problem.
   */
  [JOB_NAMES.EXTRACT_ANSWERS]: async ({ assessmentId, jobId, logger, providers }) => {
    const outcome = await extractAnswers({
      assessmentId,
      jobId,
      logger,
      provider: providers.ai,
    });

    logger.info(
      {
        answerCount: outcome.answers.length,
        unlabelledCount: outcome.metadata.unlabelledCount,
        reused: outcome.reused,
        promptVersion: outcome.metadata.promptVersion,
      },
      'assessment.answers.extracted',
    );
  },
  /**
   * Matches answers to questions. Candidate generation narrows the field with
   * cheap deterministic signals; the model only adjudicates the shortlist,
   * and the confidence is computed here rather than taken from it.
   */
  [JOB_NAMES.MAP_ANSWERS]: async ({ assessmentId, jobId, logger, providers }) => {
    const outcome = await mapAnswersToQuestions({
      assessmentId,
      jobId,
      logger,
      provider: providers.ai,
      embeddings: providers.embeddings,
    });

    logger.info(
      {
        mappingCount: outcome.mappings.length,
        autoMapped: outcome.metadata.autoMappedCount,
        reviewRequired: outcome.metadata.reviewRequiredCount,
        humanReview: outcome.metadata.humanReviewCount,
        unmapped: outcome.metadata.unmappedCount,
        reused: outcome.reused,
      },
      'assessment.answers.mapped',
    );
  },
  /**
   * Marks each answer against the question currently in force for it — the
   * teacher's correction where one exists, the AI's mapping otherwise. The
   * model recommends criterion by criterion; the total and the confidence are
   * computed here.
   *
   * It is also the one stage the run can finish without.
   *
   * Everything the teacher needs — the questions, the answers, the mapping and
   * the regions that drive highlighting — is already persisted by the time
   * this runs. Letting a marking failure roll the whole assessment back to
   * FAILED would discard all of it and leave the teacher with nothing, over
   * the part of the output that is advisory. So a failure here is recorded and
   * the run completes; the grades API simply reports no grade, which the UI
   * already renders as "Not marked" rather than as a score of zero.
   *
   * The implementation is untouched and still runs first — this only changes
   * what a failure costs.
   */
  [JOB_NAMES.GRADE]: async ({ assessmentId, jobId, logger, providers }) => {
    let outcome;

    try {
      outcome = await gradeAssessment({
        assessmentId,
        jobId,
        logger,
        provider: providers.ai,
      });
    } catch (error) {
      logger.warn(
        {
          status: 'SKIPPED',
          code: isAppError(error) ? error.code : 'UNKNOWN',
          reason: error instanceof Error ? error.message : String(error),
        },
        'assessment.answers.grading_skipped',
      );

      return;
    }

    logger.info(
      {
        answersConsidered: outcome.metadata.answersConsidered,
        graded: outcome.metadata.answersGraded,
        reviewRequired: outcome.metadata.reviewRequired,
        notGradeable: outcome.metadata.notGradeable,
        gradingCalls: outcome.metadata.gradingCalls,
        markSchemeSource: outcome.metadata.markSchemeSource,
        reused: outcome.reused,
      },
      'assessment.answers.graded',
    );
  },
  [JOB_NAMES.FINALIZE]: placeholder('Assemble the grading summary'),
};
