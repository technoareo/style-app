# Build 016 Revision 4: independent review (Claude)

Written for: root and the owner, as the review of the 213-file `build-016-revision4` freeze, its three approved full runs and the red-before-green diagnostic.

I used Read, Glob and Grep, plus this one Write. I ran no shell, tests, typecheck, build, network or browser, started no subagent, edited no source and made no git call. I did not open `.env*`, `.data`, `.runtime`, `node_modules` or `sources/`.

Evidence classes: **Read** (I read it in the working tree), **Log** (root's recorded results in `BUILD016_ROOT_CHECKS.md`; I did not open the log files), **Reasoning** (my inference, not run), **Author** (a claim only in the author's notes), **Unverified**.

## 0. Reviewed material and exact read gaps

Read in full: `build-016-revision3-claude.md`, `BUILD016_ROOT_CHECKS.md`, `implementation-016-notes.md` (Revision 4, lines 186 to 240), `src/server/database.ts`, `src/server/directoryLock.ts`, `src/app/api/health/route.ts`, `tests/helpers/backupChild.ts`, `tests/healthUnusable016.test.ts`, `tests/queuedWaiterQuarantine016.test.ts`.

Read in part:
- `backupSafety.test.ts`: lines 255 to 775. I did not re-read 1 to 254 or 771 onward.
- `backupDatabase.ts`: Grep with context only (lines 126 to 141 and 361 to 375).
- `rollbackFailure016.test.ts`: lines 370 to 432, plus a Grep of finally, release and isOpen lines.
- `presenceLifecycle016.test.ts`: Grep of finally, isOpen, restore and previousDir lines only.
- `DEPLOYMENT.md`: Grep counts only, and two long matching lines were omitted from the output, so I never saw them.
- Repo-wide Grep of `src`, `scripts` and `deploy` for `onBusy`, `onLockWait` and `acquireProcessLock(`.

