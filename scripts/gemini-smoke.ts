import '../workers/load-env';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { getEnv } from '../lib/config';
import { logger } from '../lib/logger';
import { LocalDocumentStorage, setDocumentStorage } from '../lib/storage/local-storage';
import { setAssessmentStore, InMemoryAssessmentStore } from '../lib/services/assessment-store';
import { createAssessment, getAssessment } from '../lib/services/assessment-service';
import { uploadDocument } from '../lib/services/document/document-service';
import { prepareAssessmentDocuments } from '../lib/services/document/document-preparation-service';
import { extractQuestions } from '../lib/services/question/question-extraction-service';
import { GeminiProvider } from '../lib/providers/ai';
import { A4_PORTRAIT, makePdf } from '../tests/fixtures/documents';

/**
 * Opt-in Gemini smoke test.
 *
 * Contacts the real API, so it is deliberately kept out of the normal suite:
 * CI must never depend on Gemini availability, quota or latency.
 *
 *   npm run smoke:gemini                 # generated one-page fixture
 *   npm run smoke:gemini -- paper.pdf    # a real question paper
 *
 * Requires GEMINI_API_KEY in .env.local. Prints a structured summary only —
 * never the key, never page data, never the prompt.
 */
async function main(): Promise<void> {
  const env = getEnv();

  if (!env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set. Add it to .env.local and try again.');
    process.exitCode = 1;
    return;
  }

  const inputPath = process.argv[2] ?? null;

  // Run entirely on throwaway state so the smoke test cannot disturb Redis
  // or the development document store.
  const storageRoot = await mkdtemp(join(tmpdir(), 'veda-smoke-'));
  const store = new InMemoryAssessmentStore();

  setAssessmentStore(store);
  setDocumentStorage(new LocalDocumentStorage(storageRoot));

  try {
    const data = inputPath
      ? await readFile(inputPath)
      : makePdf([A4_PORTRAIT]);

    const assessment = await createAssessment({ title: 'gemini smoke test' });

    await uploadDocument({
      assessmentId: assessment.id,
      type: 'QUESTION_PAPER',
      filename: inputPath ? inputPath.split(/[\\/]/).pop()! : 'generated-fixture.pdf',
      declaredMimeType: null,
      data,
    });

    console.log(`source        : ${inputPath ?? 'generated one-page fixture'}`);
    console.log(`bytes         : ${data.byteLength}`);

    await prepareAssessmentDocuments({
      assessmentId: assessment.id,
      jobId: 'smoke',
      logger,
    });

    const document = (await getAssessment(assessment.id)).documents[0]!;
    console.log(`pages prepared: ${document.pageCount}`);

    const provider = new GeminiProvider();
    console.log(`model         : ${provider.model}`);
    console.log('');
    console.log('calling Gemini...');

    const started = Date.now();
    const { questions, metadata } = await extractQuestions({
      assessmentId: assessment.id,
      jobId: 'smoke',
      logger,
      provider,
    });

    console.log('');
    console.log('--- extraction summary ---');
    console.log(`provider          : ${metadata.provider}`);
    console.log(`model             : ${metadata.model}`);
    console.log(`prompt version    : ${metadata.promptVersion}`);
    console.log(`pages processed   : ${metadata.pagesProcessed}`);
    console.log(`candidates        : ${metadata.candidatesReceived}`);
    console.log(`rejected          : ${metadata.candidatesRejected}`);
    console.log(`questions kept    : ${metadata.questionsExtracted}`);
    console.log(`elapsed           : ${Date.now() - started} ms`);

    if (metadata.usage) {
      console.log(
        `tokens            : prompt ${metadata.usage.promptTokens ?? '?'}, ` +
          `response ${metadata.usage.responseTokens ?? '?'}, ` +
          `total ${metadata.usage.totalTokens ?? '?'}`,
      );
    }

    if (metadata.warnings.length > 0) {
      console.log('');
      console.log('--- warnings ---');
      for (const warning of metadata.warnings) {
        console.log(`  [${warning.code}] ${warning.message}`);
      }
    }

    console.log('');
    console.log('--- questions ---');

    if (questions.length === 0) {
      console.log('  (none extracted)');
    }

    for (const question of questions) {
      const marks = question.marks === null ? '  -' : String(question.marks).padStart(3);
      const pages = question.pageNumbers.join(',');
      const text =
        question.text.length > 68 ? `${question.text.slice(0, 65)}...` : question.text;

      console.log(
        `  ${question.labelRaw.padEnd(10)} ${marks} marks  p${pages.padEnd(5)} ` +
          `[${question.normalizedLabel.padEnd(8)}] ${text}`,
      );

      for (const rect of question.rects) {
        console.log(
          `             page ${rect.pageNumber}  ` +
            `x=${rect.x.toFixed(3)} y=${rect.y.toFixed(3)} ` +
            `w=${rect.width.toFixed(3)} h=${rect.height.toFixed(3)}`,
        );
      }
    }

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
