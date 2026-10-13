# Implementation 007 notes: review batch A (sections 3.1–3.4, 3.6, 3.7)

Author: Claude (VS Code). **Nothing was run.** I had Read/Glob/Grep/Edit/Write only, so no typecheck, lint, test, build or browser run happened. Codex runs all checks. Every claim below is "implemented as written", not "verified".

**Not production ready after this batch.** Still required later: dense wardrobes (3.5), durable mail (3.8), erasure/retention (3.9, see `docs/verification/RETENTION_FINDING.md` and `retention-canary.json`), fresh-server restore (3.10), plus all external gates (Docker, TLS, SMTP, capacity, restore drill, recognition benchmark). `release-snapshots/build-006` was not touched.

## What changed, by requirement

### 1. Admission, ETA, deadlines, refunds

- `src/server/limits.ts` (new): every runtime bound with a default and an env override. Invalid or out-of-range overrides are ignored (default used), so a typo cannot disable a bound. Read on every call.
- Admission (`checkAdmission` in `analysisJobs.ts`), in this order: one active job per account (409, body carries `code:"active-job"` and `jobId`); global cap (default 20, 503 + `Retry-After`); **wait budget**: `(jobsAhead + 1) × perJobEstimate + reviewBudget` must fit in the 1-hour photo lifetime, otherwise 503 with `retryAfterSeconds` and `estimatedReadyMs`; daily chargeable allowance (429, retry until UTC midnight); daily attempts (429).
- Per-job estimate = `max(STYLE_ANALYSIS_ESTIMATE_MS, min(1.25 × mean of the last 5 completion durations, inference timeout))`. Default floor 120 s, review budget 10 min. Measured speed can only raise it. Durations live in the new anonymous `analysis_timings` table (no user id).
- Every job view returns `createdAt`, `expiresAt` (= upload + 1 h, absolute), `serverNow`, and for queued/running `position`, `estimatedStartMs`, `estimatedReadyMs`. The running job counts as a full job ahead (conservative).
- Client (`UploadDialog.tsx`, `analysisClient.ts`): polls until the server says terminal; the only client-side limit is `expiresAt + 30 s` corrected for clock skew. The fixed 15-minute cancellation is gone. Capacity errors show a retry hint (`retryText`).
- Quota: `usage_daily.count` (chargeable) and new `usage_daily.attempts` (never refunded, default cap 40/day). A refund flips `analysis_jobs.refunded` with a conditional UPDATE and moves `count` only if that UPDATE changed a row, so it happens at most once whichever of sweep, worker or user gets there first (`refundLocked`).
  - Refunded: cancel while **queued**; failure kind `server` (model unreachable, timeout, 5xx, missing input, worker lost after max attempts); `expired` before completing.
  - Not refunded: completed (even if discarded), model output that failed validation (`unverified`, kind `model`), **cancel of running inference**, discard of a finished result.
- Pre-processing failures (unreadable/oversize/over-limit images) are never charged because the charge happens only at enqueue, after decode.

### 2. Discovery, resume, retained results, background processing

- `GET /api/analysis-jobs` (new): owner from the session only; lists queued/running/completed/failed within the 1-hour window (max 5, newest first, no result payloads, cancelled omitted). Read-only.
- `GET /api/analysis-jobs/:id` still returns the result and no longer has any delete-on-fetch behaviour; the client no longer calls cancel on completion. The result stays until explicit save/discard (DELETE) or expiry.
- Dialog: closing (X, Escape, "Continue in background") only stops watching. Separate explicit buttons: "Cancel analysis" (while processing), "Discard these photo results" (while reviewing). Both show a failure message if the server did not confirm. Saving reviewed items discards the server copy.
- On open, the dialog asks the server for the account's job and follows/restores it; a duplicate upload (409 `active-job`) resumes that job.
- `AnalysisBanner` + `useAnalysisJobs`: the wardrobe app shows "Photo analysis in progress…" or "ready to review" from any tab with a button into the dialog. Polls every 6 s only while a job is active.
- Review progress on the same device: `sessionStorage` key `style-review:<accountId>:<jobId>` holding choices, crop bounds and dismissed pair suggestions (no photos), max 200 KB, at most 30 drafts, validated field-by-field on read. It is only read after the server confirmed that job for the signed-in account; keys for other accounts are purged on dialog open; mismatched payloads are deleted. The privacy copy in the dialog states what is held where.
- Fallback: when resuming without the original upload (reload before storage existed), the duplicate-photo hash is computed from the server's normalized image instead, so that one duplicate check can miss across a resume.

