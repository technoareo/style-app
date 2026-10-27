# Build 016 Revision 3: independent review (Claude)

Written for: root and the owner, as the review of the 212-file Revision 3 freeze (`build-016-revision3-fixture`) and of the one failure in the first approved full run.

I used Read, Glob, Grep and this one Write. I ran no shell, tests, typecheck, build, network or browser, started no subagent, edited no source and made no git call. I did not open `.env*`, `.data`, `.runtime`, `node_modules` or `sources/`.

Evidence classes: **Read** (I read it in the working tree), **Log** (root's recorded output, which I read), **Reasoning** (my inference, not run), **Author** (a claim only in the author's notes), **Unverified**.

## 0. Reviewed material, deviations, evidence gaps

Read in full: `BUILD016_ROOT_CHECKS.md`, `implementation-016-notes.md`, `build-016-corrected-claude.md`, `database.ts`, `writeTransaction.ts`, `processPresence.ts`, `directoryLock.ts`, `backupChild.ts`, `presenceLifecycle016.test.ts`, `presenceLifecycleNoAuth016.test.ts`, `queuedWaiterQuarantine016.test.ts`, `rollbackFailure016.test.ts`, `quarantine-presence-probe-016-revision3.json`, `quarantine-waiter-probe-016-revision3.json`, `src/app/api/health/route.ts`, `compose.yaml`.

Read in part: `backupSafety.test.ts` (1 to 550), `backupDatabase.ts` (350 to 420 plus Grep), `auth.ts` (Grep with context for `getReadyAuth`), `backend-016-revision3-reviewed-01.log` (Grep: failure block, per-test lines, totals), `deploy/Caddyfile` and `scripts/analysis-worker.ts` (Grep only).

Gaps, stated plainly:

- I read the working tree, not `../build-016-revision3-fixture`, and I cannot hash. Equality with the 212-file manifest is root's check.
- I did **not** re-read the original probe `.mjs` files this round (only the two Revision 3 result JSONs); the originals were read in the previous review.
- I did not read `processPresence.test.ts` (case G). `git status` at session start lists it as unmodified, so "unchanged" is Reasoning from that, not a diff.
- I have no diff, so "no existing test was weakened or removed" (Author) is **Unverified** by me.
- The failing log gives no child timestamps: the assertion has no message values, so `startedAt`, `rawCopiedAt` and `killedAt` for the failing run were never recorded. Section 2 therefore rests on a logical argument, not on measured numbers.
- Not read: `mail-worker.ts --check`, `writeGate.ts`, `sqliteRetry.ts`, `lockDiagnostics.test.ts`, `vision.ts` (author says unchanged this revision), the node:sqlite implementation.
- The wall time of the full run rose from 79.3 s (corrected, 295 tests) to 116.5 s (this run, 305 tests). Ten more tests do not explain 37 s. Whether anything else ran on the machine is unknown to me.

## 1. Verdicts (kept separate)

| Question | Verdict |
|---|---|
| **Scoped acceptance: presence retention across quarantine, close, reopen failure and shutdown** | **ACCEPT, with conditions** (section 3). Closes the prior P1 by reading, by root's Revision 3 probe (refusal at all three stages) and by the recovery tests (Log, 74/74 focused). |
| **Scoped acceptance: queued waiters re-resolve under the gate** | **ACCEPT, with conditions** (section 4). Closes the prior P1 by reading, root's waiter probe (`secondCalls` 1, fresh write succeeds) and W1 to W4. |
| **Scoped acceptance: quarantine design as a whole (errors, gate release, diagnostics)** | **ACCEPT the in-process semantics. NOT accepted as operationally complete:** no operator-visible record of a quarantine, and `/api/health` stays ready in the unusable state (section 5). |
| **Test-harness finding: `backupSafety.test.ts:355`** | **Test defect, not a lock defect. Root's hypothesis is correct on cause, and stronger than "plausible": the failure logically implies it. The proposed handshake is necessary but, as stated ("ready"), not sufficient for what the test claims.** Section 2. |
| **Release verdict for Revision 3** | **NOT RELEASABLE as a verified candidate.** The first approved full run failed (305/300/1/4), runs 02 and 03 never ran, and the failing test has not been corrected or re-run. Focused 74/74 is real evidence for the recovery changes; it is not a full-suite pass. |
| **Launch** | **NOT READY.** Vision quality, current-candidate Linux and browser, transport and HTTP/2, real hosting, HTTPS, SMTP, off-site recovery and phones are open and nothing here touches them. |

