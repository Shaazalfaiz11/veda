import sharp from 'sharp';

/**
 * Document fixtures.
 *
 * Generated at test time rather than committed as binaries, so the suite has
 * no opaque blobs and every fixture's geometry is stated in the test that
 * uses it.
 */

export interface PdfPageSpec {
  width: number;
  height: number;
}

/**
 * Builds a minimal but structurally valid PDF with one text run per page.
 * Written by hand so the fixture has no dependency of its own and the byte
 * offsets in the xref table are known to be correct.
 */
export function makePdf(pages: PdfPageSpec[]): Buffer {
  if (pages.length === 0) throw new Error('A PDF fixture needs at least one page.');

  const objects: string[] = [];
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ');

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`,
  );
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  pages.forEach((page, index) => {
    const content = `BT /F1 24 Tf 50 ${page.height - 80} Td (Page ${index + 1}) Tj ET`;

    objects.push(
      `${4 + index * 2} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${page.width} ${page.height}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> ` +
        `/Contents ${5 + index * 2} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${5 + index * 2} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    );
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;

  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** A4 portrait, in PDF points. */
export const A4_PORTRAIT: PdfPageSpec = { width: 595, height: 842 };
export const A4_LANDSCAPE: PdfPageSpec = { width: 842, height: 595 };

/**
 * Carries a valid PDF signature but a corrupt body — exactly the case where
 * magic-byte sniffing passes and only real parsing catches the problem.
 */
export function makeMalformedPdf(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from('this is not a page tree, xref table or trailer\n'.repeat(8), 'latin1'),
  ]);
}

export async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 250, g: 250, b: 248 } },
  })
    .png()
    .toBuffer();
}

export async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 240, g: 235, b: 225 } },
  })
    .jpeg()
    .toBuffer();
}

/**
 * A JPEG whose EXIF orientation says the display axes are swapped — what a
 * phone produces when a page is photographed sideways.
 */
export async function makeRotatedJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 30 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

/** A PNG with an alpha channel, to prove transparency flattens to white. */
export async function makeTransparentPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
}

/** Bytes that match no supported signature. */
export function makeGarbage(bytes = 64): Buffer {
  return Buffer.alloc(bytes, 0x7a);
}

/** Builds a File suitable for a multipart FormData upload. */
export function asFile(data: Buffer, filename: string, mimeType: string): File {
  return new File([new Uint8Array(data)], filename, { type: mimeType });
}