### 3. Prompt abort, cancel quota, shutdown

- `runWorkerTick` starts a **read-only watcher** (default every 1 s, `STYLE_JOB_WATCH_MS`; `watchIntervalMs` option for tests). It aborts the model request when: the row is gone (account deleted via FK cascade), status is no longer `running` (cancelled), the lease differs or `worker_state.owner` is not this worker, or `created_at + 1 h` has passed.
  - cancel / deleted / lease: nothing is written (the row already says what happened).
  - expired: records the expiry failure (refunded).
  - the worker's own shutdown signal: the job is returned to `queued`, `started_at` cleared and the attempt given back (previously it was failed). If that write cannot get the lock, the existing lease sweep requeues it.
- Sequential worker, lease/owner-guarded finish and late-result suppression are unchanged.
- `DELETE /api/analysis-jobs/:id` uses `account(req, true, { quota: false })`: origin, session and `X-Style-Account` binding are still enforced; the 120/min change counter is skipped; a separate in-memory bound of 300 cancels/min/account applies.
- `UploadDialog` surfaces cancel failures (`Could not cancel: …`) instead of ignoring them.

### 4. Semaphore and early admission

- `src/server/admission.ts` (new): process-wide semaphore (state on `globalThis` because Next bundles routes separately): `STYLE_IMAGE_CONCURRENCY` 2 running, `STYLE_IMAGE_QUEUE` 6 waiting, `STYLE_IMAGE_WAIT_MS` 15 s; beyond that 503 + `Retry-After: 5`. Shared by `/api/analyze` and `/api/photos`; wraps body read + header inspection + decode. It is released before any database write and never held while waiting for the write gate, and the guarded function never opens a transaction, so it cannot nest with the write gate.
- Order in `POST /api/analyze`: origin/session/account binding/change quota → read-only admission pre-check (active job, global, wait budget, daily) → `Content-Length` check → semaphore { body read with size cap and 20 s stall timeout → consent → data-URL decode → header inspection → decode/normalize } → atomic re-check + enqueue in one write transaction. `/api/photos`: same shape with a read-only storage pre-check (account bytes/count, global bytes) first and the existing atomic check kept.
- `src/server/imageAdmission.ts` (new): the claimed MIME type is never trusted (only a `data:image/(jpeg|png|webp);base64,` prefix is required; the format is sniffed). Dimensions come from `sharp(...).metadata()` (header only) and are checked **before decode**: longest side ≤ 2400, pixels ≤ 6,000,000, single frame, format in {jpeg, png, webp}. Decoded bytes ≤ 2,500,000; body ≤ `ceil(bytes/3)×4 + 64 KiB`. `sharp` decode additionally uses `limitInputPixels` = the pixel bound. Hash and owner are computed/taken server-side as before (sha256 of the re-encoded bytes; owner from the session).
- Phone and legacy uploads: the client still canvas-normalizes to ≤1600 px JPEG. `fitDataUrl` (new in `images.ts`) is applied in `serverRepository.upload`, so imported backups and old photos larger than 1600 px or ~1.3 MB are re-encoded client-side before upload.
- `vision.normalizePhoto(bytes, maxPixels = 32,000,000)`: default unchanged so existing tests and scripts still pass; routes pass the 6 MP bound.
- `compose.yaml`: `mem_limit: 1536m` and `NODE_OPTIONS=--max-old-space-size=768` on `app` as starting values. **Docker untested.** `docs/DEPLOYMENT.md` has a table of every limit.

### 5. Dress code, warmth, shoe pairs

- Upload review shows "Dress code" (Not sure / Casual / Smart / Formal) and optional "Warmth" (Not sure / Light / Medium / Warm), all selects, default "Not sure", no required typing. The model's guess is stored as `aiFormality`, shown as "AI guessed 'formal'; it is not applied unless you choose it" with a "Use this" button, and stripped on save. "Details checked" still gates saving; dress code does not.
- `src/domain/pairs.ts` (new): `suggestShoePairs` suggests only for two `Shoes` detections with usable (not full-frame) boxes that overlap or are within 0.12 of each other and whose areas differ by ≤4×; each detection is in at most one suggestion. Colour is not used. `mergeShoePair` gives the union crop, a name like "Pair of shoes", combined evidence, min confidence and `reviewed:false`. The dialog regenerates the crop from the union box, so nothing merges without the user pressing "Merge as one pair"; "Keep separate" dismisses. Two bags (Accessories) are never suggested.

