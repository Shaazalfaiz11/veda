import '../workers/load-env';
import { GoogleGenAI } from '@google/genai';
import { getEnv } from '../lib/config';
import { classifyGeminiError } from '../lib/providers/ai';
import { isAppError } from '../lib/errors';

/**
 * One minimal Gemini call, to find out what the API currently says.
 *
 * Exists because a 429 is two different problems wearing the same status: a
 * per-minute burst limit that clears in seconds, and a per-day quota that does
 * not clear until tomorrow. Only the response body distinguishes them, and
 * running the whole pipeline to read one error message costs a stage's worth
 * of requests.
 *
 * The prompt is deliberately trivial — this is a reachability and quota check,
 * not an extraction.
 *
 *   npx tsx tools/gemini-probe.ts
 */
async function main(): Promise<void> {
  const env = getEnv();

  if (!env.GEMINI_API_KEY) {
    console.log('GEMINI_API_KEY is not set.');
    return;
  }

  console.log(`model   : ${env.GEMINI_MODEL}`);
  console.log(`key     : present (${env.GEMINI_API_KEY.length} chars, never printed)`);
  console.log('');

  const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const started = Date.now();

  try {
    const response = await client.models.generateContent({
      model: env.GEMINI_MODEL,
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
      config: { temperature: 0, maxOutputTokens: 16 },
    });

    console.log(`RESULT  : HTTP 200 in ${Date.now() - started} ms`);
    console.log(`reply   : ${JSON.stringify(response.text?.trim() ?? '')}`);
    console.log(`tokens  : ${JSON.stringify(response.usageMetadata ?? null)}`);
    console.log('');
    console.log('Quota is available. A failure in the pipeline is not a quota problem.');
  } catch (error) {
    const classified = classifyGeminiError(error, env.GEMINI_TIMEOUT_MS);
    const details = isAppError(classified) ? classified.details : undefined;

    // The classified detail is truncated for logging. A probe exists to read
    // the whole thing — the quota metric name is the answer, and it sits past
    // the cut.
    const rawMessage = error instanceof Error ? error.message : String(error);
    console.log('--- raw provider response ---');
    console.log(rawMessage.slice(0, 2000));
    console.log('-----------------------------');
    console.log('');

    console.log(`RESULT  : FAILED in ${Date.now() - started} ms`);
    console.log(`code    : ${isAppError(classified) ? classified.code : 'UNKNOWN'}`);
    console.log(`message : ${classified.message}`);
    console.log(`details : ${JSON.stringify(details, null, 2)}`);
    console.log('');

    const raw = JSON.stringify(details ?? {});

    if (raw.includes('PerDay') || /quota.*day|daily/i.test(raw)) {
      console.log('READING : a PER-DAY quota. Waiting will not help until it resets.');
    } else if (raw.includes('PerMinute') || /per minute|retryDelay/i.test(raw)) {
      console.log('READING : a PER-MINUTE burst limit. It clears on its own shortly.');
    } else if (raw.includes('"status": 429')) {
      console.log('READING : rate limited, but the body does not say which window.');
    } else if (raw.includes('"status": 50')) {
      console.log('READING : a server-side error on Google. Transient; retry.');
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
