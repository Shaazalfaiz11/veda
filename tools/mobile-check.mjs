/**
 * Exercises the mobile interactions responsiveness must not break: the drawer
 * opens and closes, a question still selects its answer, and the highlight
 * overlay still lands on the same part of the page after a resize.
 */
const PW = process.env.PW_PATH;
const { chromium } = await import(
  PW ? `file:///${PW.replace(/ /g, '%20')}/playwright/index.mjs` : 'playwright'
);

const id = process.argv[2];
const out = process.argv[3];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 850 } });

await page.goto(`http://localhost:3000/assessments/${id}/mapping`, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

// --- drawer -------------------------------------------------------------
await page.locator('button[aria-label="Open menu"]').click();
await page.waitForTimeout(500);
const drawerOpen = await page.locator('[role="dialog"]').count();
const drawerBox = await page.locator('[role="dialog"]').boundingBox();
await page.screenshot({ path: `${out}/mobile-drawer.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const drawerClosed = (await page.locator('[role="dialog"]').count()) === 0;
console.log(`drawer: opens=${drawerOpen === 1} width=${Math.round(drawerBox?.width ?? 0)} closesOnEscape=${drawerClosed}`);

// --- question -> answer, on a phone -------------------------------------
const card = page.locator('[class*="QuestionCard_card"]').filter({ hasText: 'mode of the distribution' }).first();
await card.scrollIntoViewIfNeeded();
await card.click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/mobile-questions.png` });

// The phone layout hides the viewer behind the Answers tab.
await page.locator('button', { hasText: 'Answers' }).first().click();
await page.waitForTimeout(1800);
await page.screenshot({ path: `${out}/mobile-answer.png` });

// --- highlight alignment across a resize --------------------------------
const readOverlay = () =>
  page.evaluate(() => {
    const stage = document.querySelector('[data-page="5"]');
    const el = stage?.querySelector('[class*="overlayFocused"]');
    if (!stage || !el) return null;
    const s = stage.getBoundingClientRect();
    const o = el.getBoundingClientRect();
    // Position as a fraction of the page stage: this is the number that must
    // survive a resize, not the pixel box.
    return {
      x: +((o.left - s.left) / s.width).toFixed(4),
      y: +((o.top - s.top) / s.height).toFixed(4),
      w: +(o.width / s.width).toFixed(4),
      h: +(o.height / s.height).toFixed(4),
    };
  });

const atPhone = await readOverlay();
await page.setViewportSize({ width: 1440, height: 950 });
await page.waitForTimeout(1500);
const atDesktop = await readOverlay();

console.log('overlay @390 :', JSON.stringify(atPhone));
console.log('overlay @1440:', JSON.stringify(atDesktop));

if (atPhone && atDesktop) {
  const drift = Math.max(
    Math.abs(atPhone.x - atDesktop.x), Math.abs(atPhone.y - atDesktop.y),
    Math.abs(atPhone.w - atDesktop.w), Math.abs(atPhone.h - atDesktop.h),
  );
  console.log(`alignment drift: ${drift.toFixed(5)} -> ${drift < 0.005 ? 'ALIGNED' : 'DRIFTED'}`);
} else {
  console.log('alignment: overlay not found at one of the sizes');
}

await browser.close();