### 6. Migrations

`migrateApplicationSchema` (database.ts), exported, run in `runReady` after `APPLICATION_SCHEMA`, under the existing `schema.lock`, the in-process write gate and an asynchronously retried `BEGIN IMMEDIATE`. Additive and idempotent:

- `analysis_jobs`: `started_at INTEGER`, `finished_at INTEGER`, `refunded INTEGER NOT NULL DEFAULT 0`, `failure_kind TEXT` (each added only if missing via `PRAGMA table_info`)
- `usage_daily`: `attempts INTEGER NOT NULL DEFAULT 0`, then `UPDATE usage_daily SET attempts = count WHERE attempts < count`
- new `analysis_timings(finished_at, duration_ms)` + index; new index `analysis_jobs_user_status_idx`
- new `schema_migrations(id, applied_at)`, row `007-queue-metadata` (`INSERT OR IGNORE`)

Nothing is dropped, recreated or rewritten; queued jobs keep their photo and become resumable (position computed from `created_at`/rowid). An old build still running during a rolling upgrade keeps working (new columns are nullable or defaulted).

## Exact bounds (defaults)

| Bound | Value |
|---|---|
| Upload bytes / side / pixels | 2,500,000 / 2400 px / 6,000,000 |
| Body cap | `ceil(bytes/3)×4 + 65,536`; body stall timeout 20 s |
| Image work | 2 concurrent, 6 queued, 15 s wait, then 503 + Retry-After 5 |
| Active jobs | 1 per account, 20 global |
| Per-job estimate | max(120 s, min(1.25 × recent mean, 240 s)) |
| Review budget | 10 min inside the 60 min lifetime |
| Inference timeout | 240 s |
| Watcher | 1 s |
| Daily | 20 chargeable, 40 attempts per account per UTC day |
| Cancel | not counted in the 120/min change quota; 300/min separate bound |
| Review storage | 200 KB, 30 drafts, tab-scoped |
| Job list | 5 newest, last hour |
| Pair suggestion | gap ≤ 0.12, area ratio ≤ 4, not full-frame |

## Changed and new files

New: `src/server/limits.ts`, `src/server/admission.ts`, `src/server/imageAdmission.ts`, `src/app/api/analysis-jobs/route.ts`, `src/services/analysisClient.ts`, `src/domain/pairs.ts`, `src/hooks/useAnalysisJobs.ts`, `src/components/AnalysisBanner.tsx`, `tests/pairs.test.ts`, `tests/admission.test.ts`, `tests/queue007.test.ts`, `tests/migration007.test.ts`, `tests/e2e/review007.spec.ts`, this file.

Changed: `src/server/access.ts` (RequestError extras, Retry-After, quota-exempt option, read timeout), `src/server/analysisJobs.ts` (rewritten around the above), `src/server/database.ts`, `src/server/vision.ts`, `src/app/api/analyze/route.ts`, `src/app/api/photos/route.ts`, `src/app/api/analysis-jobs/[id]/route.ts`, `src/components/UploadDialog.tsx`, `src/app/page.tsx`, `src/services/images.ts`, `src/data/serverRepository.ts`, `compose.yaml`, `README.md`, `docs/DEPLOYMENT.md`, `tests/e2e/api.spec.ts` (one added test).

Untouched: all 23 backend and 13 browser tests as written. I expect them to pass unchanged. `scripts/analysis-worker.ts` is unchanged (same `runWorkerTick` signature).

## Intended behaviour changes relevant to existing tests

- `enqueueAnalysisJob` returns a full job view (extra fields); old assertions on `.id`/`.status` still hold.
- A server-side failure now reads "Photo analysis was unavailable and this attempt was not counted…" instead of the generic message; no existing test asserts the old text for that path.
- Failed analyses from the model being unreachable are refunded; the daily-limit test sets `count=20` directly and still throws.
- The mocked immediate-result path in `consumer.spec.ts` (status 200, no job) is deliberately still supported by the client.
- `tests/fixtures/public-shirt.jpg` is 2048×2048 (I checked the image), inside 2400 px / 6 MP; I could not measure its byte size. If it is over 2.5 MB, `accounts.test.ts` (which uploads it to `/api/photos`) will get 413; raise `STYLE_MAX_UPLOAD_BYTES` default or downscale the fixture.

