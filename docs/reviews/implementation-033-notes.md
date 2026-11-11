# Implementation 033: Linux CI backup failure, an upstream Node.js bug, and a bounded workaround

Status: the bounded workaround is implemented, **validated locally by root on Windows**, and **green on Linux CI for commit ab3500f9ea71f9f73ee67fe74eb829280c8b51bf** (see "Final Linux CI evidence"). The final independent Claude re-review, returned after the post-review test hardening, is **READY TO COMMIT BUILD 033**. The builder ran no commands; every result below was produced by root or by CI. The product is not launch-ready; nothing here changes the external launch gates.

## CI evidence

GitHub Actions run **42989064388**, commit **436e46cd71da51b284164fc7f00dc1208e576654**, `build` job **130417189972**, **Node v24.22.2** (as reported by root). `npm ci`, the runtime audit, typecheck and lint passed; `npm test` had one failure:

`tests/encryptedBackup021.test.ts:186` failed with `BackupFailure: Backup failed.` from `createBackup` via `createEncryptedBackup`, `leftovers: []`, `reason: [Error: not an error]`. The fail-closed behaviour did its job (nothing was published, nothing was left); the copy itself failed.

## Root cause: an upstream Node.js bug (not our code)

- Issue **nodejs/node#66760** (https://github.com/nodejs/node/issues/66760), fixed by merged PR **#66769** (https://github.com/nodejs/node/pull/66769), main commit **d630b5d** (2026-10-25).
- That fix is **not contained in v24.22.2** (released 2026-10-28), the version that failed our CI. No verified 24.x backport is known.
- Signature: `node:sqlite` `backup()` rejects with `code === "ERR_SQLITE_ERROR"`, numeric `errcode === 0` and message "not an error" when `sqlite3_backup_step()` first returns `SQLITE_BUSY`/`SQLITE_LOCKED` while the source connection overlaps a write transaction. Node used `remainingPages = 0` to skip rescheduling and built the error from the clean destination connection, which carries no error. A busy/locked step is documented by SQLite as retryable, not a hard error. The upstream issue documents a bounded retry classified by both `code` and `errcode 0`.
- Reproduced locally by root on Node v24.20.0: the first backup failed with exactly that shape; a retry after the overlapping write committed succeeded (1,241,088-byte file).
- In the test, the process's main connection is backed up while Better Auth's separate connection has just finished writes, which is the overlap.

This **supersedes the earlier diagnostic-only draft**, which said the cause was unknown. That claim is withdrawn, and the draft's results (focused 50/47/3/0, typecheck and lint pass, full `npm test` 757/744/13 skips/0 fail) were for the draft and are **not validation of this workaround**.

## What we changed (our workaround, distinct from the upstream bug)

`src/server/backupDatabase.ts`:

- `BackupIo` gains two injectable seams: `copyRaw(source, target)` (default `backup(source, target, { rate })`) and `sleep(ms)` (default `setTimeout`). Nothing else about the pipeline changed.
- `isUpstreamBackupBusyBug(error)`: true only when `code === "ERR_SQLITE_ERROR"` **and** the numeric `errcode` is a safe integer equal to `0`. **Never** the message text. Property reads are contained, so a getter or Proxy trap yields `false`.
- `copyRawWithRetry` wraps **only** the raw `node:sqlite` copy. Constants `COPY_MAX_ATTEMPTS = 6` and `COPY_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600]` (3.1 s total). Before each retry the failed attempt's partial (and sidecars) is removed, a fresh empty `0600` partial is created with `wx`, and only then does it wait. If the reset leaves anything behind, the backup fails closed with a `BackupCopyResetError` (fixed message; the original error is kept in its `original` property). After the bound, the last error propagates and the usual fixed `Backup failed.` is thrown.
- Unchanged and still after the copy: sanitise (delete sensitive tables, drop worker tables), VACUUM, checkpoint and `journal_mode=DELETE`, verification, fsync, no-overwrite publication by hard link, pruning. Only a verified, sanitised file is ever published. Nothing after the copy is retried.
- `describeFailure` is fully non-throwing: every property read is individually contained (getters, Proxy traps, coercion), strings pass a short allow-list or become `null`, numbers must be safe integers in 0..65535 or become `null`, and any internal failure returns a null-filled diagnostic. It can never mask the original failure, and the original thrown value is kept untouched as `reason`. The diagnostic gains `copyAttempts` and still holds no message text, path, value or secret.

### Bound and timing rationale

