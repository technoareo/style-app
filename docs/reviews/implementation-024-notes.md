# Implementation 024 notes

Written for: root and the independent reviewer. Branch `style-studio-encrypted-backups-021`, on top of the committed build 023. **Status: FOUNDATION ONLY. NOT RUN against any real benchmark.** It adds the tooling and policy a production launch gate for the supported easy single-prominent-item photo workflow would need. It adds no benchmark images, no labels and no model output, and **it makes no claim that recognition works or that the product is ready to launch.** Application runtime behaviour is unchanged (no file under `src/` was edited; `compose.yaml`, `Dockerfile` and `deploy/` are untouched).

## Process incident: commit a288df1

The original build 024 task said **do not commit or push**. The prior builder nevertheless created commit `a288df1` ("build 20", Techno Areo, 2026-11-02) containing the whole first build 024 implementation, and it was pushed. That breached the explicit no-commit instruction. It is recorded here, not hidden: the reviewed code is already in history. **This correction pass is deliberately left uncommitted for root review**; nothing in it has been committed or pushed, and the diff against `a288df1` is the review surface.

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
| `cli.ts`, `templates.ts` | `single-template`, `single-freeze`, `single-validate`, `single-adapt-qwen`, `single-score`, `single-approve`; blank templates. |
| `templates/*.json` | Static copies of the templates (a test keeps them equal to the generator). |
| `tests/singleItemGate024.test.ts` | The tests (below). |

`package.json` gains `vision:single` (`tsx scripts/vision-evaluation/run.ts`). `scripts/vision-evaluation/README.md` documents the commands, files, refusals and report.

## Design decisions

1. **A new schema family, not an edit of the old one.** Build 014's `fixture-manifest`/annotations describe crowded multi-garment boxes; changing them risked its compatibility. The single-item files have their own `kind`s; each validator refuses the other's files (tested).
2. **The manifest is what is frozen; labels are separate.** The manifest fixes bytes, split, groups and rights before inference. `single-freeze` sets `frozenAt`, writes the manifest and a receipt with the sha256 of the written file; scoring refuses a manifest that no longer matches its receipt, a fixture count that changed, a run that started before the freeze, and labels completed after the run started.
3. **Rights fail closed.** Licence is an allow-list of (id, version) pairs: CC0 1.0, PDM 1.0, CC BY and CC BY-SA 2.0/2.5/3.0/4.0. NonCommercial, NoDerivatives, unknown and reserved are refused with a specific message. Every rights field must be present; `distributedSha256` must equal the file; with no declared modification the original hash must equal it. The allow-list admits BY-SA on the reading that evaluation use needs no derivative distribution; that is a legal judgement for the owner, not settled here.
4. **Leakage is checked across splits** on bytes, fixture id/file, source shoot, garment, source page, original URL and original file hash. Sharing a garment or shoot inside one split is allowed. Near-duplicate images (re-encodes, crops) are **not** detected; only the declared groups and exact hashes are.
5. **Gold is human or nothing.** Annotators must be `kind: "human"`; `modelAssisted` must be `false`; ids/tools/notes that look like a model or script are refused (conservative: an annotator literally named "Ai" would be refused and must be renamed).
6. **Abstention is explicit.** An attribute is abstained when the model lists it in `uncertain`, the category is `Unsorted`, colour/pattern is empty, a blank material is returned, or fit is `unknown`. The model's numeric confidence is **never** used as correctness; the adapter stores it as `selfConfidence` and refuses a record that breaks the app's cap (confidence above 0.5 beside listed doubts), since such a record did not pass through `analyzePhoto`. A test runs the real `refineSingleItem` to show the cap and the adapter agree.
7. **Scoring rules.** Failed, timed-out, invalid, unverified and missing cases keep their gold in every denominator. Gold `unknown` fit/material is excluded and only checked for overclaiming. Unmappable colour/pattern text is wrong, not guessed. The app's full-frame fallback box (with its "bounds could not be verified" notice) is not scored as a box. Free-text colour mapping is a fixed, documented table; "black and white" and unknown words are unmapped (so a two-tone garment the model describes in two colours counts wrong).
8. **Gate semantics.** Held-out only. a policy that fails validation (or whose approval no longer matches its content) is refused; `NOT_EVALUATED` if the policy has no approval record, no held-out predictions exist, or a stratum is below the policy minimum; else `FAIL` if any gate rule fails, `NOT_EVALUATED` if any gate rule has fewer than `minN` observations, `PASS` only if all gate rules pass. Wilson 95 % bounds are available per rule (a lower bound for "at least", an upper bound for "at most"). Seasons and occasions are informational only and the policy validator refuses to gate on them.
9. **The default policy is a proposal.** Its numbers (for example category accuracy lower bound 0.90, false-accept upper bound 0.10, latency p95 120 s) are the builder's proposals for the owner, not a standard and not derived from user research; latency limits are explicit placeholders. It has no approval, so the shipped configuration can never report `PASS`; an approval is bound to the policy content by digest (see the correction pass).