## Unresolved assumptions and things Codex should look at first

1. **Typecheck/lint were not run.** Likeliest friction: tuple spread into `finishJob(...)` in `runWorkerTick`; `sharp.Metadata` narrowing in `inspectUpload`; unused destructured variables in `UploadDialog.finishAndSave` (the original had the same pattern).
2. `sharp(bytes).metadata()` is assumed not to enforce `limitInputPixels` (I removed it from that call so oversize rasters are reported as 413, not 400). If it does decode anything, `tests/admission.test.ts` will show it.
3. `tests/queue007.test.ts` deletes a `user` row directly to simulate account deletion; it assumes Better Auth's own tables cascade (as the accounts test implies). The abort timing assertions use 3 s ceilings with a 25 ms watcher.
4. `tests/migration007.test.ts` uses `ALTER TABLE … DROP COLUMN` to rewind to the build 006 shape (SQLite ≥ 3.35). It then relies on `scripts/init-auth.ts` in child processes, like `migrations.test.ts`.
5. The three new browser tests mock the analysis and job endpoints and assume the selectors/labels in the dialog (`Dress code`, `Warmth (optional)`, `Merge as one pair`, `Continue in background`, `Review photo results`). Playwright `**/api/analysis-jobs` is assumed not to match `/api/analysis-jobs/job-resume`.
6. `e2e/api.spec.ts` exhausts the 120/min counter with invalid `/api/photos` posts (loop up to 260, so a minute-boundary reset does not make it flaky).
7. Job polling (`GET /api/analysis-jobs/:id`) is still a write transaction (it also expires stale photos). Making it a read is a later efficiency item; the new list endpoint is read-only.
8. The sweep still runs only on enqueue, claim, startup and a job's own GET; the periodic sweep is later work.
9. Resume restores review from `sessionStorage` only on the same tab/session. A different device sees the server job (and result) but not the draft edits.
10. The attempts cap (40) and review budget (10 min) are judgment calls, not measurements. The per-job estimate floor (120 s) must be replaced by the measured p95 on the target server.
11. Limits for backup import: `fitDataUrl` re-encodes images over 1600 px or ~1.3 MB, but a backup with many images still counts one change-quota unit per upload (P2 item 5 in the review, untouched).
12. Docker/compose changes are unrun.

## Corrections after self-review (second pass)

1. **Admission now uses the worst case, not the estimate.** The first pass admitted on `(ahead+1) × max(120 s estimate, history)`, which could admit a photo that misses the hour if every job ahead ran to the 240 s inference timeout. `checkAdmission` now uses `worstCaseJobMs = max(estimate, STYLE_INFERENCE_TIMEOUT_MS + 10 s)` per job ahead (250 s by default): a photo is admitted only if `(ahead+1) × 250 s + 10 min review ≤ 60 min`, i.e. at most 11 jobs ahead at defaults (the global cap of 20 no longer binds first). The displayed ETA still uses the estimate and the client text says "about", not "at most". Not covered by the guarantee: a job re-run after a worker crash (it waits for its lease); if it then misses the hour it is expired and refunded. New test: "admission assumes the worst case…" in `tests/queue007.test.ts` (12 admitted, 13th refused with `busy` + retry hint). `docs/DEPLOYMENT.md` table and text updated; the earlier "about 24 / 12 ahead" figures above are superseded.
2. **Lease vs timeout.** The job lease was a fixed 10 min while `STYLE_INFERENCE_TIMEOUT_MS` may be set up to 900 s, which could let a lease lapse mid-inference and cause a duplicate run. The lease is now `max(10 min, inference timeout + 2 min)` (`jobLeaseMs`), also used for the finish-retry budget.
3. **Typecheck fixes from Codex:** `imageAdmission.ts` uses `import sharp, { type Metadata } from "sharp"` (the `sharp.Metadata` namespace form did not resolve); the noisy-image fixture in `tests/admission.test.ts` supplies the required `background` alongside `noise` in `create`. No suppressions.
4. **Reviewed and left unchanged:** owner-only resume (server lookups are all `id AND user_id`; stored review data is read only after a server-confirmed job and validated; foreign keys are purged), cancel/abort guards (status, lease and worker-owner checks), migration atomicity (one `BEGIN IMMEDIATE` transaction under the schema lock; all statements idempotent), image semaphore (release in `finally`, handoff on release, timed-out waiters removed, never held across a write), review confirmation (dress code stays "Not sure" until chosen; merge resets review).
5. **`concurrency.test.ts` failures reported by Codex (deferred upgrade, eager dialect, writer waits, two-token consumers, combined HTTP).** I have not found a cause in my changes: the "deferred BEGIN" test uses only raw `node:sqlite` on a temp directory and imports no app code, and the dialect/gate modules were not edited. The one shared-path change near them is the new `runApplicationMigrations` step (write gate + `BEGIN IMMEDIATE` after `APPLICATION_SCHEMA`), which only affects tests that call `getReadyAuth` (the combined HTTP test). I am waiting for the full error text rather than guessing, and no assertion has been weakened.