Not read, so nothing below says anything about them:
- The three full-run logs, `targeted-016-revision4-reviewed.log` and `recovery-016-red-before-green.log` (Log below is root's summary).
- Any manifest, so I cannot confirm the 213 files are unchanged. That is root's byte check.
- `writeTransaction.ts` and `processPresence.ts` this round. The first is listed modified in the session-start git status, and I last read it in Revision 3.
- `compose.yaml` and `Caddyfile`. Their behaviour comes from my Revision 3 reading plus the author's and root's notes.
- The mailer and worker health paths.
- `scripts/` callers of `createBackup`, `restore-database.ts`, `mock-ollama.mjs`, `vision.ts`, `analysisJobs.ts` and `lockDiagnostics.ts`.
- node:sqlite internals.
- Linux behaviour of any of this.

The production compile is running and unclaimed. I make no statement about it.

## 1. Verdicts (kept separate)

| Question | Verdict |
|---|---|
| **Scoped: backup contender fix** (`onBusy`/`onLockWait` seam, `waiting` IPC, `within`/`withChildren` cleanup) | **ACCEPT.** It replaces timing inference with program-order causality. Conditions are P3 (section 2). |
| **Scoped: same-millisecond test rework** | **ACCEPT with one stated weakening** of failure diagnosis, not of the invariant (section 3). |
| **Scoped: busy-callback containment** | **ACCEPT the implementation for its actual use; REJECT the wording.** "Cannot delay, shorten or otherwise change the wait" is false for a synchronous callback. A throwing `options.onBusy` getter escapes the guard. Both are cheap to fix (section 4). |
| **Scoped: health false-ready fix** | **ACCEPT** for the web process, at source level, with conditions (section 5). |
| **Scoped: quarantine log line** | **ACCEPT.** Fixed text, literal outcome and integer only. |
| **Scoped: recovery lifecycle (Revision 3 items) after Revision 4's test-hygiene edits** | **ACCEPT.** The red/green evidence is real but weaker than it looks (section 7). |
| **Operational completeness** | **NOT complete.** The recovery procedure is in author notes, not in `DEPLOYMENT.md`. This must be fixed before launch, and it needs no new owner decision (section 6). |
| **Repeat-suite evidence** | **Sufficient for the scoped acceptance above. Not a flake bound, not load-tested** (section 8). |
| **Release verdict** | **CONDITIONAL.** Accept as a test-verified *source candidate* that may proceed to the compiled-build and current-Linux gates. It is **not releasable as a build** until the production compile and a Linux/container run pass on this exact manifest (or its documented successor). |
| **Launch** | **NOT READY.** Vision quality and whole-wardrobe acceptance, compiled browser and current Linux, transport/H2, real hosting/HTTPS/SMTP, off-site recovery and real phones are open. Unit and integration tests are not launch evidence. |

I found no new P1.

## 2. Causal backup waiting IPC (`directoryLock.ts`, `backupDatabase.ts`, `backupChild.ts`, `backupSafety.test.ts`)

**Read, and correct.**

- `directoryLock.ts:131-134` fires `notifyBusy` once, on the first genuine `isSqliteBusy` refusal. That is before the deadline check and before the first poll sleep, and never when the lock is free. `backupDatabase.ts:367-370` forwards it only when set. `backupChild.ts:62-65` sends `{ stage: "waiting", at }` from it.
- `forkBackup` (`backupSafety.test.ts:301-357`) discriminates IPC by `stage`. `reached()` flips only on `"raw-copied"` (line 324). That fixes the Revision 3 hazard I raised, where any message would have set it. Each `stageReached` promise rejects with the child's stdout and stderr if the child closes first, and carries `.catch(() => {})`.
- The contender test (lines 439-495) waits on `Promise.all([b1.waiting, b2.waiting])` under a 60 s bound. Assertions 458/459 (`reached() === false`) are now **non-vacuous**: each contender has demonstrably been refused. The owner is killed only after that.
- Assertion 486 (`second.startedAt < first.rawCopiedAt`) now holds by construction, in this chain: `startedAt <= waitingAt <= killedAt <= first.rawCopiedAt`. Assertions 477-488 carry a JSON detail. The earlier ones (waiting before kill, `first.rawCopiedAt >= killedAt`, non-overlap) are kept.
- Kill-time fidelity: the child's `at` and the parent's `killedAt` come from `Date.now()` on one host. The kill is issued after the parent received both messages, so `waiting*.at <= killedAt` is causal, not statistical. A backward wall-clock step is the only escape, which I regard as negligible.
- `withChildren` (381-390) always SIGKILLs and awaits every tracked child in `finally`. The body's error wins, and a cleanup problem is thrown only if the body succeeded. It is applied to the killed-owner, contender, live-blocked-owner and same-millisecond tests. This answers the missing-`try/finally` finding.

**What the causal signal does and does not prove (Reasoning).** `waiting` proves a refusal happened. It does not prove the owner still held the lock at the later kill. That is true by construction here (a 120 s `Atomics.wait` block), and the author states it (notes line 210). It is acceptable and should stay written down.

**Conditions (all P3):**

- **Timeout arithmetic.** The tests carry a 300 s node:test timeout, but the chained failure-path bounds can total more. The contender test allows 60 (owner) + 60 (waiting) + 120 + 120 (exits) + 15, about 375 s. node:test does not cancel the async body when its timeout fires, so a late body can overlap the next test. The window is failure-path only and `withChildren` still reaps. Either raise the per-test timeout above the sum or shrink the exit bounds.
- **Unused data.** `Mark.receivedAt` and `marks()` are recorded but never asserted or printed. Put `receivedAt` into the `detail` JSON or drop it.
- **`liveChildren` is module-level.** A test that forks without `withChildren` leaks entries into a later test's reap. All four current fork users use it; this is a maintenance trap only.
- **Strict `<` at line 486** would fail only if `startedAt`, `waitingAt`, the kill and `rawCopiedAt` all fell in one millisecond. That is not credible, since a kill and a full backup stage sequence separate them. No change needed.

## 3. Same-millisecond scenario fidelity (`backupSafety.test.ts:687-769`)

**Preserved (Read):**
- The same injected `TEST_BACKUP_STAMP` in both children, so the same-name collision exists by construction (the "same millisecond" is the injected clock, not process start-up).
- The sentinel file and its byte-identity assertion.
- The `-1` and `-2` final names, the integrity checks, no partials and no marker bytes.
- A 3 s hold in the winner.

The old defect is gone: overlap no longer depends on the later child starting within 3 s. The winner now also waits at a parent-sent `release`, sent only after one child reports a real busy refusal. IPC ordering is safe: the loser's refusal implies the winner already holds the lock and is inside `createBackup`, so the winner's `process.on("message")` (registered at the top of `main()`, `backupChild.ts:48-54`) exists long before `release` is sent. The promise also remembers an early message.

**One honest weakening to record (Reasoning).** Because the loser's refusal now gates the release, a broken lock (no refusal) produces a 60 s `Promise.race` timeout, not a failure of the overlap assertions. In that case neither child sends `waiting`, both sit at the gate, and the test fails by timeout. It still fails, so the invariant is guarded. But the `>= 2_500` hold-overlap assertion (743-745) is now unreachable in the broken-lock case and near-tautological otherwise (the hold is at least 3 s by construction). Say so in the notes, and consider putting the winner's `raw-copied` vs loser's `raw-copied` ordering into the timeout message. P3.

`second.startedAt < first.doneAt` (728) is now also near-tautological (`startedAt <= waitingAt <= release < first.doneAt`). It is harmless. The authentic overlap assertion is 732 (`loserWaiting.at <= first.doneAt && < second.rawCopiedAt`).

## 4. Bounded cleanup and diagnostic callbacks

### 4.1 Is the callback trusted or public? (Read)

My repo-wide Grep over `src`, `scripts` and `deploy` shows `onBusy` and `onLockWait` are referenced **only** in `directoryLock.ts` and `backupDatabase.ts` (the type and the forwarding). No production code passes either; `deletionLedger.ts:295, 369` call `acquireProcessLock` without it. The only callers that supply one are the tests (`backupChild.ts`, `backupSafety.test.ts`). The options come from in-process TypeScript call sites, not from request input, environment variables or parsed files. So the callback is **internal and trusted**, a test seam on a non-network operator path. I read no `scripts/` caller of `createBackup`; that is the one gap in "no production caller passes it", and the Grep covers `scripts` for these names anyway.

Practical risk is therefore a future maintainer wiring a slow or buggy callback, not an attacker. An arbitrary monkeypatch (replacing `process.send`, redefining `Date`, patching `console.error`) is outside the threat model of any in-process guard and I do not weigh it.

### 4.2 The claim "cannot delay or shorten" is false for synchronous callbacks (Read, root is right)

`notifyBusy` calls the callback synchronously on the event loop, **before** the `Date.now() >= deadline` check (`directoryLock.ts:131-135`).

- A synchronous callback that takes time **does** consume the absolute deadline and blocks the loop. If it exceeds the remaining wait, a would-be wait becomes an immediate `LockBusyError` (it still reports the right error, so correctness holds, but the claimed property does not).
- It also parks every other timer, request and heartbeat in that process. In a backup CLI that is irrelevant, but in the server it is not.
- The wording appears in `directoryLock.ts:76-82` (comment) and notes line 202 ("can never ... delay, shorten or otherwise change the lock, the wait, the deadline"). The test at lines 558-573 supports the narrower true statement: **a throw or rejection does not shorten the wait.** It does not support "cannot delay" and does not test a slow callback.

**Fix (comment and notes only):** say "contained against throws and rejections; synchronous time spent in the callback runs on the event loop and counts against `waitMs`, so keep it trivial (a fixed, non-blocking IPC send)." Optionally add an assertion-free comment on the lock, not code.

### 4.3 Getter outside the guard (Read, root is right)

`notifyBusy(options.onBusy)` evaluates the `onBusy` property in the caller, which is inside the inner `catch (error)` block of the polling loop and inside the outer `try`. A throwing getter, or a non-function value, never reaches `notifyBusy`'s own `try`. A getter throw propagates from the inner catch to the outer catch, which closes the handle and rethrows the **getter's** error. So a busy wait is aborted at the first refusal and the caller sees a foreign error, not `LockBusyError` or a granted lock. A non-function value is safe only because it throws a TypeError **inside** `notifyBusy`'s try.

`backupDatabase.ts:369` repeats the shape: `options.onLockWait ? { onBusy: options.onLockWait } : {}` reads the property twice outside any guard, and a throwing getter fails `createBackup` before the lock. For `BackupOptions` as a plain object literal this cannot happen; it needs a hand-written accessor.

**Minimal fixes (P3, both lines):**
- `directoryLock.ts`: move the property read into the guard, for example `notifyBusy(() => options.onBusy?.())` with `notifyBusy` unchanged, or pass `options` and read inside `try`.
- `backupDatabase.ts:369`: forward a thunk, `onBusy: () => options.onLockWait?.()`, always set. A harmless no-op when unset, and it removes the double read.

**Add a test** (not run by anyone): `acquireProcessLock(file, { waitMs: 300, pollMs: 20, get onBusy() { throw new Error("getter") } })` against a held lock. Expected: `LockBusyError` after at least 250 ms, and with a free lock it must not throw.

### 4.4 Severity

P3. The seam is test-only, internal, and unused in production, so neither item is reachable by request input. They are cheap, and the false claim is the more important of the two because it is a safety assertion in a source comment.

**Cost of editing source now.** Any source edit, even a comment, changes the manifest. I recommend a comment-only plus thunk change be treated as **Revision 5 (small)**: new manifest, a diff proof that only those lines changed, typecheck, lint, the `backupSafety` file and the new getter test. Do **not** require another three full runs for a change this size, unless the diff touches anything beyond those lines. If root prefers not to touch source, correct the claim in the notes and leave the comment wrong, with the discrepancy recorded. That is acceptable, but second-best.

### 4.5 Logger (`database.ts:175-183`)

`logQuarantine` catches synchronous throws only. `console.error` is the Node built-in; it returns nothing, and Node's `Console` ignores stream write errors. So an async rejection from it does not occur in practice. A replaced `console.error` that returns a rejected promise would leak an unhandled rejection. That is an arbitrary monkeypatch, not a practical risk, and I do not ask for a fix. The test at `healthUnusable016.test.ts:142-149` covers the sync-throw case correctly.

Quarantine state is set before the log is called. The log runs inside `quarantineMainConnection`'s outer `try/catch`, so nothing it does can change `database`, `unusableMain` or the caller's reported error. Read, correct.

Minor: the `marked-only` outcome (`database !== db`) is logged as "main connection quarantined", which an operator may read as the shared connection having been affected. The write path re-resolves under the gate (Revision 3), so I expect this branch to be rare. Consider a clearer literal such as `outcome=marked-only (handle already replaced)`. P3.

## 5. Health false-ready fix

**Read, and correct for what it claims.** `mainConnectionUnusable()` (`database.ts:163-165`) is a pure flag read, set only when the quarantined handle could not be closed and never cleared. The route (`route.ts:13-28`) calls it after `getReadyAuth()` inside the `try`, and returns the same fixed `{ ready: false }`, 503, `no-store` it already used for a failed init. No reason text; the route is unauthenticated. `healthUnusable016.test.ts` asserts the exact body (`JSON.stringify({ ready: false })`), status, `no-store`, two repeated probes, the unclosed log line, and the state after the stuck handle really closes. I find no defect in the control flow.

**What remains false-ready (Reasoning/Read):**
- **Worker and mailer.** Neither has an equivalent signal. A stuck main connection in the app process holds SQLite's write lock for them. (`compose.yaml` was not re-read; this is from my Revision 3 reading and the author's notes.) Disclosed by the author. Document it in the runbook.
- **Auth connection.** There is no quarantine concept for it. A failed auth-side transaction state is not reflected.
- **Reopen failure after a successful quarantine close.** If the replacement connection cannot be opened, the flag stays false. Health says 200 while each write retries and fails. That is a transient, self-clearing state by design and I do not propose changing it, but it is not covered by the signal.
- **Compiled server.** The health test imports the route with `tsx` against source. Whether the production bundle shares **one `database.ts` module instance** between the health route and the write routes (the premise that the flag the writers set is the flag the probe reads) depends on how Next chunks server modules. The whole design already relies on singleton `getDatabase()` sharing, so I expect it to hold, but no compiled evidence exists yet. **Unverified.** Ask root to confirm during the compiled/browser gate: force the unusable state in a compiled server (only possible with a test hook, so possibly by reading, not forcing) or at least record that the compiled gate does not exercise it.

