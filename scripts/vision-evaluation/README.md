# Offline recognition evaluation harness (build 014)

Offline and model-agnostic. It never runs a model, opens a network connection or touches the app. It validates JSON that someone else produced and scores it. It alone does not show that recognition works, and it applies no launch threshold.

Run with `tsx scripts/vision-evaluation/run.ts <command>` (no npm script was added):

- `inspect <image>...` prints sha256 and stored width/height/EXIF orientation (JPEG/PNG headers), read-only. Use it to fill `originalDimensions`.
- `adapt-qwen --record R --fixture-id ID --manifest M --images-dir D --out NEW` converts the saved `docs/verification/qwen-compact-corners-013.json` into a prediction report. The operator asserts the image; no start time was recorded, so it cannot be used for held-out scoring.
- `score --manifest M... --annotations A... --predictions P --images-dir D --out NEW [--iou 0.5]` writes a new report. `--out` must not exist; the file is created with exclusive-create. Any problem below makes it refuse (exit 2) and write nothing.

`--iou` contract: text that is not a plain decimal is a usage error (exit 1); a number outside (0, 1], such as `0`, is a scoring refusal (exit 2). Neither writes output. `evaluate()` itself revalidates every typed manifest, annotation file and prediction report, so direct library calls get the same schema, contamination and split checks as file loading.

## What scoring refuses

Missing, unreadable or hash-mismatched images; unmeasured or differing dimensions; missing, unlabeled, draft, or model-made annotations; annotation/manifest split, hash or stratum inconsistencies; a prediction for another image or an unknown fixture; a held-out fixture that is a known development image, `priorInference: true`, listed in the development manifest, or has no `splitFrozenAt`; a held-out run with no `startedAt` or one before `splitFrozenAt`; unknown fields anywhere; truncated or invalid JSON files.

Hashes, `priorInference` and `splitFrozenAt` are self-reported provenance. The harness refuses contradictions; it cannot prove split history or that an image was never inferred.

## Output rules

Boxes are normalized corners `[x1,y1,x2,y2]` in 0..1 in display (EXIF-rotated) orientation, finite, with x2>x1 and y2>y1; nothing is clipped, swapped or widened. Categories are fixed: top, bottom, dress, outerwear, shoe, accessory. One invalid item makes its whole case `invalid_output`; truncated JSON is never repaired. Failed, timeout, truncated, invalid and missing cases keep their gold in every recall, count and attribute denominator and contribute no detections.

## Reading the report

Matching is deterministic one-to-one maximum matching at the IoU threshold (class-agnostic; maximum pairs, then maximum total IoU). Read these with care:

- `detection.precision` is null when nothing was predicted by a scored case; it is never 1 for a failure. `perImage.macroPrecision` covers scored images only; `failedImages` / `precisionUndefinedImages` sit next to it.
- `categoryAccuracyGivenGeometryMatch` is conditional on a match. `categoryCorrectOfAllGold` is not.
- Attribute `correct`/`wrong`/`notPredicted` are conditional on a match of a human-labelled gold value; `goldLabelledTotal` is the unconditional denominator. Only color and pattern exist; brand, size and material are never scored.
- Empty truth with empty prediction is `emptyTruthCorrect`, with null precision/recall.
- Development and held-out are separate; each is split into `single_item`, `crowded`, `no_garment`. A split with no case is null.

## Human labelling workflow

1. Choose images with a license that allows evaluation use. Do this before any model sees them.
2. Add them to `manifests/heldout.manifest.json` (or a new development manifest): file name, hash from `inspect`, dimensions, source/author/license, `stratum`, `priorInference: false`. Set `splitFrozenAt` to the time you freeze the list. Do not edit a fixture afterwards; a changed image is a new fixture.
3. Copy `templates/annotations-*.json`. For each image a person draws each visible garment box (display orientation), picks one category, `visibility` and `truncatedByFrame`, and sets `attributes` only if they labelled color/pattern themselves. Hangers and furniture are not garments. If nothing is visible set `emptyTruth: true`.
4. Set `labelStatus` to `single_human` (or `double_human_adjudicated` after two annotators resolve differences), list annotators as `human`, set `completedAt`.
5. Only after step 4 run models, record `run.startedAt`, then `score`.

