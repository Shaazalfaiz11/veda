/**
 * Versioned extraction prompts.
 *
 * The version string is recorded on every extraction run, so a change in
 * output quality can always be traced back to the prompt that produced it.
 * Bump it whenever the wording changes in a way that could alter results.
 */

export const QUESTION_EXTRACTION_PROMPT_VERSION = 'question-extraction/v2';

/**
 * Instructions for reading a printed question paper.
 *
 * Two themes run through it. First, faithfulness: the paper is the source of
 * truth, so labels and wording are copied rather than tidied, and anything
 * not printed is left null rather than guessed. Second, restraint: an
 * over-eager extractor that promotes instructions to questions or invents a
 * missing number does more damage downstream than one that omits a doubtful
 * item, because the mapper cannot tell an invented question from a real one.
 */
export function buildQuestionExtractionPrompt(pageCount: number): string {
  return `You are extracting questions from a printed exam question paper.

You are given ${pageCount} page image${pageCount === 1 ? '' : 's'}, in order. Page numbers are 1-based: the first image is page 1.

Return every question that is actually asked on the paper.

WHAT COUNTS AS A QUESTION
- A numbered or lettered item that asks the student to do something.
- Labelled sub-parts are separate questions. "11 (a)" and "11 (b)" are two entries, not one.
- A question whose text continues onto the next page is still one question.

STEMS AND SUB-PARTS
- Where a numbered question introduces material and then poses labelled sub-parts, return the numbered stem as its own entry AND each sub-part as its own entry.
  For example, given:
      6. A diagram shows two potted plants...
         (a) Explain why plant B is pale.
         (b) Suggest one measure to help plant B.
  return three entries: "6.", "(a)" and "(b)".
- Put the stem's own wording in the stem entry, and only the sub-part's wording in each sub-part entry. Do not copy the stem text into the sub-parts.
- If the stem has no marks printed against it, its "marks" is null even when its sub-parts do have marks.

WHAT DOES NOT COUNT
- Instructions and rubric: "Answer any five questions", "All questions are compulsory", "Time allowed: 3 hours".
- Section headings: "Section A", "Part II".
- Headers, footers, page numbers, school names, logos, decorative rules.
- Blank answer space, ruled lines, margins.
If a line tells the student how to sit the exam rather than asking them something, it is an instruction.

LABELS
- Copy the label exactly as printed into "labelRaw", including its punctuation and spacing: "Q4", "4.", "11 (a)", "(iii)".
- If a sub-part is printed as a bare "(a)" with no number, report it as "(a)". Do not attach the parent number yourself.
- Do not renumber, tidy, expand or invent labels.
- If an item is genuinely unlabelled, use an empty string rather than making one up.

TEXT
- Copy the question wording faithfully into "text". Preserve the meaning and the details; do not summarise, answer, or paraphrase.
- If marks are printed as part of the sentence, leave them in the text as well as reporting them in "marks".
- Where a question includes a table, diagram or formula you cannot transcribe exactly, describe it briefly in square brackets, e.g. "[diagram of a plant cell]".

MARKS
- Set "marks" only when a mark allocation is visibly printed for that question, such as "[5]", "(5 marks)" or a figure in a marks column.
- If no allocation is printed, set "marks" to null. Never infer, split or total marks yourself.

PAGES AND REGIONS
- "pageNumber" is the 1-based page the question starts on.
- "rects" bounds the question on the page, as normalized coordinates measured against the page image:
    x, y      the top-left corner, as a fraction of page width and height
    width     fraction of the page width
    height    fraction of the page height
  The origin (0, 0) is the top-left of the page and (1, 1) is the bottom-right. y increases downward.
- Every value must lie between 0 and 1, and a region must not extend past the page edge.
- Return more than one rect when the question is split — across columns, or continuing on the following page. Each rect names the page it lies on via "rectPageNumber".
- Give at least one rect per question. Bound the question's own label and text, not the whole page and not the answer space below it.

ORDER
- Return questions in the order they are printed, reading top to bottom on each page and page 1 first.

Return only the structured data requested. Do not add commentary.`;
}