**Pure safe signal and no forced exit** is the chosen policy and I agree with it: a forced `process.exit` would cut in-flight uploads.

## 6. Operational guidance belongs in `docs/DEPLOYMENT.md` (P2, needs no owner decision)

My Grep found no occurrence of `quarantin`, `[database]` or `ready: false` in `DEPLOYMENT.md` (0 matches), so the procedure exists only in `implementation-016-notes.md` line 217. An operator reading the deployment guide will not see it. This is routine documentation of behaviour already built, so root can write it without asking the owner. The only owner decision (automatic restart policy) is separate and is not blocked.

Suggested runbook section, "Main database connection unusable":
1. **Detect.** `/api/health` returns 503 `{"ready":false}` while the app otherwise answers; Compose shows `app` unhealthy after about a minute; the app log has `[database] main connection quarantined: outcome=unclosed count=<n>`. Alert on the unhealthy status and on that log line.
2. **Meaning.** `outcome=replaceable`: self-healed (a failed rollback; the handle closed and a fresh connection is in use); investigate only if the count repeats (disk full, I/O errors). `outcome=unclosed`: this process now refuses every database access until restarted, and the stuck transaction may hold SQLite's write lock from the worker and mailer. Wardrobe and photo writes fail; sign-in may still work.
3. **Plain Compose does not recover it.** `restart: unless-stopped` acts only when the process exits; an unhealthy flag restarts nothing; `deploy/Caddyfile` has a plain `reverse_proxy` with no active health check, so the 503 changes no traffic.
4. **Action.** Avoid cutting active uploads where practical (drain or wait), restart the `app` service, then check the worker and mailer logs for repeated busy or timeout errors and restart them if they are stuck. Confirm `/api/health` returns 200. Do **not** delete or copy `app.db`, `-wal` or `-shm` files by hand.
5. **Afterwards.** Take a verified backup, and record the incident. If it recurs, look at the volume (local, not NFS/SMB; see `directoryLock.ts` residual cases).
6. **Not covered.** Worker and mailer have no equivalent signal; automatic recovery (an autoheal on the unhealthy status, or workers exiting after the current job) is an open owner decision.