Templates here are unlabeled on purpose; no label was created or guessed.

---

# Single-item launch gate (build 024)

For the supported **easy single-prominent-item** photo workflow only. Crowded and multi-item recognition stays with the build 014 harness above, which is unchanged: the single-item files have their own schemas (`single-item-*`) and commands (`single-*`), and neither side accepts the other's files. Same rules as before: offline, never runs a model or the app, writes NEW files only (`--out` must not exist), refuses (exit 2) instead of repairing. The adapter and schemas import vocabulary constants and the result schema from `src/domain/analysis.ts` (read only) so they cannot drift from the app.

**This is a foundation. It contains no benchmark images and no labels, and no run of it shows that recognition works or that the product may launch.** The default policy is an unsigned proposal, so the gate reports `NOT_EVALUATED` until a named person approves a policy and a large enough, frozen, rights-cleared benchmark is scored. A benchmark of about 360 images (60 development, 240 held-out in-scope, 60 held-out rejection) is a *recommendation* from the research summarised in `docs/reviews/implementation-024-notes.md`, not a proven standard.

Run with `npm run vision:single -- <command>` or `tsx scripts/vision-evaluation/run.ts <command>`:

| Command | What it does |
|---|---|
| `inspect <image>...` | (build 014) sha256 and stored width/height/EXIF orientation of JPEG/PNG files. |
| `single-template --kind manifest, gold, record, policy, intake-batch or coverage --out NEW` | Writes a blank template. Manifest, gold and record templates are invalid until people fill them in. |
| `single-freeze --manifest M --images-dir D --out-manifest NEW --out-receipt NEW [--against M...]` | Validates rights, hashes, dimensions and leakage, sets `frozenAt` to now and writes the frozen manifest plus a receipt holding its exact sha256. **A held-out freeze needs `--against` the development manifest** (leakage cannot be checked otherwise) and the two outputs must be different new paths. Both files are written or neither is. Run it **before any model sees an image**. A frozen manifest is never refrozen. |
| `single-validate --manifest M... --gold G... [--receipt R...] --images-dir D [--policy P]` | All integrity checks, no predictions. With `--policy`, also fails (exit 2) if the held-out strata are below the policy minimums. |
| `single-run-qwen --manifest M... [--receipt R...] --images-dir D --run-dir NEW [--allow-dirty-development] [--model-version V]` | **Runs the app's real analysis over a frozen benchmark** (build 025): see *The benchmark runner* below. Needs Ollama and the configured model; nothing else in this folder does. |
| `single-adapt-qwen --run-dir RUN --manifest M... --images-dir D --out NEW` | Converts a **complete** runner directory into a prediction report bound to the run (the only way to get launch evidence). |
| `single-adapt-qwen --record R or --records-dir DIR, --manifest M... --images-dir D --out NEW` | Converts saved `analyzePhoto()` records into one prediction report. Each record carries the sha256 of the image it analysed; it is checked against the manifest. |
| `single-score --manifest M... --gold G... --receipt R... --predictions P [--run-dir RUN] --images-dir D --policy P --out NEW` | Writes the report: per-split metrics, the launch gate and every case. **If the predictions carry a run binding, `--run-dir` (the completed runner directory) is required**: the directory is re-opened and the predictions must equal what is re-derived from it (see below). **Both the development and the held-out manifest are required** for any held-out score, so cross-split leakage is always checked; the report says what was checked (`integrity`). |
| `single-approve --policy P --approved-by NAME --note TEXT --out NEW` | Writes a copy of a proposed policy with an approval **bound to its content by sha256** (`approval.policySha256`). Changing any threshold, minimum or note afterwards makes the approval fail and every command refuse the policy. Records who decided; says nothing about readiness. |

## Files

