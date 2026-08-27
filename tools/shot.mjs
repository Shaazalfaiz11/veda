const PW = process.env.PW_PATH;
const { chromium } = await import(
  PW ? `file:///${PW.replace(/ /g, '%20')}/playwright/index.mjs` : 'playwright'
);

/**
 * Screenshot helper for the Figma comparison pass.
 *
 * Usage: node shot.mjs <url> <out.png> <width> <height> [waitSelector]
 */
const [, , url, out, width, height, waitSelector] = process.argv;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: 1,
});

await page.goto(url, { waitUntil: 'networkidle' });

if (waitSelector) {
  // A `text=` prefix waits for the string to appear anywhere on the page,
  // which is how a polled screen signals that its first response has landed.
  if (waitSelector.startsWith('text=')) {
    const needle = waitSelector.slice(5);
    await page
      .waitForFunction((t) => document.body.innerText.includes(t), needle, { timeout: 20000 })
      .catch(() => console.log(`WARN: never saw "${needle}"`));
  } else {
    await page.waitForSelector(waitSelector, { timeout: 20000 }).catch(() => {});
  }
}

// Let webfonts settle so text metrics match the design.
await page.evaluate(() => document.fonts.ready);

// And wait for every image to actually decode. `networkidle` only proves the
// bytes arrived; a large page bitmap can still be undecoded when the shutter
// fires, which shows up as an empty viewer rather than a missing file.
await page
  .waitForFunction(
    () => [...document.images].every((i) => i.complete && i.naturalWidth > 0),
    null,
    { timeout: 20000 },
  )
  .catch(() => console.log('WARN: some images never decoded'));

await page.waitForTimeout(500);

// Freeze CSS animations so a loading screen screenshots deterministically
// at its first frame, which is the frame the design shows.
await page.screenshot({ path: out, animations: 'disabled' });
await browser.close();
console.log(`wrote ${out}`);
