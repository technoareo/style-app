# Build 016 Revision 5: independent review (Claude)

Written for: root and the owner, as the review of the Revision 5 narrow-fix freeze (213-file manifest), its focused and full source runs, and the production compile/package.

I used Read, Glob and Grep, plus this one Write. I ran no shell, test, typecheck, lint, build, network or browser, started no subagent, edited no source or test and made no git call. I did not open `.env*`, `.data`, `.runtime`, `node_modules` or `sources/`.

Evidence classes: **Read** (I read it in the working tree or in the log file itself), **Root** (a result stated in the review request that the log does not itself record), **Reasoning** (my inference, not run), **Author** (a claim only in the author's notes), **Unverified**.

## 0. What I read, and the gaps

Read in full: `build-016-revision4-claude.md`; `implementation-016-notes.md` lines 236 to 277 (Revision 5 and its W2 correction); `build-016-revision5-diff-paths.json`; `typecheck-016-revision5.log`, `lint-016-revision5.log`, `targeted-016-revision5.log`, `build-016-revision5-reviewed.log`; `queuedWaiterQuarantine016.test.ts`; `healthUnusable016.test.ts` lines 120 to 204; `backupSafety.test.ts` lines 262 to 395 and 440 to 873; `directoryLock.ts` lines 60 to 160; `DEPLOYMENT.md` lines 90 to 135; `compose.yaml` lines 40 to 70.

Read in part: `backend-016-revision5-reviewed.log` (Grep of the summary, skips and failure keywords only, not every line); `build-016-revision5-source-manifest.json` (first 40 lines, plus a Grep of the seven changed paths and the entry count, 213); `database.ts` (Grep with context of the quarantine code); `backupDatabase.ts` (Grep with context of the two touched regions).

Not read, so nothing below covers them: `backupChild.ts` this round; the other 205 manifest entries; `compiled-health-016-revision4.cjs` and its log; `production-browser-016-revision5.config.mjs` (I saw only that it exists); any Linux material. **I did not recompute any hash**, so I cannot confirm the manifest matches the tree. That is root's byte check.

## 1. Verdicts (kept separate)

| Question | Verdict |
|---|---|
| **Source acceptance** (the Revision 5 edits to `directoryLock.ts`, `backupDatabase.ts`, three test files, `DEPLOYMENT.md`) | **ACCEPT**, with the P2/P3 conditions in section 8. I found no regression and no false claim about behaviour. Two documentation sentences are inaccurate (section 5), and one test-reporting choice is wrong (section 2). |
| **Revision 4 findings** | Of ten items: 4 fixed, 3 partly fixed, 2 not done (disclosed), 1 not applicable to source. Table in section 7. |
| **Build acceptance** | **ACCEPT as compile/package evidence only.** The production compile and the packaging check passed (log Read). It is **not** a Revision 5 compiled-behaviour acceptance: the compiled health check, the compiled browser run and Linux have no Revision 5 result (section 6). |
| **Launch readiness** | **NOT READY.** Same open list as Revision 4 (section 9). Nothing in Revision 5 moves it. |

I found **no P1**. Nothing here changes a production code path except two thunks.

## 2. `t.skip` after earlier assertions (`backupSafety.test.ts:501-538`)

**Your question: should it be split?** Yes. Keep the fix, change the shape. P2 for reporting fidelity, P3 for risk.

What happens (Read, plus `node:test` behaviour from my knowledge, not run here): `t.skip(msg)` does not stop the test. It marks the whole test skipped, and the `return` on line 533 then ends it. The assertions on lines 505 to 523 run before it, and an assertion failure there still throws and fails the test, so **this is not a false green.** I also see that they really ran on this host: the targeted log shows 338.1 ms for that test (log line 7), which fits the `sleep(300)` on line 514.

The cost is in the report:
- On any host that cannot create links, the core lock assertions (refused while held, refused in the same process, waiter granted only after release, `assertHeld` after release) are shown as **skipped** (`﹣`, targeted log line 7; backend log line 45). A reader of the log sees them as not run. That is the opposite of the earlier silent pass: now a real pass is reported as a skip.
- If the platform could create links, the same test would report ✔ and also cover the guard. The result depends on the account, not on the test.

**Recommendation (cheap, test-only):** split it into two tests.
1. "the lock module: a second holder is refused…" with lines 503 to 523 only. It is always reported as run.
2. "the coordinator file that is a link is refused…" which probes link creation **first** and calls `t.skip(...)` before doing anything else, so a skip means exactly "nothing here ran".

**The same silent pass still exists at `backupSafety.test.ts:871-872`** ("physical path guards"): a `console.warn` and `return` on a no-link account. The targeted log reports it as ✔ at 298.3 ms (log line 15) although the whole body was unexercised. Revision 4 item 9 named only the coordinator test, so this is not a false claim by the author, but the notes' wording suggests the silent-pass pattern is gone. It is not. Convert it the same way (P3).

Also (P3, pre-existing): `outsideFile` written at lines 526 to 527 is never deleted on either path.

## 3. Getter containment and the corrected wording (`directoryLock.ts`, `backupDatabase.ts`)

**Read, and correct.**
- `directoryLock.ts:137` is `notifyBusy(() => options.onBusy?.())`. The property read is now inside `notifyBusy`'s `try`, so a throwing getter is swallowed and the loop proceeds to the deadline check. It also reads the property once per refusal only, since `busyReported` gates it.
- `backupDatabase.ts:370` is always `onBusy: () => options.onLockWait?.()`. The double read is gone, and the read happens only inside the guard. Because the thunk is now always set, `notifyBusy` always runs a callback on the first refusal, even when `onLockWait` is unset. The cost is one no-op call per contended backup. Harmless.
- The comments at `directoryLock.ts:76-85` and `backupDatabase.ts:130-134` now say the true thing: a throw, a throwing getter or a rejection is contained, and **synchronous time spent in the callback counts against the deadline**. The false "cannot delay or shorten" claim is withdrawn in the notes (line 258). I accept this. It was the more important item.

**Assertion fidelity of the new tests (Reasoning, from reading the old and new code):**
- `backupSafety.test.ts:611-668` discriminates. On the old code the getter would throw inside the polling `catch`, the outer `catch` would rethrow the getter's error, and `caught instanceof LockBusyError` (line 633) would fail. The `>= 250` ms check (line 635) guards a shortened wait. The free-lock check (line 664) guards a spurious read. `reads >= 1` proves the getter was really reached, so the test cannot pass vacuously.
- `backupSafety.test.ts:670-695` discriminates for `createBackup`: the old line read the accessor in `createBackup` before the lock call, so `createBackup` would have rejected with the getter's error. `reads >= 1` is non-vacuous.
- **Not red-observed.** These two tests were written against Revision 4 code that nobody ran them on. Their discrimination is by reasoning, not by a failing run. State that plainly. If root has a frozen Revision 4 `src` (the earlier "red-before-green" approach), running just these two tests against it would settle it in seconds. P3, optional.
- The older callback test (540-609) casts an async function to `() => void` (line 573). Typecheck passed, so this compiles.

`logQuarantine`/`marked-only` is unchanged (section 5).

## 4. W2 body and cleanup bounds (`queuedWaiterQuarantine016.test.ts`)

**Read, and correct** for what it claims.
- `bounded()` (35-41) rejects with a label, clears its own timer in `.finally`, and so never leaves a timer. The body's `await all` (line 83) is bounded to 30 s, and a body timeout is a rejection that sets `bodyFailed` through the `catch` (98-100).
- `finally` (101-123): `releaseGate` is idempotent and is called before the bounded wait, so a held gate cannot stall the queued writers (this is the case that hung in the first Revision 5 edit). The cleanup bound is a separate 30 s. A cleanup timeout becomes `cleanupError` and is thrown only if the body succeeded, so the body's own assertion failure is never replaced.
- Worst-case failure time is about 30 + 30 s plus the 500 ms gate-free race, then `closeDatabases()` and the `isOpen` assertion. There is no unbounded await left except `acquireWriteGate()` on line 59, which runs with an empty queue at the start of the test, so I do not count it.
- `bodyFailed` is set only in the `catch`, so a `return` path would count as success. There is none.

**Small items (P3):**
- The 500 ms race at 93 to 96 leaves an uncleared 500 ms timer on the success path, which only delays process idle. Use `bounded()` there.
- If the body times out, the queued writers are still pending when the cleanup runs `closeDatabases()`. Because it is already a failure path with a 30 s cleanup bound first, the cleanup waits for them before closing. Fine.
- The same `cleanupError ??=` pattern is used in the health last test (183-198), but only one cleanup error is recorded there (`cleanupError = error`), not `??=`. Equivalent, since there is one `try`.

## 5. `marked-only` and the runbook (`DEPLOYMENT.md:95-113`, `database.ts:204-228`)

**The runbook is a real fix** for Revision 4 P2 item 1: the section exists, states that plain Compose does not recover it, that Caddy does not route around a 503, that `unclosed` is never cleared, what to do and what not to do, and that automatic recovery is an owner decision. I accept it.

**Two inaccurate statements (P2 for the first, P3 for the second), both documentation-only:**

1. **`marked-only` meaning (line 101).** The doc says "the quarantined handle had already been replaced; treat it like `replaceable`". The code (`database.ts:208-212`) logs `marked-only` when `database !== db`, **marks the handle and returns without closing it.** "Already replaced" is one cause, but it is not what the outcome states. The shared connection may be `null` (after `closeDatabases`) or may be a different handle, and this call proved nothing about whether `db` is closed. Replace with something like: "the handle was not the current shared connection; it was marked quarantined but this call did not close it. Nothing is known about the shared connection from this line; treat a repeating count like `replaceable`." I could not tell from my reading whether the handle was closed earlier, so I do not assert that it was not. **Reasoning**, because I did not read the callers' ordering in `writeTransaction.ts` this round. The notes line 272 also says the log wording was left unchanged "documented instead", so the doc is the only place the meaning lives; it should be precise.
2. **Worker health (line 108).** "They have **no** equivalent unusable signal, so their health checks can stay green while blocked." `compose.yaml` shows a `healthcheck` for `app` (line 28) and `mailer` (line 87) only; `worker` (lines 43-59) has **none**. "Their health checks" is wrong for the worker. Say: "the mailer's health check (heartbeat) can stay green while its writes are blocked; the worker has no Compose health check at all."

Also confirm, if root has not already: the `docker compose restart app` command in step 2 assumes the service is named `app`. It is (compose.yaml line 2). Read.

## 6. Evidence logs, and what each does and does not prove

| Log | Result | What I read | Supports | Does not support |
|---|---|---|---|---|
| `typecheck-016-revision5.log` | Only the `tsc --noEmit` banner and no error lines. Exit code is **not** in the file (Root: exit 0). | Read | The whole tree typechecks, **tests included**: `tsconfig.json` includes `**/*.ts` (Read). So the getter-typed object literals and the `t.skip` use compile. | An exit code from the file itself. |
| `lint-016-revision5.log` | Banner only. Exit not in file (Root: exit 0). | Read | `src` lints clean. | **Any claim about tests.** `package.json` runs `eslint src --ext .ts,.tsx` (Grep), so no test file is linted by this command. The notes' worry about "a lint rule may object" to the cast was never checked by this log. Say "lint covers `src` only". |
| `targeted-016-revision5.log` | 19 total, 18 pass, 1 skip, 0 fail, 34.3 s | Read | The contender test (✔ 5252 ms), the two new getter tests, the unchanged seam test, same-millisecond (7352 ms), the health tests and W2 pass on this host. Arithmetic: 15 `backupSafety` + 3 health + 1 W2 = 19. | Windows-only; the link guard not exercised; the 1 skip is the lock-module test (section 2). |
| `backend-016-revision5-reviewed.log` | 312 total, 307 pass, 5 skip, 0 fail, 75.3 s | Read (summary and keyword Grep) | Arithmetic is consistent with Revision 4 (310 total and 306 pass): +2 new tests, +1 skip converted from a pass, so 307. The "failed (timeout)" mail lines are injected test output inside passing tests (Grep). No `✖`, `cancelled`, `child cleanup problem` or unhandled-rejection text. **No real failure is indicated.** | **One run.** Revision 4 had three. 75.3 s versus 72 s is within noise but is a single sample. No induced-load run. Not a flake bound. |
| `build-016-revision5-reviewed.log` | Next 15.5.27 compile, 8/8 pages, build traces, sanitizer, packaging check, all printed success (Read). Exit not in file (Root: exit 0). | Read | The chained `next build && sanitize && verify-packaging` ran to its last stage, which is consistent with exit 0. All 11 routes including `/api/health` are built. | **Which source it was built from.** The log carries no build id and no manifest hash, so "built from this exact manifest" is root's assertion, not shown by the log. No behaviour of the compiled server. |

**Compiled health.** The notes (line 267) and your message agree: `compiled-health-016-revision4.cjs` proved shared module identity and GET 200, then a synthetic quarantine and 503 twice, **for the Revision 4 build only**. The Revision 5 diff touches neither `database.ts` nor the health route (diff paths below), so there is a strong reason to expect the same result, but that is Reasoning. **There is no Revision 5 compiled health result, no compiled browser result (I saw only a prepared `production-browser-016-revision5.config.mjs`, with no log) and no Linux result.** I make no claim that they pass.

**Diff proof.** `build-016-revision5-diff-paths.json` lists seven paths: the notes, `DEPLOYMENT.md`, `backupDatabase.ts`, `directoryLock.ts` and the three test files. It is a **path list, not a line diff**, and it mixes `/` and `\` separators (cosmetic). It shows no *other* file changed. It does not show that the two source files changed only in the thunk and comment lines. I read both and the current content matches the notes' description exactly, but I had no Revision 4 copy to compare against. The manifest keeps 213 entries, the same count as Revision 4 (Read), so no file was added or removed. I did not recompute any hash.

## 7. Revision 4 findings, one by one

| # | Revision 4 finding | Status | Note |
|---|---|---|---|
| P2-1 | Runbook in `DEPLOYMENT.md` | **Fixed** | Two wording defects (section 5). |
| P2-2 | Production compile + Linux on the exact manifest | **Partly** | Compile and package: logged. Linux: not done. Compiled health identity on Revision 5: not re-run. |
| P2-3 | False "cannot delay or shorten" claim; getter guard and thunk; test | **Fixed** | Source, comments, notes and two new tests (section 3). Tests not red-observed. |
| P2-4 | One full run under induced load | **Not done** | Disclosed in the notes' limitations. Single full run at 75.3 s on a quiet host. |
| P3-5 | Per-test timeout above the chained bounds | **Fixed** | `TEST_TIMEOUT_MS` 600 000 (`backupSafety.test.ts:274`). Contender chain: 60 + 60 + 120 + 120 + 15 = 375 s, plus up to 15 s per tracked child in `reapChildren` (3 children, 45 s) is about 420 s; same-ms about 330 s; live-blocked about 190 s. All below 600 s (Reasoning from the constants at 267 to 274). The bounds are failure-only. |
| P3-6 | Record the same-millisecond diagnosis weakening | **Fixed (notes)** | Notes line 272. |
| P3-7 | `cleanupError` pattern in health last test and W2; bound `await settled` | **Fixed** | Section 4. The `presenceLifecycle016` finally blocks were not part of this edit and I did not re-read them. |
| P3-8 | `marked-only` wording; use or drop `Mark.receivedAt` | **Partly** | `receivedAt` now goes into the JSON detail (lines 474 to 480 pass `waiting1`/`waiting2` whole). `marked-only` log text unchanged; the doc covers it imprecisely (section 5). |
| P3-9 | Link-guard early `return` as `t.skip` | **Partly, and wrongly shaped** | Section 2: a real pass is reported as a skip, and the sibling silent pass at line 871 remains. |
| P3-10 | Carried-forward Revision 3 items | **Unchanged** | Not in scope. |

## 8. Prioritised findings

**P1** None.

**P2**
1. **Split the lock-module test** and probe link creation first, so a skip means nothing ran and the core lock assertions are always reported (section 2). Test-only; no source change; no manifest change to `src`. Do the same at line 871 so no no-link account reports ✔ for an unexercised body.
2. **Correct the `marked-only` sentence** in `DEPLOYMENT.md` (section 5, item 1). Docs only.
3. **Re-run, on the Revision 5 build (or its documented successor), the compiled health script, the compiled browser run and a Linux/container execution**, and state which manifest each ran on. Until then the Revision 4 compiled health result is not Revision 5 evidence. (Carried from Revision 4 P2-2.)
4. **One full run under induced load**, reported either way (carried from Revision 4 P2-4). The only full run this round is a single quiet-host sample.

**P3**
5. Fix the worker health-check sentence in `DEPLOYMENT.md` line 108 (section 5, item 2).
6. State in the notes that **lint covers `src` only**; the lint log says nothing about tests.
7. Record that the two new getter tests were written against code that was never red-observed; optionally run just those two against a frozen Revision 4 `src`.
8. Use `bounded()` for the 500 ms race in W2 (line 93 to 96).
9. Delete `outsideFile` in the lock test.
10. Carried forward unchanged: `isOpen` is not proof of a released file lock; `closeDatabases()` swallows retry errors at shutdown; `unusableMain` is never cleared; stale-waiter shutdown revival; `DatabaseQuarantineError` has no route mapping; same-millisecond hold assertion near-tautological.

Items 1, 2, 5 and 6 are test or doc edits. Items 1, 2 and 5 change the manifest hash for those files only. They need typecheck, the one test file and a new manifest, not three full runs.

## 9. What stays open (launch)

Real vision quality and whole-wardrobe acceptance. Compiled browser coverage and current-Linux execution on this candidate. Transport and HTTP/2 behaviour under a real front end. Real hosting, TLS and SMTP. Off-site encrypted recovery and real-phone acceptance. The `synchronous` durability decision. A load-tested repeat of the full suite. Worker and mailer unusable-connection signal and the automatic restart policy (owner decisions). The refund-exposure decision. Passing unit and integration tests, a green typecheck and a successful production compile are not launch evidence, and I claim none of the Linux, current-browser, real-vision, TLS or SMTP items.