## Correction pass (reviewer NOT READY)

The independent reviewer returned NOT READY on the first build 024. Every finding was fixed and tested (tests in `tests/singleItemGate024.test.ts`, section "build 024 correction pass").

- **B1, a policy that cannot fail.** The validator accepted `falseAcceptRate >= 0`, `latency.p95Ms >= 0`, `minN: 1`, IoU 0.01 and an approved policy that omitted gates. It now has a per-metric table (`METRIC_SPECS`): one allowed comparator direction, a threshold floor (for `>=`) or ceiling (for `<=`) so a run that barely works cannot pass, thresholds that could never be met are refused, rates must use a Wilson bound (macro F1 and latency a point value), and `minN` must follow the policy strata (equal to the in-scope, rejection or all-case minimum; at least 40 % of the in-scope minimum for fit and material, which are computed on subsets). Minimums have absolute floors (`POLICY_FLOORS`: 100 in-scope, 40 rejection, 10 per category, 10 per required scene, 5 per rejection reason), at least three required scenes, and the per-stratum minimums must fit inside the totals. The IoU settings have floors. A complete required gate set is enforced (selection, crop, false refusal, failure rate, p95 latency, answered-accuracy and coverage for category, colour, pattern and fit, material accuracy, category macro F1, silent and unsafe false accept, in-scope warning rate); an informational rule does not count. The limits are the builder's guard rails, **not product standards**. A bounded set of sample-size rules can be relaxed (`relaxedSampleChecks`) so synthetic tests with a dozen images can run; direction, strictness, required gates and the approval digest are never relaxed, the CLI never relaxes, and a relaxed report says so (`policy.validation`, plus a statement that it is not launch evidence). `evaluateSingle` validates the policy itself, so a vacuous or tampered policy is refused, not scored.
- **B2, held-out scoring without the development manifest.** Fail closed: any manifest set that contains a held-out split but no non-empty development manifest is refused at freeze, validate and score, because cross-split leakage (bytes, shoot, garment, source page, original URL, original file hash) would otherwise be unchecked. The report now carries an `integrity` block (splits checked, whether cross-split leakage was checked, the leakage keys, fixture counts).
- **M1, approval not bound to content.** The approval carries `policySha256`, the sha256 of the **canonical** policy content (object keys sorted at every depth) without the approval record. The validator recomputes it; a changed threshold, minimum, IoU, rule, version or note makes the approval fail. The report exposes `policy.contentSha256` and `documentSha256`. `single-approve` writes the bound approval (records the approver, the time and the note; refuses an already-approved policy, an existing output and the input path). The binding proves the approved content is the content scored; it cannot prove who really approved it. Templates and the README are updated.
- **M2, a notice counted as safe.** The strict `refusal.falseAcceptRate` (silent clean accepts only) is kept. Added `refusal.unsafeAcceptRate`: a rejection photo where an item came back without the notice that fits the rejection reason (silent, crop-only, or a multiple-items notice on a photo that is not a multiple-items case); and `inScope.warningRate`: in-scope photos that came back with a multiple-items or crop-unverified notice. Both are required gates, so a model that warns about everything fails (in-scope warnings) and a model that attaches the wrong notice fails (unsafe accept). The per-reason table now splits refused, accepted with a fitting notice, unsafe, silent and failed. Failed cases are not accepts; they count in the failure rate.
- **Low items.** The adapter carries the app's shoe-pair notice (`shoePairNotice`), reported and never scored or penalised. A blank material is an abstention, not a correct "none visible": material accuracy is computed only where the model named a texture, so a model cannot score by naming nothing. A consequence is that the material gate is NOT_EVALUATED when a model names too few textures; the owner may prefer to gate `material.visibleMaterialRecall`. `single-freeze` refuses the same path for manifest and receipt (and an output equal to the input), and writes both files or neither on ordinary failures (each file created exclusively at its final path with precomputed bytes, and every file created removed on any failure; see the Windows follow-up). The policy digest is canonical and independent of key order. The catch-all `other-verified` source collection is removed; the list is closed. Provenance fields are documented as claims in the manifest type and the README.

## Checks run (Windows, Node 24.20.0)

The first build 024 checks below are from before the correction pass; the correction-pass counts are in the next section.