- **Manifest** (`single-item-manifest`): per image, immutable `sha256` and measured `dimensions`; `sceneType`; `stratum` (`in_scope` or `rejection`) and `rejectionReason`; leakage groups `sourceShootId` and `garmentId`; `priorInference`; `addedAt`; and rights evidence (`sourceCollection`, `sourcePageUrl`, `originalUrl`, `creator`, `license {id, version, url}`, `retrievedAt`, `attribution`, `modifications`, `originalSha256`, `distributedSha256`, `verifiedBy`, `verifiedAt`).
- **Gold** (`single-item-gold`): one human label per image: exactly one prominent item (`category`, coarse `color`, `pattern`, `fit` or `unknown`, observable `material` or `none_visible`/`unknown`, `box` as normalized corners, suggested `seasons` and `occasions`) or an explicit rejection. `annotation` records the human annotators, status, completion time and `modelAssisted: false`.
- **Predictions** (`single-item-predictions`) and the **saved record** (`analyze-photo-record`, one `analyzePhoto()` call per file): see the templates in `templates/`.
- **Policy** (`single-item-launch-policy`): explicit IoU settings, strata minimums and one rule per metric (`metric`, `comparator`, `threshold`, `bound` point or Wilson 95 %, `minN`, `gate` or `informational`). The validator **refuses a policy that cannot fail**: each metric has one allowed direction (a false-accept rate is bounded above, never `>=`), a threshold floor or ceiling (a run that barely works must not pass), a bound type (rates use a Wilson bound), and a `minN` that follows the policy strata (full in-scope or rejection minimum for metrics over every photo; for accuracy-on-answered, which is computed only over photos the model answered, any value from 60 % of the in-scope minimum up to the full minimum, with the coverage gates bounding abstention; the shipped proposal uses 216); minimums have absolute floors; and the policy must **gate on** category/colour/pattern/fit/material answered-accuracy and coverage, category macro F1, selection, crop, false refusal, failure rate, p95 latency, `refusal.falseAcceptRate`, `refusal.unsafeAcceptRate` and `inScope.warningRate`. The limits are the builder's guard rails, not product standards. The approval is bound to the policy content (see `single-approve`); the report prints `policy.contentSha256`.
- **Provenance fields are claims.** `priorInference`, `addedAt`, `verifiedBy`/`verifiedAt`, annotator ids and `imageHashSource` are statements by people (or by the run wrapper) that the harness checks for consistency but cannot prove. `frozenAt` is set by `single-freeze`, and the receipt proves the manifest file is unchanged since, not that no model saw the images before. `sourceCollection` is a closed list (`wikimedia-commons`, `open-images`, `self-owned-with-release`); there is deliberately no catch-all.

## What is refused (fail closed, nothing is written)

Missing or unclear rights; a licence outside the allow-list (CC0, PDM, CC BY, CC BY-SA at listed versions), so every NonCommercial, NoDerivatives, unknown or reserved licence; DeepFashion anywhere in the rights evidence; `distributedSha256` that differs from the file; hash mismatch, missing image or re-measured dimensions that differ; incomplete labels, a label for different bytes, a stratum that disagrees with the label; model-made or model-assisted labels (non-human annotator, `modelAssisted: true`, a model-like annotator id or tool); the same bytes, shoot, garment, source page or original file in two splits; a held-out split without the development manifest (or with an empty one); a policy that cannot fail, omits a required gate or whose approval no longer matches its content; a held-out image that has `priorInference`, is a known development image, or was added after the freeze; no freeze receipt, or a manifest that no longer matches it; a run that started before the freeze; labels completed after the run started; unknown fields anywhere; invalid JSON.

Too-small strata are not a refusal: the report is written and the gate says `NOT_EVALUATED` with each shortfall listed (use `single-validate --policy` to make it an error).

## Reading the report

