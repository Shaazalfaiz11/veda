/**
 * Slices the first N pages of a PDF into a new, smaller PDF.
 *
 * Exists so the demo can run on a 5-page pair without hand-editing PDFs: the
 * source papers are 10-18 pages, and every extra page is another paced vision
 * request. Pages are rasterised through the same pdf.js path the pipeline
 * uses, then re-wrapped as JPEG image pages — the pipeline rasterises anyway,
 * so nothing downstream can tell the difference.
 *
 *   npx tsx tools/slice-pdf.ts <in.pdf> <out.pdf> <pageCount> [maxDim] [firstPage]
 */
import '../workers/load-env';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { openPdf } from '../lib/services/document/pdf-preparation';

interface JpegPage {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Wraps JPEG pages into a PDF using DCTDecode image XObjects. */
function buildPdf(pages: JpegPage[]): Buffer {
  const chunks: Buffer[] = [];
  let length = 0;

  const push = (value: string | Buffer): void => {
    const buffer = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
    chunks.push(buffer);
    length += buffer.length;
  };

  push('%PDF-1.4\n');

  const offsets: number[] = [0];
  const writers: Array<() => void> = [];
  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ');

  writers.push(() => push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
  writers.push(() =>
    push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`),
  );

  pages.forEach((page, index) => {
    const pageObj = 3 + index * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;
    const content = `q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`;

    writers.push(() =>
      push(
        `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
          `/MediaBox [0 0 ${page.width} ${page.height}] ` +
          `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> ` +
          `/Contents ${contentObj} 0 R >>\nendobj\n`,
      ),
    );
    writers.push(() => {
      push(
        `${imageObj} 0 obj\n<< /Type /XObject /Subtype /Image ` +
          `/Width ${page.width} /Height ${page.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
          `/Length ${page.jpeg.length} >>\nstream\n`,
      );
      push(page.jpeg);
      push('\nendstream\nendobj\n');
    });
    writers.push(() =>
      push(
        `${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
      ),
    );
  });

  for (const write of writers) {
    offsets.push(length);
    write();
  }

  const xref = length;
  push(`xref\n0 ${writers.length + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= writers.length; i += 1) {
    push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${writers.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const [input, output, countArg, dimArg, firstArg] = process.argv.slice(2);

  if (!input || !output) {
    throw new Error('usage: slice-pdf.ts <in.pdf> <out.pdf> <pageCount> [maxDim] [firstPage]');
  }

  const wanted = Number.parseInt(countArg ?? '5', 10);
  const maxDim = Number.parseInt(dimArg ?? '1600', 10);
  const first = Math.max(1, Number.parseInt(firstArg ?? '1', 10));
  const pdf = await openPdf(readFileSync(input));

  console.log(`${input}: ${pdf.pageCount} pages`);

  const last = Math.min(first + wanted - 1, pdf.pageCount);
  const take = Math.max(0, last - first + 1);
  const pages: JpegPage[] = [];

  for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
    const rendered = await pdf.renderPage(pageNumber, maxDim);
    const jpeg = await sharp(rendered.data).jpeg({ quality: 80 }).toBuffer();
    pages.push({ jpeg, width: rendered.width, height: rendered.height });
    console.log(`  page ${pageNumber}: ${rendered.width}x${rendered.height} -> ${(jpeg.length / 1024).toFixed(0)}KB`);
  }

  await pdf.close();

  mkdirSync(dirname(output), { recursive: true });
  const out = buildPdf(pages);
  writeFileSync(output, out);
  console.log(
    `wrote ${output}: ${take} pages (source ${first}-${last}), ${(out.length / 1024 / 1024).toFixed(2)}MB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
