import '../workers/load-env';
import { readFile } from 'node:fs/promises';
import { createAssessment } from '../lib/services/assessment-service';
import { uploadDocument } from '../lib/services/document/document-service';
import { runAssessmentPipeline } from '../lib/services/pipeline/runner';
import { FakeAIProvider, setAIProvider } from '../lib/providers/ai';
import { FakeEmbeddingProvider, setEmbeddingProvider } from '../lib/providers/embeddings';
import { closeRedisConnection } from '../lib/queue/connection';
import { getAssessmentStore } from '../lib/services/assessment-store';
import type {
  ExtractedAnswerCandidate,
  ExtractedQuestionCandidate,
  GradingRequest,
} from '../lib/providers/ai';

/**
 * Produces a COMPLETED assessment by running the **real** pipeline.
 *
 *   npx tsx tools/seed-completed.ts
 *
 * Only the model is substituted. Everything else is the production path:
 * the real document service rasterises the real fixture PDFs, the real
 * mapping service scores and assigns with the Hungarian solver, and the real
 * grading service validates and totals the marks. So the page bitmaps, the
 * normalized coordinates, the mappings and the grades the UI renders are all
 * genuinely pipeline-generated — not fabricated records written into Redis.
 *
 * It exists because Gemini's free-tier quota is exhausted and a real run
 * cannot currently reach COMPLETED. When quota returns, the same screen
 * renders live output with no code change.
 */

/**
 * The question paper, using the wording shown in the Figma frame so the
 * screen can be compared against the design at a glance.
 */
const QUESTIONS: ExtractedQuestionCandidate[] = [
  ['Q1', 'Which blood vessel carries blood away from the heart?', 2],
  ['Q2', 'Which of the following organelles is primarily involved in photosynthesis?', 2],
  [
    'Q3',
    'Explain the role of chloroplasts in photosynthesis, naming the main pigments involved and briefly outlining the two major stages of the process.',
    2,
  ],
  [
    'Q4',
    'Describe the flow of blood through the human heart starting from the right atrium and ending at the aorta; include the names of valves crossed.',
    2,
  ],
  [
    'Q5',
    'Draw a labelled diagram of an alveolus showing capillaries and air space (label alveolar sac, capillary, and direction of gas exchange).',
    2,
  ],
  [
    'Q6',
    'Draw a neat labelled diagram of the human digestive system (stomach, small intestine, large intestine, liver, pancreas) and label the site where most absorption occurs.',
    5,
  ],
  [
    'Q7',
    "Draw and label a nephron (Bowman's capsule, glomerulus, proximal tubule, loop of Henle, distal tubule, collecting duct).",
    5,
  ],
  [
    'Q8',
    'Explain the structural differences between palisade mesophyll and spongy mesophyll and state how each structure aids its function in the leaf.',
    5,
  ],
  [
    'Q9',
    'Describe the process of transpiration in plants in two to three sentences and name two environmental factors that increase its rate.',
    5,
  ],
  [
    'Q10',
    'Explain how the structure of xylem vessels facilitates water transport in plants (mention one structural feature and its role).',
    5,
  ],
].map(([labelRaw, text, marks], index) => ({
  labelRaw: labelRaw as string,
  text: text as string,
  marks: marks as number,
  pageNumber: 1,
  rects: [{ pageNumber: 1, x: 0.08, y: 0.06 + index * 0.08, width: 0.84, height: 0.06 }],
}));

/**
 * The answers, positioned over where the fixture answer sheet actually has
 * handwriting. `scripts/make-answer-sheet.ts` draws on a 1240x1754 canvas
 * with labels at x=78 and body text from x=150, each row 46px apart; these
 * rectangles are those positions expressed in normalized [0,1] space.
 */