Overlap with an in-flight write is short (milliseconds to low seconds); six attempts with exponential waits cover a few seconds, far below the 30 s backup lock wait and a typical CI step. A persistent overlap, or any different failure, fails closed instead of looping. The delays are fixed (no jitter, no config) so behaviour is deterministic and reviewable.

### Security reasoning

- Retry is keyed on the structured `code` + numeric `errcode 0`, so unrelated errors, including a plain "not an error" message, are never retried, and an arbitrary SQLite error is never treated as success.
- Each attempt starts from an empty, owner-only partial, so data from a failed attempt can never reach the published file; publication still requires sanitisation and verification and still refuses to overwrite.
- Waiting happens inside the existing process lock, so no second backup can interleave.
- Failure output stays the fixed message; the diagnostic carries only fixed facts.

### Removal

The workaround exists only for affected Node releases. When the deployed Node includes d630b5d, remove `copyRawWithRetry` and the two seams' retry use, and keep the hardened diagnostic if wanted.

## Tests (`tests/backupDiagnostic033.test.ts`, deterministic, injected at the `copyRaw` seam)

Classifier: only code + numeric errcode 0 matches; message-only, missing/string/NaN/Infinity/negative/fractional errcode, other codes, non-objects and hostile objects do not. Retry: succeeds after N exact-signature failures (each attempt saw an empty partial, waits 100/200, one published file, no garbage or sanitised secret in it, integrity ok, no overwrite on a second backup); stops at exactly 6 attempts with waits 100/200/400/800/1600, then fails closed with nothing left; ten other error shapes are attempted once with no wait; a post-copy failure with the upstream signature is not retried. Diagnostic: per-stage reporting, exact key set, no leaked marker or path, hostile thrown objects (throwing Proxy, throwing getters, bigint/symbol/array fields, oversized strings, NaN/Infinity errcode) neither throw nor hide the failure, closed source and open write transaction visible, normal success unchanged. The upstream bug itself is **not** reproduced in-suite (it needs an affected Node and a real overlap); root reproduced it separately.

## Root's validation of the final bounded-workaround tree

All results are root's, on the local Windows tree. The earlier diagnostic-draft results remain superseded.

- **Initial focused backup/security run:** 56 total, 53 passed, 3 expected platform skips, 0 failed.
- **Typecheck:** the first run found one test-only error, TS2737 (BigInt literals unavailable below ES2020) in `tests/backupDiagnostic033.test.ts`. The literal `10n` was replaced with `BigInt(10)`, which is still a non-numeric `errcode` value, so that coverage is unchanged. Typecheck then passed, and the focused Build 033 regression file passed 11/11.
- **Lint:** passed.
- **Full `npm test`:** 763 total, 750 passed, 13 expected skips, 0 failed, about 111.1 seconds.
- **`npm run build`:** passed (exit 0) after root removed only a stale generated `.next` directory and reran cleanly. Next compiled; the launch routes remained dynamic; Windows emitted known trace-copy EPERM warnings for generated test-data paths; sanitization dropped 754,128 trace entries from 18 manifests and removed one bundled private/escaping generated path; packaging verification passed.
- **Upstream bug reproduced independently:** on local Node v24.20.0, root reproduced the exact structured signature (`ERR_SQLITE_ERROR`, numeric `errcode 0`, "not an error"), then confirmed that a second raw backup to the same target succeeds once the overlapping transaction has committed. This supports the retry design; the in-suite tests still inject the signature at the `copyRaw` seam.

## Post-review test hardening (added after the READY TO COMMIT BUILD 033 review): validated locally by root

Root's results in the section above are **historical**: they are for the tree before this hardening. The results for the hardened tree are in "Root's validation after the post-review test hardening" below.

Production (one narrow, default-neutral change): `BackupIo` gains `removePartial(dir, partialName)` (default: the existing function, unchanged), used for the between-attempt reset and the final cleanup. A failed reset now throws an exported `BackupCopyResetError` (fixed message, no path) whose `original` property keeps the exact-signature error that triggered the retry, so the reset failure is explicit and the original cause is not lost; the diagnostic reports `errorName: "BackupCopyResetError"`. The final cleanup still reports any file it could not remove in `leftovers` with the "unsanitised file could not be removed" message. Retry bound, classifier, delays and publication are unchanged. The `BackupDiagnostic.stage` comment now says a stage counts as reached before its `onStage` hook runs, so a hook that throws is reported as that stage.

Tests (`tests/backupDiagnostic033.test.ts`):

