# Implementation 025 notes

Written for: root and the independent reviewer. Branch `style-studio-encrypted-backups-021`. **Status: EVIDENCE PLUMBING ONLY. NOT RUN against any real model or benchmark.** Build 025 adds the benchmark runner that the build 024 adapter said was missing. It contains no recognizer of its own, no benchmark photos, no labels and no generated accuracy claim, and **the app is not launch-ready**: that needs a representative, licensed or consented real-photo benchmark to be acquired, human-labelled, frozen, run with this runner and to pass the approved policy. Nothing is committed or pushed.

## What was built

`npm run vision:single -- single-run-qwen --manifest M... [--receipt R...] --images-dir D --run-dir NEW [--allow-dirty-development] [--model-version V]` runs the app's real single-item analysis over a frozen benchmark and publishes a run directory. `single-adapt-qwen --run-dir` turns a **complete** run into a prediction report bound to it. Crowded and multi-item detection stays out of scope; no UI changed.

| File | Purpose |
|---|---|
| `src/server/vision.ts` | Exports `visionRequestIdentity(mode)` (prompt text hash, output schema hash, sampling options, image processing, one request hash) and `ollamaUrl()`. `analyzePhoto` and `normalizePhoto` now take the prompt, options and image sizes from the same constants the identity hashes, so they cannot drift; the request sent is unchanged. |
| `single-item/runner.ts` | Preflight, run/completion receipt schemas, strict run-directory reader, exclusive publication, lock, resume, the run loop. No model call in this module. |
| `single-item/runner-real.ts` | Binds the runner to the app: `analyzePhoto`, `normalizePhoto`, `configuredVisionModel`, `limits().inferenceTimeoutMs`, `loadLocalEnvFiles`, Ollama's model digest, `git`. Loaded lazily. `makeClassify` maps `VisionError` kinds by `instanceof`. |
| `single-item/run-binding.ts` | `RunBinding` (carried in the prediction report's run block), its validator, and `casesDigest`. |
| `single-item/integrity.ts` | New stage `"run"` (everything checkable before any labels or predictions, receipts included), and binding cross-checks at scoring. |
| `single-item/score.ts` | `runBindingProblems`: the gate precondition. |
| `single-item/cli.ts`, `scripts/vision-evaluation/run.ts` | `single-run-qwen` (async entry `runSingleRunCli`), `single-adapt-qwen --run-dir`. |
| `tests/singleItemRunner025.test.ts` | 51 tests. |
| `.gitignore` | `benchmark-images/`, `benchmark-runs/`. |
| Docs | `scripts/vision-evaluation/README.md` (a section on the runner), `docs/VISION_EVALUATION.md`, root `README.md`, `docs/DEPLOYMENT.md` (operator note), this file. |

## Design decisions

1. **The app path, exactly.** Per fixture: read the bytes, check they still hash to the frozen value, then time `normalizePhoto(bytes)` + `analyzePhoto(normalized, signal, { mode: "single" })` together. A test asserts the call contract (mode single and nothing else, the normalizer's output reaches the analyzer, one call per fixture). The record keeps the **original** frozen `imageSha256`, never the normalized copy's.
2. **Model identity.** Name from the app's own `configuredVisionModel()` (a malformed `VISION_MODEL` stops the run). Version is the digest Ollama reports for the installed model (`ollama-digest:...`); `--model-version` can only confirm it, never relabel. Prompt/request identity comes from `visionRequestIdentity("single")`, hashed in the app module from the very values `analyzePhoto` sends (prompt, `format` schema, options, image processing, `think`, `stream`). The record's `promptId` is `app-single-item:sha256:<request hash>`; the run receipt also holds the prompt hash.
3. **Fail closed before inference.** Preflight reuses build 024's `integrityProblems` (new `run` stage): manifest validity, held-out freeze receipt bound to the exact manifest file digest and `frozenAt`, prior inference, post-freeze additions, image bytes and dimensions, duplicate ids/files/hashes, cross-split leakage, mixed benchmark ids, the development manifest requirement. On top: every image must decode with the app's `normalizePhoto`, the model must be installed, the commit known and the worktree clean. Only if everything passes is any run directory created. Tests assert zero `analyze` calls and no created directory for 15 distinct failures.
4. **Dirty worktree.** Refused unless `--allow-dirty-development`, which sets `developmentOnly` in the receipts and in the run binding; the launch gate then reports NOT_EVALUATED. It cannot become launch evidence.
5. **Immutable evidence.** `run-receipt.json` first (exclusive create, in a directory only one runner can create), one `records/<id>.json` per fixture (validated, then created in place at its final path with exclusive create, see the Windows correction below), `completion-receipt.json` last (exclusive; lists every record's sha256; only when every fixture has exactly one valid record). Receipts and records are validated strictly (unknown fields refused). Records are `analyze-photo-record` v1, unchanged: Build 024 evidence and tests are preserved; binding lives in the run directory and in a new optional `run.runBinding` block of the prediction report (absent means unbound).
6. **Resume.** The existing directory is accepted only if its run receipt's `inputsDigest` equals the digest of the current inputs (manifests, receipts, fixtures and hashes, model, version, prompt/request, timeout, commit, development flag, mode, runner id). Every record is re-read and re-validated against the receipt and the manifest; refused: mismatch, truncated/corrupt/foreign JSON, foreign files, leftover temporary files, duplicates, a stale lock, a completed run. The first session's `startedAt` is kept.
7. **Concurrency.** `mkdir` without `recursive` makes new-directory creation single-winner; a `run.lock` (exclusive create) stops a second runner on the same directory; and even a runner that ignores the lock cannot overwrite a record (the final path is created with exclusive-create semantics, so a second writer gets EEXIST). Tested: two simultaneous starts (exactly one succeeds, each fixture analysed once), a second runner while the first is mid-run.
8. **Errors.** `VisionError` `timeout`, `unavailable`, `unverified` map to the same-named outcomes. `unreadable` and any other error are recorded as a failed case (`unavailable`, `error: "runner-unexpected: <ErrorType>"`, analysis null): the error type only, because messages can hold paths; counted as `unexpectedErrors` in the completion receipt. An operator interrupt (Ctrl-C) writes no record for the interrupted photo, since an interrupt is not model evidence.
9. **From run to score.** `single-adapt-qwen --run-dir` requires a complete, internally consistent run, the very manifest files the run used, and the frozen image bytes. The report's `runBinding` carries the run id, receipt digests, commit, development flag, model, version, prompt and request hashes, manifest digests and a digest of the adapted cases. **That binding is a claim until `single-score --run-dir` verifies it against the completed directory** (see Review 2 below). Loose records adapt as before but are unbound and never launch evidence.
10. **Logs.** Fixture ids, outcome and milliseconds, counts. No image bytes or base64, no model answers, no source or absolute paths (a test checks this against the real temp path), no environment values.

## Honest limits

- **Not a transaction.** A crash or power loss while a record is being written can leave a **partial final record file**, and a crash before completion leaves a run without a completion receipt. A partial record is never trusted: resume and adaptation parse every record strictly and refuse a truncated one until it is deleted by hand (check no runner is active first). A run without a completion receipt is resumable and is refused as launch evidence. While a record is being written, a reader that does not use the lock could briefly see its partial bytes; the strict parse refuses them.
- **Not signed.** Receipts are digests, not signatures. Anyone who controls the machine can fabricate a directory, or alter records and both receipts together. The binding, and its verification against the re-opened run directory at scoring time, detect accidents, hand-written bindings and later edits to individual files, not a determined forger who controls the machine and rewrites the whole directory consistently. The git commit proves which code was checked out, not that the process ran it.
- **A stale lock** (crashed runner) blocks resume until someone deletes `run.lock` by hand; that is deliberate.
- **Model version** is Ollama's digest of the installed model; it says nothing about quantization settings beyond what the digest covers, and the digest is read once at the start.
- **The runner proves what was run**, not that the benchmark is representative, lawfully sourced, correctly labelled or large enough. The policy gates still decide that, and the shipped policy is an unsigned proposal.
- **No capacity test.** Runs are sequential; they do not measure concurrency or the hosting target.
- **Nothing was run against Ollama here.** All tests use fakes. The real wiring (`runner-real.ts`: env loading, Ollama digest lookup, `git`) is covered by typecheck and by reading, not by a live run.
- **Still open, as before:** the benchmark itself (photos, rights evidence, human labels, freeze), an approved policy, public hosting, SMTP, off-site backup and capacity.

## Review 2 (independent reviewer, NOT READY): findings and corrections

The reviewer's verdict was NOT READY with one blocker and two medium findings. All were fixed; tests are in the "review 2" section of `tests/singleItemRunner025.test.ts`.

- **B1, false evidence from a hand-written binding.** `single-score` accepted any `runBinding` typed into a predictions file (the Build 024 test helper `syntheticBinding()` proved it). Now a binding is only a claim: `single-score --run-dir` re-opens the completed directory with `readCompleteRun`, refuses a development-only or dirty receipt from the directory itself, **re-adapts its records with the same function the adapter uses** (`predictionsFromRun`) and requires the supplied predictions (run block, binding, every case) to be exactly equal (`verifyPredictionsAgainstRun`). Predictions that claim a binding with no `--run-dir`, a forged binding, a binding copied from another run, or `--run-dir` with unbound predictions are refused (exit 2). Programmatic scoring (`evaluateSingle`) refuses a binding without a verified run too, and refuses a manifest whose file digest is `null` where the binding depends on it. The report carries `runVerification`. **Narrowed claim:** a prediction report is launch evidence only if it was re-derived from a complete, clean runner directory re-opened at scoring time; the verification is still unsigned and in-process callers are trusted code.
- **M1, identity sampled only at start.** The commit, worktree state, resolved model digest and the app's request identity are re-checked just before the completion receipt is written (`identityDrift`). A change, or an inability to re-check, writes **no** completion receipt: records are kept, the run is not adaptable and not resumable under the new identity. `requestSha256`, `promptSha256`, model and version are now explicit in the binding and verified at scoring against the completed run. Tests: commit change, source dirtied mid-run, model digest change, configured model change, request identity change, prompt hash change, timeout change, model unreachable at completion. **Limit:** this is a check at one more moment, not continuous monitoring; a change that happens and is reverted between checks is invisible.
- **M2, editable completion fields.** `readCompleteRun` now derives the outcome counts and the unexpected-error count from every record and compares them with the completion receipt, and checks `completedAt` is not before the run started or before the last record started. Tamper tests cover each field.
- **Low, programmatic `fileSha256 = null`:** fails closed wherever a binding depends on it. **Low, unexpected errors:** cases the runner recorded for its own faults are counted in `reliability.runnerUnexpected`, flagged per case, and add a gate precondition (NOT_EVALUATED) with only a count and error type, no details.
- **Compatibility.** Build 024 loose and development records still adapt and score; they remain unbound, carry `runVerification: null` and never launch evidence. Build 024 tests migrated their helper (a synthetic verified run); no assertion was weakened.

## Windows correction (found by root verification)

The first version published each record by writing `<id>.json.partial-...` and then calling `renameSync` to the final name. The Windows managed sandbox refuses that rename (EPERM), which failed 27 tests and every concurrency, resume and adapt path behind it. This is the second time in this line of work a link or rename assumption failed on Windows (build 024 hard links), so the rule is now explicit and tested: **publication uses open / write / fsync / close only.**

- `createExclusive` opens the FINAL path with flag `wx` (fails with EEXIST if the name exists, so nothing is overwritten), writes the bytes that were computed and validated beforehand, flushes and closes. No temporary file, no rename, no hard link.
- **Write failure rollback.** Once the open has succeeded the file is this process's own; if the write, the flush or the close then fails, that partial file, and only that file, is removed, and the original error is reported. (A failed close after a good write is reported too: the first version swallowed it, which a new test caught.)
- **Another writer wins the name.** The open fails with EEXIST: the publication is refused, the other writer's file is left exactly as found (not removed, not verified-and-adopted, not mixed into this run), and the runner stops. Resume then refuses those foreign bytes unless they are a valid record for this run.
- **A crash can leave a partial final file** (power loss between open and the end of the write). It is not a valid record, so resume and adaptation refuse it (strict parse), and the documented recovery is to delete it by hand and resume. A reader outside the lock may briefly see a partial file; it would refuse it the same way.
- **Tests added or changed.** An `ExclusiveFs` seam (default node:fs) lets tests watch and break single steps. New tests: the exact operation order for a record is open(final path) -> write -> fsync -> close and nothing else on success; a write that fails half way removes only that partial file, leaves earlier evidence byte for byte and the run resumes; fsync and close failures roll back; an EEXIST winner's file is untouched and never unlinked; a truncated final record is refused on resume with recovery by deletion; and a source guard fails if `renameSync`, `linkSync`, `copyFileSync` or a `.partial-` scheme appears in the runner or its CLI. No existing test was weakened.

## Checks

See the results appended below.

**Results (Windows, Node 24.20.0).**
- `npx tsc --noEmit`: clean. `npm run lint`: exit 0 (lints `src` only).
- `tests/singleItemRunner025.test.ts` (new): 51 tests. Together with `singleItemGate024`, `visionEvaluation` and `visionCap016`: 157 tests, 157 pass, 0 fail.
- Full `npm test`: 581 tests, 576 pass, 0 fail, 0 cancelled, 5 skipped (the same five skips as before).
- Build 024 tests needed one migration: their synthetic prediction reports now carry a valid `runBinding` (a helper in the test file), because held-out predictions without one are, by design, not launch evidence. No Build 024 assertion was weakened.
- Nothing is committed or pushed.

**Results after the Windows correction (Windows, Node 24.20.0).**
- `npx tsc --noEmit`: clean. `npm run lint`: exit 0 (lints `src` only).
- `tests/singleItemRunner025.test.ts` (now 57 tests) with `singleItemGate024`, `visionEvaluation` and `visionCap016`: 163 tests, 163 pass, 0 fail.
- Full `npm test`: 587 tests, 582 pass, 0 fail, 0 cancelled, 5 skipped (the same five skips as before). This full run was made before the final documentation-only edits; the focused run below was repeated after them.
- Not run: the Windows managed sandbox that found the failure. The fix is verified on this machine and by the source guard and spy tests above, not on that sandbox.
- Nothing is committed or pushed.

**Results after Review 2 (Windows, Node 24.20.0).**
- `npx tsc --noEmit`: clean. `npm run lint`: exit 0 (lints `src` only).
- `tests/singleItemRunner025.test.ts` (now 71 tests) with `singleItemGate024`, `visionEvaluation`, `visionCap016` and `deploymentScripts`: 181 tests, 181 pass, 0 fail.
- Full `npm test`, run after the final documentation edits: 601 tests, 596 pass, 0 fail, 0 cancelled, 5 skipped (the same five skips as before).
- Not run: Ollama or a real model, and the Windows managed sandbox; everything uses fakes and this machine.
- Nothing is committed or pushed.
