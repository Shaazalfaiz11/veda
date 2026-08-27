import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

/**
 * Builds a two-page handwritten answer sheet for the Gemini smoke test.
 *
 *   npm run make:answer-sheet          # writes fixtures/answer-sheet.pdf
 *   npm run smoke:answers -- fixtures/answer-sheet.pdf
 *
 * It exists because a text PDF proves nothing about handwriting extraction,
 * and a real student sheet cannot be committed. Rendered in a handwriting
 * face on ruled paper with a red margin, it is close enough to a scan to
 * exercise the real path.
 *
 * It deliberately contains every awkward case Phase 4 has to survive:
 *   - answers written out of order (Q3 first, then Q1)
 *   - an answer with no label at all
 *   - an answer made of text plus a drawn diagram
 *   - an answer that runs off the bottom of page 1 and continues on page 2
 *   - a teacher's tick, which is not student work
 */
const W = 1240;
const H = 1754;
const MARGIN_X = 150;
const HAND = '"Ink Free", "Bradley Hand ITC", "Comic Sans MS", cursive';

function paper(ctx: SKRSContext2D): void {
  ctx.fillStyle = '#fdfcf7';
  ctx.fillRect(0, 0, W, H);

  // Ruled lines.
  ctx.strokeStyle = '#cdd7e4';
  ctx.lineWidth = 1.5;
  for (let y = 150; y < H - 60; y += 46) {
    ctx.beginPath();
    ctx.moveTo(70, y);
    ctx.lineTo(W - 70, y);
    ctx.stroke();
  }

  // Red margin rule.
  ctx.strokeStyle = '#d9737a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(MARGIN_X - 24, 60);
  ctx.lineTo(MARGIN_X - 24, H - 60);
  ctx.stroke();
}

function label(ctx: SKRSContext2D, text: string, y: number): void {
  ctx.fillStyle = '#22314a';
  ctx.font = `36px ${HAND}`;
  ctx.fillText(text, 78, y);
}

function lines(ctx: SKRSContext2D, rows: string[], y: number, size = 30): number {
  ctx.fillStyle = '#22314a';
  ctx.font = `${size}px ${HAND}`;

  let cursor = y;
  for (const row of rows) {
    ctx.fillText(row, MARGIN_X, cursor);
    cursor += 46;
  }
  return cursor;
}

/** A hand-drawn photosynthesis diagram: stem, leaves, arrows, labels. */
function diagram(ctx: SKRSContext2D, cx: number, cy: number): void {
  ctx.strokeStyle = '#22314a';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(cx, cy + 90);
  ctx.lineTo(cx, cy - 40);
  ctx.stroke();

  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * 52, cy - 10, 46, 20, side * 0.4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Sun.
  ctx.beginPath();
  ctx.arc(cx + 190, cy - 90, 26, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + 190 + Math.cos(a) * 34, cy - 90 + Math.sin(a) * 34);
    ctx.lineTo(cx + 190 + Math.cos(a) * 48, cy - 90 + Math.sin(a) * 48);
    ctx.stroke();
  }

  const arrow = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const a = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 12 * Math.cos(a - 0.4), y2 - 12 * Math.sin(a - 0.4));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 12 * Math.cos(a + 0.4), y2 - 12 * Math.sin(a + 0.4));
    ctx.stroke();
  };

  arrow(cx + 150, cy - 60, cx + 80, cy - 20);
  arrow(cx - 150, cy - 10, cx - 100, cy - 10);
  arrow(cx + 20, cy + 70, cx + 20, cy + 20);

  ctx.font = `24px ${HAND}`;
  ctx.fillStyle = '#22314a';
  ctx.fillText('Sunlight', cx + 150, cy - 80);
  ctx.fillText('Carbon dioxide', cx - 300, cy - 16);
  ctx.fillText('Water', cx - 20, cy + 100);
  ctx.fillText('Oxygen', cx + 90, cy + 40);
}

function pageOne(): Buffer {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  paper(ctx);

  // Out of order: Q3 answered first.
  label(ctx, 'Q3.', 210);
  lines(
    ctx,
    [
      'Photosynthesis is the process used by green plants',
      'and some other organisms to convert light energy',
      'into chemical energy.',
      '6CO2 + 6H2O  --light-->  C6H12O6 + 6O2',
    ],
    210,
  );

  // No label at all, clearly separated, and plainly a different question:
  // the student simply forgot to write the number.
  lines(
    ctx,
    [
      'Arteries carry blood away from the heart, while veins',
      'carry blood back towards it.',
    ],
    560,
  );

  // Text plus a drawn diagram.
  label(ctx, 'Q2.', 700);
  lines(ctx, ['Sunlight enters the leaf and is absorbed by chlorophyll.'], 700);
  diagram(ctx, 560, 900);

  // Runs off the bottom of the page.
  label(ctx, 'Q5.', 1330);
  lines(
    ctx,
    [
      'The human heart has four chambers. Blood from the',
      'body enters the right atrium and then passes',
    ],
    1330,
  );

  // A teacher mark, which is not student work.
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(1080, 250);
  ctx.lineTo(1105, 280);
  ctx.lineTo(1150, 205);
  ctx.stroke();

  return canvas.toBuffer('image/jpeg', 92);
}

function pageTwo(): Buffer {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  paper(ctx);

  // Continuation of Q5 — no label, opens mid-sentence.
  lines(
    ctx,
    [
      'into the right ventricle. From there it is pumped to',
      'the lungs to collect oxygen, returns to the left atrium,',
      'and is finally pushed out through the aorta.',
    ],
    200,
  );

  label(ctx, 'Q1.', 430);
  lines(ctx, ['The chloroplast is the organelle responsible.'], 430);

  label(ctx, 'Q7.', 600);
  lines(
    ctx,
    [
      'Osmosis is the movement of water across a',
      'semi-permeable membrane from a dilute to a',
      'concentrated solution.',
    ],
    600,
  );

  return canvas.toBuffer('image/jpeg', 92);
}

/** Wraps JPEG pages into a PDF using DCTDecode image XObjects. */
function buildPdf(pages: Buffer[]): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [0];
  let length = 0;

  const push = (data: Buffer | string) => {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    chunks.push(buffer);
    length += buffer.length;
  };

  push('%PDF-1.4\n');

  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  const objects: Array<() => void> = [];

  objects.push(() => push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
  objects.push(() =>
    push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`),
  );

  pages.forEach((jpeg, i) => {
    const pageObj = 3 + i * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;

    objects.push(() =>
      push(
        `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
          `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> ` +
          `/Contents ${contentObj} 0 R >>\nendobj\n`,
      ),
    );
    objects.push(() => {
      push(
        `${imageObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
          `/Length ${jpeg.length} >>\nstream\n`,
      );
      push(jpeg);
      push('\nendstream\nendobj\n');
    });
    objects.push(() =>
      push(`${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`),
    );
  });

  for (const write of objects) {
    offsets.push(length);
    write();
  }

  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= objects.length; i += 1) {
    push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

const out = process.argv[2] ?? 'fixtures/answer-sheet.pdf';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buildPdf([pageOne(), pageTwo()]));
console.log(`handwritten answer sheet written: ${out}`);