- `npx tsc --noEmit`: clean. `npm run lint`: exit 0 (it lints `src` only, so it does not cover the new scripts; `tsc` does).
- `tests/singleItemGate024.test.ts` (new): 31 tests, 31 pass. Together with `tests/visionEvaluation.test.ts` and `tests/visionCap016.test.ts` (the existing evaluation suite, unchanged): 83 tests, 83 pass, 0 fail.
- Full `npm test`: 507 tests, 502 pass, 0 fail, 0 cancelled, 5 skipped (the same five skips as before this build).
- The tests cover: the valid path and byte-identical deterministic output under shuffled input; every rights boundary (missing fields, non-https URLs, NC/ND/unknown/reserved/unlisted licences and versions, DeepFashion, hash and modification contradictions); manifest boundaries (unmeasured dimensions, post-freeze additions, prior inference, missing decisions, duplicates); gold boundaries (model-made or model-assisted labels, incomplete or malformed labels, rejections with items); integrity (hash mismatch, missing or re-measured images, missing/extra/mismatched labels); cross-split leakage on seven keys; contamination (known development image, missing or stale freeze receipt, early run, late labels, wrong or unknown fixtures); too-small strata; selection and crop by IoU/coverage; abstention; unmappable text; rejection and false-accept accounting; failure and missing cases in every denominator; thresholds, boundary equality, minimum samples, unapproved policy, FAIL-before-NOT_EVALUATED; Wilson bounds; latency percentiles; self-confidence having no effect; seasons/occasions never gating; gold-unknown exclusion and overclaiming; macro F1; the adapter (including the real `refineSingleItem` cap); policy validation; templates; an end-to-end CLI run in a temp directory with freeze, validate, adapt, score, no-overwrite and tampering; and compatibility with the build 014 harness.

## Known gaps and limits

- **The guard-rail limits are judgement.** The floors, ceilings and policy-minimum floors in the validator are the builder's, chosen to stop a policy that every run meets; the owner may tighten them (they are code constants, changed by review). They are not a standard.
- **An approval proves content, not people.** The digest shows the scored policy is the approved one; the approver name is typed text.
- **Material gate depends on the model naming textures.** If a model rarely names one, material accuracy is NOT_EVALUATED rather than passed (by design); see the low items above.
- **Prediction schema.** `shoePairNotice` is a new required case field in `single-item-predictions` v1 (the schema had not been used on real data).

- **No data.** There are no benchmark images, labels or real prediction records in the repository. The tests use synthetic images (PNG headers) and synthetic labels; they test the machinery, not any model.
- **No wrapper that calls the app.** `single-adapt-qwen` reads saved `analyze-photo-record` files (a documented shape, template provided). The operator must write the small program that calls `analyzePhoto()` per frozen image, records the image hash, start time and duration, and saves the record. The record shape is the harness' own definition; it was not captured from a real run, and `analysis` is validated with the app's real `reviewAnalysisSchema`.
- **Self-reported provenance remains.** Hashes, `priorInference`, `frozenAt` and `addedAt` are claims the harness checks for consistency but cannot prove; a receipt proves the manifest file did not change after freezing, not that no model saw the images before.
- **Rights are evidence, not legal advice.** The tool checks that rights evidence is complete and on the allow-list; it does not fetch pages or verify that a licence statement is true.
- **Attributes are scored independently of box selection**, so a model that picked the wrong item can still score an attribute correct by chance; selection and crop are reported next to them.
- **Prediction timeouts and latency** depend on the operator's wrapper recording honest durations; a missing duration makes latency not evaluated rather than assumed.
- **Metrics on small samples are not meaningful.** With the shipped policy the gate stays `NOT_EVALUATED` until at least 240 in-scope and 60 rejection held-out images exist.
- **Not covered:** crowded or multi-item recognition, brand/size (never scored), real-world capacity or hosting, SMTP, offsite backup, a public domain, and any launch readiness. Those remain open as recorded in earlier notes.

## Checks after the correction pass

- `npx tsc --noEmit`: clean. `npm run lint`: exit 0 (lints `src` only).
- `tests/singleItemGate024.test.ts`: 47 tests, 47 pass (31 earlier, 16 new for B1, B2, M1, M2 and the low items).
- Full `npm test`: 523 tests, 518 pass, 0 fail, 0 cancelled, 5 skipped (the same five skips as before).
- No file under `src/` changed. Nothing is committed or pushed; the working tree is left uncommitted for root review.

## Windows follow-up: freeze publication without hard links

Root ran the focused test on the Windows managed environment: 45 pass, 2 fail, because `writeAllOrNothing` used `linkSync` and Windows returned EPERM when linking the temp manifest to its final path (CLI end-to-end, and the atomic freeze test).

**Change.** `writeAllOrNothing` (now exported from `single-item/cli.ts`) no longer uses temp files or hard links. Each file is created exclusively at its final path (`openSync(..., "wx")`, which fails with EEXIST instead of overwriting, on every platform) with bytes computed beforehand, so content and digests are deterministic. A file counts as ours as soon as it is opened; if any later open or write fails, every file this call created is removed (including a half-written one) and the error is rethrown. No temp files exist, so none can be left behind.

