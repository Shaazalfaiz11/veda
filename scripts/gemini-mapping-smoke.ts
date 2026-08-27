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
import { GeminiProvider } from '../lib/providers/ai';
import { GeminiEmbeddingProvider } from '../lib/providers/embeddings';

/**
 * Opt-in end-to-end smoke test: extraction through to mapping, against the
 * real Gemini and embedding APIs.
 *
 *   npm run smoke:mapping -- question-paper.pdf answer-sheet.pdf
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

function bandMark(band: string): string {
  return band === 'HIGH' ? 'HIGH  ' : band === 'MEDIUM' ? 'MEDIUM' : 'LOW   ';
}

async function main(): Promise<void> {
  const env = getEnv();

  if (!env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set. Add it to .env.local and try again.');
    process.exitCode = 1;
    return;
  }

  const [paperPath, sheetPath] = process.argv.slice(2);

  if (!paperPath || !sheetPath) {
    console.error('Usage: npm run smoke:mapping -- <question-paper> <answer-sheet>');
    process.exitCode = 1;
    return;
  }

  const storageRoot = await mkdtemp(join(tmpdir(), 'veda-mapping-smoke-'));
  const store = new InMemoryAssessmentStore();

  setAssessmentStore(store);
  setDocumentStorage(new LocalDocumentStorage(storageRoot));

  try {
    const assessment = await createAssessment({ title: 'mapping smoke test' });

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

    const prepared = await getAssessment(assessment.id);
    for (const document of prepared.documents) {
      console.log(`  ${document.type.padEnd(14)} ${document.pageCount} page(s) prepared`);
    }

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
    console.log(
      `  ${answerRun.answers.length} answers (${answerRun.metadata.unlabelledCount} unlabelled)`,
    );

    console.log('mapping...');
    const started = Date.now();
    const mappingRun = await mapAnswersToQuestions({
      assessmentId: assessment.id,
      jobId: 'smoke',
      logger,
      provider,
      embeddings,
    });

    const final = await getAssessment(assessment.id);
    const questionById = new Map(final.questions.map((q) => [q.id, q]));
    const answerById = new Map(final.answers.map((a) => [a.id, a]));

    console.log('');
    console.log('--- mapping summary ---');
    console.log(`questions        : ${mappingRun.metadata.questionCount}`);
    console.log(`answers          : ${mappingRun.metadata.answerCount}`);
    console.log(`top K            : ${mappingRun.metadata.topK}`);
    console.log(`auto-mapped      : ${mappingRun.metadata.autoMappedCount}`);
    console.log(`review required  : ${mappingRun.metadata.reviewRequiredCount}`);
    console.log(`human review     : ${mappingRun.metadata.humanReviewCount}`);
    console.log(`unmapped         : ${mappingRun.metadata.unmappedCount}`);
    console.log(`adjudication calls: ${mappingRun.metadata.adjudicationCalls}`);
    console.log(`embedding calls  : ${mappingRun.metadata.embeddingCalls}`);
    console.log(`elapsed          : ${Date.now() - started} ms`);

    console.log('');
    console.log('--- mappings (by question) ---');

    const byQuestion = [...mappingRun.mappings]
      .filter((m) => m.questionId !== null)
      .sort((a, b) => {
        const qa = questionById.get(a.questionId!);
        const qb = questionById.get(b.questionId!);
        return (qa?.sortKey.major ?? 0) - (qb?.sortKey.major ?? 0);
      });

    for (const mapping of byQuestion) {
      const question = questionById.get(mapping.questionId!);
      const answer = answerById.get(mapping.answerId);

      console.log(
        `  ${(question?.labelRaw ?? '?').padEnd(8)} <- answer ${mapping.answerId.slice(0, 8)}  ` +
          `${mapping.confidence.toFixed(3)} ${bandMark(mapping.confidenceBand)} ` +
          `${mapping.reasonCodes[0] ?? '-'}`,
      );
      console.log(
        `           claimed "${answer?.claimedLabelRaw ?? '(none)'}"  "${preview(answer?.text ?? '')}"`,
      );
    }

    const unmappedAnswers = mappingRun.mappings.filter((m) => m.questionId === null);

    if (unmappedAnswers.length > 0) {
      console.log('');
      console.log('--- unmapped answers ---');
      for (const mapping of unmappedAnswers) {
        const answer = answerById.get(mapping.answerId);
        console.log(
          `  answer ${mapping.answerId.slice(0, 8)}  claimed "${answer?.claimedLabelRaw ?? '(none)'}"  ` +
            `${mapping.reasonCodes.join(', ')}`,
        );
        console.log(`           "${preview(answer?.text ?? '')}"`);
      }
    }

    if (mappingRun.unmappedQuestionIds.length > 0) {
      console.log('');
      console.log('--- questions with no answer ---');
      console.log(
        `  ${mappingRun.unmappedQuestionIds
          .map((id) => questionById.get(id)?.labelRaw ?? id)
          .join(', ')}`,
      );
    }

    console.log('');
    console.log('--- boundary check ---');
    const serialised = JSON.stringify(final.answers);
    console.log(`  answers carry no questionId : ${!serialised.includes('questionId')}`);
    console.log(`  no grading in mappings      : ${!JSON.stringify(mappingRun.mappings).includes('awarded')}`);
    console.log('');
    console.log('smoke test completed.');
  } catch (error) {
    console.error('');
    console.error('smoke test failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    setAssessmentStore(null);
    setDocumentStorage(null);
    await rm(storageRoot, { recursive: true, force: true });
  }
}

void main();
