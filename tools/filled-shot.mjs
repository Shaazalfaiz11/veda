const PW = process.env.PW_PATH;
const { chromium } = await import(
  PW ? `file:///${PW.replace(/ /g, '%20')}/playwright/index.mjs` : 'playwright'
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 787 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()); });

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

// Each pane drops its file input once filled, so the second pane must be
// filled first — otherwise nth(1) no longer exists by the time we reach it.
await page.locator('input[type=file]').nth(1).setInputFiles('fixtures/answer-sheet.pdf');
await page.locator('input[type=file]').nth(0).setInputFiles('fixtures/question-paper.pdf');

// Wait for both page counts to come back from the server.
await page.waitForFunction(
  () => document.body.innerText.match(/Pages/g)?.length === 2,
  null,
  { timeout: 30000 },
).catch(() => console.log('WARN: page counts did not both arrive'));

await page.waitForTimeout(400);
await page.screenshot({ path: process.argv[2] });
console.log('body text:', await page.locator('[class*="tray"]').innerText());
await browser.close();