- `selection` is the share of in-scope photos whose single returned item overlaps the human box at the policy IoU. `crop.usefulRate` also needs the item to be covered. A box the app replaced by the full frame (with its "bounds could not be verified" notice) is *not* scored as a box.
- Each attribute (`category`, `color`, `pattern`, `fit`, `material`) reports `coverage` (answered / known gold), `accuracyOnAnswered`, `endToEndCorrect` (abstentions and failures count as misses), macro F1 and per-class rows. An **abstention** is the model listing the attribute in `uncertain`, the app's `Unsorted` category, an empty colour/pattern, a **blank material** (naming no texture is not credited as "none visible"; material accuracy is computed only where the model named a texture), or fit `unknown`. Gold `unknown` fit/material is excluded from scoring and only checked for overclaiming. Free-text colour/pattern is mapped to the gold vocabulary by a fixed table; text that cannot be mapped is **wrong**, never guessed.
- `refusal.falseAcceptRate`: rejection photos the app accepted as a clean item with no notice at all (strict, silent accepts only). `refusal.unsafeAcceptRate`: rejection photos where an item came back **without the notice that fits the reason** (silent, a crop-only notice, or a multiple-items notice on a photo that is not a multiple-items case); the per-reason table splits refused / accepted with a fitting notice / unsafe / silent / failed. `inScope.warningRate`: in-scope photos that came back with a multiple-items or crop-unverified notice, so a model that warns about everything fails. A shoe-pair notice (two shoes merged into one pair) is carried through and counted, never penalised. `falseRefusal`: in-scope photos where it returned no item. Failed, timed-out, invalid, unverified and missing cases keep their gold in every denominator and count in `reliability.failureRate`.
- Latency is the nearest-rank p50/p95/max over every case that ran; one missing duration makes latency not evaluated.
- The model's `confidence` is stored as `selfConfidence` and **never used as correctness** (the app caps it at 0.5 whenever doubts are listed; the adapter refuses a record that breaks that cap). `seasons` and `occasions` are suggestions: informational Jaccard only, and a policy may not gate on them.
- Verdict: a policy that fails validation is refused (no report). A report scored with the relaxed synthetic policy checks (tests only, never the CLI) always has verdict `NOT_EVALUATED`; only its per-check statuses are informative. `NOT_EVALUATED` if the policy has no approval, no held-out predictions exist, or a stratum is below the policy minimum; otherwise `FAIL` if a gate rule fails, `NOT_EVALUATED` if a gate rule lacks `minN` observations, and `PASS` only if every gate rule passes. The held-out split alone decides.

## The benchmark runner (build 025)

`single-run-qwen` is the one place in this folder that calls a model, and it does so only through the app: each photo goes through `normalizePhoto()` and then `analyzePhoto(normalized, signal, { mode: "single" })` from `src/server/vision.ts`, the same exported functions the analysis worker uses. There is no alternate recognizer. It reads the same environment files as the app and the worker (`VISION_MODEL`, `OLLAMA_URL`, `STYLE_INFERENCE_TIMEOUT_MS`), so it measures the configuration the app would run. Crowded and multi-item analysis is out of scope.

Flags: `--manifest` (one or more; a held-out run needs the development manifest too), `--receipt` (the held-out freeze receipt, required for any held-out fixture), `--images-dir`, `--run-dir` (a NEW directory, or an existing one to resume), `--allow-dirty-development` (see below) and `--model-version` (optional; it can only confirm what the runtime reports, never relabel it). The model name comes from the app's `VISION_MODEL`; the model **version** is the digest Ollama reports for the installed model; the prompt/request identity is a sha256 computed by `visionRequestIdentity("single")` in `src/server/vision.ts` from the exact prompt text, output schema, sampling options and image processing `analyzePhoto` uses.

**Preflight (before any inference).** Nothing reaches `analyzePhoto`, and no file is created, unless the whole run passes: every manifest valid; a freeze receipt bound to the exact held-out manifest file digest and `frozenAt`; no prior inference, no post-freeze additions; images present with the exact frozen bytes and dimensions; no duplicate ids, files or hashes; no cross-split leakage (including the development manifest); one benchmark id; every image decodable by the app's `normalizePhoto`; the model installed in Ollama; the app git commit known and the worktree clean.

**Dirty worktree.** The commit is part of the evidence, so uncommitted changes are refused. `--allow-dirty-development` permits a development-only run: it is recorded as `developmentOnly` in the receipts and in the prediction report's run binding, and the launch gate then reports NOT_EVALUATED. It can never become launch evidence.

**The run directory.**

