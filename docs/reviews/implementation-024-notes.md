# Implementation 024 notes

Written for: root and the independent reviewer. Branch `style-studio-encrypted-backups-021`, on top of the committed build 023. **Status: FOUNDATION ONLY. NOT RUN against any real benchmark.** It adds the tooling and policy a production launch gate for the supported easy single-prominent-item photo workflow would need. It adds no benchmark images, no labels and no model output, and **it makes no claim that recognition works or that the product is ready to launch.** Application runtime behaviour is unchanged (no file under `src/` was edited; `compose.yaml`, `Dockerfile` and `deploy/` are untouched).

## Why this build

The only real-model evidence so far is 3 development photos, run on CPU, 75 to 132 seconds each. That is not an accuracy measurement and says nothing about held-out photos. Crowded and multi-item detection stays deferred; this build concerns only the easy single-item path (`analysisMode: "single"`, the app default).

## Research input (as relayed to the builder)

The task statement summarised Perplexity primary-source research. I did not see the research itself, so the points below are the relayed conclusions, not independently checked here:

- **Recommended** eventual benchmark of about **360 images**: 60 development, 240 frozen in-scope held-out, 60 frozen rejection/retake. This is a *recommendation*, not a proven standard (and not an established one); the build encodes it only as the proposed policy's minimums, which the owner can change.
- Source images **only from individually verified Wikimedia Commons / Open Images files**, with a **per-image rights manifest**.
- **DeepFashion is non-commercial and must not be used.** The harness refuses it by name wherever it appears in the rights evidence.

## Scope (what was built)

New folder `scripts/vision-evaluation/single-item/`, reusing the build 014 harness rather than replacing it (its validators `check.ts`, `image.ts`, `geometry.ts`, `evaluate.ts` `EvaluationRefusal`, `manifest.ts` `KNOWN_DEVELOPMENT_SHA256`, the `types.ts` categories and the CLI conventions are reused; `scripts/vision-evaluation/run.ts` now routes `single-*` commands to the new CLI and leaves every other command to the unchanged build 014 CLI).

| File | Purpose |
|---|---|
| `vocab.ts` | Closed gold vocabularies (category, coarse colour, pattern, fit, material, scene, rejection reason), the licence allow-list, and the deterministic free-text to gold mapping for colour and pattern. |
| `manifest.ts` | `single-item-manifest` v1 and the freeze receipt: immutable hash and measured dimensions, split, freeze time, `priorInference`, leakage groups (`sourceShootId`, `garmentId`), scene type, supported or rejection reason, and the full rights evidence. |
| `gold.ts` | `single-item-gold` v1: exactly one prominent item or an explicit rejection; category, colour, pattern, fit-or-unknown, observable-material-or-unknown, box, suggested seasons/occasions; human annotator provenance, `modelAssisted: false`. |
| `predictions.ts` | `single-item-predictions` v1: what one run produced in the harness vocabulary. |
| `adapter.ts` | The qwen single-item adapter for saved `analyzePhoto()` records (`analyze-photo-record` v1). |
| `integrity.ts` | Cross-file checks that fail closed, and strata counting. |
| `policy.ts` | `single-item-launch-policy` v1, its validator and the proposed, unsigned `DEFAULT_POLICY`. |
| `score.ts` | Deterministic per-case scoring, aggregation, Wilson intervals, latency percentiles and the launch gate. |
| `cli.ts`, `templates.ts` | `single-template`, `single-freeze`, `single-validate`, `single-adapt-qwen`, `single-score`; blank templates. |
| `templates/*.json` | Static copies of the templates (a test keeps them equal to the generator). |
| `tests/singleItemGate024.test.ts` | The tests (below). |

`package.json` gains `vision:single` (`tsx scripts/vision-evaluation/run.ts`). `scripts/vision-evaluation/README.md` documents the commands, files, refusals and report.

## Design decisions

