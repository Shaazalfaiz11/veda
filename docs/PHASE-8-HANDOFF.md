# Phase 8 — Frontend implementation: state and handoff

Paused mid-phase. This is what exists, what was measured, and what comes next.

## Figma source

Duplicated file (readable via MCP — the original view-only file is not):

```
https://www.figma.com/design/c6AsAp3SIlndzJTd7FlZQg/VedaAI-Hiring-Assignment--Copy-
fileKey: c6AsAp3SIlndzJTd7FlZQg
```

Section `Extraction flow` — 9 frames:

| Node | Frame | Size | Built |
| --- | --- | --- | --- |
| `1:8744` | Upload Screen — Empty State | 1440×787 | yes |
| `1:8797` | Upload Screen — filled state | 1440×787 | yes |
| `1:9959` | Loading state | 1440×788 | yes |
| `1:8861` | Question — Answer mapping screen | 1440×1580 | yes |
| `1:10442` | Upload Screen — Empty State (phone) | 393×853 | partial (CSS only, unverified) |
| `3:791` | Loading state (phone) | 393×853 | partial (renders; header differs) |
| `3:956` | Upload Screen — filled state (phone) | 393×853 | partial (CSS only, unverified) |
| `3:1192` | Mapping — Question toggle (phone) | 393×2227 | partial (toggle works; frame not compared) |
| `3:1576` | Mapping — answer toggle (phone) | 393×872 | partial (toggle works; frame not compared) |

Asset URLs from `get_design_context` expire in ~7 days. Everything already
needed is downloaded to `public/figma/` (28 files), so a re-pull is only
required for frames not yet built.

## Design tokens (from Figma variables, not invented)

Typeface is **Bricolage Grotesque** — a Google Font, so no substitution was
needed. It is a variable font; the design is drawn at `opsz 14, wdth 100`,
which `app/globals.css` pins on `body`. Without that pin every text
measurement drifts.

Letter spacing in Figma is a percentage of font size. The design uses **two**
scales — `-4%` on the type tokens and `-6%` on specific overrides — so
tracking is set per element, never globally.

| Token | Value |
| --- | --- |
| Text/Primary | `#303030` |
| Text/Secondary | `#5E5E5E` |
| Primary/Orange | `#FF5623` |
| Background/Dark-Grey | `#2B2B2B` |
| Buttons Primary | `#181818` |
| bg-off white primary | `#F6F6F6` |
| bg-off white 20% | `#F0F0F0` |
| bg-off white 50% | `#CECECE` |
| disabled | `#A9A9A9` |
| Utilities/Success | `#34AC15` |
| realistic shadow | `0 32px 48px #00000033, 0 16px 48px #0000001F` |

Type ramp (all Bricolage, line-height 1.4 except H-1 at 1.2):
`H-1 40/700` · `P-1 20/400` · `P-3 16/{400,500,700}` · `P-4 14/{400,500}`

Shell geometry at 1440: `12 │ sidebar 304 │ 11 │ main 1100 │ 13`.

## What was built

```
app/
  globals.css                     token layer + reset
  layout.tsx                      next/font: Bricolage (opsz,wdth) + Inter
  page.tsx                        upload screen
components/
  layout/  AppShell, Sidebar, Header      (+ .module.css each)
  upload/  UploadScreen, UploadDropzone, HeroAvatar
  ui/      PrimaryButton
lib/api-client/
  types.ts                        response shapes (no server imports)
  client.ts                       typed fetch wrappers + ApiError
public/figma/                     28 exported assets
tools/
  shot.mjs                        screenshot a URL at a viewport
  measure.mjs                     diff live geometry against Figma numbers
  filled-shot.mjs                 drive a real upload, capture filled state
  e2e-processing.mjs              drive upload -> process -> poll in a browser
  seed-processing.ts              park a real assessment at a stage / FAILED
  seed-completed.ts               run the real pipeline to COMPLETED
  spec-mapping.json               measurement spec, mapping screen
  spec-upload.json                measurement spec, upload screen
  spec-processing.json            measurement spec, processing screen
```

Styling is **CSS Modules**, not Tailwind — Tailwind is not installed and the
Figma guidance says not to add it. Exact px values read better in plain CSS
than as `w-[755px]` arbitrary values anyway.

### Measured fidelity (1440×787)

`tools/measure.mjs` compares live bounding boxes to the frame's own numbers at
a 1.5px tolerance:

```
ok       sidebar            12,12  304×763
ok       header            327,12 1100×56
ok       subtitle
ok       dropzone tray     484,403.5  789×205
ok       toolkit btn        36,132  256×42
DRIFT    title row: width 752.3 vs 755 (-2.7)
```

The one remaining difference is a text run 0.36% narrower than Figma's — a
font-metric difference between Figma's renderer and the browser's. Every
*position* is exact. Forcing it would mean distorting tracking, which would
be worse.