## Third pass: Codex test results

1. **`queue007.test.ts` (3 failures):** `node:sqlite` rows have a null prototype, so `deepEqual` against plain objects failed on the `usage()` helper. It now returns a plain `{ count, attempts }` copy; all assertions and expected values are unchanged.
2. **Intermittent `database is locked` in the combined HTTP test (register child).** Not yet localized to a statement, so this is a hypothesis plus hardening, not a confirmed fix. What I checked: the signup transaction path (`authDialect.ts`, `auth.ts`) is unchanged by batch A, and nothing in batch A touches the auth connection. The one new *write* on every process's readiness path is the 007 migration (`runApplicationMigrations` after `APPLICATION_SCHEMA`), and a child that throws inside `getReadyAuth` is reported by the child's outer catch as exactly this shape (`failures: ['database is locked']`, no stage). Changes made:
   - `applicationMigrationApplied` (read-only, no write lock): when the migration is recorded and all its columns and the timings table exist, `runApplicationMigrations` returns without taking the write gate or `BEGIN IMMEDIATE`. After the first start, concurrent cold starts add no write-lock traffic from batch A.
   - When it does run, the whole migration transaction is now wrapped in `retryBusy` with rollback-and-replay. This is safe only because that transaction is atomic and idempotent (every statement is conditional); it is not applied to signup, token or any non-idempotent transaction. A lock refusal at any statement, including COMMIT, no longer escapes.
   - `scripts/concurrency-child.ts` failures now carry the stage (`signUpEmail`, `runWriteTransaction`, `heartbeat/cleanup`, `child-setup-or-role`), the SQLite `errcode`/`errstr`/`code`, the first stack frames (repo-relative) and the cause chain (up to 4). Error metadata only; no secrets, passwords or message bodies. The assertions and multi-process load (3 registrars, 3 writers × 150, worker × 60, in-process traffic, `startAt` = now + 8 s) are untouched.
   If the failure recurs, the new `stage=` and stack in the failure text will say whether it is in readiness (`child-setup-or-role`, expect `database.ts`/`auth.ts`/better-auth frames), in a signup statement inside the transaction (`signUpEmail`), or in a write path. I did not add retries around signup or token transactions and did not weaken any check.

## Fourth pass: signup `BEGIN IMMEDIATE` exhaustion (concurrency test)

Evidence from Codex: `stage=signUpEmail`, SQLite errcode 5 at `authDialect.ts` `AuthConnection.begin()` → `retryBusy` → `database.exec('BEGIN IMMEDIATE')`. So the 10 s lock-acquisition budget ran out for a signup transaction (the first migration hypothesis above was wrong for this failure; the migration changes are harmless hardening and stay).

**Diagnosis (code reading, not yet measured):** SQLite's write lock is not FIFO across processes. The synthetic `write` children loop `runWriteTransaction` back to back, and each re-takes the lock the instant it commits; waiters poll with exponential backoff capped at 250 ms, so a long waiter (backoff at its cap) polls less often than a fresh arrival (20 ms) and can lose repeatedly. Sustained writers (3 × 150 + worker + in-process signups that hold the lock through password hashing) can therefore starve one signup past 10 s. This is a fairness defect, not too short a timeout, so the budget was not raised.

