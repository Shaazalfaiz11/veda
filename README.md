# VedaAI — Assessment Extraction & Answer Mapping

Upload a question paper and a student's handwritten answer sheet. The system
reads both, works out which answer belongs to which question, and shows a
teacher the exact region of the sheet each answer occupies — click a question,
the viewer jumps to the right page and highlights the handwriting.

Grading and AI feedback run on top of that when the paper prints its marks.

```
Question paper (PDF/PNG/JPEG)        Handwritten answer sheet
              │                                │
              └──────────────┬─────────────────┘
                             ↓
                      PREPARING            rasterise every page
                             ↓
              EXTRACTING_QUESTIONS         printed order, sub-parts kept apart
                             ↓
                EXTRACTING_ANSWERS         transcribe + locate the handwriting
                             ↓
                          MAPPING          embeddings → shortlist → adjudication
                             ↓
                          GRADING          rubric → marks → feedback  (optional)
                             ↓
                        COMPLETED
```

## What it looks like

![Processing — the six stages, with the live one named](docs/screenshots/processing.png)

The run reports the stage it is actually in. Nothing here is a fake
progress bar; the percentage is derived from the stage the worker last wrote.

![Review — questions, marks, and the handwriting each answer occupies](docs/screenshots/mapping.png)

Every answer is drawn where the student wrote it. Question 3 is `Not marked`
because the paper prints no marks for it — the system says so rather than
inventing a total.

## What it does

| | |
| --- | --- |
| **Extraction** | Every question in printed order, original numbering preserved, `27 (a)` and `27 (b)` as separate questions, `OR` alternatives kept with the question they belong to |
| **Handwriting** | Answers transcribed and located, with `[unclear]` where the writing genuinely cannot be read rather than a plausible guess |
| **Mapping** | Local embeddings and deterministic signals build a shortlist; the model only adjudicates the ambiguous ones; a global assignment stops two answers claiming one question |
| **Highlighting** | Normalised `[0,1]` coordinates rendered as percentages, so the overlay stays on the handwriting at any zoom, window size or breakpoint. An answer spanning two pages is drawn on both |
| **Edge cases** | Answers written out of order, unanswered questions, and student work that matches no question are each shown as what they are |
| **Grading** | Marks computed by the application from criterion marks — never copied from the model — with a confidence that decides whether a human should look |

## Stack

Next.js 15 · BullMQ over Redis · Groq `qwen/qwen3.8-27b` for vision and
adjudication · `Xenova/all-MiniLM-L6-v2` embeddings in-process · Zod at every
boundary · CSS Modules against a Figma design · Vitest (883 tests)

## Quick start

