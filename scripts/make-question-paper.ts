import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { A4_PORTRAIT } from '../tests/fixtures/documents';
import { makePdfWithLines } from '../tests/fixtures/text-pdf';

/**
 * Builds a question paper matching the answer sheet from make-answer-sheet,
 * so the mapping smoke test has a real pair to work with.
 *
 *   npm run make:question-paper
 */
const PAGES = [
  [
    'DELHI PUBLIC SCHOOL, BOKARO STEEL CITY',
    'Class 10 Science - Unit Test 3',
    '',
    'General Instructions:',
    '(i) All questions are compulsory.',
    '',
    'SECTION A',
    '',
    '1. Which organelle is primarily involved in photosynthesis?   [2]',
    '',
    '2. Explain how sunlight is absorbed by a leaf during photosynthesis,',
    '   and draw a labelled diagram of the process.   [5]',
    '',
    '3. Define photosynthesis and give its balanced chemical equation.   [3]',
    '',
    '4. State the difference between arteries and veins.   [2]',
    '',
    '5. Describe the flow of blood through the human heart, starting',
    '   from the right atrium.   [5]',
    '',
    '6. Explain the process of transpiration in plants.   [3]',
    '',
    '7. Define osmosis and give one example from plant cells.   [5]',
  ],
];

const out = process.argv[2] ?? 'fixtures/question-paper.pdf';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, makePdfWithLines(PAGES.map((lines) => ({ ...A4_PORTRAIT, lines }))));
console.log(`question paper written: ${out}`);