## 7. Assertion fidelity and the red-before-green evidence

**Gate and handle cleanup (Read).**
- `queuedWaiterQuarantine016.test.ts` (W2): the gate is released through a once-only function that the `finally` also calls, and `finally` awaits `settled`. Correct and an improvement.
- `rollbackFailure016.test.ts` last test (370-432): override removal and `closeDatabases()` are now in `finally`; a cleanup error is held in `cleanupError` and thrown only if the body succeeded, so it cannot mask the original failure. Correct.
- `healthUnusable016.test.ts` last test (`finally` at 182-186): `restore`, `closeDatabases()` and `assert.equal(stuck.isOpen, false)` are unguarded. If cleanup throws it replaces the earlier assertion failure. Same for the W2 `finally` (89-93). P3: adopt the `cleanupError` pattern from `rollbackFailure016`.
- W2's `await settled` is unbounded. If a queued writer never settles, the test hangs with no timeout (the repo sets none). P3: race it with a bounded timer.
- `presenceLifecycle016.test.ts`: Grep shows `isOpen` assertions in the `finally` of D2, E and F (lines 143-145, 167-169, 198-199, 248-249, 288-291), consistent with the notes. I did not read the bodies, so I cannot say whether a failing `finally` assertion would mask an earlier detail.

**Red-before-green (Log).** Root ran the frozen `build-016-corrected/src` against the Revision 3 fixture recovery tests: 15 total, 8 pass, 7 fail, 0 skipped. Failures are C and D (untracked unclosed handles), A (presence after auth close), B (after a failed shutdown close), and W1, W2 and W3 (stale waiter, wrong error class, stale `ERR_INVALID_STATE`). E, F and ordinary non-quarantine rollback pass. I accept this as observed discrimination.

