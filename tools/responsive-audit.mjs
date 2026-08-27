/**
 * Measures horizontal overflow and clipped controls on every route, at every
 * width the assignment names. Reports rather than guesses: an element wider
 * than the viewport is named, so the fix can be aimed at it.
 *
 *   PW_PATH=... node tools/responsive-audit.mjs <assessmentId>
 */
const PW = process.env.PW_PATH;
const { chromium } = await import(
  PW ? `file:///${PW.replace(/ /g, '%20')}/playwright/index.mjs` : 'playwright'
);

const id = process.argv[2];
// A completed assessment redirects straight off the processing route, so
// measuring it there catches a half-torn-down page. Pass an assessment that
// stays on it -- a failed one also exercises the error state's wrapping.
const processingId = process.argv[3] ?? id;
const base = 'http://localhost:3000';

const ROUTES = [
  ['upload', `${base}/`],
  ['processing', `${base}/assessments/${processingId}/processing`],
  ['mapping', `${base}/assessments/${id}/mapping`],
];

const WIDTHS = [320, 360, 375, 390, 414, 768, 820, 1024, 1280, 1366, 1440, 1600, 1920, 2560];

const browser = await chromium.launch();
const problems = [];

for (const [name, url] of ROUTES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(350);

    const r = await page.evaluate((vw) => {
      const doc = document.documentElement;
      const offenders = [];

      if (doc.scrollWidth > doc.clientWidth + 1) {
        for (const el of document.querySelectorAll('*')) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          // Only blame elements that actually stick out of the viewport and
          // are not inside something that scrolls on purpose.
          if (box.right > vw + 1 || box.left < -1) {
            let scrollableAncestor = false;
            for (let p = el.parentElement; p; p = p.parentElement) {
              const ox = getComputedStyle(p).overflowX;
              if (ox === 'auto' || ox === 'scroll') { scrollableAncestor = true; break; }
            }
            if (scrollableAncestor) continue;
            offenders.push({
              tag: el.tagName.toLowerCase(),
              cls: (typeof el.className === 'string' ? el.className : '').slice(0, 55),
              right: Math.round(box.right),
              w: Math.round(box.width),
            });
          }
        }
      }

      // Controls too small to tap reliably.
      const tiny = [...document.querySelectorAll('button, a[href]')].filter((b) => {
        const box = b.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && (box.height < 32 || box.width < 32);
      }).length;

      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        offenders: offenders.slice(0, 4),
        tiny,
      };
    }, width);

    const overflow = r.scrollWidth - r.clientWidth;
    if (overflow > 1 || (width <= 414 && r.tiny > 0)) {
      problems.push({ route: name, width, overflow, tiny: r.tiny, offenders: r.offenders });
    }
  }

  await page.close();
}

if (problems.length === 0) {
  console.log('CLEAN: no horizontal overflow at any tested width.');
} else {
  for (const p of problems) {
    console.log(`${p.route} @ ${p.width}px  overflow=${p.overflow}px  smallControls=${p.tiny}`);
    for (const o of p.offenders) console.log(`     ${o.tag}.${o.cls} right=${o.right} w=${o.w}`);
  }
}

await browser.close();
