/** Renders one page of a PDF to a PNG so it can be eyeballed. */
import '../workers/load-env';
import { readFileSync, writeFileSync } from 'node:fs';
import { openPdf } from '../lib/services/document/pdf-preparation';

async function main(): Promise<void> {
  const [input, pageArg, out, dimArg] = process.argv.slice(2);

  if (!input || !out) {
    throw new Error('usage: peek-pdf.ts <in.pdf> <pageNumber> <out.png> [maxDim]');
  }

  const pdf = await openPdf(readFileSync(input));
  const page = await pdf.renderPage(
    Number.parseInt(pageArg ?? '1', 10),
    Number.parseInt(dimArg ?? '2000', 10),
  );
  writeFileSync(out, page.data);
  console.log(`${input} p${pageArg}: ${page.width}x${page.height} scale=${page.scale}`);
  await pdf.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