- **My Revision 3 expectation was wrong** (I predicted B would stay green). Root's log shows it fails at the failed-shutdown stage on the old source. I accept that.
- The author-side finding that the `finally` `isOpen` assertions **mask the earlier assertion detail** in C and D is correct and matters: the run proves the tests fail on old source, not *which* assertion first failed. Test-level discrimination only.
- **Scope of the evidence:** the red run used the Revision 3 test bodies. Revision 4 then edited the `finally` blocks of D2, E and F, W1/W2/W3, the last rollback test, the backup tests, and added the health test. Those edits have **no red observation**. The health test is new and has never failed anywhere; the contender fix cannot be shown red because the original failure was never reproduced. They are covered only by the current green runs. State this plainly; do not describe the Revision 4 tests as regression-proven.

## 8. Repeat-suite evidence (Log)

- Typecheck and lint PASS; the 57-test focused run passed with 0 formal skips; three sequential approved full runs each gave 310 total, 306 pass, 0 fail, 4 skip, in 71.850, 71.872 and 72.122 s, exit 0; the manifest was unchanged afterwards; the original failure is retained.
- **What it supports:** the 213-file candidate passes the full suite on this host three times in a row with unchanged workloads and budgets, and the contender test no longer depends on start-up skew. The spread is very tight (0.27 s), which also says the host was quiet.
- **What it does not support:** the Revision 3 full run took 116.5 s for 305 tests and the cause was never explained. Revision 4 ran at about 72 s for 310, in line with the 79.3 s of the 295-test corrected run. The 116 s run is therefore the outlier, and nothing in the three clean runs tests the load that produced it. The handshake removes the contender test's dependence on that load by construction. Other timing-bearing tests (for example takeover `< 5_000`, fixed `sleep`s of 150 to 300 ms and the 4 s sleep in the live-blocked-owner test at line 643) are unchanged and still load-sensitive. The 015 "mixed-process acquisition refusal" (G1) has not been seen in 016 either way. Three passes are not a flake bound.
- **Recommended extra (P2, optional):** one full run under induced load (for example two suites concurrently, or a CPU-throttled container) with the result reported whether it passes or fails. This is the closest available check on the exact condition that caused the original failure.
- **Unexercised branch:** the coordinator-link guard test (`backupSafety.test.ts:521-532`) prints a warning and `return`s as a **pass** when the account cannot create links (Windows). That is why "0 formal skips" does not cover it. Make it call `t.skip(...)` so it reports as a skip, and rely on Linux/container CI for the real run. P3.

