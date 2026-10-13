# Implementation 016 notes

Written for: root and the next independent reviewer.

Status of this file: part 1 of build 016 only (photo analysis limits). The lock-path work proposed in `build-015-fixture-corrected-claude.md` section 5 is NOT done and is not part of this change.

## Part 1: photo analysis limits (decided with the owner)

Problem observed on this machine (Ollama on CPU, `size_vram: 0`): a crowded closet photo made the model write 2,048 tokens (the output bound) in 508 s. The worker job failed at 301 s, not at the inference timeout: the app asked for a non-streamed answer, and Node's HTTP client gives up waiting for response headers after about 5 minutes, so no `STYLE_INFERENCE_TIMEOUT_MS` value could help. (The 301 s cause is inferred from the timing; it was not confirmed in the HTTP client.) The failure showed the generic "unavailable, not counted" message.

Owner decisions: item limit 6; when the limit is hit, show the partial result with a warning to upload a better photo; fold into build 016.

### Changes

- `src/domain/analysis.ts`: `MAX_DETECTED_ITEMS = 6`; the model output schema (`visionOutputSchema`) now has `maxItems: 6`; the prompt says "List at most 6 garments, the most prominent ones"; `CROWDED_WARNING` text. `analysisSchema` keeps `.max(30)` so results stored before this change still parse.
- `src/server/vision.ts`:
  - The request is streamed (`stream: true`) and read line by line (`readChatAnswer`); a server that answers with one JSON body (compact or pretty) is read the same way. Only the explicit inference deadline (`STYLE_INFERENCE_TIMEOUT_MS`) ends a slow answer; answers over 2,000,000 characters are refused.
  - `num_predict` 2048 becomes 1100 (six items at about 85 tokens plus the warning).
  - Items past the limit are dropped; a result with 6 items gets `CROWDED_WARNING` appended to the model's warning.
  - `done_reason: "length"` (answer cut at the bound, incomplete JSON) fails as `unverified` with a message that names too many items. Charged as a model result, like other unverified answers.
  - Deadline reached while the caller has not aborted: new `VisionError` kind `"timeout"` with `TOO_SLOW_MESSAGE`. A caller abort stays `"unavailable"`.
- `src/server/analysisJobs.ts`: kind `"timeout"` is recorded as a refundable server failure with the specific message (`failure_kind` still `server`, attempt not counted, as before); the too-many-items message is kept for `unverified` instead of the generic retry text.
- `src/components/UploadDialog.tsx`: a "photo tips" paragraph before upload (one to three items, laid flat or hung apart, plain background, good light, no overlap, up to 6 items listed, a full rack or closet will not work well). The crowded warning reaches the user through the existing `warning` notice.
- `tests/visionCap016.test.ts` (new, 8 tests, mock Ollama on a private port): request is streamed with the item limit and a bounded output; streamed, compact and pretty answers; limit boundary (5 vs 6 items); a model that ignores the limit; cut-at-bound message; malformed list still `unverified`; error line and non-200 are `unavailable`; caller abort versus the real 10 s deadline.

### Evidence

Typecheck (`npx tsc --noEmit`) and source lint: clean. `tests/visionCap016.test.ts`: 8/8 pass (10.7 s). `tests/queue007.test.ts`, `tests/contention.test.ts`, `tests/accounts.test.ts`: 11 + earlier tests shown passing in one run (the output was filtered to pass/fail lines; the full suite was not run). Real model, real code path (`analyzePhoto` on the owner's closet photo, deadline 900 s): 255 s, 6 items, crowded warning present; the previous behaviour was 508 s and a failed job. A single-shirt photo took 78 s before this change (not re-measured).

### Known limits

- 255 s is longer than the 240 s default deadline. On this CPU-only host a crowded photo still reaches the deadline unless `STYLE_INFERENCE_TIMEOUT_MS` is raised (for example 420000, applied to the app and the worker). It now ends with the specific "took too long" message instead of the generic one. The default was NOT changed.
- Detection quality on a crowded photo is poor (six "printed shirt" entries, five filed as Shoes). The limit bounds time; it does not make the list correct. Review before adding is already required in the UI.
- Whether Ollama builds other than this one honour `maxItems` is not established; the code cuts to the limit regardless, and `num_predict` bounds the rest.
- Not changed: the 768 px model input, the model, evidence/box field lengths (shortening them is a further saving not taken), admission estimates.
- The browser flow for the crowded-photo warning and the tips text was not exercised after this change.