**Fixes:**
1. `sqliteRetry.retryBusy` gains `maxDelayMs`; lock acquisition (auth `BEGIN IMMEDIATE`, auth autocommit statements, `runWriteTransaction`) uses `WRITE_POLL_MAX_MS = 40`, so long waiters keep polling about as often as new ones. Other callers keep the 250 ms cap.
2. `runWriteTransaction` yields `COURTESY_YIELD_MS = 3` after each committed transaction (after the in-process gate is released) so another process's poller has a window. It is not a retry and never repeats work; failed/rolled-back transactions do not pause.
3. Truthful capacity responses: new `src/server/contention.ts` (AsyncLocalStorage scope). The auth dialect calls `noteContention` only when acquisition was exhausted (gate wait, `BEGIN IMMEDIATE`, or an autocommit statement outside a transaction), which means the work never started. The public auth route (`api/auth/[...all]/route.ts`) turns such a failure, or a 5xx Better Auth produced after it, into `503 { code: "busy", retryAfterSeconds: 5 }` with `Retry-After: 5`. Concurrent requests cannot mislabel each other (per-request scope). Elsewhere `errorResponse` maps `WriteContentionError`/`WriteGateError` to the same retryable 503 instead of the generic one. No statement or transaction is replayed anywhere in this path.
4. Diagnostics: a failed `begin()` now carries `acquire: { gateMs, sqliteMs }` on the original error object (type unchanged, so the dialect tests that expect the busy error still hold); `concurrency-child.ts` prints it plus `sinceStart` ms. On recurrence these separate gate starvation (large `gateMs`) from SQLite starvation (large `sqliteMs`) and show when in the load window it happened.
5. `STYLE_AUTH_LOCK_MS` (100–60000, default 10000) sets the per-wait auth budget so the new test can use 300 ms.

**New test:** `tests/contention007.test.ts` holds a foreign write lock and checks that sign-up through the real auth route returns 503 + `Retry-After: 5` + `code: "busy"` within a bound, creates no user, and that the identical request succeeds afterwards with exactly one user; and that a refused `verify-email` request leaves the user unverified and the same one-time token still works once the lock clears.

**Not proven:** that fixes 1–2 remove the intermittent failure in `concurrency.test.ts`. They address the mechanism I can see in the code; only repeated runs with the new `acquire=` / `sinceStart=` output can confirm. If it still fails, the evidence needed is that line (gate vs sqlite split and timing). Possible next steps then: a cross-process turnstile (a short-lived lock file taken before `BEGIN IMMEDIATE`, FIFO by arrival), or fewer/lighter synthetic writers. I did not weaken the test or add whole-transaction retries.

## Wording corrections to the fourth pass

- The 40 ms polling cap and the 3 ms courtesy yield **improve the odds** that a waiter gets the lock; they do **not** give cross-process FIFO and do not guarantee that no writer is ever starved. A real FIFO would need a cross-process turnstile (not built).
- `noteContention` fires for three cases: gate wait exhausted, `BEGIN IMMEDIATE` exhausted, and a refused autocommit statement outside a transaction. Only the first two are "the transaction never began" and only the **refused-`BEGIN`** path is covered by `contention007.test.ts` (sign-up and verify-email while a foreign lock is held). A refused later autocommit statement in a multi-step request cannot prove that earlier statements of that request did not commit, so I do not claim "no side effects" for every auth request; the 503 there means "busy, retry", and the tested no-side-effect/token-not-consumed guarantee is for the refused-`BEGIN` paths only.

## Fifth pass: durable save, upsert retries, packaging

1. **Save requires the server's acknowledgement before anything is discarded.** `useStyleStore.commitGarments(items)` returns a promise that resolves only when the autosave that contains the items succeeds (photos uploaded, revision accepted) and rejects with the save error otherwise. The autosave ordering, `failed` flag, conflict handling and draft protections are unchanged; waiters are settled inside the existing save effect, and unmount or an account switch rejects them (the effect already refuses to write after `alive` is false, so nothing is written for another account). `page.tsx` `onSave` is now `async` and does not close the dialog or show the success toast until the promise resolves ("N items added and saved"). `UploadDialog.finishAndSave`:
   - on rejection: nothing is cleared; it shows "Your items were not saved: … press the button again to retry"; the job, the review storage and the drafts stay, and the button works again;
   - on success: clears the tab's review data, then awaits the server discard; if the discard fails it says so ("Saved to your wardrobe. The temporary photo result could not be removed yet…"), records the job id as a pending discard (per account, `sessionStorage`), clears the drafts so nothing is offered twice, and the next dialog open / banner refresh retries it and hides that job meanwhile; the server's one-hour expiry is the backstop.