```text
run/
  run-receipt.json          written first, exclusively: inputs digest, commit, model, version, prompt/request hashes, mode, timeout, startedAt, manifest and receipt file digests, every fixture
  records/<fixture-id>.json one analyze-photo-record v1 per fixture, validated, then created in place with exclusive create (no temp file, no rename)
  completion-receipt.json   written LAST, only when every fixture has exactly one valid record; lists each record's sha256
  run.lock                  present only while a runner holds the directory
```

Per fixture the runner hashes the exact bytes (the record keeps the frozen original hash, never the normalized copy's), then times `normalizePhoto` + `analyzePhoto` together. `VisionError` kinds map exactly: `timeout`, `unavailable` and `unverified` keep their names; any other error (including an unreadable image or a bug) is recorded as a failed case, `unavailable` with `runner-unexpected: <ErrorType>` and no output, and counted in the completion receipt. Ctrl-C writes no record for the interrupted photo.

**Resume.** Run the same command with the same `--run-dir`. An existing directory is accepted only if its run receipt matches all current inputs (manifests, receipts, images, model and version, prompt/request, timeout, commit, development flag); every existing record is re-validated and skipped. Refused: any difference, a damaged or truncated record, foreign JSON or files, a leftover temporary file, a duplicate, a stale `run.lock`, or a run that is already complete. Delete a stale lock or temporary file by hand only after checking no runner is active.

**Adapting and scoring.** `single-adapt-qwen --run-dir` refuses an incomplete run ("incomplete: N of M"), an edited record, receipt or completion, and manifests or images that differ from the run. The prediction report it writes carries a `runBinding` (run id, receipt digests, commit, development flag, model, version, prompt and request hashes, manifest digests, a digest of the adapted cases). **A binding in a predictions file is only a claim.** At scoring time `single-score --run-dir` re-opens the completed directory (`readCompleteRun`), refuses a development-only or dirty receipt on the directory's own evidence, re-adapts its records and requires the supplied predictions (run block, binding and every case) to be exactly equal; predictions that claim a binding without `--run-dir`, a hand-written binding, or a binding for another run are refused (exit 2). The report then states `runVerification` (run id, completion digest, request hash, model version). Held-out predictions that are not so verified (loose records, no binding) still score, but the launch gate adds a precondition and the verdict is NOT_EVALUATED. Cases the runner recorded for a fault of its own (`runner-unexpected: <ErrorType>`) are counted in `reliability.runnerUnexpected` and also stop a launch verdict; only the error type is ever reported.

**Identity is re-checked before completion.** The commit, worktree cleanliness, installed model digest, configured model, the app's request identity (prompt, schema, options) and the timeout are sampled at the start and again just before the completion receipt is written. If any changed (source edited mid-run, a model re-pulled), no completion receipt is written: the records stay as evidence of what happened, the run cannot be adapted for launch evidence, and it cannot be resumed under the new identity. The completion receipt's outcome counts, unexpected-error count and completion time are re-derived from the records on every read, so editing them is refused.

**Limits, stated plainly.** The directory is an append-only log with checks, not a transaction or a signed ledger. A crash or power loss can leave a partial final record file (refused as corrupt; delete it by hand after checking no runner is active, then resume) or a run without a completion receipt (resume it). Files are published with open/write/fsync/close only: Windows sandboxes refuse rename and hard links. The lock stops cooperating runners only; a runner that ignores it still cannot overwrite a record (exclusive create). Anyone who controls the machine can fabricate a directory; the binding and its scoring-time verification detect accidents, hand-written bindings and later edits, not a determined forger who controls the machine and rewrites the directory consistently. The runner proves what was run, not that the benchmark is representative, lawfully sourced or correctly labelled. **It creates trustworthy evidence plumbing; the app is not launch-ready until a representative, licensed or consented real-photo benchmark has been acquired, human-labelled, frozen, run with this runner and has passed the approved policy.**

## Operator workflow

1. Choose images whose rights you verified one by one (Wikimedia Commons or Open Images files, not DeepFashion). `inspect` them; fill the manifest (`single-template --kind manifest`).
2. `single-freeze` the held-out manifest (and freeze development) **before any inference**.
3. Have people label every image (`single-template --kind gold`); `single-validate`.
4. `single-run-qwen` over the frozen manifests (a clean worktree, the receipts, the images). It checks everything first, then runs the app's `analyzePhoto` and publishes one record per image plus a run receipt and a completion receipt.
5. `single-adapt-qwen --run-dir`, then `single-score` with a policy the owner approved. Keep every output; nothing is overwritten.

The older loose-records path (`--record` / `--records-dir` with a wrapper of your own) still works for development, but its predictions carry no run binding and the gate treats them as **not launch evidence**.

---

# Rights-cleared photo intake and gold labels (build 026)

Build 026 is the front half of the single-item benchmark: **collecting rights-cleared real photos, labelling them with two independent people, choosing the split with explicit coverage, and freezing it.** It produces the manifests, gold files and freeze receipts that `single-validate`, `single-run-qwen` and `single-score` already consume. Crowded and multi-item photos stay out of scope. **It measures nothing**: no model is run, no accuracy is computed, and a READY report here is not a launch decision. The repository contains no photos; everything below happens on a private, git-ignored workspace (`benchmark-intake/`).

**What may be imported.** Only files the operator supplies (JPEG, PNG or WebP, up to 40 MB, shortest side at least 224 px). Nothing is downloaded and no public fashion dataset is read or depended on: DeepFashion is non-commercial only, ModaNet is CC BY-NC, and Fashionpedia does not own its image copyrights, so all three are refused by name wherever they appear in rights evidence. Every photo needs its own rights evidence, checked by a person:

| Field | Rule |
|---|---|
| `sourceType` | `self-captured`, `contributor-consent` or `open-license`. Nothing else: "unknown", "public-web", "scraped", "other" are refused. |
| `rightsHolder` | The author or holder. **Private**: stored only in the intake record, never in a report, a manifest of a private source, or an error message (manifests carry a pseudonymous `rh-...` reference). |
| `acquiredAt` | ISO date, 1995 or later, not in the future. |
| `evaluationPermission` | Must be `true` (permission to evaluate a model on the photo). |
| `redistributionAllowed` | Recorded (`true`/`false`), never assumed. An allow-listed open licence cannot say `false`. |
| `individuallyVerified`, `verifiedBy`, `verifiedAt` | A person checked THIS photo; `verifiedBy` is a pseudonym (`op-...`). |
| `consent` | `contributor-consent` only: a consent reference and date. |
| `openLicense` | `open-license` only: collection (`wikimedia-commons` or `open-images`), source page and file URL (https), an allow-listed licence (CC0, PDM, CC BY, CC BY-SA at known versions; every NC/ND licence refused) and attribution. |

**People.** A photo with a person (`personsPresent`, which a `worn` scene implies) is refused unless `modelRelease` is present: a release reference, its date, and `coversEvaluation: true`. Reviewers also flag `personVisible`; a person a reviewer sees that the import did not declare excludes the photo.

**What the importer refuses, writing nothing.** Executables and disguised files (content is sniffed, the name does not decide), an extension that does not match the content, bytes after the end of the image (a hidden payload), truncated or undecodable or animated images, symbolic links and junctions, hard-linked files, names with separators, `..`, drive letters, `:streams`, trailing dots/spaces or Windows device names, a real path outside the source directory, a file whose size or modification time changes while it is read, a photo that claims prior inference, an existing output (nothing is overwritten), the same bytes twice, and a **near-duplicate** (perceptual hash, also mirrored, plus a colour grid) that does not declare the same shoot and garment as the photo it resembles. A batch is all or nothing: every file is examined before anything is copied, and if a write fails the files that one call created are removed. Original file names are not stored. Each record keeps the exact sha256, dimensions, EXIF orientation, a perceptual signature, the batch digest and a provenance receipt (source hash, copied hash, stable read).

**Labels.** `single-label-template` writes a blank review per reviewer (a different image order each). A review records, per image: the exact image hash, start and finish times, `personVisible`, the outcome (`single_item`, `reject` with a reason, or `unsure`), and for an item its category, colour, pattern, localisation box (normalized, EXIF-rotated display orientation), fit, material, seasons and occasions, with `unknown` allowed where the photo does not show a value. Reviewers are pseudonyms (`rv-...`; an email, a name or a model-like id is refused). **Held-out labels need two reviews** by different reviewers in different sessions; boxes agree at IoU 0.75. If they disagree, a **third** person adjudicates only the disagreements (never an agreement) and must finish after both. The result is an ordinary `single-item-gold` file the unchanged validator accepts. One reviewer posing as two, a shared session, a verbatim copy, identical full-precision boxes, identical notes or identical timestamps are refused.

**Sampling and freeze.** `single-sample` assigns reviewed photos to development or held-out from a coverage spec and a seed a person wrote down. Shoots, garments and near-duplicates are union-grouped and never split. The spec must be at least as strict as the launch policy (in-scope and rejection totals, every category) and may require minimums for colour, pattern, background, lighting, camera, item size and wearable type. Item size comes from the gold box; wearable type from the scene. Every shortfall is reported as `have of need`. `single-intake-freeze` re-derives the plan, refuses a stale or edited one and any deficit, and writes `development` and `heldout` manifests, gold files, freeze receipts and separate image folders into a NEW directory, then seals the workspace (`seal.json`): afterwards nothing sharing a shoot, garment or near-duplicate with a held-out photo can be imported, and a second freeze is refused.

| Command | What it does |
|---|---|
| `single-template --kind intake-batch` / `--kind coverage --out NEW` | Placeholder templates that fail validation until people decide. |
| `single-intake-init --workspace NEW --benchmark-id ID` | Creates the private workspace (never reused). |
| `single-intake-import --workspace W --batch FILE --source-dir DIR --operator op-xxxxxx` | Validates and imports one batch, all or nothing. |
| `single-label-template --workspace W --reviewer rv-xxxxxx [--adjudicates rv-a,rv-b] --out NEW` | Blank review (or adjudication of disagreements only). |
| `single-label-submit --workspace W --review FILE` | Validates and stores a review; a reviewer id and a session are used once. |
| `single-label-verify --workspace W --reviewers rv-a,rv-b [--adjudicator rv-c] [--development-single-review]` | Counts final labels, agreements, adjudications, exclusions; exit 2 on any independence problem. |
| `single-sample --workspace W --coverage FILE --policy FILE --reviewers ... [--adjudicator ...] --out NEW` | Writes the deterministic plan and prints every deficit. |
| `single-intake-freeze --workspace W --plan FILE --coverage FILE --policy FILE --reviewers ... --out-dir NEW` | Freezes and seals. |
| `single-intake-report --workspace W [--coverage FILE --policy FILE --reviewers ...] --out NEW` | Privacy-safe READY / NOT READY for collection and freeze only. |

**The report** has counts and generic blockers only: no holder, reviewer, operator, file name, URL, release reference or image id, and an explicit statement that no accuracy is measured.

**Manual steps no tool can do.** Obtain or capture the photos and keep the proof (consent forms, signed releases, licence pages) somewhere private; fill the batch honestly; use real pseudonyms and keep the name-to-pseudonym list elsewhere; have genuinely different people review without conferring; choose the coverage minimums and the seed; approve the launch policy; then run `single-run-qwen` and `single-score` (above).

**Limits, stated plainly.** Rights evidence is attestation: the tool does not fetch URLs, read releases or confirm a licence is what it claims. It cannot prove two pseudonyms are two people or that reviewers did not talk; copy detection is a heuristic. There is no face detection: a person nobody declared and no reviewer flagged would pass. Near-duplicate detection misses heavy crops, edits and different shots of one garment (the shoot and garment groups cover those if declared honestly). The workspace is unsigned: someone who controls the machine can rewrite records and the seal consistently. A crash can leave a pool file without its record or a half-built freeze directory (reported or refused, deleted by hand); rollback covers ordinary failures only. Sealing is procedural: the tool refuses imports and refreezing but the files are on disk. The default coverage numbers and the item-size thresholds are the builder's proposal, not standards. Greedy selection is deterministic, not optimal, and reports shortfalls rather than hiding them. Decoding untrusted images uses libvips (via sharp), limited to 80 megapixels, on operator-supplied files only.
