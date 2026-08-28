import type { PdfPageSpec } from './documents';

export interface PdfTextPage extends PdfPageSpec {
  lines: string[];
}

/**
 * A PDF whose pages carry real printed text.
 *
 * `makePdf` produces a structurally valid file with a placeholder line, which
 * is all most tests need. This one is for the cases where the fixture has to
 * be *readable* — a model extracting questions from it has to find something
 * to extract.
 *
 * Written by hand, like its sibling, so the byte offsets in the xref table
 * are known to be right and the fixture pulls in no dependency of its own.
 */
export function makePdfWithLines(pages: PdfTextPage[]): Buffer {
  if (pages.length === 0) throw new Error('A PDF fixture needs at least one page.');

  const objects: string[] = [];
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ');

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  pages.forEach((page, index) => {
    let y = page.height - 60;
    let content = '';

    for (const line of page.lines) {
      if (line) content += `BT /F1 11 Tf 55 ${y} Td (${escapePdfText(line)}) Tj ET\n`;
      y -= 19;
    }

    objects.push(
      `${4 + index * 2} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${page.width} ${page.height}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> ` +
        `/Contents ${5 + index * 2} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${5 + index * 2} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
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

/** Backslash and parentheses are structural inside a PDF string literal. */
function escapePdfText(text: string): string {
  const backslash = String.fromCharCode(92);

  return text
    .split(backslash)
    .join(backslash + backslash)
    .split('(')
    .join(backslash + '(')
    .split(')')
    .join(backslash + ')');
}