## 9. Prioritised recommendations

**P1** None.

**P2**
1. Write the section 6 runbook into `docs/DEPLOYMENT.md` before launch. Docs only. State that unhealthy alone restarts nothing and that the worker and mailer are not covered.
2. Run production compile and a Linux/container execution on this exact manifest (or its documented successor). Both are required for the release verdict to move beyond "CONDITIONAL". Record whether the compiled health route shares the `database.ts` instance with the write routes (section 5).
3. Correct the false "cannot delay or shorten" claim in `directoryLock.ts:76-82` and in the notes (section 4.2), with the small getter guard and thunk (4.3) and its test, as a small Revision 5. If root declines, record the wording discrepancy in the notes.
4. One full run under induced load, reported either way (section 8).

**P3**
5. Raise the per-test timeout above the sum of the chained bounds or shrink the exit bounds (section 2).
6. Note the same-millisecond diagnosis weakening (section 3).
7. Use the `cleanupError` pattern in the `finally` of the health last test and W2, and bound `await settled`.
8. Clearer `marked-only` log wording; use or drop `Mark.receivedAt` (section 4.5, section 2).
9. Turn the link-guard early `return` into `t.skip` (section 8).
10. Carried forward from Revision 3, unchanged: `isOpen` is not proof of a released file lock; `closeDatabases()` swallows retry errors at shutdown; `unusableMain` is never cleared; shutdown revival by a stale waiter; `DatabaseQuarantineError` is not mapped to a route response; un-gated cached handles still fail loudly.

## 10. What stays open

Real vision quality and whole-wardrobe acceptance. Compiled browser coverage and current-Linux execution (the earlier Linux success applies to commit `df3b3d2` only). Transport and HTTP/2 behaviour under a real front end. Real hosting, HTTPS and SMTP. Off-site encrypted recovery and real-phone acceptance. The `synchronous` durability decision. A load-tested repeat of the full suite. Worker and mailer health. Automatic restart policy (owner decision). The refund-exposure decision. Focused and repeated green unit tests are not launch evidence.