## 2. The backup contender failure

### 2.1 What failed (Log, Read)

`backupSafety.test.ts:381`, `assert.ok(second.startedAt < first.rawCopiedAt, "both were contenders for the same release")`, `actual: false`, in a 12.7 s test. In the same test these passed first: both contenders exited 0 (371, 372), `first.rawCopiedAt >= killedAt` (377), `second.rawCopiedAt >= first.doneAt - 50` (380). The assertions after it (382 to 386: owner's partial removed, two finals, no partials, no marker bytes) **did not execute**, so this run says nothing about them. The neighbouring tests (killed owner, live blocked owner, same-millisecond, lock module) passed in the same run.

`backupDatabase.ts`, `directoryLock.ts`, `backupChild.ts` and this test are not in the modified list at session start. The test dates from build 009. This is a latent test timing assumption exposed by load, not a Revision 3 regression in the lock code (Reasoning from status, Read of the sources).

### 2.2 Independent assessment of the root hypothesis

Root: the fixed 4-second sleep does not establish that both contenders are running.

**Confirmed, and provably so.** `startedAt` is `Date.now()` taken on the first line of the child's `main()` (`backupChild.ts:25`), before `getDatabase()` and before the lock call. Assertion 377 passed, so `first.rawCopiedAt >= killedAt`. Assertion 381 failing means `second.startedAt >= first.rawCopiedAt >= killedAt`. So the second contender's `main()` **had not begun when the parent killed the owner**, which is 4 s plus after both forks. If both contenders had started before the kill, `second.startedAt < killedAt <= first.rawCopiedAt` and 381 could not fail. The only escape is a wall-clock step backward during the test, which I regard as negligible but cannot exclude (no timestamps logged). The fixed sleep is therefore the cause, not a candidate.

Why start-up can exceed 4 s (Reasoning): each child is `node --import tsx` and loads `backupChild.ts`, which imports `database.ts`, which imports `better-auth/db/migration`, `proper-lockfile` and the whole backup module before `main()` runs. The full suite runs test files in parallel (`tsx --test tests/*.test.ts`), and this run took 116 s. A multi-second import under that load is plausible. I did not measure it.

Second consequence: the earlier assertions "contender 1/2 cannot start while the owner lives" (365, 366) are **vacuous for a child that has not yet started**. They passed in the failing run regardless.

### 2.3 The hypothesis understates one problem

Even with perfect start-up, the assertion at 381 does not test what its message says. `startedAt` marks "module loaded", not "was refused by the lock and is polling". The test claims two contenders *waiting on a live owner*. Nothing in it observes a refused attempt. `copy-started` cannot serve as the signal either: `backupDatabase.ts:382` fires it **after** `acquireProcessLock` returns.

### 2.4 Smallest correct correction (not implemented)

Goal: replace the timing inference by program-order causality. No sleep is lengthened and no assertion is weakened.

1. **A causal "waiting" signal (the sufficient version).** Add an optional, additive callback invoked once, on the first busy refusal, before the first poll sleep:
   - `ProcessLockOptions.onBusy?: () => void` in `directoryLock.ts`, called in the `catch` after `isSqliteBusy(error)` is true, guarded so it fires once;
   - `BackupOptions.onLockWait?: () => void`, forwarded by `createBackup` to `acquireProcessLock`;
   - in `backupChild.ts`: `onLockWait: () => process.send?.({ stage: "waiting" })`.

   It changes nothing when unset, and `BackupOptions` already carries test seams (`onStage`, `io`). Because the owner holds `BEGIN IMMEDIATE` for the whole test, each contender's first attempt is guaranteed busy, so "waiting" is guaranteed to arrive or the test fails by its bound. This is a small production-source edit for a test seam; say so in the notes.
2. **The test-only fallback ("ready").** If root will not touch source: send `{ stage: "started" }` from `backupChild.ts` after `getDatabase()` returns and immediately before `createBackup`. This removes the observed failure (start-up skew). Its residual, which must be written down: "started" is not "refused by the lock", so the claim shrinks to "both were running and about to contend". Do not describe it as a waiting proof.
3. **Harness changes common to both:**
   - `forkBackup` currently resolves `raw` and sets `reached` on **any** IPC message (`proc.on("message", ...)` ignores the payload). New messages must be discriminated by `stage`, or `reached()` flips on "waiting" and assertions 365, 366 become wrong.
   - Add a `waiting` (or `started`) promise per child that rejects if the child exits first, with `.catch(() => {})` as `raw` has.
   - Replace `await sleep(4_000)` with `await Promise.all([b1.waiting, b2.waiting])` under a bound (for example 60 s). The bound only matters on failure; the success path returns when the messages arrive, so no latency is added.
   - Keep 365 to 367, keep 377 to 386 verbatim, keep 381 verbatim (it then holds by construction: `startedAt < waiting < killedAt <= rawCopiedAt`). Put the numbers into the failure messages of 377, 380 and 381 so the next failure is diagnosable.
   - Give the test an explicit `{ timeout }` (the repo has no `--test-timeout`; `package.json` test script is `tsx --test tests/*.test.ts`), because the owner blocks for 120 s and the contenders wait up to 90 s.
4. **Bounded failure and cleanup.** The test has no `try/finally` (Read). Create a `procs` list before the first fork, wrap everything after it in `try { ... } finally { ... }` and in `finally` SIGKILL every child that has no `exitCode` or `signalCode`, then await each `close` with a bound. Without this, a failure at 365 to 371 leaves the owner alive for up to 120 s holding the coordinator lock, and the later tests in the file (`acquireProcessLock(file, { waitMs: 0 })` at 393, the `lockWaitMs: 0` expectations) fail for an unrelated reason. The same missing cleanup applies to "a killed owner..." (310) for the same reason.

### 2.5 Same defect class elsewhere (not observed to fail)

"two backups started in the same millisecond" (479 to 530) asserts `second.startedAt < first.doneAt` with a 3 s hold, using `execFile` children without IPC. If the later child needs more than about 3 s to reach `main()`, it fails the same way. It passed in this run (11.1 s). P2: give it the same handshake, or at least message values. I make no claim that it will fail.

### 2.6 Not a reason to relax anything

Do not widen the 4 s, do not delete 381, do not mark the test flaky and retry. A retry loop would hide a start-up delay that is itself useful to know about.

## 3. Presence retention (`database.ts`)

**Read, and correct.** `unclosed` replaces `unusableHandle`; `closeTracked` never throws, asks `isOpen` afterwards, treats an unaskable handle as open and a handle that reports closed after a throwing `close()` as closed; `anyHandleOpen()` also checks both singleton slots; `releasePresenceIfIdle` refuses while any is open. Used in `closeAuthDatabase`, `closeDatabases` and `quarantineMainConnection`. I traced:

- ordinary auth close failure: `authDatabase` is nulled, the handle goes into `unclosed`, the error propagates from the `finally` that then declines to release (test C);
- ordinary main close failure at shutdown (test D) and late-throwing close (D2);
- successful quarantine close: handle closed, not in `unclosed`, presence kept, reopen under the same hold (E);
- failed quarantine close: `unusableMain` set, hold kept through `closeAuthDatabase()` and a failing `closeDatabases()` (A, B; root's Revision 3 probe shows refusal at all three stages, Log);
- `openConnection` failure: released only when nothing is open (F and its twin). With the hold already taken, a failed open cannot raise `PresenceBusyError` (`ensurePresence` returns early), so that path is not a reopen concern after a quarantine.

`closeDatabases()` now closes main even if the auth close throws, retries a snapshot of `unclosed`, releases once at the end and rethrows the first error. I find no defect in the control flow.

**Conditions (none blocks the scoped accept):**

- **P3, `isOpen` is not proof of a released file lock (Unverified).** `closeTracked` equates `isOpen === false` with closed. D2 simulates a late-throwing close by calling the real close first and then throwing, which proves the bookkeeping, not that a real `close()` can throw after releasing the connection, nor how node:sqlite behaves if statements are outstanding. I did not read node:sqlite. Say this in the notes; do not claim more.
- **P3, shutdown reports success with a handle still open.** `closeDatabases()` swallows the retry errors (test A (c) asserts it does not throw). Reasonable because the first error was surfaced earlier and the process is ending, but nothing records that a handle survived.
- **P3, `unusableMain` is never cleared**, even after the stuck handle has really closed (A's last assertion pins `getDatabase()` still throwing). That is a stated design choice ("only a restart clears it"). It matters in section 5: with a permanent refusal, restart is the only recovery, so the signal that restart is needed has to exist.
- **P3, `closeDatabases()` finally.** If `releasePresenceIfIdle()` throws (the presence `ROLLBACK` in `releaser`), that error replaces `firstError`. Pre-existing shape; very low likelihood.
- **P3, shutdown revival.** A waiter that captured a handle before `closeDatabases()` finds it closed (`isQuarantined` includes `!isOpen`) and reopens a connection and a hold during shutdown. The process is ending, so this is tolerable; note it.

## 4. Queued waiters and the write path (`writeTransaction.ts`)

**Read, and correct.** After `acquireWriteGate` and inside the existing `try/finally { release() }`, `live = getDatabase()` only when the captured handle `isQuarantined`. BEGIN, body argument, COMMIT, ROLLBACK and `settleOrQuarantine` all use `live`. A failed re-resolution sets `reopenFailed`, which bypasses the `isSqliteBusy` mapping, so the error is rethrown as itself, never as `WriteContentionError`. `began` is false so no rollback runs, `attempts` stays 0, the gate is released by the same `finally`. `timeoutMs` for `retryBusy` is computed after the reopen from the entry `deadline`, so the budget is neither extended nor reset. Placement of the reopen is between `gateAcquiredAt` and the first BEGIN, so it is inside `sqliteMs` and `totalMs` and outside `initializationMs` and `gateMs`, by construction (Read). One `getDatabase()` serves all waiters (the singleton), so several waiters do not open several connections. Replay and error-identity properties of the same-turn block are unchanged.

**Conditions:**

- **P3, test W3 overclaims in its message.** `event.totalMs + 0.5 >= initializationMs + gateMs + sqliteMs` is labelled "the reopen time sits in sqliteMs, not in the other fields". That inequality holds for any placement of the time, so it does not discriminate. The placement is true by construction (above), not by that assertion. The author's notes admit W4 asserts "only a consistency bound"; the assertion message in the file says more than the notes do. Relabel it.
- **P3, `DatabaseQuarantineError` still reaches routes as an unclassified error** (previous review item, unchanged; a product decision).
- **P3, un-gated cached handles** (`analysisJobs.ts` and routes) still hit `ERR_INVALID_STATE` loudly (unchanged, disclosed).

## 5. Health and operations

### 5.1 The unusable-main state can remain falsely ready (Read)

`/api/health` is `await getReadyAuth()` and nothing else. `getReadyAuth` memoises a resolved promise (`auth.ts`, `readyPromise`), so after the first success it returns without touching the database. The route does not import `database.ts`. In the state where a quarantined main handle could not be closed (`unusableMain` set), the process refuses every `getDatabase()` and every write, holds SQLite's write lock against the worker and mailer, and `/api/health` still answers 200 `{ ready: true }`. So yes: it can falsely remain ready. Only the main connection is affected; the auth connection is separate, so sign-in may still work while wardrobe and photo writes fail with 500, which is a partial outage a probe would not see.

### 5.2 What a health signal can and cannot do here (Read)

- `compose.yaml`: the app healthcheck calls `/api/health` and exits 1 on a non-OK status (interval 10 s, 6 retries, so unhealthy after about a minute). `restart: unless-stopped` acts only when the process **exits**; an unhealthy container is not restarted by plain Compose. The worker and mailer use `depends_on: service_healthy` only to order start-up.
- `deploy/Caddyfile` has a plain `reverse_proxy app:3000`; my Grep found no active health check, so a 503 health response changes no traffic.
- The AI worker has no healthcheck in `compose.yaml`; I did not read the mailer's `--check`. An unusable main connection in either worker would be invisible to this signal.

### 5.3 Recommendation (safe signal, no forced exit)

1. Add a pure, non-throwing read to `database.ts` (for example `mainConnectionUnusable(): boolean`, true when `unusableMain` is set). It must not open or query anything.
2. In the health route, after the ready check, return the existing fixed 503 body `{ ready: false }` with `Cache-Control: no-store` when it is true. Add no reason text; the route is unauthenticated.
3. Add an own-process test: before forcing the state the route answers 200; after forcing a failed rollback and failed close (the existing technique) it answers 503 with exactly `{ ready: false }`. The existing health usage is in `mailOutbox.test.ts:641`.
4. Do **not** add `process.exit` to the web process: it would kill in-flight requests, including uploads. If automatic recovery is wanted, do it in the worker loops (exit after the current job; Compose restarts them) or through an external monitor or autoheal acting on the unhealthy status. State in the runbook that, under plain Compose, the unhealthy flag alone restarts nothing. This is an owner decision, as the previous review said.
5. **Diagnostics gap, separate and also real (Read):** neither `database.ts` nor `writeTransaction.ts` logs anything; `quarantinedConnectionCount()` has no consumer outside tests. A quarantine, even a successfully replaced one, leaves no operator-visible record, and an unusable main leaves only 500s. Add one fixed-text log line when a connection is quarantined (outcome: replaced or unclosed, count), with no SQL, paths or user data, and expose the unusable flag as in 5.3.

## 6. Coverage matrix: review's A to F and W1 to W5

| Case | Where | Assessment |
|---|---|---|
| A (double fault, auth open, three stages, then real close) | `presenceLifecycle016` (last) | Present; assertions match the review; root's probe is independent Log evidence. |
| B (same, no auth) | `presenceLifecycleNoAuth016` | Present; own process because main stays refused. |
| C (auth close throws) | `presenceLifecycle016` | Present. |
| D (main close throws) | same | Present; D2 (throw after closing) is an addition. |
| E (successful quarantine and reopen keeps the hold) | same | Present. |
| F (reopen failure releases; retry works; twin with auth keeps) | same | Present; the Revision 3 fixture fix gives the twin its own directory. Depends on `new DatabaseSync(<directory>)` throwing; passes on Windows (Log), unverified on Linux. |
| G (healthy wiring) | `processPresence.test.ts` | Not re-read; unmodified per status. |
| W1 (healthy replace, four waiters) | `rollbackFailure016` | Present, with identity, once-each, rows, queue 0, foreign lock, budgets. |
| W2 (close-failed branch) | `queuedWaiterQuarantine016` | Present; own process. |
| W3 (re-resolution failure) | `rollbackFailure016` | Present; see the message overclaim in section 4. |
| W4 (observer, budgets) | within W1 and W3 | Present for fields and budgets; reopen placement not asserted numerically (Author admits). W2 asserts no observer fields; acceptable. |
| W5 (characterisation of the old failure) | root's probe JSON | Not a test, by the author's choice; acceptable. The Revision 3 probe shows the flip. |

**Red-before-green is not observed for the new tests (Author: "by reading, not observed").** For A the original probe is independent red evidence; for C, D and W1 the old failure is clear from the code but no run on the old tree exists. A cheap discriminating check exists: root froze the pre-Revision 3 tree as `build-016-corrected`; running the new recovery files against its `src` should be red for C, D, A (b) and (c), W1 and green for E, F, B. Do this before calling the tests regression guards.

## 7. Author overclaims about finally cleanup

The notes say every case "removes its overrides in `finally`, calls `closeDatabases()` and asserts `isOpen === false`". By reading:

- **True for C, D, A, B and W2.**
- **Weaker than stated:** D2 and E restore and close in `finally` but assert nothing there (E's `fresh` is scoped inside the `try`); F's `finally` closes and sets the env var but asserts nothing, and neither restores `previousDir` (the file's `after` does).
- **No `finally` for gate release.** W1 asserts `writeGateQueueLength() === 5` **before** calling `release()`, with no `finally` that releases. If that assertion fails the gate stays held and the rest of `rollbackFailure016.test.ts` stalls on it until budgets expire, so a single failure would report several unrelated ones. W2 has the same shape (assertion at line 57 precedes `release()`, and its `finally` does not release). Use a once-only release called in `finally`.
- **Last test of `rollbackFailure016.test.ts`** (pre-existing, Revision 2): its override removal and `closeDatabases()` sit in the main flow, not in `finally`; if an assertion fails midway the stuck handle stays overridden until `after()`, whose `closeDatabases()` then cannot close it. It is the final test of an isolated process, so the damage is bounded.
- **`closeDatabases()` in a `finally` can throw and mask the original assertion.** Prefer cleanup that records its own error and rethrows the first.
- The root's wording, "bounded failure and finally cleanup", is an intent for the backup test, which currently has neither (section 2.4 item 4). It is not yet an accomplished property.

## 8. Prioritised corrections (review only; none implemented)

1. **P1: correct `backupSafety.test.ts:355`** per section 2.4: causal signal (seam preferred, "started" as a stated-limit fallback), `stage`-discriminated IPC, bounded waits, `try/finally` that kills all children, a per-test timeout, values in the assertion messages. No sleep change and no weaker assertion. Apply the same cleanup to the "killed owner" test.
2. **P1: then repeat the full approved run at least three times**, each result reported separately, with the failed run 01 log kept. The remaining two repetitions never ran. One failure and one earlier pass do not bound a flake rate, and G1 remains unobserved in 016.
3. **P2: health signal** and **operator-visible quarantine log** (section 5.3), with the own-process test. Decide the restart policy in the runbook.
4. **P2: red-before-green check** of the new recovery tests against the `build-016-corrected` snapshot.
5. **P2: same-class handshake for the same-millisecond backup test** (section 2.5).
6. **P2: explain the 79 s to 116 s growth** (what else ran; whether the new test files or other load account for it). It bears on how the flake happened.
7. **P3:** gate release in `finally` for W1 and W2; relabel W3's inequality; add `isOpen` assertions in D2, E and F `finally`; document the `isOpen` versus lock-release caveat; document shutdown revival and `closeDatabases()` swallowing; reconsider whether a provably closed stuck handle should allow reopen (previous item 4, optional).
8. **Process:** keep the failed run 01 log and the part 2 shell-heredoc deviation on record. This revision's author reports no shell use (Author).

## 9. What stays open

Nothing above closes: prior vision quality and gold labels; browser coverage of 016; current-candidate Linux and container execution (the CI success applies to commit `df3b3d2` only); transport and HTTP/2 behaviour under a real front end; real hosting, HTTPS and SMTP; off-site encrypted recovery; real-phone acceptance; the `synchronous` durability decision; G1 in a repeated full series; HTTP-client timeout classification against a real model; the refund-exposure decision. Focused green tests are not launch evidence.