1. **A new schema family, not an edit of the old one.** Build 014's `fixture-manifest`/annotations describe crowded multi-garment boxes; changing them risked its compatibility. The single-item files have their own `kind`s; each validator refuses the other's files (tested).
2. **The manifest is what is frozen; labels are separate.** The manifest fixes bytes, split, groups and rights before inference. `single-freeze` sets `frozenAt`, writes the manifest and a receipt with the sha256 of the written file; scoring refuses a manifest that no longer matches its receipt, a fixture count that changed, a run that started before the freeze, and labels completed after the run started.
3. **Rights fail closed.** Licence is an allow-list of (id, version) pairs: CC0 1.0, PDM 1.0, CC BY and CC BY-SA 2.0/2.5/3.0/4.0. NonCommercial, NoDerivatives, unknown and reserved are refused with a specific message. Every rights field must be present; `distributedSha256` must equal the file; with no declared modification the original hash must equal it. The allow-list admits BY-SA on the reading that evaluation use needs no derivative distribution; that is a legal judgement for the owner, not settled here.
4. **Leakage is checked across splits** on bytes, fixture id/file, source shoot, garment, source page, original URL and original file hash. Sharing a garment or shoot inside one split is allowed. Near-duplicate images (re-encodes, crops) are **not** detected; only the declared groups and exact hashes are.
5. **Gold is human or nothing.** Annotators must be `kind: "human"`; `modelAssisted` must be `false`; ids/tools/notes that look like a model or script are refused (conservative: an annotator literally named "Ai" would be refused and must be renamed).
6. **Abstention is explicit.** An attribute is abstained when the model lists it in `uncertain`, the category is `Unsorted`, colour/pattern is empty, or fit is `unknown`. The model's numeric confidence is **never** used as correctness; the adapter stores it as `selfConfidence` and refuses a record that breaks the app's cap (confidence above 0.5 beside listed doubts), since such a record did not pass through `analyzePhoto`. A test runs the real `refineSingleItem` to show the cap and the adapter agree.
7. **Scoring rules.** Failed, timed-out, invalid, unverified and missing cases keep their gold in every denominator. Gold `unknown` fit/material is excluded and only checked for overclaiming. Unmappable colour/pattern text is wrong, not guessed. The app's full-frame fallback box (with its "bounds could not be verified" notice) is not scored as a box. Free-text colour mapping is a fixed, documented table; "black and white" and unknown words are unmapped (so a two-tone garment the model describes in two colours counts wrong).
8. **Gate semantics.** Held-out only. `NOT_EVALUATED` if the policy has no approval record, no held-out predictions exist, or a stratum is below the policy minimum; else `FAIL` if any gate rule fails, `NOT_EVALUATED` if any gate rule has fewer than `minN` observations, `PASS` only if all gate rules pass. Wilson 95 % bounds are available per rule (a lower bound for "at least", an upper bound for "at most"). Seasons and occasions are informational only and the policy validator refuses to gate on them.
9. **The default policy is a proposal.** Its numbers (for example category accuracy lower bound 0.90, false-accept upper bound 0.10, latency p95 120 s) are the builder's proposals for the owner, not a standard and not derived from user research; latency limits are explicit placeholders. It has no approval, so the shipped configuration can never report `PASS`.

## Checks run (Windows, Node 24.20.0)

- `npx tsc --noEmit`: clean. `npm run lint`: exit 0 (it lints `src` only, so it does not cover the new scripts; `tsc` does).
- `tests/singleItemGate024.test.ts` (new): 31 tests, 31 pass. Together with `tests/visionEvaluation.test.ts` and `tests/visionCap016.test.ts` (the existing evaluation suite, unchanged): 83 tests, 83 pass, 0 fail.
- Full `npm test`: 507 tests, 502 pass, 0 fail, 0 cancelled, 5 skipped (the same five skips as before this build).
- The tests cover: the valid path and byte-identical deterministic output under shuffled input; every rights boundary (missing fields, non-https URLs, NC/ND/unknown/reserved/unlisted licences and versions, DeepFashion, hash and modification contradictions); manifest boundaries (unmeasured dimensions, post-freeze additions, prior inference, missing decisions, duplicates); gold boundaries (model-made or model-assisted labels, incomplete or malformed labels, rejections with items); integrity (hash mismatch, missing or re-measured images, missing/extra/mismatched labels); cross-split leakage on seven keys; contamination (known development image, missing or stale freeze receipt, early run, late labels, wrong or unknown fixtures); too-small strata; selection and crop by IoU/coverage; abstention; unmappable text; rejection and false-accept accounting; failure and missing cases in every denominator; thresholds, boundary equality, minimum samples, unapproved policy, FAIL-before-NOT_EVALUATED; Wilson bounds; latency percentiles; self-confidence having no effect; seasons/occasions never gating; gold-unknown exclusion and overclaiming; macro F1; the adapter (including the real `refineSingleItem` cap); policy validation; templates; an end-to-end CLI run in a temp directory with freeze, validate, adapt, score, no-overwrite and tampering; and compatibility with the build 014 harness.

## Known gaps and limits

- **No data.** There are no benchmark images, labels or real prediction records in the repository. The tests use synthetic images (PNG headers) and synthetic labels; they test the machinery, not any model.
- **No wrapper that calls the app.** `single-adapt-qwen` reads saved `analyze-photo-record` files (a documented shape, template provided). The operator must write the small program that calls `analyzePhoto()` per frozen image, records the image hash, start time and duration, and saves the record. The record shape is the harness' own definition; it was not captured from a real run, and `analysis` is validated with the app's real `reviewAnalysisSchema`.
- **Self-reported provenance remains.** Hashes, `priorInference`, `frozenAt` and `addedAt` are claims the harness checks for consistency but cannot prove; a receipt proves the manifest file did not change after freezing, not that no model saw the images before.
- **Rights are evidence, not legal advice.** The tool checks that rights evidence is complete and on the allow-list; it does not fetch pages or verify that a licence statement is true.
- **Attributes are scored independently of box selection**, so a model that picked the wrong item can still score an attribute correct by chance; selection and crop are reported next to them.
- **Prediction timeouts and latency** depend on the operator's wrapper recording honest durations; a missing duration makes latency not evaluated rather than assumed.
- **Metrics on small samples are not meaningful.** With the shipped policy the gate stays `NOT_EVALUATED` until at least 240 in-scope and 60 rejection held-out images exist.
- **Not covered:** crowded or multi-item recognition, brand/size (never scored), real-world capacity or hosting, SMTP, offsite backup, a public domain, and any launch readiness. Those remain open as recorded in earlier notes.