const ANSWERS: ExtractedAnswerCandidate[] = [
  {
    claimedLabelRaw: 'Q3',
    text:
      'Photosynthesis is the process used by green plants and some other organisms ' +
      'to convert light energy into chemical energy. 6CO2 + 6H2O --light--> C6H12O6 + 6O2',
    regions: [
      { pageNumber: 1, x: 0.063, y: 0.099, width: 0.84, height: 0.105, kind: 'text' as const },
    ],
  },
  {
    claimedLabelRaw: null,
    text: 'Arteries carry blood away from the heart, while veins carry blood back towards it.',
    regions: [
      { pageNumber: 1, x: 0.121, y: 0.302, width: 0.758, height: 0.049, kind: 'text' as const },
    ],
  },
  {
    claimedLabelRaw: 'Q2',
    text:
      'Sunlight enters the leaf and is absorbed by chlorophyll. The process mainly occurs ' +
      'in the chloroplast of the plant cell.',
    regions: [
      { pageNumber: 1, x: 0.063, y: 0.379, width: 0.84, height: 0.249, kind: 'diagram' as const },
    ],
  },
  {
    claimedLabelRaw: 'Q5',
    text:
      'The human heart has four chambers. Blood from the body enters the right atrium ' +
      'and then passes into the right ventricle. From there it is pumped to the lungs to ' +
      'collect oxygen, returns to the left atrium, and is finally pushed out through the aorta.',
    // Spans both pages: starts at the foot of page 1, continues at the top of page 2.
    regions: [
      { pageNumber: 1, x: 0.063, y: 0.738, width: 0.816, height: 0.052, kind: 'text' as const },
      { pageNumber: 2, x: 0.121, y: 0.097, width: 0.774, height: 0.075, kind: 'text' as const },
    ],
  },
  {
    claimedLabelRaw: 'Q1',
    text: 'The chloroplast is the organelle responsible.',
    regions: [
      { pageNumber: 2, x: 0.063, y: 0.225, width: 0.582, height: 0.026, kind: 'text' as const },
    ],
  },
  {
    claimedLabelRaw: 'Q7',
    text:
      'Osmosis is the movement of water across a semi-permeable membrane from a dilute ' +
      'to a concentrated solution.',
    regions: [
      { pageNumber: 2, x: 0.063, y: 0.322, width: 0.784, height: 0.079, kind: 'text' as const },
    ],
  },
];

/**
 * Marks that vary the way a real paper does, so every score-badge variant in
 * the design is represented. Deterministic: the same question always gets the
 * same fraction, so screenshots are reproducible.
 */
const FRACTIONS = [1, 1, 0, 0.6, 1, 0.8, 0.6, 1];

function scriptedGrading(request: GradingRequest) {
  const seed = [...request.questionLabel].reduce((n, c) => n + c.charCodeAt(0), 0);
  const fraction = FRACTIONS[seed % FRACTIONS.length]!;

  const criteria = request.criteria.map((criterion) => ({
    criterionId: criterion.id,
    // Whole marks only: the grading service rejects anything else under the
    // default WHOLE granularity.
    awardedMarks: Math.round(criterion.maxMarks * fraction),
    reason:
      fraction === 1
        ? 'Covers every point the criterion asks for.'
        : fraction === 0
          ? 'The response does not address what the criterion asks for.'
          : 'Addresses part of what the criterion asks for.',
  }));

  return {
    criteria,
    totalAwardedMarks: criteria.reduce((total, c) => total + c.awardedMarks, 0),
    confidence: 0.86,
    feedback:
      fraction === 1
        ? 'Excellent work! You correctly identified the chloroplast as the organelle responsible for photosynthesis. Keep it up!'
        : fraction === 0
          ? 'This answer does not address the question that was asked. Re-read the question and try again.'
          : 'A reasonable attempt. Some of the required detail is missing — look again at the parts the mark scheme asks for.',
    usage: null,
  };
}

async function main(): Promise<void> {
  setAIProvider(
    new FakeAIProvider({
      candidates: QUESTIONS,
      answerCandidates: ANSWERS,
      grading: scriptedGrading,
    }),
  );
  setEmbeddingProvider(new FakeEmbeddingProvider({}));

  const assessment = await createAssessment({ title: 'mapping fixture' });

  for (const [type, path] of [
    ['QUESTION_PAPER', 'fixtures/question-paper.pdf'],
    ['ANSWER_SHEET', 'fixtures/answer-sheet.pdf'],
  ] as const) {
    await uploadDocument({
      assessmentId: assessment.id,
      type,
      filename: path.split('/').pop()!,
      declaredMimeType: 'application/pdf',
      data: await readFile(path),
    });
  }

  await runAssessmentPipeline({ assessmentId: assessment.id, jobId: `seed-${assessment.id}` });

  const stored = await getAssessmentStore().get(assessment.id);

  console.error(
    `status=${stored.status} questions=${stored.questions.length} ` +
      `answers=${stored.answers.length} mappings=${stored.mappings.length} ` +
      `grades=${stored.grades.filter((g) => g.isCurrent).length}`,
  );
  console.log(assessment.id);

  setAIProvider(null);
  setEmbeddingProvider(null);
  await closeRedisConnection();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
