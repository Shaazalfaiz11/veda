const PW = process.env.PW_PATH;
const { chromium } = await import(
  PW ? `file:///${PW.replace(/ /g, '%20')}/playwright/index.mjs` : 'playwright'
);

/**
 * Drives the real upload → process → poll flow in a browser.
 *
 * No stubs: it clicks the actual UI, which posts to the actual routes, which
 * enqueue an actual job that an actual worker picks up. What it prints is
 * every stage transition the status endpoint reported, in order.
 *
 *   node tools/e2e-processing.mjs <baseUrl> <outDir>
 */
const base = process.argv[2] ?? 'http://localhost:3000';
const outDir = process.argv[3] ?? '.';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 788 } });

page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text());
});

const seen = [];
page.on('response', async (response) => {
  if (!response.url().includes('/status')) return;
  try {
    const body = await response.json();
    const key = `${body.status}/${body.stage ?? '-'}`;
    if (seen[seen.length - 1] !== key) {
      seen.push(key);
      console.log(`  status -> ${key}  progress=${body.progress}`);
    }
  } catch {
    /* a non-JSON response is not a transition */
  }
});

console.log('1. opening upload screen');
await page.goto(base, { waitUntil: 'networkidle' });

console.log('2. uploading both documents');
// Each pane drops its input once filled, so fill the second one first.
await page.locator('input[type=file]').nth(1).setInputFiles('fixtures/answer-sheet.pdf');
await page.locator('input[type=file]').nth(0).setInputFiles('fixtures/question-paper.pdf');

await page.waitForFunction(
  () => !document.querySelector('button:disabled[class*="PrimaryButton"]'),
  null,
  { timeout: 30000 },
);

console.log('3. clicking Start Mapping');
await page.getByRole('button', { name: /Start Mapping/i }).click();

await page.waitForURL(/\/processing$/, { timeout: 30000 });
const assessmentId = page.url().match(/assessments\/([0-9a-f-]{36})\//)?.[1];
console.log(`4. landed on /processing for ${assessmentId}`);

// Watch until the run settles, or we run out of patience.
const settled = await page
  .waitForFunction(
    () => {
      const t = document.body.innerText;
      return t.includes('Processing failed') || location.pathname.endsWith('/mapping');
    },
    null,
    { timeout: 180000 },
  )
  .then(() => true)
  .catch(() => false);

await page.screenshot({ path: `${outDir}/e2e-final.png`, animations: 'disabled' });

console.log('');
console.log('transitions observed:');
for (const entry of seen) console.log(`  ${entry}`);
console.log('');
console.log(`final url : ${page.url()}`);
console.log(`settled   : ${settled}`);

await browser.close();
