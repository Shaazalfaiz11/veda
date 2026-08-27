/**
 * Proves the two halves of the highlight requirement that a page-1 answer
 * cannot: that clicking a question moves the viewer to the page the answer is
 * actually on, and that an answer spanning two pages is drawn on both.
 *
 *   PW_PATH=... node tools/demo-navigate.mjs <assessmentId> <outDir> <questionLabel>
 */
const PW = process.env.PW_PATH;
const { chromium } = await import(
  PW ? `file:///${PW.replace(/ /g, '%20')}/playwright/index.mjs` : 'playwright'
);

const [, , assessmentId, outDir, wanted] = process.argv;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

await page.goto(`http://localhost:3000/assessments/${assessmentId}/mapping`, {
  waitUntil: 'networkidle',
});
await page.waitForTimeout(5000);

const readPageIndicator = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('span, div, button')].find((n) =>
      /^Page \d+ of \d+$/.test((n.textContent || '').trim()),
    );
    return el ? el.textContent.trim() : 'not found';
  });

const before = await readPageIndicator();
console.log(`before click: ${before}`);

const card = page
  .locator('[class*="QuestionCard_card"]')
  .filter({ hasText: wanted })
  .first();

await card.scrollIntoViewIfNeeded();
console.log(`clicking: ${(await card.innerText()).split('\n').slice(0, 2).join(' | ')}`);
await card.click();
await page.waitForTimeout(2500);

const after = await readPageIndicator();
console.log(`after click:  ${after}`);

// Which pages carry a focused region, read off the DOM rather than assumed.
const pages = await page.evaluate(() => {
  const out = [];
  for (const stage of document.querySelectorAll('[data-page]')) {
    const n = stage.getAttribute('data-page');
    const hit = stage.querySelectorAll('[class*="overlayFocused"]').length;
    if (hit > 0) out.push(`page ${n}: ${hit} region(s)`);
  }
  return out;
});

console.log(pages.length ? pages.join('\n') : 'no focused regions');
await page.screenshot({ path: `${outDir}/navigate-${wanted.replace(/\W/g, '')}.png` });
await browser.close();
