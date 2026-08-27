/**
 * Drives the mapping screen the way a teacher does: find a question that has a
 * mapped answer, click it, and capture what the viewer does. Exists because
 * "clicking a question highlights the exact answer region" is the behaviour the
 * assignment is judged on, and only a real browser can show whether it happens.
 *
 *   PW_PATH=... node tools/demo-click.mjs <assessmentId> <outDir>
 */
const PW = process.env.PW_PATH;
const { chromium } = await import(
  PW ? `file:///${PW.replace(/ /g, '%20')}/playwright/index.mjs` : 'playwright'
);

const [, , assessmentId, outDir] = process.argv;
const base = 'http://localhost:3000';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

await page.goto(`${base}/assessments/${assessmentId}/mapping`, { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);

const cards = page.locator('[class*="card"]');
const total = await cards.count();
console.log(`question cards: ${total}`);

// The first card without the "No answer mapped" tag is the first question the
// mapper actually resolved.
let target = -1;
for (let i = 0; i < total; i += 1) {
  const text = await cards.nth(i).innerText();
  if (!text.includes('No answer mapped')) { target = i; break; }
}

if (target === -1) {
  console.log('FAIL: every card says "No answer mapped"');
  await browser.close();
  process.exit(1);
}

const label = (await cards.nth(target).innerText()).split('\n').slice(0, 2).join(' | ');
console.log(`clicking card ${target}: ${label}`);

await page.screenshot({ path: `${outDir}/before-click.png` });

await cards.nth(target).click();
await page.waitForTimeout(2000);

const pageLabel = await page.locator('text=/Page \d+ of \d+/').first().innerText().catch(() => '?');
console.log(`viewer now shows: ${pageLabel}`);

const focused = await page.locator('[class*="overlayFocused"]').count();
const dimmed = await page.locator('[class*="overlayDim"]').count();
console.log(`focused overlays: ${focused}, dimmed overlays: ${dimmed}`);

await page.screenshot({ path: `${outDir}/after-click.png` });

await browser.close();
console.log(focused > 0 ? 'PASS: an answer region is highlighted' : 'FAIL: nothing highlighted');