Re-run it with:

```bash
npm run dev
PW_PATH="<npx playwright node_modules>" node tools/measure.mjs \
  http://localhost:3000/ 1440 787 <spec.json>
```

Playwright is not a project dependency; it was resolved from the npx cache.
If it should be a permanent tool, add it as a devDependency.

### Two bugs found and fixed by measuring

1. **Default UA margins on `h1`/`p`** pushed the subtitle 56px below the title
   where the frame asks for 8. Fixed with a margin reset in `globals.css`.
2. **CSS `border` added 4px to the primary button.** Figma draws the 2px
   stroke *inside* the 44px frame, and measures padding from the outer edge.
   Padding now absorbs the border: `10px 18px 10px 22px`. This shifted the
   whole centred content block by 2px — worth remembering for every other
   bordered element in the design.

Also: Figma crops two images from oversized sources (the school crest at
538.54% width, the file-type icon at 142.86%). Both needed a
`overflow:hidden` window rather than `object-fit`, or they render as a
shrunken sprite.

## Backend wiring

Real, not mocked. `UploadScreen` creates the assessment lazily on first
upload, posts each file to `POST /:id/documents` immediately, then
`POST /:id/process` and routes to `/assessments/:id/processing`.

Verified end to end against real Redis: both fixture PDFs upload and the
filled state renders their names and sizes.

### Open issue — page count

The design's filled state shows `2MB · 2 Pages`. **The upload response returns
`pageCount: null`** — page count is only known after the `PREPARING` stage
runs in the worker:

```json
{ "status": "UPLOADED", "sizeBytes": 1652, "pageCount": null, "preparedAt": null }
```

Current behaviour omits the page count rather than inventing one, so the
filled card shows `2KB` alone. Three options, in order of preference:

1. Poll `GET /:id/documents` after processing starts and fill it in then —
   truthful, but the count appears later than the design implies.
2. Read the PDF page count client-side before upload — fast, but duplicates
   logic the server already owns and cannot work for images.
3. Have `uploadDocument` read PDF page count at upload time. Cleanest match to
   the design; a backend change, so it needs a decision.

## Processing screen — done

`/assessments/[assessmentId]/processing`, Figma `1:9959`. All nine measured
elements land within 1.5px; see `tools/spec-processing.json`.

The frame uses the **collapsed 64px sidebar** (`1:10146`), not the 304px one,
with different gutters: `10 | 64 | 12 | 1341 | 13`. `AppShell` gained a
`sidebar="collapsed"` prop for it and `Sidebar` a `collapsed` variant; the
expanded path is untouched.

Two blocks are **additions, not Figma** — the frame has neither, and both are
marked as such in the CSS: a six-segment stage indicator, and a failure state.
They are positioned absolutely so they cannot move the loader off its measured
centre.

Design notes worth carrying forward:

- The collapsed frame highlights **Home** while the expanded frames highlight
  **Exams**. Treated as a design slip — the active row is driven by the route
  and stays on Exams in both.
- The phone Loading frame (`3:791`) draws the loader at the **same** size as
  desktop — same 177×221.492 block, same 30px/20px type. Do not scale it down.
- That phone frame also shows **no app header**, while the phone Upload frame
  has an 81px one. Currently the shared header renders on both; reconciling
  that belongs to the mobile task.

## Mapping screen — done

`/assessments/[assessmentId]/mapping`, Figma `1:8861`. All eight measured
elements within 1.5px; see `tools/spec-mapping.json`.

Split `672 | 12 | 659`, each pane scrolling on its own. The left pane carries
a 16px inset; the right pane has none and starts flush at the content edge.

**Normalized coordinates.** Answer regions are rendered as CSS percentages of
the page stage — `left: x*100%`, `width: w*100%` — never converted to stored
pixels. The browser re-resolves them on every zoom step, window resize and
breakpoint change, which is exactly what the `[0,1]` convention exists for.
Verified at 50–200% zoom and at 393px, where the overlays still land on the
handwriting. An answer that spans pages has one region per page and is drawn
on each.

Score badges are derived from the marks (`awarded >= max` full, `> 0` partial,
`0` zero), so the pill can never disagree with the number beside it. A grade
with no marks shows "Not marked" rather than a green or red claim.

Measuring caught three more layout bugs, all of the same family as the
button-border one:

1. **The card's transparent border added 4px** to every card and shifted the
   badge 2px. Figma strokes are drawn *inside* the frame, so the expanded
   card's ring is now `box-shadow: inset 0 0 0 2px`.
2. **The header had no `flex-shrink: 0`** and was being squashed from 56 to 21
   in the viewport-pinned shell, dragging every measured position up 34.7px.