2. **Retries upsert by stable id with the latest values** (user review of the first draft of this fix). `commitGarments` now replaces an existing item with the same id by the incoming one (latest name, colour, crop, dress code …), adds missing ones, and leaves every other wardrobe item untouched, so there are no duplicates and a correction made after a failed save is what gets saved. Item ids for job results are now deterministic, `<jobId>-<position>` (a merged pair keeps its first detection's id), so saving the same result again after a lost success response, including after a reload or from another tab with no stored review, updates the same wardrobe item instead of adding another. The server already acknowledges a byte-identical retry after a committed-but-lost response.
3. **Browser regressions** (`tests/e2e/review007.spec.ts`): failed wardrobe write then reload, resume and retry (one garment, discard only after the acknowledged save, still one after reload); failed save, correct name/colour, retry, reload (latest values exactly once, old name absent); lost success response then retry (one garment); failed discard after a successful save (honest message, not offered again).
4. **Packaging.** `next.config.mjs` now sets `outputFileTracingExcludes` for `.data`, `.runtime`, `.env*`, `.codex`, `release-snapshots`, `tests`, `docs`, `.git` (patterns for the root and nested). The root cause is that `path.join(process.cwd(), ".data")` makes Next's tracer pull in the whole directory (Codex's path-only probe counted 6608 `.data` entries over 14 manifests and a `standalone/.data`); I left that code unchanged because making the path non-literal would likely make the tracer include the entire project. `scripts/verify-packaging.ts` (`npm run verify:packaging`, also added to CI after the build) reads every `*.nft.json` outside `standalone`/`node_modules`, resolves each listed path, and walks the names in `.next/standalone`; it fails on private runtime directories, root `tests`/`docs`, env files (except `.env.example`) and runtime artifacts by name (auth-secret, mail-outbox, app.db and sidecars, style-*.db, schema.lock), and also fails if `standalone/server.js` or `node_modules/next` is missing (over-exclusion). Paths only; no file contents are read. `.dockerignore` also excludes `.codex` and `release-snapshots`. Unverified: that Next's exclude matcher treats dot-directories as I assume (it should, `.data/**` and `**/.data/**` are both listed); the rebuild plus `verify:packaging` is the proof, and if `.data` entries remain the report will list the manifest and path.

## Sixth pass: packaging on Windows (supersedes the "unverified matcher" caveat in item 4 above)

Root's read of the installed Next 15.5.27 `collect-build-traces.js` (I re-read lines 440–566 and agree): each exclude becomes `path.join(dir, exclude)` and is matched with picomatch against `path.join(pageDir, file)`. On Windows `path.join` yields backslashes, and picomatch treats a backslash in a pattern as an escape, so no `outputFileTracingExcludes` entry can match an absolute Windows path. The route key (`"*"`) matched; the path matching did not. This is a Next/Windows limitation, not a dot-directory problem, and I cannot edit `node_modules`.

**Why not prevent the trace at the source:** the tracer picks up `path.join(process.cwd(), ".data")` in `database.ts`. Rewriting that so nft cannot evaluate it is uncertain (a partly dynamic `cwd` join can make nft trace the whole project, which is worse), and a fixed external default data directory would change local-development behaviour and break `README`/`init-auth` flows. I did not do either; Docker already sets `STYLE_DATA_DIR=/data` and the excludes work on Linux, so the source-level trace exists only in Windows/local builds.

