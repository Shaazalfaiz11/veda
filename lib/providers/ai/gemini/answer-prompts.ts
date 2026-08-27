/**
 * Versioned answer extraction prompts.
 *
 * The version is recorded on every run, so a change in output quality can be
 * traced back to the prompt that produced it. Bump it whenever the wording
 * changes in a way that could alter results.
 */

export const ANSWER_EXTRACTION_PROMPT_VERSION = 'answer-extraction/v3';

/**
 * Instructions for reading a handwritten answer sheet.
 *
 * Three themes run through it.
 *
 * Faithfulness: transcribe what is on the page, and mark illegible stretches
 * rather than guessing. A confidently wrong word is far more damaging than an
 * admitted gap, because nothing downstream can tell it was invented.
 *
 * Restraint about identity: the model reports the label the student *wrote*
 * and nothing more. It is never asked which question an answer belongs to —
 * that decision needs evidence this stage does not have, and a model that
 * volunteers it produces an answer that looks resolved when it is only
 * guessed.
 *
 * Restraint about scope: student work only. A page border, a printed header
 * or a teacher's tick is not an answer.
 */
export function buildAnswerExtractionPrompt(pageCount: number): string {
  return `You are reading a student's handwritten answer sheet.

You are given ${pageCount} page image${pageCount === 1 ? '' : 's'}, in order. Page numbers are 1-based: the first image is page 1.

Identify every distinct block of the student's own written work, and transcribe it.

WHAT COUNTS AS AN ANSWER
- Handwriting the student produced in response to a question.
- A block may contain prose, working, equations, lists, bullet points, tables or a labelled diagram.

WHAT DOES NOT COUNT
- Printed text from the question paper that happens to appear on the sheet.
- School names, exam headers, footers, roll numbers, dates, page numbers.
- Margins, ruled lines, page borders, staple marks, decorative marks.
- Marks, ticks, crosses, scores or comments written by a teacher in the margin.
- Blank space and blank ruled lines.
If a mark is not the student answering a question, leave it out.

LABELS
- If the student wrote a question label beside their work, copy it exactly as written into "claimedLabelRaw": "Q1", "2.", "(a)", "4(b)", "Ans 3".
- If they wrote no label, set "claimedLabelRaw" to null. This is common and completely normal — still return the answer.
- Do NOT infer, correct or invent a label. Do not work out which question an answer belongs to. Report only what is visibly written.

TRANSCRIPTION
- Transcribe the handwriting into "text" as faithfully as you can.
- Preserve line breaks, numbered points, bullet points and the order of working.
- Transcribe equations and chemical formulae as written, e.g. "6CO2 + 6H2O -> C6H12O6 + 6O2".
- Where a word or phrase is genuinely illegible, write exactly "[unclear]" in its place. Never substitute a plausible guess for handwriting you cannot read.
- Do not correct the student's spelling, grammar or factual errors. Transcribe what is there.
- For a diagram, transcribe any readable labels and add a short bracketed description, e.g. "[diagram: plant with arrows labelled sunlight, oxygen, carbon dioxide, water]". Do not attempt to reproduce the drawing itself.

REGIONS
- "regions" locates the answer on the page. Give coordinates normalized against the page image:
    x, y      top-left corner, as a fraction of page width and height
    width     fraction of the page width
    height    fraction of the page height
  The origin (0, 0) is the top-left of the page and (1, 1) is the bottom-right. y increases downward.
- Every value must lie between 0 and 1, and a region must not extend past the page edge.
- Set "kind" to "diagram" for a region that is a drawing, and "text" for written work.
- Return several regions when one answer occupies separate areas — a paragraph, then a diagram, then more writing. Do not force an answer into one rectangle that swallows the gaps between them.
- Bound the student's actual writing. Do not return the whole page, and do not include a neighbouring answer inside the region.
- Give at least one region per answer, and set "pageNumber" on each region to the page it lies on.
- Measure each rectangle against the writing you can actually see. Look at where the ink starts and stops, and read the numbers off that. A region is only useful if it lands on the handwriting it names.
- Do not fill these in by pattern. Evenly spaced boxes — every answer the same width and height, each y a fixed step below the last — mean the coordinates were guessed rather than measured, and a guessed box highlights the wrong part of the page. Real answers differ in size: a one-line choice is short, a worked solution is tall.

ANSWERS THAT CONTINUE ONTO ANOTHER PAGE
- When one answer carries on from the bottom of a page to the top of the next, return it as ONE answer with regions on both pages.
- Only do this when the writing plainly continues — a sentence broken mid-way, or an explicit "continued". If two blocks are merely about similar topics, keep them separate.
- An answer that is complete on one page gets regions on that page only. Never repeat an answer's region on a second page to be safe: that claims the student wrote it twice, and the second box highlights someone else's work.

SEPARATE ANSWERS
- Two blocks with the same written label are two answers unless they are visibly one continuous piece of writing. Return them separately; do not merge them and do not drop either.
- A block separated from the writing above it by a clear blank gap, and carrying no label of its own, is its own answer with "claimedLabelRaw" null. Do not absorb it into the labelled answer above just because that answer is the nearest one.
- Do not go the other way either: consecutive paragraphs of one continuous argument, or a numbered list within one answer, are still a single answer. Split on a visible gap plus a change of subject, not on every paragraph break.

ORDER
- Return answers in the order they appear on the sheet, reading top to bottom on each page, page 1 first.

Return only the structured data requested. Do not add commentary, and do not say which question any answer belongs to.`;
}