**Preserved:** no overwrite, collision refusal (same path, input path, existing path, a directory on the name), two outputs or neither on ordinary failures, deterministic bytes, receipt digest equal to the manifest file's bytes.

**Unavoidable limit, stated honestly.** This is rollback, not a transaction. Without an atomic multi-file primitive, a crash or power loss between the two creates can leave the manifest without its receipt, and a concurrent reader could see the manifest first. It fails closed: scoring refuses a held-out manifest with no receipt. Rollback itself is best effort (an unlink can fail, for example under an antivirus lock, and a leftover file would then have to be removed by hand; the original error is still reported).

**Tests.** New test `writeAllOrNothing never overwrites, rolls back ... (no hard links)` covers success bytes and digests, an existing second path, an existing first path, a missing directory for the second file, a directory squatting on the second name, no leftover files, and that the source contains no `linkSync`. The freeze CLI tests (no temp files left, receipt hash equals file bytes, incomplete freeze leaves nothing) now run on the Windows path.

**Results (Windows, Node 24.20.0).**
- `npx tsx --test tests/singleItemGate024.test.ts`: 48 tests, 48 pass, 0 fail.
- `npx tsc --noEmit`: clean. `npm run lint`: exit 0 (lints `src` only).
- Full `npm test`: 524 tests, 519 pass, 0 fail, 0 cancelled, 5 skipped. One earlier full run showed 518 pass, 1 fail in `tests/concurrency.test.ts` (the SQLite "database is locked" stress test, a `WriteContentionError` after the 10 s budget under load). That file is unrelated to this change (no `src/` change), passes alone (7 of 7), and the next full run was clean. It looks load-sensitive; it was not investigated further.
- Nothing is committed or pushed.

## N1 follow-up: accuracy gates were unreachable

**Finding (reviewer).** The validator gave every in-scope metric a `minN` of exactly the in-scope minimum (240), but category, colour and pattern accuracy are computed only over photos the model answered. The shipped coverage gates (0.95 category, 0.90 colour and pattern) allow 228 or 216 answers, so even a compliant model with perfect accuracy left the accuracy gates NOT_EVALUATED, and the validator forbade lowering `minN`. PASS was practically unreachable.

**Fix.**
- New basis `inScopeAnswered` for `category/color/pattern.accuracyOnAnswered`: `minN` may be any value from 60 % of the in-scope minimum (144 for 240) up to the full minimum. 60 % sits below the lowest coverage floor (0.7 colour/pattern, 0.8 category), so a policy that passes its coverage gates always has enough answers to be evaluated; the coverage gates, not `minN`, bound abstention. Fit and material keep the existing subset range (40 % to 100 %).
- The shipped proposal (now `1.2.0-proposed`) uses `minN` 216 for the three accuracy rules (90 % of 240, exactly the answers the 0.90 coverage gate guarantees). Template regenerated.
- Metrics over every photo (selection, crop, coverage, macro F1, false refusal, failure rate, latency, rejection rates) still demand the full minimum. All required-gate, direction, threshold, bound, floor and approval-digest protections are unchanged.

**Relaxed checks no longer display a verdict.** A report scored with `relaxedSampleChecks` now has a precondition ("relaxed sample-size checks (synthetic use only); no launch verdict is given") and so its overall verdict is always NOT_EVALUATED; per-check statuses remain visible. Gate-logic tests read the would-be verdict from the check statuses (`verdictOf` in the test file), and a test asserts a synthetic report never contains a PASS verdict.

**Production-scale tests** (240 in-scope + 60 rejection synthetic photos, shipped policy, production checks, no relaxation): ~95 % answered with perfect accuracy reaches a real PASS (category 228 answered, colour and pattern 216, every gate passing); half answered leaves accuracy NOT_EVALUATED and coverage FAIL; 216 answers evaluate the accuracy gate, 215 do not; a model answering nothing is never a PASS; with a valid stricter-sample policy and coverage passed, too few answers give an overall NOT_EVALUATED verdict; validator range tests (143 refused, 144, 216 and 240 accepted, 241 refused; full-sample metrics unchanged). These use synthetic images and labels and prove the gate arithmetic is reachable, not that any model passes.

**Results after the N1 follow-up (Windows, Node 24.20.0).**
- `npx tsx --test tests/singleItemGate024.test.ts`: 54 tests, 54 pass, 0 fail.
- `npx tsc --noEmit`: clean. `npm run lint`: exit 0 (lints `src` only).
- Full `npm test`: 530 tests, 525 pass, 0 fail, 0 cancelled, 5 skipped. (The `tests/concurrency.test.ts` stress test that flaked once earlier passed in this run.)
- Nothing is committed or pushed.
