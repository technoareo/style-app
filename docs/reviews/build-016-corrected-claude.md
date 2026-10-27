# Build 016 corrected (Revision 2): independent review (Claude)

Written for: root and the owner, as the review of the corrected 016 candidate (209-file freeze `build-016-corrected`).

I used Read, Glob, Grep and this one Write. I ran no shell, tests, typecheck, build, network or browser, started no subagent, edited no source and committed nothing. I did not open `.env*`, `.data`, `.runtime`, `node_modules` or `sources/`.

Evidence classes: **Read** (I read it in the working tree), **Log** (root's recorded output, which I read), **Reasoning** (my inference from code, not run), **Author** (a claim only in the author's notes), **Unverified**.

## 0. Reviewed material and deviations

Read in full: `BUILD016_ROOT_CHECKS.md`, `implementation-016-notes.md`, `build-016-initial-claude.md`, `LINUX_CI_016_PART1.md`, `database.ts`, `writeTransaction.ts`, `processPresence.ts`, `writeGate.ts`, `sqliteRetry.ts`, `vision.ts`, `rollbackFailure016.test.ts`, `quarantine-presence-probe-016.mjs/.json`, `quarantine-waiter-probe-016.mjs/.json`.

Read in part: `visionCap016.test.ts` (lines 1 to 84 and 180 to 496), `lockDiagnostics.test.ts` (325 to 555), `analysisJobs.ts` (315 to 375, 925 to 1004, plus Grep), `processPresence.test.ts` 84 to 108, `restore-database.ts` 160 to 220; Grep over `src` and `scripts` for `getDatabase`, `closeDatabases`, `closeAuthDatabase`, `claimExclusiveAccess`, `PRAGMA`.

Deviations:

- I read the working tree, not `../build-016-corrected`, and I cannot hash. Equality with the 209-file manifest is root's check.
- Not read: the 209-entry manifest itself, the full-suite and lint/typecheck logs (I rely on root's statements), `queue007.test.ts` and `queue.test.ts` bodies beyond Grep, `authDialect.ts` beyond Grep, `lockRecorder.ts`, `mock-ollama.mjs`, `Dockerfile`, the workflow file. The 60 focused tests and 295 total are root's Log; I have not re-derived them.
- Root ran a diagnostic concurrently with the full suite (disclosed by root). That weakens the full pass only slightly: it is a tiny synthetic run, but the machine was not dedicated.

## 1. Verdicts (kept separate)

| Question | Verdict |
|---|---|
| **Scoped acceptance: stream parser and upstream cancellation** | **ACCEPT, with the low-severity conditions in section 4.** The fail-open defect from the initial review is closed by reading and by 60/60 focused tests (Log). |
| **Scoped acceptance: same-turn write transaction, no replay, decomposition** | **ACCEPT.** Unchanged in substance from the initial review; the replacement timing test is causal and sound (section 5). |
| **Scoped acceptance: rollback-failure quarantine, in-process semantics** | **ACCEPT the design; REJECT two interactions as incomplete** (presence, section 2; queued waiters, section 3). |
| **Scoped acceptance: presence retention across quarantine, close and shutdown** | **REJECT.** Root's probe is correct and the cause is confirmed by Read (section 2). |
| **Scoped acceptance: cause-neutral cut message, timeout classification, refund bound** | **ACCEPT with conditions** (section 6). |
| **Release verdict for the corrected candidate** | **NOT RELEASABLE until P0/P1 below are corrected and re-run.** The full suite passed once (295/291/0/4, Log); that is one observation, not proof the 014/015 failures are gone. |
| **Launch** | **NOT READY.** Section 8. |

## 2. CRITICAL: presence is released while a quarantined or unclosed handle is still open

**Log:** `quarantine-presence-probe-016.json`. With an injected failing ROLLBACK and failing `close()` on the main handle: stage 1 (auth open) refuses; after `closeAuthDatabase()` exclusive access is **granted** while `stuckIsOpen` and `stuckIsTransaction` are both true; after `closeDatabases()` (main close still failing) it is granted again.

**Read, cause (confirms root's hypothesis, and it is wider than root stated):**

- `releasePresenceIfIdle()` (`database.ts:39`) tests only `database` and `authDatabase`. `quarantineMainConnection` sets `database = null` before `close()`, then records the survivor in `unusableHandle`, which `releasePresenceIfIdle` never consults. `closeAuthDatabase()` then calls it and drops the hold.
- `closeDatabases()` (`:169`) has the same blind spot at both of its exits: `if (!database) { releasePresenceIfIdle(); return; }`, and the `finally` after the main close.
- **Wider than the quarantine path (Reasoning):** `closeAuthDatabase()` sets `authDatabase = null` before `close()`, and `closeDatabases()` sets `database = null` before `close()`. If either `close()` throws, the handle is no longer tracked anywhere and the `finally` releases presence. So an ordinary close failure, with no quarantine involved, also yields "presence released, handle possibly open". `unusableHandle` covers only the one quarantine case.
- `openConnection`'s `catch` calls `releasePresenceIfIdle()` too (`:58`). That release-on-initialization-failure behaviour is correct and must be preserved: a `new DatabaseSync` that threw left no handle, so nothing may keep the hold. It must keep working, and it must also respect any unclosed handle.

**Risk classification (honest):** needs a double fault (failed ROLLBACK and failed close) or a close failure; no real occurrence exists, only injection (Log). Likelihood very low. Consequence if it happens: the restore command (`restore-database.ts:181`) is told nobody has the database open, while a live process holds an open handle, and on the quarantine branch that handle sits inside a transaction that holds SQLite's write lock. Restore would then replace `app.db` under it. The operator procedure (stop every service, `STYLE_RESTORE_CONFIRMED`) is still a second guard, and a process stuck in this state refuses all main-connection use until restarted, so an operator would normally restart it. But presence exists precisely to catch the case where the operator is wrong; a guard that opens in the one state the code itself calls broken is a **defect, not an acceptable limit**. P1.

**Precise correction (not implemented):**

1. Track every handle whose closure is not proven, in one module-level set (replace `unusableHandle`, keep `unusableMain` as the refusal flag):
   ```
   const unclosed = new Set<DatabaseSync>();
   function closeProven(db): boolean {       // never throws
     try { if (db.isOpen) db.close(); } catch { /* judged below */ }
     let open = true;                        // cannot be asked => assume open
     try { open = db.isOpen; } catch { }
     if (open) unclosed.add(db); else unclosed.delete(db);
     return !open;
   }
   function anyHandleOpen(): boolean {
     for (const h of unclosed) {
       let open = true; try { open = h.isOpen; } catch { }
       if (open) return true;
       unclosed.delete(h);
     }
     return Boolean(database) || Boolean(authDatabase);
   }
   function releasePresenceIfIdle() { if (anyHandleOpen() || !presence) return; ...unchanged... }
   ```
2. Use `closeProven` in `closeAuthDatabase`, `closeDatabases` and `quarantineMainConnection`. Remove `database`/`authDatabase` from the singleton slot before closing as now (so no new user can obtain them), but add the handle to `unclosed` when closure is not proven. Keep the existing behaviour that a close error the old code let propagate still propagates after bookkeeping (`finally`), so shutdown callers see it.
3. `closeDatabases()` retries every member of `unclosed` (not just one slot), then calls `releasePresenceIfIdle()` once at the end. A handle that finally closes drops out and presence is released then, not before.
4. If `close()` threw but `isOpen` is now false, treat it as closed (the handle is gone), and for the quarantined main handle allow `getDatabase()` to reopen rather than refusing for the life of the process. This is a small availability improvement; optional.
5. **Preserve:** presence is kept (not released and retaken) across a *successful* quarantine close and reopen, as designed. Preserve release when `openConnection` fails and no handle is open (`:58`). Preserve `PresenceBusyError` semantics and the 3 s bound in `holdPresence`. Do not release presence just because the process "is ending"; the kernel does that.
6. Consequence to document: while an unclosed handle exists the restore stays refused until the process exits or the handle really closes. That is the intended direction (safe).
7. Product follow-up (a decision, not a silent change): in the close-failed state the process refuses every main-connection use and holds the write lock against the worker and mailer until restarted. Nothing I read exposes this to a supervisor or health check (I did not read the health route). Consider making the health endpoint fail while `unusableMain` is set, or exiting the process after a bounded drain. Owner decision.

**Tests to add (new file, own process and synthetic data dir, additions only; claim through `claimExclusiveAccess` as `processPresence.test.ts` already does):**

- A. Quarantine with failing rollback and failing `close` on main, auth open: claim refused (a) after quarantine, (b) after `closeAuthDatabase()`, (c) after `closeDatabases()` with `close` still failing. Then remove the overrides, `closeDatabases()`, and the claim is granted and releasable. **Red today at (b) and (c).**
- B. Same with auth never opened (already correct today; pins it).
- C. `closeAuthDatabase()` where the auth handle's `close` throws: the error surfaces, the claim stays refused, a later `closeDatabases()` (override removed) closes it and then the claim succeeds. **Red today** (the handle is untracked).
- D. `closeDatabases()` where the main `close` throws: same assertions.
- E. Successful quarantine close then reopen: presence held throughout (claim refused), fresh connection works; after `closeDatabases()` the claim succeeds.
- F. Reopen failure with no other handle open: `getDatabase()` throws the real error, presence is released (claim granted), and a later `getDatabase()` retries. Make `app.db` unopenable only inside the synthetic dir. A twin with the auth handle open must keep the hold.
- G. The healthy-path wiring test in `processPresence.test.ts` stays unchanged.
- Each test restores overrides in `finally` and asserts `isOpen === false` for every handle at teardown, so a failing test cannot leave a lock behind for the rest of the process.

## 3. Queued waiters capture a stale handle (root's second probe)

**Log:** `quarantine-waiter-probe-016.json`. Two calls queued behind a held gate; the first fails and its rollbacks fail, the main handle is quarantined and closed. The second rejects with `ERR_INVALID_STATE` "database is not open", `secondCalls` 0, and a fresh third call succeeds.

**Read, cause:** `runWriteTransaction` resolves `const db = getDatabase()` at the top (`writeTransaction.ts:94`), **before** `await acquireWriteGate(budget)`. Every waiter keeps that handle across the wait. The gate holder is the only code that can quarantine, so only callers queued at that moment are affected (at most the 256-entry queue cap), plus any caller that cached a handle outside the gate.

**Classification (honest):** an **explicit availability failure, not a corruption or replay risk.** The body never runs (`secondCalls` 0); the closed handle cannot write; `began` is false so no rollback is attempted; `release()` runs. On the close-failed branch the stale handle is open and inside a transaction, so `BEGIN IMMEDIATE` would fail with a non-busy "cannot start a transaction within a transaction" (Reasoning, not probed), also with no body run and no join, because `runWriteTransaction` never joins. What is wrong is the **error class**: a raw `Error` that is neither `WriteContentionError` nor `DatabaseQuarantineError`, which the routes' `isWriteContention` check will not treat as a retryable 503 (Reasoning from the Grep: only `access.ts`, `analysisJobs.ts` and `mailOutbox.ts` test it). In the healthy-replace case a fresh handle already exists, so these requests fail for nothing. The failing request is the only one the design's "expected failure" covers; the waiters are a gap in the design. P1 for availability, not for data.

**Precise correction (not implemented):**

1. Keep the early `getDatabase()` and its `initializationMs` unchanged: it is the fail-fast path for "cannot open at all" and it is a different number from the gate wait.
2. After `acquireWriteGate` succeeds and **inside the existing `try`/`finally` that calls `release()`**, re-resolve: `const live = isQuarantined(db) ? getDatabase() : db`. Do not call `getDatabase()` unconditionally, so the common path costs one `WeakSet` lookup and one `isOpen` read.
3. If re-resolution throws (`DatabaseQuarantineError` after a failed close, or a reopen error such as `PresenceBusyError`), the **gate must be released** (the `finally` already does this; verify it covers the new statement). Report it as outcome `"error"` through `notifyAcquire` with `gateMs` measured, `attempts: 0`, and rethrow **the error as it is**. Do not map it to `WriteContentionError` (it is not lock contention) and do not retry the body.
4. Honest diagnostics: the time spent reopening happens under the gate and before the first BEGIN. Include it in `sqliteMs` (it is part of `gateAcquiredAt → beganAt`) or add an optional `reopenMs`; do **not** fold it into `initializationMs` or `gateMs`, and do not extend or reset the deadline. `budget`, `deadline` and `acquireTimeoutMs` stay as computed at entry; if the reopen consumes the whole budget, the first BEGIN attempt still runs at zero remaining budget as it does today, then refuses as `WriteContentionError` if busy.
5. Use `live` everywhere below (`BEGIN`, body argument, `COMMIT`, `ROLLBACK`, `settleOrQuarantine`). A quarantine of `live` must apply to `live`, not to the stale `db`.
6. Map `DatabaseQuarantineError` to a clear retryable/failed response at the routes, or document that it is a 500 by design. Today `grep` shows no consumer; that is a product decision.
7. Separate smaller point: callers that hold `const db = getDatabase()` across their own awaits (`analysisJobs.ts` 325 to 850, `wardrobes.ts`, `photos` routes) get the same raw `ERR_INVALID_STATE` on un-gated reads; the author states this. Not fixed by item 2; it needs each such read to resolve the handle at use. P3, loud failure.

**Tests to add (additions to `rollbackFailure016.test.ts`, which already forces the failure by `exec`/`close` override):**

- W1. Healthy replace: hold the gate, queue the failing call plus N (at least 3) successful writers, release. Expect the first to reject with its own error (identity), **all N to succeed on the fresh connection**, each body run exactly once, rows present once, `writeGateQueueLength() === 0`, the foreign connection can take the write lock. Red today.
- W2. Close-failed branch (last in the file, as now): same queue; the failing call surfaces its error; every waiter rejects with `DatabaseQuarantineError`, bodies 0, gate free and queue empty afterwards.
- W3. Re-resolution failure releases the gate: make the reopen fail (synthetic dir only); the waiter rejects with that error, the next caller is not blocked, nothing leaks presence (ties to test F above).
- W4. Observer: the waiter's `notifyAcquire` reports `ok:false`, outcome `"error"`, `attempts` 0, and a `sqliteMs` that includes the reopen. Assert the budget fields equal the entry values (no extended deadline).
- W5. Characterisation before the change: record that the waiter rejects with `ERR_INVALID_STATE` and `secondCalls` 0 (root's probe, as a test), so the regression is pinned and the flip is visible in review.

## 4. Stream parser, protocol, cancellation (part 1, corrected)

Read `vision.ts` in full and the 21 added tests by title and, for the protocol group, by body. Findings:

**Closed (Read + Log):** the three fail-open probe results are now refused. Mode selection is deterministic: declared `ndjson`/`jsonl` means strict NDJSON; otherwise the first non-blank line decides (whole object selects NDJSON, a lone `{` selects the buffered one-body path, anything else is refused at once). Every object must be a plain object, `message` an object, `content` a string, `done` a boolean, `done_reason` a string, no truthy `error`; exactly one `done:true`, last; EOF without it is truncation; `TextDecoder` is fatal so invalid UTF-8 and a cut multi-byte tail are refused; `MAX_ANSWER_CHARS` and `MAX_PENDING_CHARS` bound memory. On failure `abandonUpstream` aborts the internal controller first and synchronously, awaits `cancel()` for at most 1,000 ms with a cleared timer, and `releaseLock` runs in `finally`. A `VisionError` is rethrown before the deadline test, so the cleanup's own abort cannot be read as "too slow", and the internal controller sets neither `deadline.aborted` nor `signal.aborted`. The tests keep the mock socket **open** and require the mock to see the close, which is the right proof of no orphaned inference.

**Compatibility:** chunked NDJSON, compact and pretty single bodies each with `done:true`, CRLF, missing final newline, blank lines. Tests for these exist. The behaviour change (a server omitting `done` is refused) is stated by the author; real Ollama sends it.

**Conditions (all low; none block the scoped accept):**

- **P2: a body timeout from the HTTP client is not a deadline (Reasoning, Unverified).** The deadline classifier relies on `deadline.aborted`. If Node's fetch client gives up first (its default response-header and body-idle waits are about 5 minutes; the part 1 notes already infer this for the old 301 s failure), the error is a plain fetch failure with the deadline not yet aborted, so it is classified `unavailable` (refundable, generic message), not `timeout`. Streaming makes the body wait unlikely to trip once tokens flow, but time-to-first-token on this CPU host plus a 420 s configured deadline (the notes' suggestion) could exceed the header wait. Either classify a recognisable client timeout cause as `timeout`, or configure the client wait to the inference deadline. Needs a real-model observation; I make no claim it happens.
- **P3: terminal then stall.** After `done:true` the reader reads to EOF. A server that sends the terminal and keeps the socket open holds the worker to the full deadline and is then labelled `timeout`, although the answer was complete. Author-disclosed. A bounded grace (for example a few seconds) after the terminal, then `unavailable`, would be more honest than "too slow". Not needed for Ollama.
- **P3: `error` falsy values.** `{"error":""}` or `0` passes the `value.error` truthiness check and is treated as a normal envelope. Acceptable; say so, or require `error === undefined`.
- **P3: `done_reason` on non-terminal objects** is accepted and ignored. Fine; document.
- **P3: `auto` mode** rescans from the cursor on every chunk (`search(/\S/)`). Bounded by `MAX_PENDING_CHARS`; not a risk.
- **Coverage gap (low):** no test that a `done:true` object arriving in the **first** line of a pretty body is accepted when preceded by whitespace-only lines inside the braces, and no test that a body of exactly `MAX_PENDING_CHARS` is handled at the boundary. Add if cheap.
- **Test runtime:** the file now contains two 10 s deadline waits (the original and the new one), about 20 s of the 30.4 s focused run (Reasoning from the code and the Log total). Acceptable; they could share one.

Classification of timing in `analyzePhoto`: unchanged and honest. `timeout` only when `deadline.aborted && !signal?.aborted` for a non-`VisionError`. A caller abort stays `unavailable`.

## 5. Lock timing, causal invariants, test quality

**Read:** `lockDiagnostics.test.ts` 340 to 494. The old absolute `holdMs < 90` is gone and the failed run is retained as history (Log). The replacement:

- queues a microtask and a `setTimeout(0)` from inside a wrapper on native `BEGIN IMMEDIATE` return, so the claim does not depend on how many microtask ticks `acquireWriteGate` takes (the dependence I flagged earlier). It asserts event order `begin-returned, body, blocker, timer`, `isTransaction === false` at both, and native COMMIT returned before the blocker started;
- brackets every reported number between native timestamps taken from the same `performance.now` clock (Read: `monotonicNow` is `performance.now`), with 0.1 ms rounding slack: `holdMs`, `bodyMs`, `commitMs`, `beginMs`;
- adds a deterministic 120 ms spin before native COMMIT and asserts it lands in `commitMs`, not `bodyMs`.

This is the right design: all bounds are one-sided inequalities that hold under any scheduling, none is an absolute duration, and none depends on the disk. I accept it. Notes:

- **Low:** `assert.ok(bodyEnd - bodyStart >= 10)` after `spin(10)` depends on `performance.now` monotonicity only; fine.
- **Low:** the blocker microtask spins 50 ms after the assertions' data are captured, so it lengthens the test but not any measured number.
- **Low:** the begin/backoff contended test asserts `sqliteMs >= 250` against a 300 ms holder; this is scheduling-sensitive on a very loaded host (a timer could fire late and only make it larger, so it errs safe). Fine.
- The 120 ms spin test and the five concurrency repetitions (Log, initial candidate) agree that the hold is commit-dominated on this host. No threshold, budget or durability was changed in this revision (Read: `database.ts` still sets only `journal_mode = WAL`; no `synchronous` pragma anywhere under `src`). The `synchronous` decision remains the owner's and is not made here.

## 6. Cap messaging, timeout classification, refunds

- **Cause-neutral cut (Read):** `ANSWER_CUT_MESSAGE` names no cause; `done_reason:"length"` stays `unverified` and charged. I flagged that charging is a product question; the author left it open. Still open, not a defect.
- **Timeout is refundable (Read):** `analysisJobs.ts` 977 maps `timeout` to `failure_kind: 'server'` with `TOO_SLOW_MESSAGE`. Per the author, the refund returns `usage_daily.count` but `attempts` is never refunded and admission refuses at `STYLE_DAILY_ATTEMPTS` (default 40), so repeated refunded timeouts are finite (Author, plus the Grep hits on `attempts`; the new queue007 test is Author/Log-covered by root's green run). **Residual (Arithmetic):** 40 refunded 240 s attempts is up to 9,600 s, about 2.7 hours of worker time per account per day. That is bounded, not small. The owner may want a lower attempts cap for repeated timeouts of the same user, or a cooldown. Not changed silently.
- **Protocol failures are refunded** (`unavailable`, `server`), including a model that answered garbage. That is consistent and bounded by the same counter; note that a hostile or broken local model can therefore consume worker time at no allowance cost, again bounded by 40.
- **Crowded flag:** exactly six real items are still flagged "may show more than 6". Acceptable and conservative.
- **Not established:** recognition quality. The author's real-model figures (255 s, six items, six "printed shirt" entries, five filed as Shoes) remain Author-reported; the 255 s still exceeds the 240 s default deadline, so the owner's crowded photo times out at defaults. The default was not changed.

## 7. Full suite, Linux CI, evidence limits

- **Corrected local evidence (Log, root):** typecheck and lint PASS; six focused files 60/60, 0 skipped, 30.416 s; full `npm test` 295 total, 291 pass, 0 fail, 4 skipped, 79.322 s; mixed workload passed in 56.252 s. This is **one** full pass after the earlier 014 and 015 full-suite failures (retained). One pass does not bound a flake rate; 014/015 failed two of three observations of this scenario, so a single green run is weak evidence the mixed-process refusal (G1) is gone. Treat G1 as **open, unobserved in 016**, not closed. Repeat the full suite several times, under the same reviewed permissions, before saying anything stronger.
- **Linux CI (Log, `LINUX_CI_016_PART1.md`):** run 38347611817, commit `df3b3d2` (part 1 only), Ubuntu build job 269 total, 267 pass, 0 fail, 2 skipped; production build, packaging and standalone checks passed; 37 Chromium tests passed, 1 skipped; Docker app, AI worker and mailer smoke passed with a **mock** model. Accepted as real Linux and container execution for that commit. It does **not** transfer to the corrected working tree (which changes `database.ts`, `writeTransaction.ts`, `vision.ts`, `analysisJobs.ts` and the tests), does not involve real AI, SMTP, TLS, Caddy, a public host, off-site recovery or phones, and the CI Linux run is not a performance or contention measurement of this build. Corrected-candidate Linux execution requires committing and pushing the candidate (owner's decision on timing); I make no claim about it.
- **Browser coverage:** no compiled or browser run of the corrected candidate exists (root). The crowded-photo warning, photo tips and failure messages are unexercised in a browser at this revision.
- **Concurrency of root's diagnostic:** disclosed above.

## 8. Unresolved (explicit, nothing here closes them)

Vision recognition quality and human gold labels; real-model timing beyond the single Author run; transport and HTTP/2 behaviour under a real front end; actual hosting, HTTPS, SMTP delivery; off-site encrypted recovery; real-phone acceptance; G1 in a repeated full-suite series; browser coverage of 016; corrected-candidate Linux/container execution; the `synchronous` durability decision; the process-exit or health-signal policy for the unusable-main state.

## 9. Prioritised corrections (review only; none implemented)

1. **P1: presence retention** (section 2). Track every unclosed handle in one set; `releasePresenceIfIdle` must refuse while any is open or unprovable; `closeDatabases` retries all; keep release on initialization failure when nothing is open. Tests A to F.
2. **P1: queued waiters** (section 3). Re-resolve the handle after the gate, inside the existing release-on-throw scope, only when the captured one is quarantined or closed; report reopen time honestly in the existing fields; do not extend the budget or mislabel as contention. Tests W1 to W5.
3. **P1: re-run** `rollbackFailure016.test.ts`, `processPresence.test.ts`, `lockDiagnostics.test.ts` and the other focused files, then **several** full `npm test` runs; state each result separately, keep the failed 014/015 logs.
4. **P2: HTTP-client timeout classification** (section 4) after one real-model observation of time to first token near the configured deadline.
5. **P2: refund exposure** (section 6): decide whether 40 refunded 240 s attempts per account per day is acceptable, and whether charged `length` cuts are intended.
6. **P2: unusable-main policy** (section 2, item 7): health signal or bounded exit; owner decision.
7. **P3:** `error` falsy values; terminal-then-stall grace; `close()` that threw but left `isOpen` false should allow reopen; retain-the-`isOpen`-after-throw handling in quarantine; map `DatabaseQuarantineError` at routes; resolve cached handles at use in un-gated reads; share the two 10 s deadline waits.
8. **Process:** keep the shell-heredoc deviation of part 2 recorded; this revision's author reports no shell use (Author); the `BUILD016_ROOT_CHECKS.md` heading "Release state" is followed by a second section header and could be tidied. Do not claim launch readiness from 60/60 focused or one 295-test pass.
