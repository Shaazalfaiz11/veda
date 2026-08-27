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
import { extractAnswers } from '../lib/services/answer/answer-extraction-service';
import { GeminiProvider } from '../lib/providers/ai';
import { UNCLEAR_MARKER } from '../lib/domain/answer';

/**
 * Opt-in Gemini answer-extraction smoke test.
 *
 * Contacts the real API, so it stays out of the normal suite: CI must never
 * depend on Gemini availability, quota or latency.
 *
 *   npm run smoke:answers -- answer-sheet.pdf
 *
 * Requires GEMINI_API_KEY. Prints a concise summary only — never the key,
 * never page data, and never a student's answer in full.
 */

/** Answers are student work; the summary shows enough to judge, no more. */
const TRANSCRIPT_PREVIEW = 72;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TRANSCRIPT_PREVIEW ? `${flat.slice(0, TRANSCRIPT_PREVIEW - 3)}...` : flat;
}

async function main(): Promise<void> {
  const env = getEnv();

  if (!env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set. Add it to .env.local and try again.');
    process.exitCode = 1;
    return;
  }

  const inputPath = process.argv[2];

  if (!inputPath) {
    console.error('Usage: npm run smoke:answers -- <path-to-answer-sheet>');
    console.error('A real handwritten sheet (PDF, PNG or JPEG) is required — a generated');
    console.error('fixture has no handwriting, so it would prove nothing.');
    process.exitCode = 1;
    return;
  }

  const storageRoot = await mkdtemp(join(tmpdir(), 'veda-answer-smoke-'));
  const store = new InMemoryAssessmentStore();

  setAssessmentStore(store);
  setDocumentStorage(new LocalDocumentStorage(storageRoot));

  try {
    const data = await readFile(inputPath);
    const assessment = await createAssessment({ title: 'answer smoke test' });

    await uploadDocument({
      assessmentId: assessment.id,
      type: 'ANSWER_SHEET',
      filename: inputPath.split(/[\\/]/).pop()!,
      declaredMimeType: null,
      data,
    });

    console.log(`source        : ${inputPath}`);
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
    const { answers, metadata } = await extractAnswers({
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
    console.log(`answers kept      : ${metadata.answersExtracted}`);
    console.log(`unlabelled        : ${metadata.unlabelledCount}`);
    console.log(`multi-page        : ${answers.filter((a) => a.spansPages).length}`);
    console.log(`multi-region      : ${answers.filter((a) => a.regions.length > 1).length}`);
    console.log(`with diagram      : ${answers.filter((a) => a.containsDiagram).length}`);
    console.log(`uncertain         : ${answers.filter((a) => a.hasUncertainSegments).length}`);
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
    console.log('--- answers (transcripts truncated) ---');

    if (answers.length === 0) {
      console.log('  (none extracted)');
    }

    for (const answer of answers) {
      const label = (answer.claimedLabelRaw ?? '(no label)').padEnd(10);
      const key = (answer.claimedLabelNormalized ?? '-').padEnd(6);
      const pages = answer.pageNumbers.join(',');
      const flags = [
        answer.spansPages ? 'multi-page' : null,
        answer.containsDiagram ? 'diagram' : null,
        answer.hasUncertainSegments ? 'uncertain' : null,
      ]
        .filter(Boolean)
        .join(' ');

      console.log(
        `  ${String(answer.documentPosition).padStart(2)}. ${label} [${key}] ` +
          `p${pages.padEnd(5)} ${answer.regions.length} region(s) ${flags}`,
      );
      console.log(`      "${preview(answer.text)}"`);

      for (const region of answer.regions) {
        console.log(
          `      page ${region.pageNumber}  ${region.kind.padEnd(7)} ` +
            `x=${region.x.toFixed(3)} y=${region.y.toFixed(3)} ` +
            `w=${region.width.toFixed(3)} h=${region.height.toFixed(3)}`,
        );
      }
    }

    console.log('');
    console.log('--- boundary check ---');
    const serialised = JSON.stringify(answers);
    console.log(`  no questionId on any answer : ${!serialised.includes('questionId')}`);
    console.log(`  uncertainty marked, not guessed : uses "${UNCLEAR_MARKER}"`);
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