**Fix: fail-closed sanitize + verify as part of the build.**
- `scripts/packaging-rules.ts` (shared, paths only): the forbidden set (`.data`, `.runtime`, `.codex`, `.git`, `release-snapshots`, project-root `tests`/`docs`, env files except `.env.example`, `auth-secret`, `mail-outbox`, `app.db*`, `style-*.db`, `schema.lock`), `assertInside`, manifest and name walkers, and `collectPackagingProblems`. Manifests inside `.next/standalone/.next` are now checked relative to the standalone root (the first version of the probe only looked at the non-standalone ones plus the tree).
- `scripts/sanitize-build-output.ts` runs after `next build`: (1) drops forbidden entries from every generated `*.nft.json` under `.next`; (2) deletes the **generated copies** of forbidden paths inside `.next/standalone`. Safeguards: every target is resolved to an absolute path and must be strictly inside `.next/standalone` (or, for manifests, `.next`); `.next/standalone` itself must be a real directory, not a link; links in the bundle are unlinked, never followed; the real project `.data`, `.runtime`, `.env*`, tests, docs and source are never touched; it reads only manifest path lists and directory names; any error (including a locked file) exits non-zero and fails the build.
- `package.json`: `"build": "next build && tsx scripts/sanitize-build-output.ts && tsx scripts/verify-packaging.ts"`, so a build only succeeds if the check passes (Docker's `npm run build` runs it too; on Linux the excludes mean the sanitizer removes nothing). `scripts/start-server.ts` re-runs the path check and refuses to start a bundle that contains private paths. CI keeps its separate `verify:packaging` step.
- `next.config.mjs` keeps the excludes (effective on Linux) and now documents the Windows limitation.

**What to expect on rebuild:** `Sanitized build output: N trace entries dropped from M manifests, K bundled private paths removed`, then `Packaging check passed`. Remaining failure modes: an existing `.next/standalone/.data` file locked by a running server or antivirus (the sanitizer fails the build instead of leaving it); a forbidden name I did not anticipate (the check lists the path, add it to `packaging-rules.ts`); or an over-exclusion (the check fails if `server.js` or `node_modules/next` is missing). Stop any local server before rebuilding so the old `.next/standalone/.data` copy can be removed. No file contents were read at any point.

## Seventh pass: browser-suite failures (7 of 30)

1. **Dress code / warmth not found by label.** The implicit `<label>` wrapped the whole `<select>`, so its accessible name was the label text plus every option, and `getByLabel("Dress code", { exact: true })` could not match. The two selects now use an explicit `<label htmlFor>` and `<select id="dress-code-<itemId>">` / `warmth-<itemId>`, so the accessible name is exactly "Dress code" / "Warmth (optional)". Default "Not sure" and the explicit formal-choice checks in the tests are unchanged; a small `.review-card .field` rule keeps the layout.
2. **Stale results and fixtures.**
   - *Fixture semantics (my fault):* `mockCompletedJob` and the resume test listed a finished job before any upload existed, so a real resume raced the test's own file choice and its review state. Jobs now exist only after the mocked POST is accepted and persist across reloads until discarded; the resume test got the same treatment. No assertion was weakened.
   - *Product fix:* `showResult` could publish after an `await` (photo hash, crops) even if its flow had been superseded, cancelled or unmounted. It now takes the flow's `AbortController` and checks it before every state write and after each async stage; `follow` and `analyze` also check it after `getJob`, `imageFromFile`, `photoHash` and `response.json()`, and a superseded flow no longer reports errors. A newer flow (new upload), cancel, discard or unmount aborts the old one, so its result can never replace newer reviewed data.
   - *New regression:* "a superseded or cancelled result that arrives late cannot overwrite the newer reviewed photo": an earlier photo is resumed with a deliberately slow answer, is cancelled, a new photo is uploaded and edited, then the delayed old answer is allowed to land; the edited new item, its checked state and a single card must remain and "Old shirt" must never appear. The fetch is aborted on cancel, so this exercises the abort path end to end; the stage-by-stage guards (hash/crop) are not separately provable from the browser and are covered by code review only.
3. **Escape after the draft controls disappear.** `Dialog` attached its key handler to the modal element, so once the focused control was removed (focus falls to `<body>`) Escape never reached it. Handling is now on `document` with a stack of open dialogs: only the innermost dialog reacts (one Escape never closes a stack), Tab brings lost focus back inside, and the handler and stack entry are removed on unmount while focus is still restored to the previous element. The failed-discard test now presses Escape, asserts the dialog is gone (`getByRole("dialog")` count 0), and only then navigates; no forced click or longer timeout.

Not changed: save/reload/lost-response assertions, stable ids, durable-save flow, packaging. Not production approval; later dense-wardrobe, durable-mail, erasure and fresh-restore batches remain.

## Evidence still needed for batch A items

Typecheck, lint, all backend tests (old 23 + the four new files), the full browser suite (old 13 + new tests), a real-model queued upload through the new UI including a cancel mid-inference, and a measured p50/p95 on the target server to set `STYLE_ANALYSIS_ESTIMATE_MS`.