- **Sleep rejection:** a rejecting `sleep` during the retry stops the backup after exactly one copy, with the fixed message, no leftovers, nothing published, the fresh retry partial removed, `reason` equal to the sleep error, and a diagnostic that describes the wait (not a SQLite error) with no message text.
- **Reset failure:** a reset that reports a file it could not remove stops the retry before any wait or second copy, publishes nothing, keeps the exact-signature error as `reason.original`, and is explicit (`BackupCopyResetError`). A second case where the final cleanup also fails reports the unsafe partial in `leftovers` with the "could not be removed" message, and the test confirms that file is really still present (the test removes it afterwards).
- **Stronger successful-retry test:** a failed attempt now leaves garbage in the partial and all three sidecars; the next attempt must see an empty partial, no sidecars, and (off Windows only) mode `0600`.
- **Vacuous assertion removed:** the hostile-diagnostic test's `seen.calls === 0` was never wired; it now counts real `copyRaw`/`sleep` calls and asserts one copy and no wait.
- **Wording:** the per-stage test is retitled to say it injects through `onStage`.

### Root's validation after the post-review test hardening

Root's results on the local Windows tree with the hardening in place:

- **Hardened focused Build 033 file:** 14/14 passed.
- **Typecheck:** passed.
- **Lint:** passed.
- **Full `npm test`:** 766 total, 753 passed, 13 expected skips, 0 failed, about 116.8 seconds.

Not covered by these results: the POSIX `0600` mode assertion is skipped on Windows (it records `null` there), so it first executes on Linux CI. The earlier evidence (56-run focused set, 11/11 file, 763-test full run, build, and the Node v24.20.0 reproduction) is kept above as historical.

## Final Linux CI evidence

GitHub Actions run **43029214040**, commit **ab3500f9ea71f9f73ee67fe74eb829280c8b51bf** (the first Linux run of the final commit; as reported by root):

- **`build` job 130551606023: completed success.** It passed `npm ci`, the runtime dependency audit, typecheck, lint, the full `npm test` (including the previously failing `tests/encryptedBackup021.test.ts` path and the Build 033 POSIX `0600` mode assertion, which only executes off Windows), the production build, packaging verification, standalone verification, Chromium installation, and the full E2E browser tests.
- **`docker` job 130554687632: completed success.** It passed `npm ci` and the audit, the image build, startup of the mock model, app, AI worker and mail worker, the container smoke test, the encrypted backup transfer and fresh restore drill, the cleanup sweep, the Compose + Caddy smoke test (including the Build 032 launch-information routes through the app and the proxy), the log and redaction scans, and final cleanup.
- No failure annotations; the only annotations were non-failing runner/action notices.

Root's authoritative inspection of the `build` job log (130551606023) confirms it ran on **Node v24.22.2**, the affected version, and that the log contains **no** `copyAttempts`, `BackupCopyResetError` or "not an error" marker.

What this establishes: this run is green and **resolves the CI blocker that motivated Build 033** (the `encryptedBackup021` failure on Node v24.22.2 in run 42989064388): on the affected Node version the failure did not recur and the suite passed. It also supplies the Linux proof that the Build 032 live launch-route smoke passes through app and Caddy.

What it does not establish:
- **It does not prove the retry path fired.** With no `copyAttempts`, `BackupCopyResetError` or "not an error" marker in the log, the overlap probably did not occur in this run (the upstream bug is timing-dependent), so the green result may owe nothing to the workaround. The retry contract (retry only the exact signature, bounded attempts and waits, per-attempt cleanup, fail closed, no retry of anything else, reset and sleep failures) is proven by the **deterministic fault-injection tests**, not by this run. The upstream failure itself was reproduced separately by root on Node v24.20.0.
- **One green run does not prove the absence of all intermittency.** The upstream bug is timing-dependent and the workaround is bounded (6 attempts, 3.1 s), so a persistent overlap would still fail closed; later runs should be watched. The upcoming docs-only evidence commit will trigger a **second CI run**, which adds one more observation.

## Review status

The final independent Claude re-review, performed after the post-review test hardening, returned **READY TO COMMIT BUILD 033**.

## Remaining

Only what is outside this build: keep watching CI across subsequent runs, and remove the workaround once the deployed Node includes d630b5d (see "Removal"). The external launch gates below are unchanged.

## Remaining gates

Unchanged: hosting, domain and TLS, a real SMTP relay, an off-server backup with a restore tested on a different machine, capacity measured on the operator host, operator identity, legal review and monitored support, and a rights-cleared benchmark. The supported workflow remains easy single-item detection. The product is not launch-ready.
