# Build 015 fixture-corrected candidate: fresh independent review (Claude, Revision 3 review)

I used Read, Glob and Grep, plus this one Write. I ran no shell, tests, type check, build, network or browser, and I edited no source. Every execution result below (typecheck, lint, wardrobe 22/22, the 20 repetitions, the full-suite FAIL) is root's, taken from `docs/verification/BUILD015_CHECKS.md`, `wardrobe-015-repeats-final.json` and `backend-015-fixture-corrected-npm-reviewed.log`. Nothing here is a readiness claim.

Evidence classes: **Read** (I read it in the working tree), **Log** (root's recorded output, which I read), **Arithmetic** (my calculation from Log numbers), **Reasoning** (my inference from code), **Unverified** (needs a run or a source I did not read).

## 0. Reviewed material and deviations

Read in full: `implementation-015-notes.md` (Revision 3 and earlier sections), `build-015-corrected-claude.md` (my previous verdict), `BUILD015_CHECKS.md`, `LOCK_NEXT_FINDINGS_016.md`, `PHOTO_SCAN_FINDINGS_015.md`, `WARDROBE_CORRUPTION_RECOVERY_015.md`, `wardrobe-015-repeats-final.json`, `tests/helpers/wardrobeFixtures.ts`, `tests/localCaptureSettle015.test.ts`, `tsconfig.json`, `src/server/writeTransaction.ts`, `writeGate.ts`, `sqliteRetry.ts`, `authDialect.ts`, and the four permitted SDK files (`better-auth/package.json`, `dist/api/dispatch.mjs`, `dist/api/to-auth-endpoints.mjs`, `dist/api/routes/sign-up.mjs`).

Read in part: `src/server/mailOutbox.ts` lines 620 to 706 (kick timer, drain, `settleLocalCapture`); `src/server/wardrobes.ts` lines 296 to 364 plus Grep for `photoIds`/`referenceSet`; `src/server/database.ts` lines 60 to 109 and 385 to 418; `tests/wardrobeContention015.test.ts` lines 612 to 730 plus test titles; `tests/concurrency.test.ts` lines 300 to 700; `scripts/concurrency-child.ts` lines 100 to 228; `tests/lockDiagnostics.test.ts` lines 254 to 330; `tests/contention.test.ts` around `heldResponse`; `backend-015-fixture-corrected-npm-reviewed.log` lines 86 to 89 (the `CONCURRENCY_TIMING` line) and 295 to 340 (summary and failure), plus Grep; the source manifest (first 60 lines and a count).

Deviations:

- **Frozen copy not opened.** I read the working tree under `style-app`, not `../build-015-fixture-corrected`, and I cannot hash. A Grep count of `"path":` in `build-015-fixture-corrected-source-manifest.json` gives 206, which matches root's number. Whether the tree equals the manifest is root's verification (root states all 206 were unchanged after the tests). My findings apply to what I read.
- **Not read:** `wardrobeRoutes015.test.ts`, `authDeadline015.test.ts`, `proxyConfig.test.ts` (no Revision 3 change was claimed for them; I rely on root's pass counts), the per-run logs, the transaction isolated log, the probe scripts and JSON (`photo-scan-*`, `write-turn-gap-probe-015.*`), the gate-waiter trace, `lockRecorder.ts`, `auth.ts`, `Dockerfile`, the 014 snapshot (the F8 comparison is root's and I did not repeat it), and every Better Auth file outside the four permitted ones (so the password hasher, the `runWithTransaction` implementation, the router and the middleware order inside an endpoint are Unverified).
- The 20-run aggregate I did read in full: 20 entries, each `tests 22, pass 22, fail 0, exit 0`, each with the same A/B/C line.
- No `.env*`, `.data`, `.runtime`, `node_modules` (other than the four exact SDK files) or `sources/` content was read.

## 1. Verdicts (three separate questions)

| Question | Verdict |
|---|---|
| **Scoped fixture acceptance** (the Revision 3 hidden-writer correction: `newRepositoryUser`, `settleLocalCapture`, quiescence in `verifiedSession`, L1, two-kinds test, A/B/C, M1 document) | **ACCEPT**, with the low conditions in section 3. The four formerly blocked retention tests now ran to completion and passed with their original queue and retention assertions unchanged (Log). The A/B/C numbers support the diagnosis (Log). Twenty repetitions all passed. |
| **Release verdict for build 015** | **FAIL.** The only full `npm test` run at normal reviewed permissions completed `261 total, 256 pass, 1 fail, 4 skip, 69.654 s`. The failing test is the unchanged mixed multi-process concurrency scenario. The earlier restricted-environment mixed pass (56.580 s, no problems) does not erase it, and the 014 failure (216/211/1/4, worker lease) is a second, different refusal from the same scenario. Of the three full-suite observations of this scenario in builds 014 and 015, two failed (Log). |
| **Launch** | **NOT READY.** G1 is open and unexplained, and nothing above closes any external gate: real vision correctness and human gold labels, SMTP, HTTPS and transport (H2), Docker/Linux execution, off-site encrypted recovery, real phones, hosting. No production build, compiled browser run or deployment of 015 exists. |

The fixture acceptance is a statement about the fixture and the four wardrobe races. It must not be quoted as a statement about the release.

## 2. What the checks do and do not establish

Log, accepted as recorded:

- Typecheck PASS and source lint PASS. I read `tsconfig.json`: `include` is `**/*.ts` and `**/*.tsx`, so `npm run typecheck` **does** cover `tests/` (this closes the open item in my previous review). `npm run lint` still does not lint tests.
- Wardrobe file 22/22 in 9.334 s; the other four target files 28/28 in 14.387 s (two invocations, not one); 20 further wardrobe runs 22/22 each. In the reviewed full run all 50 new assertions passed again.
- A/B/C: A queue 1, outbox 0; B queue 2, outbox 1; C queue 1, outbox 1, identical in all 20 repetitions. That is a clean A/B on the one variable (real sign-up with a pending drain versus none), and C shows the settle seam removes it.

Statistical honesty (Arithmetic): 22 observations of the wardrobe file (1 first run, 20 repeats, 1 inside the full suite) with 0 failures bound the true failure rate only to about 3/22, roughly 14 % at 95 % confidence. Those runs were sequential, one file at a time, not under the multi-process load that the full suite produces. "0/20" is a useful absence of a gross flake, not proof that the queue-length preconditions are timing-proof.

Test-design point worth keeping: B is the one assertion that cannot be exact (it may see 1 or 2), and the test says so and asserts only that range. Twenty identical 2s show the 15 ms timer versus 100 ms sleep margin is wide on this host; it says nothing about slower hosts.

## 3. Findings on the fixture correction (all accepted; low conditions)

**Source read of the seam.** `settleLocalCapture` (`mailOutbox.ts:687` to `706`) validates `timeoutMs` and `pollMs` as finite numbers before reading any flag, clamps, and polls `kickTimer !== null || draining`. It clears and changes nothing, takes no gate, and rejects at the cap instead of hiding a blocked drain. The NaN/Infinity/string/null/object/boolean cases are covered by tests that also assert the blocked writer is still queued. By reading, the NaN hole is closed. `drainLocalCapture` keeps `draining` true across the whole do-while including the final empty claim, so settle waits for that last gate acquisition too (my earlier concern is met).

**`newRepositoryUser`** (`wardrobeFixtures.ts:45` to `89`). Sound by reading: schema is read at run time, unknown NOT NULL columns without a default throw by name, and the function asserts zero outbox rows and zero gate waiters before returning. It passed, so the column assumption held on this Better Auth version.

**L1** is resolved: `photoIds` is now `Object.freeze([...referenceSet])` (`wardrobes.ts:347`), the commit loops `payload.photoIds` for ownership (line 391, per the Grep) and the reclamation uses the same `referenceSet`. `checkPhoto` is validation only. The equality test covers four shapes, which is a regression guard, not a proof.

**Two-kinds test** is well formed: the aged shared photo is referenced by a wardrobe `sourcePhoto` and a look item `image`, an expired orphan added before the second save proves reclamation really ran in that save, a later `reclaimExpiredPhotos` returns 0, and only the last removal deletes it. It passed.

Low conditions:

- **F-L1 (Low).** Make `newRepositoryUser` also prove the capture is idle, for example by calling `settleLocalCapture({ timeoutMs: 1000 })` before returning. Today the guard sees only an empty queue, so a drain that has not yet reached the gate (timer pending) passes the guard. No current test order exposes this, but the diagnostic's B and C run `newUser` in the same file; a reordering could.
- **F-L2 (Low).** The three timeout tests in `localCaptureSettle015.test.ts` rely on taking the gate in the same turn as `queueVerificationEmail`, before the 15 ms timer. `queueVerificationEmail` awaits a write that ends with the 3 ms courtesy sleep, so the real margin is about 12 ms. They fail loudly (never silently pass) when the margin is lost, and they passed, but they are the next candidates to flake on a loaded host. Record them separately in any flake count.
- **F-L3 (Low).** `settleLocalCapture` is an exported test seam in a production module. It is read-only and no route imports it. Confirm in the standalone-bundle check that nothing imports it. No action otherwise.
- **F-L4 (Low, process).** The Revision 3 notes still open with "Nothing in this batch was executed". That is true of that batch, but the file now sits beside root's results. Root should add a one-line status header pointing to `BUILD015_CHECKS.md` so a later reader does not take it as the current state.
- **Residual hidden-writer class.** Settling covers the mail capture only. `reclaimAfterRead` (in-flight map), Better Auth background work and any other timer can still queue a writer. The guard in `newRepositoryUser` is the only protection for repository tests, and `verifiedSession` has no equivalent for non-mail writers. By Log nothing else appeared in 22 runs.

**M1 document** (`WARDROBE_CORRUPTION_RECOVERY_015.md`): accurate and honest. It says repair is OPEN, gives no invented commands, and does not claim self-service recovery. Rated Medium for launch: before a public launch an operator procedure with a tested backup-first path is needed, even if corruption is unlikely (the application validates every write). It does not block the fixture acceptance.

**F8 (ownership before revision):** root reports a read-only comparison with 014 showing the same order. I did not repeat it; I treat it as root's finding, preservation not regression.

## 4. The reviewed full-suite failure: what the log shows

This is the part that matters most. Everything in this section is from the `CONCURRENCY_TIMING` line (log line 88) and the failure block (lines 301 to 339).

### 4.1 The failure itself (Log)

Child 5 (a `write` role, index 5 in the child list: three registrars, three writers, one worker) refused one `runWriteTransaction` before its body: budget 10 000 ms, `gateMs 0.1`, `sqliteMs 10001.5`, `attempts 53`, `queueDepth 0`, `sinceStart 10367 ms`. The refused call therefore began about 0.37 s after the child's start and waited the whole budget. The child continued, 149 of 150 writes succeeded, and the table shows 449 of 450 rows. The refusal is a refused operation, not a lost write and not a replay. All other children and the in-process traffic had no failures.

### 4.2 The lock is close to saturated (Arithmetic from Log)

Summing `count × mean holdMs` over every role in the timing line (write holds, worker, registrar write, registrar auth, main-process write and auth):

| Role | count × mean hold | ≈ |
|---|---|---|
| three writer children | 150×57.7 + 150×57.2 + 149×60.2 | 26.2 s |
| worker | 122×35.7 | 4.4 s |
| three registrars, write path | 3×(90.1+103.8+111.7) | 0.9 s |
| three registrars, auth path | 4×(173.3+217.6+214.3) | 2.4 s |
| main process, write path | 48×84.8 | 4.1 s |
| main process, auth path | 11×183.9 | 2.0 s |
| **total** | | **≈ 40.0 s** |

The stress phase lasted about 44.4 s (children 43.7 to 44.4 s, parent 44.37 s). SQLite has one writer at a time, so the sum cannot exceed the wall time; 40.0 s against 44.4 s is consistent and means the write lock was held **about 90 % of the stress window**. Each writer child took about 43 s for 150 writes (mean call 286 to 296 ms) while its own hold per write was about 58 ms, so each spent roughly 80 % of its time waiting.

Consequences (Reasoning): with offered load near capacity and a lock that is not FIFO across processes, a heavy tail is expected, not a rare accident. The tail is visible in the same line: six acquisitions of about 650 waited more than 6.5 s: writer child 3 at 7.72 s, writer child 4 at 8.90 s (`sqliteMs` max 8844), the worker at 7.49 s, the first registrar's auth acquire at 9.09 s, the third registrar's at 6.71 s, and the refused one at 10.00 s. The refusal is the sixth of a group, not an isolated event. The in-process queue behaves: the main process's own gate wait peaks at 1.27 s and its SQLite wait at 2.01 s. The tail lives in cross-process polling.

### 4.3 What dominates the hold (Arithmetic + Reasoning)

- The three writer children run a body of one `SELECT COUNT(*)` and one `INSERT OR REPLACE` (`concurrency-child.ts:152` to `157`). Their median hold is **41 to 56 ms** and p95 120 to 137 ms, max 195 to 281 ms. A two-statement body cannot take 40 ms by itself. The hold runs from BEGIN return to COMMIT return, so the most plausible dominant term is the COMMIT's durable write (WAL sync) on this Windows host while six other processes also sync (Reasoning; **bodyMs and commitMs have never been measured separately**).
- `grep` for `synchronous` and `journal_mode` over `src` finds only the WAL pragma (`database.ts:407`) and the backup-copy pragmas. No `synchronous` setting is applied, so the SQLite default applies. Whether Node's bundled SQLite defaults to FULL is Unverified, but a default of FULL in WAL mode would sync on every commit and fit the numbers.
- Hashing is **not** the main share: the auth path accounts for about 4.4 s of 40 s (about 11 %). Its holds are long (174 to 218 ms mean, 381 ms max), so each one blocks pollers for a long single stretch, but in total occupancy it is a minority.
- Linux and Docker, the target host, are an open gate. fsync cost on ext4 or a Docker named volume may be very different from this host. Do not carry these numbers to the target in either direction.

### 4.4 The poll cycle looks too long (Arithmetic; cause Unverified)

53 attempts in 10 001.5 ms is **189 ms per attempt**. By reading, one cycle is a native `BEGIN IMMEDIATE` wait of at most the main connection's 50 ms (`database.ts:76`), then an async backoff sleep capped at `WRITE_POLL_MAX_MS` 40 ms plus up to 10 ms jitter (`sqliteRetry.ts:44`, `62` to `64`). That is at most about 100 ms, or somewhat more with the Windows timer granularity. About 190 ms means roughly half of each cycle is unexplained. Candidates (none observed): CPU starvation of the polling child by the other JS-hashing processes, a native busy handler that overshoots its limit, or timer lateness on a loaded host. Because the polling interval is what decides how often a waiter notices a free window, this matters more than the 3 ms courtesy pause. It is a measurement gap, not a finding about cause.

### 4.5 What the evidence says about the root-proposed designs

**(a) Same-turn BEGIN, body, COMMIT (proposal in `LOCK_NEXT_FINDINGS_016.md`).** Correct and worth doing as hygiene, but **it cannot have caused this refusal and will not by itself fix it**:

- The gap it removes is only a microtask gap. `runWriteTransaction` awaits `retryBusy` after `BEGIN`; between BEGIN return and the body only microtasks that were already queued can run, not timers, I/O or other requests. The root probe used a synthetic 75 ms microtask; LOCK_NEXT itself says it does not prove causation. The existing test `lockDiagnostics.test.ts:255` to `283` does the same thing with 20 × 5 ms `queueMicrotask` blockers. Real production microtasks are short.
- The refusing process is a child that does nothing else (`concurrency-child.ts:139` to `165`): nothing is queued behind its BEGIN. The same holds for the other two writer children. The main process holds the lock in only 59 of about 650 acquisitions (about 6 s of 40 s).
- Therefore the expected gain on the full-suite failure is negligible. Do not describe it as the G1 fix.

Design requirements if it is implemented (all are correctness constraints; each needs a test):

1. **Only BEGIN is retried; the body and COMMIT run in the same synchronous block as the successful BEGIN, and their outcome must not be thrown through `retryBusy`.** `retryBusy` retries any busy-shaped error it sees. If the body or the COMMIT ran inside the retried callback and threw a busy-shaped error (errcode 5, 6, 261, 517), the callback would be replayed, BEGIN taken again and the body re-run. So the callback must catch everything after a successful BEGIN and return a tagged result (`{began: true, value}` or `{began: true, error}`), roll back, and rethrow after `retryBusy` has returned. Test: a body that throws an error with `errcode` 5 and a COMMIT forced to fail with a busy-shaped error, each asserting the body count is exactly 1, the original error identity surfaces (not `WriteContentionError`), the transaction is rolled back and the gate is released.
2. A body that returns a Promise must still roll back and fail with the same message.
3. The first attempt and every retry use the same block; the remaining-budget arithmetic (`deadline − now`, one attempt even at zero) is unchanged.
4. **Observer calls must leave the hold.** Today `notifyAcquire` runs between BEGIN and the body, inside the SQLite hold, and `notifyHold` runs in `finally` before `release()`. In the stress test the recorder is installed in every child, so instrumentation currently sits inside the lock. Capture the numbers in the block (`beganAt`, `commitReturnedAt`, attempts) and notify afterwards, preserving event order and the existing swallow-all-observer-errors behaviour. Prefer after `release()` so a slow synchronous observer cannot extend the process gate hold either.
5. The hold metric becomes `commitReturnedAt − beganAt`, taken in the same block. Keep the numeric-only detail shapes and add fields rather than changing any.
6. **Two existing tests pin the old behaviour and must be replaced, not weakened or deleted silently:** `lockDiagnostics.test.ts:265` (write path) asserts `holdMs >= 90` after microtask blockers queued before the BEGIN returned, which cannot hold once the body runs in the same block. Replace with: a microtask queued at BEGIN return does not run before the body, and the hold equals body plus COMMIT. The auth-path test at line 285 stays: the auth transaction is Kysely-driven and asynchronous, so it cannot become same-turn.

**(b) Hold the process gate through the post-COMMIT courtesy pause.** Reasoning: it only affects waiters in the same process. In the three writer children and the worker the gate queue is always empty (`queueDepthMax 0`), and those children already pause 3 ms between their own commits because the pause is awaited inside `runWriteTransaction`. Only the main process, with about 15 % of the lock occupancy, has an in-process queue that can re-take the lock at once. A 3 ms window is also small against polling cycles of 100 to 190 ms, so the chance that a given poller lands in it is a few percent. A longer window costs throughput on a lock that is already about 90 % busy. Do not implement it on the current evidence. The decomposition below would show whether main-process re-take is a real contributor.

**(c) Auth driver (async) semantics.** `finish()` commits synchronously and `begin()` is the only awaited acquisition, with BEGIN IMMEDIATE before the body's first read (`authDialect.ts:101` to `204`, `230` to `269`). Single-use token and reset atomicity depend on that. Keep it separate and untouched until its own design review.

**(d) Request-scoped password prehash outside the transaction (SDK 1.7.7 read).** Confirmed by reading the four files:

- `sign-up.mjs:144` wraps validation, `findUserByEmail` (192), the duplicate-path hash (200, only when `requireEmailVerification` or `autoSignIn === false`) and the new-user hash (214) in `runWithTransaction`. Hash-inside-transaction is confirmed. Whether the adapter's `transaction()` takes BEGIN at that call is Unverified (core not read), but it matches the measured 174 to 218 ms auth holds.
- `dispatch.mjs` runs `runBeforeHooks` (line 210) before `endpoint(internalContext)` (line 231), so a before hook runs outside the transaction. `to-auth-endpoints.mjs` sends every `auth.api.*` call through `dispatchAuthEndpoint`, so the hook applies to direct `auth.api.signUpEmail` calls as well. The HTTP router path is not in my permitted read set (Unverified).
- A hook's returned `context` is merged into the dispatch context with `defu`, hook values taking priority (lines 211 to 220).

What the reading adds that the proposal must respect:

1. **The endpoint calls `ctx.context.password.hash(password)` on the plaintext itself** (lines 200 and 214). A before hook cannot make it skip hashing. A prehash therefore needs a custom `password.hash` that looks up a server-side, request-scoped value. The option name and signature are Unverified.
2. **Never carry the precomputed hash in the request body or any user-controlled field.** The body schema is `... .and(z.record(z.string(), z.any()))` (lines 15 to 22): arbitrary extra keys are accepted. A hash smuggled through `body` or merged context could be supplied by the client and stored as the credential. Keep it in a server-side `AsyncLocalStorage` or a `WeakMap` keyed by the request or context object, created and consumed by trusted code only.
3. **The hook runs before the endpoint's own checks.** `use: [formCsrfMiddleware]`, the email and length validation (lines 151 to 154), the sign-up-enabled check and body parsing all run inside the endpoint, after the hooks (middleware order inside better-call is Unverified, but the dispatch order is read). An unconditional prehash would let unauthenticated, invalid or cross-origin requests spend a full hash. The hook must first apply the same origin, length and shape checks, match the exact path and method only (the `hooks.before` matcher is `() => true`, so it must self-filter), and sit behind a bounded hashing concurrency and queue.
4. **Duplicate response and timing.** Today the duplicate path hashes to equalize timing. If the hash is always done in the hook for both paths, parity improves, but the consumed-once rule, the dropped value on every exit and the identical cost for known and unknown addresses must be tested explicitly.
5. Memory and CPU: one hash is memory-heavy (the hasher's parameters were not read; Unverified). Bound concurrency and queue length. No global plaintext or hash cache, no dependency patch, no disabled transaction.
6. Value and priority: it takes about 4 s of 40 s of lock occupancy out of this scenario (about 11 %) and shortens the longest holds (up to 381 ms). It matters for sign-up latency under load. It is not the primary lever for this refusal and it is a security-sensitive, auth-wide change. It should be its own batch after the hook mechanics are verified.

## 5. Choosing the next (016) batch

Not a timeout increase and not a stress reduction. Based on the evidence above, the highest-value, lowest-risk step is a **decomposition and hygiene batch** that finds where the ~50 ms hold and the ~190 ms poll cycle go, because that decides which real fix is worth building:

**016 scope (source and tests only; nothing executed by the author):**

1. `runWriteTransaction` restructured to one synchronous block after a successful BEGIN, to the requirements in section 4.5(a), items 1 to 6. No change to the gate, the courtesy pause, the auth dialect, budgets, hashing or any timer.
2. Additive numeric fields only (existing keys and shapes preserved): in the hold event `bodyMs` and `commitMs`; in the acquire detail per-attempt totals `beginMs` (time spent inside `BEGIN IMMEDIATE`) and `backoffMs` (time spent in async sleeps). Extend `lockRecorder`/the `CONCURRENCY_TIMING` aggregation so the next run reports them per role. No assertion in `concurrency.test.ts` changes.
3. Replace the two pinned tests as described, and add the replay-safety and observer-outside-hold tests.
4. Bound the harness hazard found by root, without touching any assertion count: `contention.test.ts:240` to `245` is `while (!held.release) await sleep(10);` with no deadline. If the mock endpoint is unreachable the test never ends, as root saw. Add a deadline that fails with a clear message. This is harness work, not product work.

**Evidence root should record afterwards, in this order:** typecheck and lint; the unchanged lock suites (`lockDiagnostics`, `authDeadline015`, `concurrency`, `contention`, `accounts`, `bodyDeadline`) at reviewed permissions; the unchanged mixed scenario at least five times at reviewed permissions, each with the full `CONCURRENCY_TIMING` line kept, recording the failure count and the per-role `bodyMs`, `commitMs`, `beginMs`, `backoffMs`; then a measurement-only probe (author-independent) of commit latency on this host with the current settings, and the same on a Linux/ext4 volume when that gate is run. Report the failure rate with its denominator; do not call a single pass a fix.

**Decision gates after the numbers (not decided here):**

- If `commitMs` dominates the hold, as I expect: the options are a durability trade-off (synchronous level, which in WAL mode risks recent commits on power loss but not corruption) or fewer commits per operation. That is an **owner decision** about acceptable data loss for sign-up and token consumption, not something to slip into a test-fix batch. Measure on Linux first, since the target host may not show the problem.
- If `backoffMs` plus native `beginMs` explain far less than the 190 ms cycle: the polling child is being starved of CPU or the busy handler overshoots; then look at poll cadence and CPU contention before any new lock design.
- If main-process re-take shows up (long `gateMs` followed by immediate `beginMs` near zero in the main process only): only then is the gate-through-pause design worth a review.
- A cross-process FIFO (a ticket or baton outside SQLite's lock) is the structural answer to non-FIFO polling, and the heaviest. Do not start it without the numbers.
- Prehash (4.5(d)) and the F3 index (below) are separate, later batches.

## 6. F3 large-photo scans

The two probes are properly caveated by root and I accept them as **measurement of the SQL only**: about 87 ms per owner-index scan against under 0.08 ms for a covering index, on 50 rows, 96 MB of owned payload, alternating plans, with the small in-memory control not a sole-variable proof. They show the scan is not negligible with large photos; they do not show end-to-end GET or PUT hold time.

Risks the migration batch must plan for (Reasoning, nothing run):

- The photo table has `created_at` after the BLOB, so reading it can traverse the overflow chain; an index build reads every row, so the build time scales with the total photo bytes of all accounts. 152.9 ms on 96 MB suggests minutes at gigabyte scale. `runReady` retries only inside a `30_000` ms bound (`database.ts:405`), under a schema lock; a long build there could fail startup. Measure the build on a multi-gigabyte synthetic table before any migration.
- The sweep inside a write transaction (if reclamation holds the lock for the scan, as the notes describe) would hold the lock for that long; a synchronous scan on the main connection also blocks the event loop for the same time even outside any transaction. Measure GET and PUT with a large-photo account before and after.

F3 stays open. It is not part of the lock-path fix, and the lock-path numbers above do not involve large photos.

## 7. Severity summary

| ID | Severity | Item |
|---|---|---|
| R1 | **High, release blocker** | G1: reviewed full suite FAIL. Lock about 90 % busy in the mixed scenario, six of about 650 acquisitions above 6.5 s, one refusal at 10 s. Cause of the tail not measured. |
| R2 | Medium | The proposed same-turn transaction does not target the observed refusal; it breaks two existing tests by design and, as stated, could replay a busy-shaped body or COMMIT through `retryBusy`. Implement with the section 4.5(a) constraints and call it hygiene, not the G1 fix. |
| R3 | Medium | Commit durability is unexamined: hold 41 to 56 ms for a two-statement body suggests the COMMIT dominates; no `synchronous` setting is applied. Needs measurement (host and Linux) and an owner decision. |
| R4 | Medium | Poll cycle 189 ms against a designed at most about 100 ms: unexplained. Needs `beginMs`/`backoffMs`. |
| R5 | Medium | Prehash: confirmed hash-in-transaction; any design must keep the hash off the client-controlled body, bound CPU and concurrency, run only after origin and shape checks, and preserve duplicate-response parity. Unverified proposal; about 11 % of occupancy here. |
| R6 | Medium | F3 index migration: build time and startup bound at gigabyte scale; end-to-end hold not measured. |
| R7 | Medium (launch) | M1: no operator recovery procedure for a corrupt wardrobe row; honestly documented as OPEN. |
| R8 | Medium (harness) | `heldResponse` has no deadline, so an unreachable mock hangs the suite. Also the sandbox `makeTempDir` EPERM and loopback EACCES are environment limits, correctly handled by the reviewed rerun; they are not product findings. |
| R9 | Low | F-L1 to F-L4 (idle guard, 15 ms margins in the settle timeout tests, production seam export, stale status header). |
| R10 | Low | GET awaiting bounded cleanup (F5), the near-vacuous static auth test (F9) and the unverified compose runtime items from my previous review remain as recorded. |

## 8. Distinctions kept

- **Fixture acceptance:** accepted. The hidden-writer interference is diagnosed, removed in repository tests without loosening any count, and the retention assertions ran and passed.
- **Release:** FAIL, from the reviewed full run. Restricted-environment and sequential repetitions neither replace nor offset it.
- **Launch:** NOT READY. G1; hashing and fairness; F3; transport/H2; real vision correctness and human-labelled gold; SMTP; HTTPS and hosting; Docker and Linux execution; encrypted off-site recovery; real phones; the Compose/Caddy runtime items (guard message, restart behaviour, `.env` versus `--env-file`, `/bin/sh` in the proxy image, build-context `.env`), none of which these checks touch.
- No production build, compiled browser suite or deployment is claimed for 015.