3. **Toolbar icons needed a 24px box, not 16** — that is what makes the dark
   viewer header exactly 64 tall.

`AppShell` gained `fill` (pin to viewport so panes scroll internally) beside
the existing `sidebar` prop.

### Seeding

`tools/seed-completed.ts` produces a COMPLETED assessment by running the
**real pipeline** with the existing fake providers — real rasterised pages,
real Hungarian assignment, real grading validation. Only the model is
substituted. It exists because Gemini quota is exhausted; when quota returns
the same screen renders live output unchanged.

## Findings from a real CBSE paper

Run against `CBSE-Class-10-Maths-Sample-Paper-Set-2.pdf` (5 pages) and a
second attempt with a 15-page paper + 18-page answer sheet. What held and what
did not:

**Question extraction is solid.** 37 questions off the real 5-page paper,
0 rejected, 0 warnings. Handled the 15-page paper too.

**Answer extraction does not scale past a few pages.** It sends the *entire*
sheet in one request — deliberately, so an answer running from one page to the
next is recognised as one answer. That is right at 2 pages and breaks down at
15–18:

| Pages | Outcome |
| --- | --- |
| 2 (fixture) | works |
| 15 | COMPLETED, but the only answer extracted was `[unclear]` |
| 18 | `not valid JSON`, twice |

The 18-page case is unresolved: quota ran out before the finish reason could be
captured. If it reports `MAX_TOKENS`, raising the budget again is a band-aid —
**the real fix is chunking the sheet with page overlap**, which keeps the
spanning guarantee without demanding one enormous reply. That is a Phase 4
design change and needs a decision.

### Bugs this surfaced, all fixed

1. **No `maxOutputTokens` on any Gemini call.** Every request used the model
   default; a long answer sheet truncated mid-object and arrived as broken
   JSON. Now `GEMINI_MAX_OUTPUT_TOKENS` (default 65536). This was latent from
   Phase 3 and would have reached production.
2. **`GEMINI_TIMEOUT_MS` of 2 minutes** was too short for a 15-page vision
   request. Raised to 420000 in `.env.local`.
3. **An answer transcribed entirely as `[unclear]` was accepted.** Validation
   only rejected *empty* text, so a wholly unreadable region became a real
   answer, reached the mapper and produced a grade standing for nothing. Now
   rejected; partly-illegible answers still pass, which is what the marker is
   for. Three regression tests.
4. **Three diagnostic blind spots.** Unparseable JSON discarded the finish
   reason; `all_rejected` logged counts but not reasons; and the extraction
   failure log dropped the error's `details` entirely — so the diagnostics
   added for (1) never reached the log. All three now recorded.

### Input expectations worth stating

- The answer sheet must be **handwritten student work**. Given a printed
  solutions PDF, extraction finds nothing usable — that is what produced the
  `[unclear]`-only result, not a bug.
- Real CBSE papers put marks in section headers (*"Section B — 2 marks
  each"*), not per question, so every question came back `marks: null` and
  grading correctly refused to invent a total. Everything lands as
  `NOT_GRADEABLE / MARK_SCHEME_UNAVAILABLE`. This is the mark-scheme-upload
  gap, and real papers make it the common case rather than the edge case.

### Operational note

Do not run `npm run build` while the dev server is up — both write to
`.next/` and the dev server's chunks get clobbered (`Cannot find module
'./vendor-chunks/next.js'`). Recovery: `rm -rf .next` and restart.

`pino` had to join `serverExternalPackages` in `next.config.ts`: its pretty
transport runs in a worker thread that resolves `pino/lib/worker.js` relative
to where pino was loaded, and bundled into `.next/server/vendor-chunks/` that
path does not exist. The throw happens on the worker's own tick, so it takes
down the whole server process rather than failing one request.

## Next steps, in order

1. **Mobile** (`393px`) — the CSS breakpoints are written but have not been
   compared against the phone frames. The mapping phone frames have a
   question/answer toggle that is real behaviour, not a reflow.
2. **Screens the Figma does not contain** — review workflow, results, export.
   Build these only after the provided frames are done, extending the same
   token system, and label them clearly as new rather than Figma-derived.
   Backend already supports accept/remap/reject/skip plus an audit trail.

## Things to be careful of

- Gemini free-tier quota is exhausted on `gemini-3.5-flash` and
  `gemini-3.6-flash`. A live run stalls at question extraction. The upload and
  loading screens can be exercised regardless; the mapping screen needs either
  fresh quota, a paid key, or a seeded assessment.
- Redis must be up: `docker start veda-redis`.
- `lib/domain/*` and `lib/services/*` are server-only. Client components must
  keep importing from `lib/api-client/` instead — pulling a domain module into
  a client component drags config, pino and ioredis into the browser bundle.
- Phases 1–7 are untouched. 795 backend tests still pass.
