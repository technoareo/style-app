# Build 011 (corrected) independent review (Claude, second reviewer)

Reviewer: Claude. Date: 12 October 2026.
Subject: corrected build 011, `SOURCE_MANIFEST` of 162 files (`docs/verification/build-011-corrected-source-manifest.json`, which I counted and compared by SHA256 string against `build-010-source-manifest.json`). Root reports Build ID `9AXAtEvfYWrnQHgdTnLSz` and zero hash changes through matrix, compile, standalone and browser checks. I could not recompute hashes.

## 0. Method and limits

- Tools used: Read, Glob, Grep, and one Write (this file). **I used no Bash, shell, PowerShell, test, build, browser or network call.** I touched no `.data`, `.runtime`, `.env`, secret or synced source. I changed no source.
- I read the **working-tree** source named below, not the sibling snapshot copies. That the working tree equals `../build-011-corrected` rests on root's hash statement and on the manifest, not on my own comparison.
- Every runtime number below comes from files root produced (`summary.json`, `stress-10.json`, `stress-1.json`, per-run JSON, `burner-sample.json`, `auth-body-deadline-probe-011.json`). Sums, ratios and counts marked "my arithmetic" were done by hand from those numbers and should be re-derived by a script.
- Labels: **[Observed]** read in a root-produced file. **[Code-proven]** follows from code I read. **[Inferred]** my reasoning from observed data. **[Hypothesis]** needs the named experiment. **[External gate]** needs real-world evidence.
- **Read in full:** `BUILD011_CHECKS.md`, `REVIEW_EVIDENCE.md` (sibling), `implementation-011-notes.md`, `build-010-claude.md`, `AUTH_BODY_FINDING_011.md`, `READ_LOCK_FINDINGS_011.md`, `CONSUMER_RELEASE_AUDIT_011.md`, `auth-body-deadline-probe-011.json`, `lockDiagnostics.ts`, `writeTransaction.ts`, `authDialect.ts`, `writeGate.ts`, `sqliteRetry.ts`, `access.ts`, `lockRecorder.ts`, `concurrency-child.ts`, `concurrency.test.ts`, `concurrency-matrix.ts`, `matrixConfig.ts`, the `[...all]` auth route, the wardrobe route, `wardrobes.ts`, both manifests, the 19-run `summary.json`, `burner-sample.json`, `stress-10.json`.
- **Read in part:** `lockDiagnostics.test.ts` (first 260 lines), `analysisJobs.ts` (lines 380-520), per-run JSON by search (`stress-1`, `default-initial`, `corrected-default`, all setup/wait phases), `auth.ts`/`database.ts`/`mail-worker.ts`/`Dockerfile`/`DEPLOYMENT.md` by search.
- **Not read, so no claim is made:** `observerChild.ts`, `matrixConfig.test.ts`, the rest of `lockDiagnostics.test.ts`, `browser-011-corrected.log`, `verify-standalone.ts`, packaging/sanitiser output, the e2e specs, `analysis-jobs/[id]/route.ts` (I rely on root's note and my 010 citation), the Caddyfile, the detector research files, `VISION_NEXT_EXPERIMENT_011.md`, `detector-*` probes. "Production compile, lint, types, sanitise, package pass", "standalone passes" and "33 browser checks pass" are root's statements; I saw none of that output.

---

## 1. Verdict

**Accept as an evidence-only diagnostics candidate. Do not approve for production or public launch.**

- I found **no P0**.
- The instrumentation does what it claims and I found no behaviour change on the production paths beyond the two additions in section 2.3 (a rollback safety net and a `reason` field). Control flow, budgets, SQL and the 503 contract are unchanged by reading. By manifest, only `authDialect.ts`, `writeGate.ts`, `writeTransaction.ts`, `concurrency-child.ts` and `concurrency.test.ts` changed among existing code and test files; seven files are new (`lockDiagnostics.ts`, `lockRecorder.ts`, `observerChild.ts`, `lockDiagnostics.test.ts`, `concurrency-matrix.ts`, `matrixConfig.ts`, `matrixConfig.test.ts`); two review documents were swapped for two others. 155 - 2 + 2 + 7 = 162. `access.ts`, `wardrobes.ts`, `auth.ts`, `sqliteRetry.ts`, `database.ts`, `contention.ts`, `mail-worker.ts`, `Dockerfile`, `compose.yaml`, `DEPLOYMENT.md`, `README.md`, `package.json` and every route are **identical to build 010**. So no 010 finding outside the lock path can have been fixed by this build, and none was.
- **E1.3, by the rule I wrote in the 010 review, is met numerically** (section 4). That does not close G1. It removes the strongest argument for calling G1 a proven design defect and replaces it with a thinner one: the worst acquisitions are SQLite lock waits with a very heavy tail, no run failed, and the data cannot yet tell fairness from capacity.
- Root's new finding is **confirmed and I rate it P2, a launch gate for any public host** (G14). It is not a database-lock issue and does not explain the 010 failure.
- I found three further things the matrix summary does not show: authenticated requests stall behind sign-ups for seconds (G16); the recorded lock-hold times cannot all be true lock occupancy (G17); and in 8 of 19 matrix runs at least one child had under a second of slack before the release instant, in 5 it started after it (G18).
- Everything carried from 010 stays open and nothing in 011 touches it (section 7).

---

## 2. Instrumentation review

### 2.1 Correctness of the measurements [Code-proven]

Write path (`writeTransaction.ts:76-222`):
- `deadline` is computed before `getDatabase()`, exactly as in 010. `initializationMs` brackets only `getDatabase()`. `gateMs` brackets only the `await acquireWriteGate`. `sqliteMs` runs from gate ownership to the instant `exec` returned inside the retry callback (line 132), so the microtask hop is excluded. `totalMs = initializationMs + gateMs + sqliteMs` plus microseconds. The hold starts at `beganAt` and ends before `release()`, excluding the 3 ms courtesy sleep. This matches section 10.3 of the notes.
- The retry callback returns the same `exec` result and still increments a counter only. `retryBusy`'s own deadline restarts inside `retryBusy` (`sqliteRetry.ts:50`), as before, so the budget is not changed by the measurement.
- On a refused BEGIN the thrown class and message are unchanged; `refusal.acquire` is built from the caller's own event object, not the frozen copy the observer saw.

Auth path (`authDialect.ts:92-189, 215-254`): same structure. `initializationMs` is a constant 0. `finish()` keeps COMMIT/ROLLBACK, the rollback after a failed COMMIT, and `release?.()` in `finally`.

### 2.2 Observer containment [Code-proven; Test-shown per root]

`invoke()` (`lockDiagnostics.ts:164-177`) does the property lookup, the call and `absorb()` of any returned promise or thenable inside one `try/catch`. The callback gets `Object.freeze({...event})`, a copy. `absorb` calls `then(undefined, noop)` and recurses to depth 3, itself inside `try`. I find no path by which a throwing getter, a throwing Proxy trap, an `async` rejecting observer, or a hostile thenable changes a result, skips ROLLBACK, or skips `release()`. Root's independent probe agrees (`getterEscaped:false`, `asyncUnhandled:false`) and the 21/21 run passed.

Residuals, all stated in the notes and none a defect:
- A **synchronous** slow or non-terminating observer still blocks its caller. Only harness code installs one: grep over `src`, `scripts`, `tests`, `deploy` shows `setProcessLockObserver`/`runWithLockObserver` are used only by `lockDiagnostics.ts`, `observerChild.ts`, `concurrency.test.ts`, `concurrency-child.ts`, `lockDiagnostics.test.ts`. No route, environment variable or header enables it.
- Any in-process code can set the observer through the `Symbol.for` slot on `globalThis`. That is an in-process capability, not an external surface.
- A thenable that schedules its own rejection by a path other than its return value cannot be absorbed by anyone.

### 2.3 Behaviour added to production paths in an "evidence-only" batch

1. `WriteGateError.reason`: a new readonly property, message unchanged. Fine.
2. **A rollback safety net in `runWriteTransaction`'s `finally`** (`:195-203`). It is correct by reading and cannot trigger on any current path. It is also **not exercised by any test I read**, because no path leaves the transaction open. A change that cannot be reached by a test is still code in the most contended path. P3 (G19c).

### 2.4 Timing boundaries and what the diagnostics do **not** see

- **Kysely connection mutex wait is not measured** [Code-proven; the notes say so]. `begin()` runs only after the mutex was granted inside `inner.acquireConnection()`; the wrapper's `acquireConnection` (`authDialect.ts:276-279`) is not timed. Autocommit statements on the auth connection (rate-limit reads and writes, session lookups) take no gate and are not recorded.
- **Observed consequence [Observed, stress-10, parent process]:** sign-up through the handler took p50 4960.9 ms and max 7118.8 ms, but the parent's auth acquire max was 1747.3 ms. `wardrobeRequest` took p95 4949.2 ms and max 4958.5 ms while the parent's worst write acquire was 1747.7 ms. Three to five seconds of user-visible waiting sit outside every recorded acquire and hold. See G16.
- Percentiles are per process and never merged (stated). Peaks in `summary.json` are the maximum over per-process maxima: a correct "worst call anywhere" value, not a distribution.
- All clocks are per-process `performance.now()`. **No two processes' events can be placed on one timeline.** That one fact limits what these diagnostics can ever say about cross-process fairness (G17).

### 2.5 Minor instrumentation defects (G19, all P3)

a. The BUSY error on the auth path carries `acquire` whose `gateMs`/`sqliteMs` are the **legacy wall-clock** values while its other fields are monotonic (`authDialect.ts:165-169`). The type is `AcquireDetail`, documented as monotonic. A reader of `error.acquire` cannot tell two clocks are mixed. The comment at the site explains it; the type does not.
b. `finish()` emits a `commit` hold when `wasBegan` is true even if `database.isTransaction` is already false (the COMMIT block is skipped but the event still says `commit`). A transaction ended elsewhere would be reported as committed. Not reachable today.
c. The safety net in 2.3 is untested.

---

## 3. G6 report completeness and matrix validity

### 3.1 G6 (evidence collection in `concurrency.test.ts`) [Code-proven]

Closed. Every in-process task, every status, every child report (by role and index, with exit code) and each data invariant is evaluated into a named `problems` list before one `assert.deepEqual(problems, [])`. The workload constants are as in 010 (3 registrars x 4, 3 writers x 150, one worker x 60, 8 in-process sign-ups, 3 wardrobe chains, reset race, deletion race, `startAt = Date.now() + 8000`). Assertions were not weakened. The report file is written before the final assertion, so a failing run still leaves its evidence. A child whose last stdout line is not JSON becomes a visible failure, not a skip.

Remaining gaps in the report (G18): no per-child "started late" flag, no machine facts (CPU model and count, Node version, OS build, concurrent activity), no wall-clock start and end per run, no lock timeline.

### 3.2 Runner validity [Code-proven]

- Strict arguments, an allow-listed child environment, tracked and killed children, recorded stop problems, and an exit code that distinguishes incomplete, clean and failing matrices. A failing run is kept, never retried. `summary.json` shows `planned 19, completed 19, allChildrenStopped true, problems []`.
- **It is not literally `npm test`.** The runner starts `node --import tsx --test <explicit sorted file list>` in a stripped environment with `NODE_ENV=development`, `APP_URL`, `STYLE_PUBLIC_DEPLOYMENT=false`. `npm test` is `tsx --test tests/*.test.ts` in the user's full environment. The file set is the same (140 tests = 119 + 21). The difference is small and was stated, but "default" in the matrix means "Node's default file concurrency", not "the exact release command".
- `package.json` is unchanged: the release command and its policy are not quieter, and no budget, gate timeout, poll cap, queue cap or workload constant changed (`sqliteRetry.ts`, `contention.ts`, `database.ts` identical to 010; `DEFAULT_WRITE_ACQUIRE_MS` 10,000, gate 15,000, queue 256 and `WRITE_POLL_MAX_MS` 40 unchanged in the files I read).

### 3.3 Where the matrix is weaker than it looks (G18)

a. **The "released at the same instant" premise often fails.** `startAt` is a fixed 8 s after the parent's setup. A child that finishes module import and migrations later than that starts late. Children report `setupMs` and `waitMs`; `waitMs: 0` means it started after the release instant. [Observed, by search across the 19 run files]
   - `waitMs` 0 to 999 in 8 of 19 runs: `stress-9`, `stress-10`, `serial-1`, `default-2`, `default-3`, `load-1`, `load-2`, `load-3`.
   - `waitMs` exactly 0 (a child started after release) in 5 of 19: `stress-10` (all three registrars and the worker, setup 9.1-10.4 s), `serial-1` (the same four, 7.6-8.1 s), `default-3` (one), `load-1` (one), `load-2` (one).
   - The corrected single default run is worse: three registrars and the worker took 15.3-16.9 s of setup (`corrected-default/default-1.json`), so they joined 7-9 s after release.
   - So in several runs the registrars and the worker were not contending with the writers from time zero. Each run is still a valid pass of the unchanged test. It means "the same workload" has a **different shape from run to run**, and the shape of the failing 010 run is unknown. The runner's summary does not surface this.
b. **The CPU-load scenario is not shown to impose load.** `burner-sample.json` matched zero burners (sampled after the matrix ended) and root does not claim otherwise. The stress phases under "load" were 28.1, 21.2 and 20.2 s against 19-31 s with no load, and the write-acquire maxima (2.8, 4.5, 5.4 s) are not worse than unloaded `stress-10` (6.6 s). That is consistent with the burners having had little effect (a never-sleeping spinner is deprioritised by the Windows scheduler relative to processes that wait) [Hypothesis]. Treat "load x3 passed" as "ran three more times", not as saturation evidence.
c. **Ambient conditions were not recorded.** Root says it inspected files and ran probes during the matrix. Setup time and total duration drifted upward across the ten isolated stress runs (setup 1.4 s to 3.4 s; duration 40 s to 54 s; the worst acquisition was in the last run). Possible causes include other activity, antivirus scanning, accumulating `.data/tests/<uuid>` directories or thermal state. I cannot tell which. [Observed drift; cause unknown]
d. Windows, one machine, local SSD, no Docker. Not target-host evidence.

---

## 4. What E1.3 proves locally, and what stays open

### 4.1 The numbers [Observed, `summary.json`; all 19 runs exit 0, zero integrity problems, zero failed acquisitions, no timeout]

| Group | Runs | Pass | Max write acquire per run (ms) |
|---|---|---|---|
| Isolated stress | 10 | 10/10 (7 of 7 each) | 1387, 1430, 1473, 2100, 2269, 2685, 3652, 3704, 4179, **6564** |
| Serial (`--test-concurrency=1`) | 3 | 3/3 (136 + 4 skips) | 4089, 2127, 1729 |
| Default | 3 | 3/3 (136 + 4 skips) | 4004, 3306, 4446 |
| "Load" (12 burners configured) | 3 | 3/3 | 2790, 4521, 5424 |
| Outside the 19: original candidate, default | 1 | 1 run; its only failure was the diagnostic fixture | **9079.8** (91% of the 10 s budget) |
| Outside the 19: corrected candidate, default | 1 | 1/1 | **7402.8** (74%) |

The maximum of the 19-run matrix is 6563.9 ms (66% of the budget). **The maximum over every run of the corrected candidate is 7402.8 ms, and over the original candidate 9079.8 ms.** "Max matrix write acquire 6563.9 ms" is true of the matrix and should not be quoted as the largest value seen. The 010 failure (a write child refused at about 10 s) and the initial 011 diagnostic-fixture failure are both preserved on disk (`matrix-011-default-initial/`, the 010 log) and I saw neither erased.

By the rule I proposed in the 010 review (E1.3: (a) and (b) pass every time; (c) and (d) pass N-1 of N; every failure typed with integrity intact), **the gate is met**: 10/10, 3/3, 3/3, 3/3, with no failures at all.

### 4.2 What the data show about the mechanism [Inferred unless noted]

1. **In 18 of the 19 runs the largest acquisition is a SQLite wait, not a gate wait.** For all ten stress runs, `writeSqliteMaxMs` equals `writeAcquireMaxMs` to within a few ms; the same holds in default 1-3 and load 1-3. Only `serial-3` has the maximum on the gate. [Observed] The in-process gate queue (depth 2-3) is not what dominates the tail.
2. **The worst call is a pure cross-process wait.** In `stress-10` the 6563.9 ms acquisition belongs to a direct-writer child: gate wait 0.8 ms, SQLite wait 6563.8 ms, **66 attempts**. [Observed, `stress-10.json`, write child 2.] That is about 100 ms per attempt, which matches the constants (native busy wait 50 ms, then 20-40 ms back-off plus up to 10 ms jitter) [Inferred]. Roughly half of that wait was therefore spent **inside the native busy handler with that process's event loop parked** [Inferred from constants; not measured]. This is G13 with a number attached.
3. **The tail is very heavy.** For the three writer children in `stress-10`, the median SQLite wait was 21.9-22.6 ms, p95 372-410 ms, p99 507-1564 ms, and the maximum 5.5-6.6 s. All three writers had a maximum above 5 s. A median-to-maximum ratio of 250 or more is not what a FIFO queue of about eight contenders produces: even with every one of seven other contenders ahead holding the largest hold seen (auth, 488 ms), a FIFO wait would be near 3.4 s, and typically well under one second [Inferred]. That is **strong circumstantial evidence of non-FIFO starvation by polling**, in line with the G1 mechanism, but **not proof** (G17: the hold data cannot be reconciled, so I cannot compute occupancy).
4. **Isolated runs were not milder than default runs.** The largest isolated maximum (6.6 s) exceeds all three matrix default maxima (3.3-4.4 s). Default-concurrency file overlap lengthened the stress phase (34-44 s against about 25 s) without raising the tail in these samples. With n = 3 to 10 I cannot say which condition is worse. The two largest values ever seen (9.1 s and 7.4 s) were the two **stand-alone** default runs.

### 4.3 What E1.3 now proves locally

- On this machine, with this workload, 23 runs of the 011 write path (19 + 2 original isolated stress + the original and corrected single defaults) produced **no refused write and no integrity problem**.
- The 010 refusal was not reproduced. Together with an unchanged write path, that makes "the 010 failure was a rare tail event of the same design, not a regression" the better-supported reading than "a deterministic defect". It does not show the tail is gone.
- The diagnostics work on the real paths and produce a usable per-call decomposition (gate, SQLite wait, attempts, queue depth, initialisation) for both write and auth.
- A refused write is typed, side-effect-free and retryable (unchanged from 010).

### 4.4 What it does not prove

- **A rate.** Zero failures in 23 runs bounds the failure rate of this workload on this machine to about 3/23, roughly 13%, at 95% confidence (rule of three), plus the one 010 failure. It does not support "rare".
- **Margin.** Two runs reached 74% and 91% of the budget with no refusal. A little more overlap would have produced a 503.
- **Fairness versus capacity.** Without a cross-process timeline I cannot say whether the lock was saturated or sat idle while pollers slept (G17). That distinction decides which mitigation, if any, is worth building.
- **The product profile.** The stress workload writes empty wardrobes and tiny rows. A real 400-item wardrobe PUT validates and serialises up to 3 MB while holding the write lock (G15). The hold times here are the best case.
- **Load.** The CPU-load runs prove nothing about saturation (3.3b).
- **Anything on the target host,** with a real inference job, backup and mail running (E1.5).

**G1 stays a P1 release gate** (capacity and fairness under combined load, no target-host evidence, tail at 91% of budget in a single run). I do not ask for a timeout, workload or `npm test` change, and I agree with root that none should be made.

### 4.5 On root's question about a BUSY-triggered fairness pause

I agree with the doubt in `READ_LOCK_FINDINGS_011.md`. In the stress data the median write attempts count is 1: more than half of acquisitions succeed on the first try and therefore **never observe SQLITE_BUSY**. Those are the callers that keep re-taking the lock while a poller sleeps. A pause triggered only by an observed BUSY would not fire for them. Any trigger must either be unconditional and bounded, or be driven by shared cross-process state, which is a larger design. **I recommend not touching scheduling in the next batch** (section 8). A cheaper candidate to evaluate first, after the timeline exists, is a shorter poll interval (smaller native busy wait and smaller back-off), because a 20-90 ms poll cannot reliably land in a gap between holds of 20-80 ms.

---

## 5. New and updated findings (build 011)

IDs continue from G13 in the 010 review.

| ID | Pri | Defect | Where | Label |
|---|---|---|---|---|
| G14 | P2, public-launch gate | **No total deadline on request-body reads for authentication, or for wardrobe PUT.** The auth wrapper's `reader.read()` loop has no timer and no abort listener; it hands off to Better Auth only after the stream ends. A stalled or trickled body keeps the handler pending indefinitely. Root's direct-handler probe: pending and not cancelled at 21,013 ms. `readJson(req)` for `PUT /api/wardrobe` passes no `timeoutMs`, so it has the same property (the photo path passes `limits().bodyReadTimeoutMs`, 20 s). | `src/app/api/auth/[...all]/route.ts:36-62`; `src/app/api/wardrobe/route.ts:25`; `access.ts:88-128` | Code-proven; probe Observed |
| G15 | P3, possibly P2 on real data | `PUT /api/wardrobe` runs `saveWardrobe` **inside** `runWriteTransaction`, so the schema parse, `JSON.stringify` and size check of up to 3 MB, plus per-photo existence checks, run while the SQLite write lock is held. The stress test saves empty wardrobes, so this hold is unmeasured. | `wardrobe/route.ts:27`; `wardrobes.ts:52-119` | Code-proven; impact Hypothesis |
| G16 | P2 | **Authenticated requests queue behind sign-ups.** `account()` calls `auth.api.getSession` on every request, which runs on the same Kysely connection whose mutex is held for a whole sign-up transaction, hashing included. No cookie cache is configured (`auth.ts` has no `cookieCache`; grep). In `stress-10` the parent's wardrobe requests had p95 4.95 s while its worst write acquire was 1.75 s, so at least 3 s was spent outside any recorded acquire. | `access.ts:61-62`; `authDialect.ts:276-279`; observed in `stress-10.json` | Mechanism Code-proven for the mutex; attribution Inferred (the wait is not measured) |
| G17 | P2 (evidence) | **The recorded hold times cannot all be real lock occupancy.** In `stress-10` the sum of (hold count x mean hold) over all seven processes is about 42.2 s (my arithmetic: writers 30.3 s, worker 4.1 s, parent auth 3.0 s, registrar auth 3.6 s, parent writes 1.0 s, registrar writes 0.2 s), inside a 30.7 s stress window. In `stress-1` it is about 36.4 s inside 25.6 s. A single exclusive write lock cannot be held for 137-142% of wall time. Either a hold window includes time after the lock is released, or the lock is not exclusive as assumed, or my arithmetic is wrong. Separately, a trivial write child transaction has a median hold of 70-84 ms against 18-20 ms for the worker and parent. | `lockRecorder.ts`; `writeTransaction.ts:123-163, 204-210` | Observed; cause unknown |
| G18 | P2 (evidence) | Matrix validity: late joiners, unproven CPU load, unrecorded ambient conditions, not literally the release command (section 3.3). | `concurrency.test.ts:480`; `concurrency-matrix.ts`; `burner-sample.json` | Observed |
| G19 | P3 | Minor instrumentation defects: mixed clocks in the auth BUSY error; `finish()` hold event without a commit; untested rollback safety net (section 2.5). | `authDialect.ts:165-169, 241-252`; `writeTransaction.ts:195-203` | Code-proven |
| G20 | P3 | Cold Better Auth logs a missing-schema diagnostic before automatic migrations (root, browser run). If the app, mail worker and analysis worker start together on a fresh volume, concurrent first-start migrations are a possible race. Not examined. | `scripts/init-auth.ts`, `compose.yaml` | Hypothesis |

**Notes on specific findings.**

- **G14 impact is resource holding, not lock starvation.** The body read happens before `runWithContention`, `getReadyAuth()` and any database work [Code-proven], so a stalled body cannot hold the write lock and cannot explain the 010 failure. The cost is an open connection and up to 32 KB buffered per attacker connection, pre-authentication. Node's HTTP server has its own `requestTimeout` (documented default 300 s in current Node) and `scripts/start-server.ts` sets no timeouts by grep, so a deployed connection is probably bounded at about five minutes by upstream defaults [Hypothesis; not tested, and Caddy settings were not read]. That is a long time for a pre-auth route and is not the intended 20 s. The 408 must be returned before the existing `catch {}`, which would otherwise turn it into the generic 503. `readJson`'s timer-then-cancel pattern is the right model: its deadline is absolute from the start, so a trickle cannot extend it. It does not listen to `request.signal`.
- **G16 is the 010 "head-of-line" factor now with data.** With a 50-sign-ups-in-60-s burst and 0.13-0.5 s of connection occupancy each, the auth connection would be busy 10-40% of the time, and every session lookup in that process would wait. Session lookups are the first step of almost every request. This is a user-visible latency problem, separate from write-lock refusals, and no budget in the current diagnostics covers it.
- **G17 matters because the next decision depends on it.** Whether to reduce lock demand, change polling, or admit fewer long transactions depends on whether the lock is saturated or idle while waiters sleep. Per-process monotonic timestamps cannot answer that, and the hold series as recorded should **not be cited as occupancy**. A plausible innocent contribution to the large trivial-write holds is durability cost: `database.ts` sets no `synchronous` pragma by grep, so SQLite's default applies, which I believe is FULL and so syncs the WAL at each commit [Hypothesis, default not verified]. That would explain 20-80 ms holds, but not holds that sum to more than the elapsed time.
- **G15** is code-proven: `runWriteTransaction(() => saveWardrobe(user.id, body))` makes the whole function the body. Moving pure validation ahead of the transaction needs no change to semantics.

---

## 6. Consumer-goal assessment

Nothing in this build changes what the product has shown.

- **Whole-wardrobe and single-item upload:** the UI flows, queueing, review and persistence are browser-tested **against controlled analysis responses** (root, 33 pass, one duplicate mobile sign-up skipped, emulated mobile viewport in desktop Chrome, no real phone). **Dense real closet recognition remains failed or unproven.** The single-shirt detector control lives in an isolated research runtime, not in the app. The whole-wardrobe promise is therefore **not satisfied**. I did not read the detector research or the browser log and make no accuracy claim.
- **Minimal typing:** supported by the review UI; whether a real photo yields enough correct fields to avoid typing is unmeasured.
- **Owned-item outfits for days and events:** rule-level domain tests cover membership, completeness and exclusions. They do not show that anyone likes the looks.
- **Self-service multi-user:** accounts, verification and reset work against captured mail. Real mail delivery, HTTPS behind a proxy, and a load run on the target are all missing.
- **Free local AI:** unmeasured on the target host; inference competes with scrypt for the same cores (E1.5 from the 010 review).

---

## 7. Carried findings: status at 011

All of these live in files whose SHA256 is **identical in the 010 and 011 manifests**, so none was touched.

| Item | Status |
|---|---|
| G1 cross-process write starvation | **Open, P1 gate.** Now measured; mechanism consistent, cause not separated from capacity (section 4) |
| G2 Docker image lacks `scripts/export-deletion-ledger.ts` | **Open.** `Dockerfile:23-27` still copies five scripts; `DEPLOYMENT.md:122` still tells the operator to run it |
| G3 ledger staleness invisible, failed tick is one log line | **Open** (`mail-worker.ts:88-95` unchanged) |
| G4 one-step backup ceiling, no free-space precheck | **Open** (`backupDatabase.ts` identical) |
| G5 read paths take the write lock | **Open; confirmed in code** (below) |
| G8 auth route's "busy, nothing written" rewrite | **Open** |
| G9 `docker compose run` without `--no-deps`, uid note | **Open** |
| G10 live restore ignores an implicit ledger when `--ledger` given | **Open** |
| G11 README/DEPLOYMENT contradict 010 behaviour | **Open** |
| G12 trusted-proxy client-IP configuration | **Open.** `auth.ts` sets neither `ipAddressHeaders` nor `trustedProxies` (grep) |
| G13 native 50 ms busy wait parks the event loop | **Open; now has a number** (66 attempts, section 4.2) |
| Worker health (010 F2, F10): healthy heartbeat while every tick fails; heavy `--check` | **Open.** The ledger tick adds a second silent-failure path |
| SMTP TLS/STARTTLS, AUTH, real provider (D2); secret scope (010 F9: SMTP URL and `AUTH_SECRET` reach four containers; `compose.yaml` identical) | **Open, untouched** |
| Physical erasure (`secure_delete`, checkpoint, vacuum, marker test) | **Open, untouched** |
| Encrypted offsite backup and recovery drill; Linux/Docker; ext4; two containers on one volume; POSIX permissions; real directory flush | **Open (external gate)** |
| Dense wardrobe recognition on a held-out set; real consumer phones; target host, domain, HTTPS | **Open (external gate)** |

**G5, confirmed against code.** `GET /api/wardrobe` always runs `loadWardrobe` inside `runWriteTransaction` (`wardrobe/route.ts:15`). `loadWardrobe` always reaches `reclaimPhotos` (`wardrobes.ts:39-51`), which deletes only assets that are unreferenced **and** older than 24 h (or listed in a previous revision). A missing wardrobe returns a revision-0 value and **creates no row**, so root's constraint is right. `getAnalysisJobForOwner` mutates only when the row is stale; the rest is reads (`analysisJobs.ts:452-469`). Read-first is therefore feasible without changing responses. Every cleanup decision must be re-derived inside the write transaction, as root's note says, because a snapshot read cannot authorise a delete after a concurrent save. In this stress test 12 of the 21 wardrobe requests are GETs, so the test understates the real read share (a phone polling a job every few seconds).

---

## 8. Next Claude implementation batch (bounded, prioritised)

Constraints for Claude: Read/Glob/Grep/Edit/Write only, no execution; do not change `DEFAULT_WRITE_ACQUIRE_MS`, any gate or auth timeout, `WRITE_POLL_MAX_MS`, the queue cap, the stress workload, its counts or assertions, or `npm test`; no public switch that disables a bound; no secrets in logs; state what was not run. Do **not** change the 3 ms yield or any scheduling in this batch. Root runs everything and keeps the 011-corrected matrix as the "before".

### Part A: authentication and body-read deadline (G14). Small, security, do first.

1. One shared bounded body reader used by the auth wrapper and by `readJson`: absolute total budget from the first read (use `limits().bodyReadTimeoutMs`, 20 s default, no new public setting), cancel and release the reader on timeout, on `request.signal` abort, on over-limit and on every early exit; clear timers and listeners in `finally`.
2. Auth: keep the 32,768-byte cap and the current content-type handling; **return** a fixed 408 JSON body with `Cache-Control: private, no-store` **before** `runWithContention`, `getReadyAuth()` and any database work; do not let the outer `catch {}` convert it to 503.
3. `PUT /api/wardrobe`: pass the same `timeoutMs`. Keep the order of `account()` then `readJson` unless you can show the quota is not consumed for a request that times out (state which).
4. Tests: stalled body; **steady trickle** that makes progress but exceeds the total (progress must not reset the deadline); client abort; over-limit; ordinary valid sign-up and sign-in; ordinary invalid request; a case proving no database function ran on timeout. Report that the direct-handler test is not a network test.
5. Root afterwards: a real loopback HTTP slow-body check against the compiled candidate, and a measurement of what Node does with no application deadline.

### Part B: finish the evidence, no behaviour change (G16-G18, G19)

1. **Epoch-aligned lock timeline.** For every successful acquire and every hold, record wall-clock begin and end (for example `performance.timeOrigin + performance.now()`), bounded as the recorder is now. In the test parent, merge all seven processes' intervals and report: lock occupancy as a share of the window, longest idle gap **while at least one caller was waiting**, and any two holds that overlap (treated as a named problem, because it would mean the hold windows are wrong). This is the experiment that settles G17 and the fairness-versus-capacity question.
2. **Mutex wait.** Time the `inner.acquireConnection()` await in the auth driver (`authDialect.ts:276-279`) and report it as a separate series, so G16 is measured, not inferred. Also time `getSession` as the parent sees it, or at least the whole `account()` call, in the wardrobe chain.
3. **Late-start flag.** Each child reports `lateStartMs = max(0, setupEnd - startAt)`; the report and `summary.json` list runs with any late child and the number of them. **Do not change the 8 s offset or the workload.** Whether to replace the fixed offset with a ready-barrier is a separate decision for root, because it changes the shape of the test.
4. **Run facts** in `summary.json`: Node version, platform, logical CPU count, per-run wall start and end (ISO).
5. **Burners prove themselves.** Each burner writes its own `process.cpuUsage()` and elapsed time to a file at exit, and the runner reports the sum and the ratio to its lifetime. No external tool needed. If it is not at least a large share of one core per burner, the load scenario is reported as ineffective.
6. Optional G19: use one clock in the auth BUSY error or rename the legacy fields; do not emit a `commit` hold unless a COMMIT ran; add a test that forces the `runWriteTransaction` safety net.

### Part C (the batch after the matrix is rerun with Part B): demand reduction, behaviour-changing, reviewed separately

1. **Read-first wardrobe GET and job GET (G5)** as in `READ_LOCK_FINDINGS_011.md`: unchanged response shapes; the write path is entered only when cleanup or expiry is due, and the decision is re-checked inside the transaction. The tests root listed: with another connection holding `BEGIN IMMEDIATE`, an existing wardrobe and an unexpired job are served promptly through the real route; due cleanup still uses the bounded write path; save versus cleanup cannot delete a newly referenced photo; expiry versus cancel cannot refund twice; an expired completed result is never served; first-time accounts and owner isolation.
2. **Validate before locking (G15):** split `saveWardrobe` into pure validation (schema, size, shape) before `runWriteTransaction` and the revision/photo/reclaim work inside it, with identical errors and codes. Add a diagnostic test that records the hold of a large realistic PUT before and after.
3. Then rerun the same matrix and compare with the 011-corrected numbers. Only after that decide on any scheduling or polling change (section 4.5), each separately reviewed.

### Rider, independent and small (G2)

Add `scripts/export-deletion-ledger.ts` to the `Dockerfile` and extend the packaging check so every script named in `DEPLOYMENT.md` or `compose.yaml` exists in the image. This touches no concurrency evidence.

### Not in Claude's next batch (root, host or later)

SMTP TLS/AUTH and secret scope (D2); worker-health honesty; physical erasure; encrypted offsite backup and recovery drill; Linux/Docker and POSIX tests; the target-host consumer load gate with a real inference job; the dense-wardrobe decision gate on a held-out set; real phones.

---

## 9. Accepting diagnostics is not approving production

- **Accepted:** the E1.1 instrumentation, the G6 evidence collection and the matrix runner, as correct and contained, with the unreconciled hold series (G17) excluded from any capacity argument until Part B1 resolves it.
- **Accepted as a baseline** for comparison: `matrix-011-corrected-complete`, with the validity caveats in section 3.3.
- **Not accepted:** any statement that the contention risk is fixed, that the system is safe under combined load, that CPU saturation was tested, or that 6563.9 ms is the largest value observed.
- **Not approved for production or public launch.** The open gates are G1, G14, G16, the DR path, SMTP, physical erasure, worker health, offsite backup, Linux/Docker, dense wardrobe recognition, real devices and a target host. Suggested status is unchanged from 010: nobody outside the team should rely on this build.
- Nothing here is a pass of any test I did not see root run, and I ran nothing.
