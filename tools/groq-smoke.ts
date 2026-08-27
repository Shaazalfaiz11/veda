import '../workers/load-env';
import { readFile } from 'node:fs/promises';
import { getEnv } from '../lib/config';
import { GroqProvider } from '../lib/providers/ai';
import { isAppError } from '../lib/errors';
import type { PageImage } from '../lib/providers/ai';

/**
 * The smallest real Groq call that exercises the whole provider path:
 * page bitmap → Groq → strict JSON → the existing Zod validation → domain
 * candidates.
 *
 * Deliberately tiny. The point is to prove the path works before spending
 * requests on a full paper, so it takes a couple of pages and stops.
 *
 *   npx tsx tools/groq-smoke.ts answers <page.png> [more.png...]
 *   npx tsx tools/groq-smoke.ts questions <page.png> [more.png...]
 */
async function main(): Promise<void> {
  const env = getEnv();
  const [mode, ...paths] = process.argv.slice(2);

  if (mode !== 'answers' && mode !== 'questions') {
    console.error('Usage: npx tsx tools/groq-smoke.ts <answers|questions> <page.png>...');
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    console.error('Give at least one page image.');
    process.exitCode = 1;
    return;
  }

  const provider = new GroqProvider();

  console.log(`provider : ${provider.name}`);
  console.log(`model    : ${provider.model}`);
  console.log(`mode     : ${mode}`);
  console.log(`pages    : ${paths.length} (limit ${env.GROQ_MAX_IMAGES_PER_REQUEST})`);
  console.log('');

  const pages: PageImage[] = [];

  for (const [index, path] of paths.entries()) {
    const data = await readFile(path);
    pages.push({
      pageNumber: index + 1,
      data: data.toString('base64'),
      mimeType: 'image/png',
      width: 0,
      height: 0,
    });
    console.log(`  page ${index + 1}: ${path} (${Math.round(data.length / 1024)}KB)`);
  }

  console.log('');
  const started = Date.now();

  try {
    if (mode === 'answers') {
      const result = await provider.extractAnswers(pages);

      console.log(`RESULT   : ${result.candidates.length} answers in ${Date.now() - started} ms`);
      console.log(`usage    : ${JSON.stringify(result.usage)}`);
      console.log('');

      for (const [i, candidate] of result.candidates.entries()) {
        const pagesOn = [...new Set(candidate.regions.map((r) => r.pageNumber))].join(',');
        const kinds = [...new Set(candidate.regions.map((r) => r.kind))].join('/');
        console.log(`  [${i}] label=${String(candidate.claimedLabelRaw)} pages=${pagesOn} ${kinds}`);
        console.log(`      ${candidate.text.replace(/\s+/g, ' ').slice(0, 150)}`);
      }
    } else {
      const result = await provider.extractQuestions(pages);

      console.log(`RESULT   : ${result.candidates.length} questions in ${Date.now() - started} ms`);
      console.log(`usage    : ${JSON.stringify(result.usage)}`);
      console.log('');

      for (const candidate of result.candidates.slice(0, 12)) {
        console.log(
          `  ${candidate.labelRaw || '(none)'} marks=${candidate.marks} p${candidate.pageNumber}` +
            `  ${candidate.text.replace(/\s+/g, ' ').slice(0, 90)}`,
        );
      }
    }

    console.log('');
    console.log('Groq -> strict JSON -> validation -> domain candidates: OK');
  } catch (error) {
    console.log(`FAILED   : after ${Date.now() - started} ms`);
    console.log(`code     : ${isAppError(error) ? error.code : 'UNKNOWN'}`);
    console.log(`message  : ${error instanceof Error ? error.message : String(error)}`);
    console.log(`detail   : ${JSON.stringify(isAppError(error) ? error.details : undefined)}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
