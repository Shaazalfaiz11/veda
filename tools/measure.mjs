const PW = process.env.PW_PATH;
const { chromium } = await import(
  PW ? `file:///${PW.replace(/ /g, '%20')}/playwright/index.mjs` : 'playwright'
);

/**
 * Pixel-comparison harness for the Figma → code pass.
 *
 * Reads the on-screen box of named selectors and diffs them against the
 * measurements taken from the Figma frame. Eyeballing a screenshot catches
 * gross layout errors; this catches the 5px ones.
 *
 * Usage: node measure.mjs <url> <width> <height> <specFile>
 */
const [, , url, width, height, specFile] = process.argv;
const spec = JSON.parse(await (await import('node:fs/promises')).readFile(specFile, 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: 1,
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);

const TOL = 1.5;
let failures = 0;

for (const item of spec) {
  const box = await page
    .locator(item.selector)
    .first()
    .boundingBox()
    .catch(() => null);

  if (!box) {
    console.log(`MISSING  ${item.name}  (${item.selector})`);
    failures += 1;
    continue;
  }

  const parts = [];
  for (const key of ['x', 'y', 'width', 'height']) {
    if (item[key] === undefined) continue;
    const delta = box[key] - item[key];
    if (Math.abs(delta) > TOL) {
      parts.push(`${key} ${box[key].toFixed(1)} vs ${item[key]} (${delta > 0 ? '+' : ''}${delta.toFixed(1)})`);
    }
  }

  if (parts.length > 0) {
    console.log(`DRIFT    ${item.name}: ${parts.join(', ')}`);
    failures += 1;
  } else {
    console.log(`ok       ${item.name}`);
  }
}

await browser.close();
console.log(failures === 0 ? '\nAll measurements within 1.5px of Figma.' : `\n${failures} element(s) off.`);
process.exit(failures === 0 ? 0 : 1);
