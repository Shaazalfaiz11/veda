# Gemini → Groq migration

Goal: complete the assignment end to end without enabling billing. Gemini's
free tier allows 20 requests/day/model, and one run of a real paper needs
30–50, so the pipeline cannot finish on it.

Nothing about the architecture changes. The queue, worker, Redis, upload,
persistence, chunking, merge/dedup, mapping, grading and Zod validation all
stay. Only the provider behind `AIProvider` changes, and embeddings move
in-process.

## Decisions

| | Choice |
| --- | --- |
| Generation + vision | Groq |
| Embeddings | Local, in-process |
| Question extraction | Gains chunking (Groq caps images per request) |
| Gemini | Kept selectable, not deleted |

## Phase 1 — local embeddings (DONE)

`lib/providers/embeddings/local-embedding-provider.ts`, behind the existing
`EmbeddingProvider` interface. `Xenova/all-MiniLM-L6-v2` via
`@huggingface/transformers`: 384 dimensions, ~90MB, downloaded once and cached
on disk, ~9.5s to load.

Selected by `EMBEDDING_PROVIDER` (`local` | `gemini`), defaulting to `local`.
Mapping's contract is untouched — it still just receives an
`EmbeddingProvider`.

Measured separation on real question/answer text:

```
sim(photosynthesis Q, chloroplast A)  0.827
sim(photosynthesis Q, heart Q)        0.210
```

9 tests in `tests/unit/local-embeddings.test.ts`. Suite: 874 passing.

**Dependency caveat.** `@huggingface/transformers` pulls in
`onnxruntime-node → adm-zip`, which carries a high-severity advisory (crafted
ZIP triggers a 4GB allocation). Not reachable from our inputs — adm-zip only
handles the ONNX runtime's own binaries, never an upload. The `sharp`, `next`
and `postcss` advisories `npm audit` also reports pre-date this work.

## Groq facts, verified against the live API

Not from documentation alone — every number below came from a real request.

**Models available to this account** (`GET /openai/v1/models`, 14 total).
Vision-capable: `qwen/qwen3.6-27b`, `qwen/qwen3.8-27b`.

**Rate limits, from response headers — authoritative for this account:**

```
x-ratelimit-limit-requests   1000     (per day)
x-ratelimit-limit-tokens     8000     (per minute)  ← the binding constraint
```

RPD 1000 is 50× Gemini's 20 and is not a problem. **TPM 8000 is.**

**Measured token cost:** one page image + a short prompt = `prompt_tokens 1841`,
so roughly **1,600–1,850 tokens per page image**. That is what caps chunk size,
not the documented image-per-request limit.

```
2 images + prompt ≈ 4,500 in  + output   comfortable
3 images + prompt ≈ 6,100 in  + output   near the 8,000 ceiling
5 images                                 impossible on TPM
```

### Model choice: `qwen/qwen3.8-27b`

| | qwen3.6-27b | qwen3.8-27b |
| --- | --- | --- |
| images/request | 5 | 3 |
| strict `json_schema` | no | **yes** |

Chosen for **strict JSON schema support**: Groq constrains decoding so the
output cannot violate the schema. That removes the entire class of
"unparseable JSON" failures that cost days on Gemini. Its lower image limit
costs nothing, because TPM caps us at ~3 images anyway.

Verified working **together with an image** (docs did not confirm this):

```
model  : qwen/qwen3.8-27b (strict json_schema + image)
HTTP   : 200 in 1.8s
parses : YES — valid JSON
content: {"answers": []}
```

The empty array is correct — that page is a printed question paper, so there
is no student work on it, and the model did not invent any.

### The trap that cost two requests

Qwen3 models reason by default, and **reasoning consumes the completion
budget**. The first attempt returned:

```
400 json_validate_failed   failed_generation: ""
```

The model spent its whole 512-token budget thinking and emitted nothing.
**`reasoning_effort: 'none'` is mandatory** for every call. Without it the
provider fails in a way whose message points at JSON, not at reasoning.

## Planned settings

```
AI_PROVIDER=groq
GROQ_MODEL=qwen/qwen3.8-27b
ANSWER_CHUNK_PAGES=3          # TPM-bound, not API-bound
ANSWER_CHUNK_OVERLAP=1
QUESTION_CHUNK_PAGES=3
QUESTION_CHUNK_OVERLAP=1
```

Vision calls need pacing near one per minute to stay inside 8,000 TPM. Text-only
calls (mapping adjudication ~1.5K, grading ~2K) are far cheaper and can run
several per minute. The existing `*_DELAY_MS` knobs already cover both.

An 18-page sheet at chunk 3 / overlap 1 → stride 2 → **9 chunks ≈ 9–18 minutes**
for answer extraction. Slow, but it completes, which Gemini could not.

## Prompts are already provider-neutral

`buildQuestionExtractionPrompt`, `buildAnswerExtractionPrompt`,
`buildAdjudicationPrompt` and `buildGradingPrompt` live outside the Gemini
provider and are reused unchanged. Only the schemas need restating as plain
JSON Schema, since the Gemini ones use Google's `Type` enum.

## Remaining phases

2. `GroqProvider` implementing `extractQuestions`, `extractAnswers`,
   `adjudicateMapping`, `gradeAnswer` + `AI_PROVIDER` selection + error
   classification (400/401/403/429/5xx/timeout) → small 1–2 page vision test
3. Question-extraction chunking with merge/dedup, page numbers preserved,
   ≤5 pages stays a single request
4. Full answer extraction
5. Mapping
6. Grading
7. Full assignment

**Do not run the full assessment until the small vision test passes.**

## Groq requests spent so far

4 — one model listing, one failed 400 (the reasoning trap), two successful
vision calls. Of 1,000/day.