**Prerequisites:** Node 22+, Docker (for Redis), and a Groq API key from
[console.groq.com/keys](https://console.groq.com/keys).

```bash
# 1. Install
npm install

# 2. Configure — then open .env.local and set GROQ_API_KEY
cp .env.example .env.local

# 3. Redis
npm run redis:up

# 4. The app, in one terminal
npm run dev

# 5. The worker, in a second terminal
npm run dev:worker
```

Open <http://localhost:3000>, upload the two files, and the app routes itself
through processing to the mapping screen.

Run **one** worker. Two on a free provider tier spend the same per-minute token
budget twice and both get refused.

### Production

```bash
npm run build
npm run start:all      # web server and worker in one process
```

Do not run `npm run build` while the dev server is up — both write to `.next/`
and the dev server's chunks get clobbered. Recovery is `rm -rf .next`.

## Checks

```bash
npm test           # 883 tests
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```

## How long a run takes

About **10 minutes** for a 5-page paper and a 5-page answer sheet, and that is
almost entirely the provider's free tier rather than the code. A page image
costs ~2,100 tokens against an 8,000 tokens-per-minute ceiling, so roughly one
vision request per minute is what the tier admits, and a run needs 28 calls.
Scheduling was measured against this and made it worse; see
`lib/providers/ai/groq/rate-limiter.ts` for what was tried and why the plain
pacing stayed.

## Deploying

Live:

| | |
| --- | --- |
| **App** | https://answermapping.vercel.app |
| **API** | https://veda-g9c9.onrender.com |

The app is one Next.js codebase containing both the pages and the API, plus a
worker process.

The worker and the API used to be inseparable: the worker wrote prepared page
bitmaps to the container's disk and the API read them back to serve the page
the highlight overlay is drawn on. That disk does not survive a restart, so a
completed assessment reopened to a broken image while its metadata sat intact
in Redis. Both the uploads and the bitmaps now live in object storage instead,
addressed by the same keys, and the constraint is gone. They still deploy
together because there is no reason not to.

### 1. Object storage — Cloudflare R2

Any S3-compatible bucket works; R2 is what this runs on.

1. R2 → **Create bucket**.
2. **Manage API tokens** → an account token with **Object Read & Write**.
3. Keep the Access Key ID, the Secret, and the S3 endpoint — the account URL,
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, *without* the bucket name.

Cloudflare requires a card on file to enable R2 even inside the free
allowance (10GB, 1M class-A operations, no egress fees).

Leave `STORAGE_DRIVER` unset for local development and the filesystem is used,
exactly as before.

### 2. Backend — Render

`render.yaml` declares the web service and the Redis the queue runs on.

1. Render → **New** → **Blueprint** → pick this repository.
2. Set the secrets:
   - `GROQ_API_KEY` — from [console.groq.com/keys](https://console.groq.com/keys)
   - `STORAGE_DRIVER=r2`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
     `R2_SECRET_ACCESS_KEY` — from step 1
   - `CORS_ALLOWED_ORIGINS` — leave blank for now; step 4 supplies it.
3. Deploy. The first build takes a while: the image bakes the ~90MB embedding
   model in so the first request does not have to download it.
4. Check `https://<your-service>.onrender.com/api/health` returns
   `{"status":"ok","redis":"up"}`.

The service runs `scripts/start-production.mjs`, which starts the web server
and the worker in one process tree and fails them together, so a restart brings
both back.

This runs on the **free** instance. It fits, but only just — see
[Known limitations](#known-limitations) for what that costs.

### 3. Frontend — Vercel

1. Vercel → **Add New** → **Project** → import this repository.
2. Framework preset **Next.js**, defaults otherwise.
3. Add one environment variable, for **all** environments:

   ```
   NEXT_PUBLIC_API_BASE_URL = https://<your-service>.onrender.com
   ```

   It is inlined at build time, so it must be set *before* the build. Changing
   it later needs a redeploy, not just a restart.
4. Deploy, and note the assigned URL.

### 4. Close the loop

Set `CORS_ALLOWED_ORIGINS` on the Render service to the exact Vercel origin —
no trailing slash, e.g. `https://answermapping.vercel.app` — and redeploy
Render.

Without this the browser blocks every call and the UI sits on "Loading the
mapping…". The allowlist takes exact origins rather than `*` on purpose: this
API accepts uploads and returns a student's work.

To verify end to end, upload a pair and watch the network tab — the requests
should go to the Render origin, and the page bitmaps under
`/api/assessments/.../pages/N` should return `200 image/png`.

### Deploying as one service instead

Simpler: deploy only to Render and leave `NEXT_PUBLIC_API_BASE_URL` and
`CORS_ALLOWED_ORIGINS` unset. Everything is same-origin, there is no CORS, and
there is one deployment to keep in step. The Vercel half exists because a
separate frontend host was asked for, not because the app needs it.

> Vercel builds the whole repository, so the API routes are deployed there too.
> They have no Redis, no worker and no storage credentials behind them, and the
> UI never calls them — `NEXT_PUBLIC_API_BASE_URL` points every request at
> Render. They are dead weight, not a second backend.

**Vercel alone will not work.** No long-running worker, and a multi-minute
pipeline against a serverless function timeout.

## Known limitations

Worth stating plainly rather than discovering in a demo:

- **The answer sheet must be handwritten student work.** Given a printed
  solutions PDF, extraction finds nothing usable — that is the input being
  wrong, not a bug.
- **Answer regions are model-estimated.** They land on the right page and the
  right block of writing, but they are not pixel-tight; the model rounds
  coordinates. Exact ink bounds would need image analysis this does not do.
- **A paper whose numbers are printed rather than handwritten maps on
  semantics alone.** With no student-written label the confidence signal is
  weaker, so mappings come back as `HUMAN_REVIEW` rather than auto-mapped.
  That is the system declining to claim certainty it does not have.
- **Grading marks a rubric derived from the printed marks**, labelled
  `GENERATED`, never presented as the examiner's. Every grade against a
  generated rubric is flagged for review by design.
- **Exam PDFs are not committed.** `fixtures/` is gitignored — the papers used
  in development are third-party material. See below to rebuild a pair.
- **The free Render instance has almost no headroom.** 512MB, and a run peaks
  around 470-500MB of it. The web server shares that container with the worker,
  so while the worker is at its peak the API can stop answering for a few
  seconds and the UI shows "Lost contact with the server. Still retrying…".
  It recovers on its own and the run completes; every measured run has. A
  larger instance is the only real fix.
- **Groq's free tier is the pacing constraint, not the hardware.** 8,000 tokens
  per minute, and one page image costs roughly 2,700 of them. The delays
  between calls exist to stay under that ceiling, and they are most of the
  wall-clock time. Faster hardware would not change it; a paid Groq tier would.

## Architecture

```
Browser
   ↓
Next.js Route Handler        app/api/assessments/**
   ↓
BullMQ Producer              lib/queue/queues.ts
   ↓
Redis                        queue + assessment state
   ↓
Node.js Worker               workers/assessment.worker.ts
   ↓
Processing Pipeline          lib/services/pipeline/
```

The worker walks six stages in order:

```
PREPARE → EXTRACT_QUESTIONS → EXTRACT_ANSWERS → MAP_ANSWERS → GRADE → FINALIZE
   ▲            ▲                    ▲               ▲            ▲
   │            │                    │               │            └── effective mapping → rubric → marks
   │            │                    │               └── candidates → LLM adjudication → assignment
   │            │                    └── the model transcribes the handwritten answer sheet
   │            └── the model reads the question paper into validated questions
   └── upload → validate → store → prepare → render → page metadata
```

## Walking through it

Open `http://localhost:3000`, upload a question paper and a handwritten answer
sheet, and the app routes itself through processing to the mapping screen. On a
free Groq tier a 5-page pair takes **10-12 minutes**, nearly all of it the
pacing between vision calls rather than the calls themselves.

The mapping screen is where the assignment is demonstrated:

- The left pane lists every extracted question, in the paper's own order and
  under the paper's own numbering. Sub-parts are separate rows.
- A question with nothing mapped to it says **No answer mapped**.
- Clicking a question scrolls the answer sheet to the page its answer is on and
  draws the answer's region over the handwriting, dimming the others. An answer
  spanning two pages is drawn on both.
- A region tagged **Unmapped** is student work that reached no question.

### Building the demo fixtures

The exam PDFs are not committed — they are third-party material, and
`fixtures/` is gitignored. Two tools rebuild a matched pair from a source PDF:

```bash
# A printed 5-page question paper (CBSE Class X Maths Basic 2020).
npx tsx tools/make-demo-question-paper.ts fixtures/demo-question-paper.pdf

# Five pages of a handwritten answer sheet, from a larger scan.
npx tsx tools/slice-pdf.ts <source.pdf> fixtures/demo-answer-sheet.pdf 5 1600 3
```

The pair must be **the same exam**. A question paper and an answer sheet from
different papers produce an empty mapping, and the failure looks like a bug in
the mapper rather than the mismatch it is.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run dev:worker` | Worker with file watching |
| `npm run build` | Production build |
| `npm start` | Production server |
| `npm run start:worker` | Worker, no watching |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (unit, API, integration) |
| `npm run redis:up` / `redis:down` | Local Redis container |
| `npm run smoke:grading` | Opt-in live grading run against real Gemini |
| `npm run start:all` | Production web server and worker in one process (deployment) |

## API

### `POST /api/assessments` → `201`

```json
{ "title": "Class 10 maths unit test" }
```

`title` is optional. Documents arrive through the upload endpoint.

### `POST /api/assessments/:assessmentId/documents` → `201`

`multipart/form-data` with `type` (`QUESTION_PAPER` | `ANSWER_SHEET`) and
`file` (PDF, PNG or JPEG, 10 MB max). Returns metadata, never bytes:

```json
{
  "id": "4ed40b12-0294-4409-872b-a72a588d7676",
  "assessmentId": "674f6c7c-9863-4127-bc73-4517fd042b4d",
  "type": "QUESTION_PAPER",
  "status": "UPLOADED",
  "format": "PDF",
  "pageCount": null
}
```

Uploading a second document of the same type replaces the first. Uploads are
refused while the assessment is `QUEUED` or `PROCESSING`.

### `POST /api/assessments/:assessmentId/process` → `202`

```json
{
  "assessmentId": "674f6c7c-9863-4127-bc73-4517fd042b4d",
  "jobId": "db83f7bb-5d4e-419e-a8ed-fa31b7d62131",
  "status": "QUEUED"
}
```

Enqueues a job and returns immediately. No processing happens on this request.

### `GET /api/assessments/:assessmentId/status` → `200`

```json
{
  "assessmentId": "674f6c7c-9863-4127-bc73-4517fd042b4d",
  "status": "PROCESSING",
  "stage": "PREPARING",
  "progress": 0,
  "jobId": "db83f7bb-5d4e-419e-a8ed-fa31b7d62131",
  "documents": [
    { "id": "4ed40b12-…", "type": "QUESTION_PAPER", "status": "READY", "pageCount": 4 },
    { "id": "0b9345fe-…", "type": "ANSWER_SHEET", "status": "PREPARING", "pageCount": null }
  ],
  "failure": null,
  "updatedAt": "2026-08-26T07:56:13.448Z"
}
```

### Others

- `GET /api/assessments/:assessmentId` — the full record, including `completedStages`
- `GET /api/assessments/:assessmentId/documents` — every document with page geometry
- `GET /api/assessments/:assessmentId/documents/:documentId` — one document, with per-page URLs
- `GET /api/assessments/:assessmentId/documents/:documentId/pages/:pageNumber` — the prepared page PNG
- `GET /api/assessments/:assessmentId/questions` — extracted questions plus extraction provenance
- `GET /api/assessments/:assessmentId/grades` — every grade in force, the totals, and superseded grades as `history`
- `GET /api/assessments/:assessmentId/grades/:questionId` — one question's grade, criterion by criterion, with the rubric behind it
- `GET /api/health` — API and Redis liveness

### Error shape

Every failure returns the same envelope:

```json
{
  "error": {
    "code": "UNSUPPORTED_DOCUMENT_TYPE",
    "message": "The document is not a supported format. Accepted formats are PDF, PNG and JPEG.",
    "details": { "accepted": ["application/pdf", "image/png", "image/jpeg"] }
  }
}
```

`400` validation · `404` not found · `409` illegal state transition · `413`
document too large · `415` unsupported document type · `422` invalid or empty
document · `503` dependency unavailable · `500` internal.

## Assessment state

| Status | Meaning |
| --- | --- |
| `CREATED` | Exists, not queued |
| `QUEUED` | Job enqueued, not yet picked up |
| `PROCESSING` | Worker is walking the pipeline |
| `COMPLETED` | Terminal, success |
| `FAILED` | Terminal for this run; can be requeued |

Transitions are enforced in `lib/domain/assessment/state.ts`. `COMPLETED` is
genuinely terminal; `FAILED → QUEUED` is allowed so a run can be retried.

`progress` is **derived** from the stage rather than stored, so it cannot drift
out of step with the pipeline. A failed assessment freezes its progress at the
stage that broke, so the caller can see how far it got.

## Documents

A document is one uploaded file. Its lifecycle is **separate** from the
assessment's: an assessment can be `PROCESSING` while one document is `READY`
and another is still `PREPARING`.

| Status | Meaning |
| --- | --- |
| `UPLOADED` | Stored and validated, not yet prepared |
| `PREPARING` | Being rendered into pages |
| `READY` | Prepared pages available |
| `FAILED` | Preparation failed; retryable |

`READY` is the success state but not a dead end — a document whose prepared
bitmaps have gone missing from storage is no longer genuinely prepared, so it
can return to `PREPARING`.

### The canonical prepared page

Preparation renders every page to **one PNG bitmap**. That single bitmap is
what a vision model will read, what the frontend displays, and what
answer-region coordinates are measured against. Nothing downstream renders its
own version of a page.

```ts
interface PreparedPage {
  documentId: string;
  pageNumber: number;      // 1-based, original document order
  width: number;           // the prepared bitmap
  height: number;
  aspectRatio: number;
  sourceWidth: number;     // geometry before preparation
  sourceHeight: number;
  scale: number;           // factor applied to reach the bitmap
  rotation: number;        // rotation baked in
  storageKey: string;      // opaque; never leaves the server
  mimeType: string;
  sizeBytes: number;
}
```

Pages are fitted inside `PREPARED_PAGE_MAX_DIMENSION` and **never enlarged** —
upscaling a small scan adds pixels without adding information. The scale is
recorded so the transformation stays explicit. PNG and JPEG uploads become
single-page documents in exactly this shape, so the rest of the pipeline never
needs to know which format arrived.

EXIF orientation is baked into the pixels. A page photographed sideways on a
phone carries an orientation flag rather than rotated pixels; without applying
it the recorded geometry would describe the stored bytes while the teacher sees
something else, and every coordinate would be measured against the wrong axes.

### Coordinate convention

Every region — question bounds, answer line rects, highlights — is normalized
against the prepared page:

```
origin (0, 0) = top-left        extent (1, 1) = bottom-right
x, y, width, height in [0, 1]   y increases downward
```

```json
{ "pageNumber": 2, "x": 0.12, "y": 0.44, "width": 0.76, "height": 0.09 }
```

Pixel coordinates are never the source of truth. A normalized rect is correct
at any zoom, any container width, and any prepared-page scale — which is
exactly why resizing a page during preparation cannot invalidate stored
regions. `NormalizedRectSchema` rejects values outside `[0, 1]`, non-finite
numbers, and rects that extend past a page edge.

## Questions

`EXTRACTING_QUESTIONS` sends the canonical prepared pages to Gemini and turns
the response into domain objects. The model is a source of *candidates*, never
of truth — nothing it returns becomes application state until it has been
validated.

```ts
interface Question {
  id: string;              // generated here; a model never names our state
  labelRaw: string;        // exactly as printed — what the UI renders
  normalizedLabel: string; // matching key: "4-a" — what the mapper compares
  sortKey: { major, minor, roman };
  parentLabel: string | null;
  isSubQuestion: boolean;
  text: string;
  marks: number | null;    // null unless printed. Never inferred.
  pageNumber: number;      // 1-based
  rects: PageRegion[];     // normalized, each carrying its own page
  pageNumbers: number[];   // every page the question touches
}
```

What validation enforces:

- **Geometry is checked, never clamped.** A rect of `x = 1.4` means the model
  misunderstood the coordinate space; trimming it to `1.0` would bury that
  behind a plausible highlight in the wrong place.
- **Page numbers must exist** on the prepared document.
- **Ordering comes from parsed labels**, not array position, so a model that
  returns questions out of order still produces the same result. The
  comparison falls through to the original label, so it is a total order.
- **Duplicates are reported, not resolved.** Two questions labelled `Q2` are
  both kept and a `DUPLICATE_LABEL` warning is raised. Discarding one loses a
  real question; renumbering fabricates a label the paper never printed.
- **Empty label, empty text, negative marks, zero-area or missing regions** are
  rejected with a warning naming the offending label.

Extraction provenance is stored alongside: provider, model, prompt version,
timestamp, pages processed, candidates received and rejected, warnings, and
token usage when reported. Prompts, page data and credentials are not stored.

### Gemini

The provider sits behind the existing `AIProvider` interface, so the stage and
the service have no vendor coupling and every case is testable without a
model. The prompt is versioned (`question-extraction/v2`) and the model name
lives only in configuration.

Failures are classified rather than blindly retried. Rate limits, timeouts,
5xx and network faults are transient and left to BullMQ's backoff. A rejected
API key, a malformed request, or structured output that fails validation are
permanent and stop immediately. There is no retry loop inside the provider —
nesting one inside the queue's would multiply attempts, not add resilience.

### Smoke test

The normal suite never contacts Gemini; a scripted `FakeAIProvider` stands in,
so CI cannot be broken by model availability or quota. To exercise the real
API:

```bash
npm run smoke:gemini                  # generated one-page fixture
npm run smoke:gemini -- paper.pdf     # a real question paper
```

Requires `GEMINI_API_KEY`. Prints a structured summary — never the key, never
page data, never the prompt.

## Mapping

`MAPPING` decides which answer belongs to which question -- never whether the
answer is *correct*, which is a later phase's job. The architecture is
deliberately hybrid rather than a single LLM call over the whole paper,
because a model asked to map fifty things at once produces fluent output with
no way to check any individual decision:

```
Question -+                                              +- HIGH   -> AUTO_MAPPED
          +-> candidate generation -> top K -> LLM -> -+- MEDIUM -> REVIEW_REQUIRED
Answer  --+   (label/semantic/         adjudication    |
               position/structure)                     +- LOW    -> HUMAN_REVIEW
```

A mapping is a **separate relationship**, never a mutation of the source data:

```
Question  <---  AnswerMapping  --->  Answer
```

Neither `Question` nor `Answer` gains a reference to the other. `Answer` still
carries no `questionId` after this phase -- the mapping lives in its own
record, addressable by `answerId` and `questionId`, so it can be recomputed or
corrected without touching extraction results.

### Candidate generation

Every answer is scored against every question on four signals, each
independently testable:

| Signal | What it captures |
| --- | --- |
| **Label** | Written label vs. printed label -- `Q4` vs `4.`, `6(a)` vs `6 (a)`, a bare `(a)` treated as *a* sub-part, not *which* question's |
| **Semantic** | Cosine similarity between embedded question and answer text, rescaled against an unrelated-text floor |
| **Position** | Reading order vs. printed order -- a weak tendency, compressed so it can never veto a strong label or semantic match |
| **Structure** | Diagram presence, answer length vs. printed marks, sub-part shape |

The four combine into a `candidateScore` via configurable weights (`label`
0.45, `semantic` 0.35, `position` 0.1, `structure` 0.1 by default). Only the
top **K** (default 3) proceed further -- never the whole question list.

### Label matching in detail

| Label pair | Kind | Score |
| --- | --- | --- |
| `Q4` vs `4.` | `EXACT_NORMALIZED_LABEL` | 1.0 |
| `6(a)` vs `6 (a)` | `EXACT_PARENT_AND_SUBQUESTION` | 1.0 |
| `6` vs `6(a)` | `PARENT_ONLY` | 0.6 |
| bare `(a)` vs any question's `(a)` | `SUBPART_ONLY` | 0.45 |
| no label written | `NO_LABEL` | 0.5 (neutral) |
| `Q4` vs `7.` | `CONFLICTING_LABEL` | 0.0 |

A bare `(a)` scores identically against **every** sub-part on the paper -- it
is evidence of being *a* sub-part, not of *which* question's, and resolving
that would be a guess dressed as a deduction. Position and semantics break
the tie.

### LLM adjudication

The adjudicator sees only the shortlist -- an answer's transcription plus up
to `K` candidate questions with their text, marks and parent context -- and
returns one of the supplied ids or `NO_MATCH`. It is never shown the rest of
the paper and is never asked to map everything at once.

An id the model did not receive is rejected outright, not silently accepted.
A decisive match (exact label, uniquely resolved, strong candidate score) is
never sent to the model at all -- there is no tie for it to break, and it
would only compete with genuinely ambiguous answers for the same rate limit.

### Final confidence

Computed by the application, never copied from the model:

```
finalConfidence = (1 - llmWeight) x candidateScore + llmWeight x agreement
                  - conflictPenalty (if the label actively contradicted)
```

`agreement` is the model's own confidence when it selected this pair, and 0
when it selected something else or the model was never consulted -- a
provider outage collapses `llmWeight` to zero rather than penalising a
mapping the outage had nothing to do with.

Bands: `>= 0.90` HIGH (auto-mapped) - `0.70-0.89` MEDIUM (review advised) -
`< 0.70` LOW (human review). Configurable, and never claimed to be optimal.

### Global assignment

Answers and questions are matched **globally**, not one answer at a time.
Given

```
Answer A:  Q1 = 0.92,  Q2 = 0.90
Answer B:  Q1 = 0.91,  Q2 = 0.30
```

processing answers independently risks `A->Q1, B->Q2` (total 1.22) purely
because A was considered first. The Hungarian algorithm (`O(n^3)`, exact, not
greedy) finds `A->Q2, B->Q1` (total 1.81) instead -- the true optimum. Pairs
below `MAPPING_MIN_ASSIGNMENT_SCORE` are excluded before matching, so a bad
pairing can never be "spent" to free up a better one elsewhere. Unmatched
answers and unmatched questions are both allowed.

### Explainability

Every mapping carries `reasonCodes` (`DIRECT_LABEL_MATCH`, `SEMANTIC_MATCH`,
`LLM_VERIFIED`, `CONFLICT_RESOLVED`, `LOW_CONFIDENCE`, ...), every candidate
considered -- including the ones that lost -- and what the adjudicator said,
kept separate from the application's own score. A confidence number is never
stored without the reasoning behind it.

## Human review

The AI's decision is evidence, not a verdict. Phase 6 lets a teacher correct a
mapping **without destroying what the AI concluded** — the two coexist, and
what the system acts on is derived from both:

```
AnswerMapping (AI, immutable)
         |
         v
  MappingReview (human decision layer)
         |
         v
  effective mapping
```

### What gets queued

A mapping enters the review queue when the system is not confident: MEDIUM or
LOW confidence, an unmapped answer, an AI `NO_MATCH`, no candidates at all, or
a HIGH-confidence mapping that only won after the optimiser moved it off its
own first choice. A plain HIGH-confidence auto-mapping is left alone.

That asymmetry is deliberate: a teacher glancing at a correct mapping costs
seconds, a wrong mapping reaching grading unchallenged costs a real mark on a
real student's paper.

### Immutability

A review **snapshots** the AI decision it responded to — question, confidence,
band, signals, reason codes, every candidate, and the adjudicator's verdict —
rather than referencing it. Nothing a teacher does edits an `AnswerMapping`.
The integration suite asserts the mapping array is byte-identical after
accept, remap and reject have all run over it.

### Actions

| Action | Effect | AI mapping |
| --- | --- | --- |
| `ACCEPT` | The AI's question stands, signed off by a human | unchanged |
| `REMAP` | The teacher's question replaces it | unchanged |
| `REJECT` | The answer is effectively unmapped | unchanged |
| `SKIP` | Nothing is decided; the AI mapping stays in force | unchanged |

`SKIP` is never silently converted into an accept or a reject. It is recorded
as a deferral, and the item can be picked up again later.

### Effective mapping

Derived on read, never stored — a stored copy would be a third version of a
fact that already lives in two places, and the first time it drifted nobody
would know which was right.

```
no decision, or SKIP  ->  the AI mapping        (source: AI)
ACCEPT                ->  the AI question       (source: HUMAN)
REMAP                 ->  the teacher question  (source: HUMAN)
REJECT                ->  nothing               (source: HUMAN)
```

### Review lifecycle

```
PENDING --> IN_REVIEW --> RESOLVED
   |            |
   +------------+--> SKIPPED --> IN_REVIEW --> RESOLVED
```

`RESOLVED` is terminal. A teacher changing their mind is a real workflow, but
it is a *different* one — reopening a settled decision silently would make the
audit trail describe something that did not happen.

### Conflicts

Remapping onto a question another answer already holds is **refused**, not
resolved automatically:

```json
{ "code": "QUESTION_ALREADY_ASSIGNED", "questionId": "...", "existingAnswerId": "..." }
```

Silently unmapping someone else's answer to satisfy this one would be a
destructive edit nobody asked for, and only the teacher can say which of the
two is right.

### Audit trail

Every action appends an event carrying the review, assessment, answer, the
original and final question, the reviewer (nullable — this assignment has no
authentication), an optional reason, and a timestamp. Events are append-only:
a review that was skipped and later accepted has two entries and neither
replaces the other. Re-running the pipeline clears mappings and reviews but
**never** the audit — it records what people actually did.

### Idempotency

A repeated action with the same target is a no-op: a double-clicked ACCEPT
leaves one audit event, not two, and the response reports `changed: false`.
A *different* action on a resolved review is a `409`, not a silent overwrite.
All writes go through the Phase 1 optimistic update, so concurrent reviewers
cannot lose each other's decisions.

## Grading

Grading answers one question per answer: how many of these marks did this
earn, and why. It runs after review, and it reads the *effective* mapping --
so a teacher's correction is what gets marked, never the AI's superseded
guess.

```
effective mapping -> mark scheme -> one bounded LLM call -> verification
                                                                |
                              app-computed total, app-computed confidence
```

### Mark schemes

Three sources, in descending order of authority:

| Source | Meaning |
| --- | --- |
| `PROVIDED` | Extracted from a mark scheme a teacher supplied |
| `GENERATED` | Derived from the question's own printed marks |
| `UNAVAILABLE` | Nothing to grade against |

The distinction is preserved everywhere rather than flattened. A grade made
against a rubric the system invented is a different claim from one made
against the examiner's, and presenting them identically would be the most
misleading thing this phase could do. Every `GENERATED` grade therefore
carries a `GENERATED_RUBRIC` review reason.

A question that prints no marks gets no scheme at all and its answer is
`NOT_GRADEABLE` with `MARK_SCHEME_UNAVAILABLE`. Inventing a mark total would
fabricate the thing being measured.

Supplied rubrics are tied to questions by the same label normalisation the
mapper uses, so `Q4`, `4.` and `Question 4` all reach the same question. A
rubric that matches nothing, matches more than one question, or whose criteria
do not sum to what the question is worth is recorded in `unresolved` with a
reason -- never attached to a best guess.

Each scheme carries a `version`: a content hash of the question id, the total
and the criteria. If a rubric is later corrected, old grades stay attributable
to the version that produced them.

### What the model is asked

One answer, one question, one rubric. The whole assessment is never sent,
because judging this answer does not require the others. The prompt
(`grading/v1`) asks for a mark per criterion with a reason, a total, a
confidence, and feedback addressed to the student. It is told to distinguish
an answer that is *missing* a point from one that states something
*incorrect*, and not to treat an `[unclear]` stretch as a wrong answer.

### What is checked afterwards

The response is a recommendation, not a result. Before anything is stored:

- every criterion id must be one that was sent -- an invented id is rejected
- every criterion must be judged exactly once
- every mark must be within its criterion's ceiling and legal under the
  granularity policy (`WHOLE` or `HALF`)
- an all-or-nothing criterion must be awarded 0 or its full value
- the model's own total must agree with its own criteria
- the total must not exceed what the question is worth

A failure throws rather than being repaired. When a grader's arithmetic
contradicts itself, its per-criterion marks are no more trustworthy than the
total it derived from them, so there is no half to keep. The application
computes `awardedMarks` from the criterion marks in every case; the model's
`totalAwardedMarks` is only ever used as a consistency check.

Criterion outcomes (`SATISFIED` / `PARTIAL` / `NOT_SATISFIED`) are derived
from the marks, not taken from the model's description of them.

### Grading confidence

A separate number from mapping confidence, and deliberately so: being sure an
answer belongs to Q4 says nothing about being sure it earned three marks.
Four weighted factors:

| Factor | What it measures |
| --- | --- |
| `rubricQuality` | A supplied rubric scores 1, a derived one 0.55 |
| `transcriptionClarity` | Drops when the answer contains `[unclear]` |
| `modelConfidence` | The model's own number -- one input, never the answer |
| `criterionClarity` | Clear-cut decisions beat a row of borderline partials |

This is an engineering signal for deciding what a human should look at, not a
calibrated probability.

### Statuses

| Status | Meaning |
| --- | --- |
| `GRADED` | Marks stand unattended |
| `REVIEW_REQUIRED` | Marked, but a human should look before it counts |
| `NOT_GRADEABLE` | No effective mapping, or nothing to grade against |
| `FAILED` | The run errored |

Marks are never withheld: a `REVIEW_REQUIRED` grade carries its full
criterion breakdown. What changes is whether anyone is asked to check it.
Review reasons are `LOW_GRADING_CONFIDENCE`, `UNCERTAIN_TRANSCRIPTION`,
`GENERATED_RUBRIC` and `DIAGRAM_NOT_ASSESSABLE` -- the last only when the
question actually asked for a drawing.

An answer that could not be graded records `awardedMarks: null`, not zero. It
has not scored nothing; it has not been scored.

### History

Grades are append-only. When a teacher remaps an answer and grading runs
again, the previous grade stays on the record with `isCurrent: false` and a
`supersededReason` naming the mapping change. So "Q4 was graded, then Q5
replaced it as the effective grading" is readable after the fact rather than
overwritten.

Re-running grading over unchanged mappings makes no further model calls; only
the answers whose effective question changed are marked again.

### Totals

`availableMarks` is the marks actually attempted and graded, not the whole
paper. Dividing by the paper total would report a student who answered half
the questions as having scored half of what they earned. The marks nobody
accounted for are reported separately as `ungradedMarks`.

## Storage

`DocumentStorageProvider` (`put` / `get` / `getStream` / `head` / `exists` /
`delete` / `deletePrefix`) hides where bytes live. Phase 2 ships a local
filesystem implementation; swapping in object storage is a new implementation
of that interface and nothing else.

Keys are opaque and server-generated, built only from UUIDs and fixed literals:

```
assessments/{assessmentId}/{documentId}/original
assessments/{assessmentId}/{documentId}/pages/{pageNumber}.png
```

An original filename is never used to build a path — it is sanitised and kept
only for display. Keys are validated (no traversal, no absolute paths, no
backslashes, no NUL) and the resolved path is re-checked against the storage
root before any I/O. No absolute path appears in an API response or an error
message.

## Design notes

**Redis holds assessment state, not just the queue.** The API and the worker
are separate processes, so a module-level `Map` in either would be invisible to
the other and the status endpoint would never reflect the worker's progress.
Redis is already a hard dependency of the queue, so it stores the state too —
still in-memory, no database, no infrastructure beyond what the queue already
needs. `InMemoryAssessmentStore` exists for unit tests.

**One job per assessment, not one per stage.** The six stage names are typed
and appear on every log line, but a single BullMQ job covers the whole
pipeline. Retry safety comes from the idempotency record instead: a replay
re-enters at the top and fast-forwards past any stage already recorded
complete.

**Idempotency key is `assessmentId + stage`.** Completed stages are recorded on
the assessment, and the runner skips them. Requesting a fresh run clears the
record, so reprocessing genuinely redoes the work.

**Preparation is idempotent at two levels.** Phase 1's stage record stops
`PREPARING` re-running once complete. Within a run, a document that is already
`READY` with every bitmap intact is reused wholesale; otherwise it is
reconciled page by page, so a retry after a mid-document failure resumes rather
than re-rasterising work that already landed. Integrity is checked by stored
size, and a page that fails the check is re-rendered — a record claiming
`READY` is not on its own evidence that it is.

**File type is decided by content, not by claims.** The declared MIME type and
the filename extension are hints; the format comes from magic-byte sniffing,
because that is the only signal a client cannot simply relabel. A mismatch is
recorded but content wins.

**Retries distinguish transient from permanent.** `AppError` subclasses carry a
`retryable` flag. Transient failures back off exponentially up to
`JOB_MAX_ATTEMPTS`; permanent ones (bad input, unknown assessment, a malformed
PDF) are wrapped in BullMQ's `UnrecoverableError` so the queue stops
immediately instead of burning its budget. Unknown errors are treated as
retryable.

**An assessment is only marked `FAILED` once the queue gives up.** An
intermediate attempt is not a terminal outcome.

**Providers are interfaces, not implementations.** `AIProvider` and
`EmbeddingProvider` are defined and injected into stage handlers; both still
throw if called, so a stage that starts using one before it is wired fails
loudly rather than silently returning nothing. `DocumentProvider` is now
implemented — it is the read side later AI stages use to fetch canonical page
bitmaps without learning where they live.

## Logging

Structured via pino. Every processing log carries `assessmentId`, `jobId`,
`stage` and `status`; document logs add `documentId`:

```
assessment.created
assessment.document.uploaded
assessment.processing.enqueued
assessment.job.received
assessment.stage.started
assessment.document.preparation.started
assessment.document.preparation.completed
assessment.document.preparation.reused
assessment.document.preparation.failed
assessment.documents.prepared
assessment.grading.started
assessment.grading.graded
assessment.grading.reused
assessment.grading.failed
assessment.grading.completed
assessment.stage.completed
assessment.stage.skipped
assessment.processing.completed
assessment.job.failed
assessment.worker.shutdown.completed
```

Document contents, transcripts, storage paths and credentials are on the
redaction list and are never logged. A grading log carries the answer and
question ids, the marks and the reasons -- never the answer text, the model's
feedback, or the criterion reasoning.

## Environment

See `.env.example`. `REDIS_URL` is required; everything else has a default.
Validated with Zod at first use — a missing or malformed value fails fast with
a message naming the offending key.

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDIS_URL` | — | Queue and state store |
| `REDIS_KEY_PREFIX` | `veda` | Namespace for every key written |
| `WORKER_CONCURRENCY` | `2` | Jobs per worker process |
| `JOB_MAX_ATTEMPTS` | `3` | Attempts including the first |
| `JOB_BACKOFF_MS` | `1000` | Exponential backoff base |
| `ASSESSMENT_TTL_SECONDS` | `86400` | How long a run stays readable |
| `STORAGE_ROOT` | `.storage` | Local document store |
| `MAX_DOCUMENT_BYTES` | `10485760` | Upload ceiling (10 MB) |
| `MAX_DOCUMENT_PAGES` | `50` | Page ceiling per document |
| `PREPARED_PAGE_MAX_DIMENSION` | `2000` | Longest edge of a prepared page |
| `GEMINI_API_KEY` | — | Server-only. Blank counts as unset. |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Centralised; never inlined |
| `GEMINI_TIMEOUT_MS` | `120000` | Per-request ceiling |
| `GEMINI_MAX_PAGES_PER_REQUEST` | `20` | Pages per extraction call |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` | Centralised embedding model |
| `GEMINI_EMBEDDING_DIMENSIONS` | `768` | Truncated + re-normalised from 3072 |
| `MAPPING_TOP_K` | `3` | Candidates that reach adjudication |
| `MAPPING_WEIGHT_LABEL/SEMANTIC/POSITION/STRUCTURE` | `.45/.35/.1/.1` | Must sum to 1 |
| `MAPPING_WEIGHT_LLM` | `0.3` | How much adjudication moves final confidence |
| `MAPPING_LABEL_CONFLICT_PENALTY` | `0.25` | Subtracted on a contradicted label |
| `MAPPING_SEMANTIC_FLOOR` | `0.65` | Cosine below which texts are unrelated |
| `MAPPING_CONFIDENCE_HIGH/MEDIUM` | `0.9/0.7` | Band thresholds |
| `MAPPING_MIN_ASSIGNMENT_SCORE` | `0.35` | Floor below which a pair is never assigned |
| `MAPPING_SKIP_ADJUDICATION_ABOVE` | `0.93` | Decisive matches skip the LLM entirely |
| `MAPPING_ADJUDICATION_DELAY_MS` | `250` | Pacing between calls, for rate-limited tiers |
| `GRADING_WEIGHT_RUBRIC` | `0.3` | Confidence weight: how much the rubric is worth trusting |
| `GRADING_WEIGHT_TRANSCRIPTION` | `0.25` | Confidence weight: legibility of the answer |
| `GRADING_WEIGHT_MODEL` | `0.3` | Confidence weight: the model's own confidence |
| `GRADING_WEIGHT_CRITERION` | `0.15` | Confidence weight: how clear-cut the decisions were |
| `GRADING_CONFIDENCE_THRESHOLD` | `0.75` | Below this, a grade goes to review |
| `GRADING_MARK_GRANULARITY` | `WHOLE` | `WHOLE` or `HALF` marks |
| `GRADING_CALL_DELAY_MS` | `250` | Pacing between grading calls |

The four grading weights must sum to 1; `getEnv()` refuses to start otherwise.

## Tests

```
tests/unit/         domain, errors, config, job config, service, validation,
                    pipeline, coordinates, file validation, storage, document/
                    question/answer preparation, labels, Gemini schemas,
                    mapping signals, confidence, assignment (Hungarian),
                    candidate generation, mapping service, review service and
                    queue, rubric resolution, grading scoring and confidence,
                    grading service
tests/api/          route handlers — assessments, documents, questions,
                    answers, mappings, reviews, grades
tests/integration/  real Redis — enqueue, delivery, retry, shutdown, and every
                    pipeline stage (prepare/extract/map/grade) through the
                    pipeline and a real BullMQ worker
tests/fixtures/     PDFs and images generated at test time, no committed blobs
```

Integration tests skip automatically when Redis is unreachable, so the suite
stays green without it. Run `npm run redis:up` before trusting a green run.

## Not in this phase

Finalisation and the entire frontend. `FINALIZING` remains a placeholder:
there is no assembled result document, no export, and no submission workflow.
Grades are computed and readable through the API, but nothing marks an
assessment as signed off.

There is also no mark-scheme upload. `resolveMarkSchemes` accepts supplied
rubrics and is fully tested against them, but no route feeds it any, so in
practice every rubric today is derived from the question's printed marks and
labelled `GENERATED`.
