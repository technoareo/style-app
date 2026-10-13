# Build 011 implementation notes (Claude): E1.1 contention diagnostics and G6 evidence collection

Scope: exactly the two items root asked for after the build 010 review: **E1.1** (accurate per-call diagnostics on the real production write and auth paths) and the **G6** correction (the concurrency stress test collects every child report and evaluates every invariant before asserting), plus a bounded matrix runner. **Evidence only.** No fairness pause, no admission control, no GET change, no timeout change, no workload change. Whole-wardrobe scope is untouched. This build is **not production ready** and nothing here alters the build 010 verdict. E2 (DR path), D2 (SMTP), physical erasure and dense recognition remain later work.

Method: Read, Glob, Grep, Edit, Write only. **I ran nothing and used no shell of any kind** (no `ls`, no `cat`). Everything below is from reading code. Nothing is verified until root runs it.

## 1. Files

New:
- `src/server/lockDiagnostics.ts`: observer registry, event types, monotonic clock, safe notification.
- `tests/helpers/lockRecorder.ts`: bounded per-process recorder, percentile helper, call timer (tests and harness only).
- `tests/lockDiagnostics.test.ts`: tests of the diagnostics (section 4).
- `scripts/concurrency-matrix.ts`: bounded matrix runner (section 5, corrected in 9.3). Not executed.
- `scripts/matrixConfig.ts`: the runner's strict argument rules and allow-listed child environment (9.3).
- `tests/matrixConfig.test.ts`: configuration, sentinel-secret and refusal tests (9.3).
- `tests/helpers/observerChild.ts`: real child with hostile observers and strict unhandled-rejection counting (9.1).
- this file.

Changed:
- `src/server/writeTransaction.ts`: measurement around the existing steps; `WriteContentionError.acquire` (new optional numeric property).
- `src/server/authDialect.ts`: measurement in `AuthConnection.begin()` and `finish()`; the existing `acquire` property on a refused BEGIN keeps `gateMs`/`sqliteMs` and gains more numeric fields.
- `src/server/writeGate.ts`: `WriteGateError` gains a `reason` ("timeout" | "full") property so the two refusals can be told apart. Message text unchanged; queue behaviour unchanged.
- `scripts/concurrency-child.ts`: reports `timing` (section 3.4).
- `tests/concurrency.test.ts`: collects everything first (section 3.5). Workload, counts, assertions unchanged.

Not changed: `sqliteRetry.ts`, `contention.ts`, `access.ts`, every route, `database.ts`, the mail/AI workers, `package.json`, `Dockerfile`, `compose.yaml`, docs other than this file. **Please confirm by manifest diff that only the files above differ from the 010 manifest** (`database.ts`, `sqliteRetry.ts`, `access.ts`, `analysisJobs.ts` etc. must keep their 010 hashes).

## 2. Behaviour preserved (what to check in review)

`runWriteTransaction` keeps this order and these values: budget and `deadline` computed first; `getDatabase()`; gate acquired with the whole `budget`; `retryBusy(BEGIN IMMEDIATE)` with `timeoutMs = max(0, deadline - Date.now())` and `maxDelayMs = WRITE_POLL_MAX_MS`; body run synchronously; COMMIT; ROLLBACK on failure; gate released in `finally`; 3 ms courtesy sleep after a commit. The thrown errors are the same classes with the same messages: a refused BEGIN still throws `WriteContentionError("The database is busy. Try again shortly.")`, a gate refusal still throws `WriteGateError`, a non-busy BEGIN error is rethrown as is. The retry callback now increments a counter and returns the same `db.exec` result. `errorResponse`, the auth route and every HTTP status, body and header are untouched.

`AuthConnection.begin()` keeps: gate first (`noteContention("auth-gate")` on refusal), then the retried `BEGIN IMMEDIATE`, `release()` and `noteContention("auth-begin")` on a refused BEGIN, `Object.assign(error, { acquire })` (still containing `gateMs` and `sqliteMs`, now with the monotonic fields spread over them). `finish()` keeps COMMIT/ROLLBACK, the rollback after a failed COMMIT, and `release()` in `finally`; the hold event is emitted just before `release?.()`.

The only new code in those paths is measurement, the attempt counter, and notification calls, each wrapped so it cannot throw (section 3.3).

## 3. Diagnostic semantics

### 3.1 Enabling
An observer is installed only by program code: `runWithLockObserver(observer, fn)` (AsyncLocalStorage context; isolates concurrent contexts) or `setProcessLockObserver(observer | null)` (one process-wide observer; the diagnostic children use it). A context observer takes precedence over the process one. There is no environment variable, header, query parameter or public route that enables it, and nothing is logged by default. With no observer, a call costs two lookups and two `performance.now()` reads. State lives on `globalThis` symbols, so duplicate Next bundles share it like the write gate does.

### 3.2 Events (`AcquireEvent`, `HoldEvent`)
All durations are monotonic milliseconds rounded to 0.1 ms.

`AcquireEvent` (one per attempt to start a transaction, success or failure):
- `path`: `write` (`runWriteTransaction`) or `auth` (`AuthConnection.begin`).
- `ok`, `outcome`: `acquired`, `gate-timeout`, `gate-full` (queue of 256 reached), `busy` (BEGIN refused until the budget ended), `error` (any other failure).
- `budgetMs`: for `write`, the **one** budget shared by the gate wait and the SQLite wait (default 10,000). For `auth`, the budget of **each** of the two waits (default 10,000), so `totalMs` can exceed it. Use `gateMs` and `sqliteMs` separately there.
- `gateMs`: time awaiting `acquireWriteGate` (about 0 when the gate was free).
- `sqliteMs`: from owning the gate to BEGIN succeeding or being finally refused. It includes the native 50 ms/20 ms busy waits, the async back-off sleeps and the attempts. It is 0 when the gate was never obtained.
- `totalMs`: from the start of the call to BEGIN succeeding or the call failing. On the write path the start is taken **before** `getDatabase()`, so a first call includes opening the connection (and the presence hold). On the auth path it starts at `begin()`; **time spent waiting for Kysely's connection mutex before `begin()` is not included** (see limits).
- `attempts`: BEGIN IMMEDIATE attempts (0 if the gate was refused).
- `queueDepth`: callers already waiting in the gate queue when the call arrived (the holder is not counted).

`HoldEvent`: `path`, `holdMs`, `outcome` (`commit` | `rollback`). Write path: from a successful BEGIN to just before the gate is released, i.e. the body, COMMIT or ROLLBACK, **excluding** the courtesy sleep. Auth path: from a successful BEGIN to after COMMIT/ROLLBACK, which spans every real `await` inside the transaction (password hashing). A COMMIT that throws is reported as `rollback`. No event is produced when no transaction began.

Errors: `WriteContentionError.acquire` (budgetMs, gateMs, sqliteMs, totalMs, attempts, queueDepth) and `WriteGateError.reason` are numbers and fixed words. Nothing serialises them into a response.

### 3.3 Failure isolation (corrected after root's first checks; see section 9)
**The first version of this paragraph was wrong.** It claimed every call into an observer was contained, but the property lookup (`observer.acquire`) happened outside the `try`, and a returned rejecting promise was never handled. Section 9.1 has the defect and the fix. In short, now: the lookup, the call, and any returned promise or thenable are all inside total containment (`invoke` and `absorb` in `lockDiagnostics.ts`); the callback gets a frozen copy of the event; and the production paths additionally protect rollback and gate release independent of the diagnostics. A synchronous slow observer still slows its caller; the harness observers only push to bounded arrays.

### 3.4 Child reports (`scripts/concurrency-child.ts`)
Each `register`, `write` and `worker` child prepares the recorder before the release instant (the dynamic imports cost the stress phase nothing) and installs the process observer at the release instant. Its JSON line is now `{ role, ok, failures, timing }` with `timing = { phases: { setupMs, waitMs, stressMs }, calls, locks }`:
- `calls`: every operation the child made, **including failed ones**: `all`, `ok`, `failed`, each `{ count, p50, p95, p99, max, mean }` (one call = one sign-up, one `runWriteTransaction`, or one heartbeat + sweep iteration). Percentiles are nearest-rank.
- `locks.write` / `locks.auth`: `acquire` (count, ok, failed, `outcomes`, `queueDepthMax`, stats for `totalMs`, `totalMsOk`, `totalMsFailed`, `gateMs`, `sqliteMs`, `attempts`) and `hold` (count, commit, rollback, `holdMs` stats), plus `truncated`.
- Storage is bounded: at most 20,000 samples per series; counts and maxima stay exact beyond that and `truncated` says when percentiles describe only the retained prefix. The stress test makes a few hundred calls, so truncation is not expected.
- The failure text (`describeError`) now prints the whole `acquire` object, including attempts and queue depth.
- Exit code and the failure list are exactly as before; a failed child still exits 1.

### 3.5 Evidence collection in `tests/concurrency.test.ts` (G6)
The stress test is the same workload (3 registrars × 4, 3 writers × 150, 1 worker × 60, 8 in-process sign-ups, 3 wardrobe chains, reset race, deletion race, 8 s release offset). Changes:
- Every in-process task, every HTTP status, **every child report** (failures and exit code, each by role and index) and **every data-integrity invariant** is evaluated into a `problems` list, each by name, before anything is asserted. The invariants are the same assertions as in build 010 (registrar and in-process account counts, no user without a credential and no orphan account, 450 writer rows, reset token consumed once, deletion succeeded, user gone, one tombstone, reset account present, wardrobe revision 3 and isolation per user), now each reported individually.
- The final statement is `assert.deepEqual(problems, [], …)`: **any failure still fails the test.** Nothing was converted to a skip, relaxed, retried or reduced.
- Phases are printed separately: `setup` (modules, verified users, reset token), `wait` (spawn to the release instant, including the 8 s offset), `stress` (release to the last report).
- The parent installs a context observer around only the in-process stress traffic and times its sign-ups (handler and API) and wardrobe requests separately.
- Output: one console line `CONCURRENCY_TIMING {json}` and, if `CONCURRENCY_REPORT_FILE` is set, the same JSON plus the (truncated) problem list in that file. The report holds numbers, roles and counts only.

## 4. Tests (`tests/lockDiagnostics.test.ts`, written, not run)

Real SQLite connections and real waiting. A second connection to the same file stands in for "another process" holding the write lock.
1. Percentile helper: nearest rank, exact maximum, empty input.
2. **Brackets**: a lock held ~400 ms makes `sqliteMs >= 300`, `attempts >= 2`, gate ≈ 0, `totalMs ≈ gateMs + sqliteMs`, and the measurement lies inside the caller's wall time. A gate held ~300 ms with two callers gives `gateMs >= 250`, one BEGIN each, and queue depths `[0, 1]`.
3. **Hold**: an auth transaction kept open ~250 ms across real macrotasks reports a commit hold ≥ 230 ms; a rollback hold ≥ 100 ms and the rolled-back row is absent; the write path reports `rollback` for a throwing body and `commit` otherwise.
4. **Isolation**: two concurrent contexts see exactly their own events (3 and 2); the process observer sees only calls made outside any context and nothing is recorded with no observer.
5. **Refusal**: a held lock with a 300 ms budget rejects with `WriteContentionError` (same message), the body counter stays 0, `error.acquire` shows budget, attempts and wait, the event is `busy`, no hold event exists, no transaction is open, the row count is unchanged, the gate is free, and the same call then succeeds.
6. **Gate refusal**: a held gate with an 80-120 ms budget rejects with `WriteGateError` (same message), event `gate-timeout`, body never ran, the waiter is removed.
7. **Hostile observer** (throws in `acquire` and `hold`): a success still returns its value and commits; a throwing body still surfaces its own error and rolls back; a busy refusal still throws `WriteContentionError`; a gate refusal still throws `WriteGateError`; the auth dialect still begins, commits and rolls back and surfaces the SQLite busy error; the gate is free after every case.
8. No-observer path: unchanged result.

Tolerances are lower bounds derived from the waits the tests create plus generous upper bounds. A very slow or paused machine could in principle break an upper bound; if one fails, read the numbers before changing it.

## 5. Matrix (`scripts/concurrency-matrix.ts`; **do not run until root decides**)

Exact commands (the runner uses the same Node runner as `npm test`, `node --import tsx --test`; it never edits `npm test`):
```sh
# inspect the plan without running anything
npx tsx scripts/concurrency-matrix.ts --dry-run
# small diagnostic subsets first
npx tsx scripts/concurrency-matrix.ts --scenario stress --reps 2
npx tsx scripts/concurrency-matrix.ts --scenario load --reps 1 --burners 4
# the requested matrix: stress x10, full --test-concurrency=1 x3, full default x3, stress under CPU load x3
npx tsx scripts/concurrency-matrix.ts --scenario all
```
Options: `--scenario stress,serial,default,load|all`, `--reps N`, `--timeout-sec N`, `--burners N` (default: logical CPUs), `--out dir` (default `docs/verification/matrix-011/<stamp>`).

Properties: every run is a new process with the repository as working directory and no inherited `STYLE_DATA_DIR`; the stress test makes its own fresh `.data/tests/<uuid>` directory each time. Each run has a finite outer timeout (defaults 600 / 1800 / 1200 / 900 s) after which its whole process tree is killed (`taskkill /T /F` on Windows, process-group kill elsewhere, no shell). CPU burners are plain `node -e` busy loops that stop themselves at a deadline slightly after the run's limit; the runner also kills them, and every tracked process on exit, SIGINT and SIGTERM. `summary.json` is rewritten after every run, so an interrupted matrix keeps what finished; each run's full log is `<scenario>-<n>.log` and its structured report `<scenario>-<n>.json`. `serial` passes `--test-concurrency=1`; `default` passes nothing, i.e. node's default; the default `npm test` command is not redefined or replaced anywhere.

Summary fields per run: exit code, timed out, seconds, node-test counts, and from the stress report: phases, problem count, per-child ok/failure/exit, and **per-process peaks** of write acquire (total, p99, gate, SQLite), failed acquires, auth acquire and hold maxima, and maximum queue depth. Peaks and p99s are per process; they are not merged into one distribution.

Not cleaned up: the stress test leaves its `.data/tests/<uuid>` directory (as before); remove old ones by hand if disk matters.

## 6. Baseline evidence (from root; not mine)

- Build 010, default full run (`tsx --test tests/*.test.ts`): 119 total, 114 pass, 1 fail, 4 skip, 149.7 s. The failure is retained, not dismissed: one write child hit `WriteContentionError` at `writeTransaction.ts:73`, `sinceStart=21820ms`.
- Isolated unchanged concurrency file: 7/7 pass, 43.4 s (stress test 36.1 s).
- Unchanged full suite with `--test-concurrency=2`: 115 pass, 4 skip, 305.3 s.
- Compiled 010 startup in an isolated OS temp directory: pass. Browser suite against compiled 010: 33 pass, 1 skip (duplicate mobile sign-up), controlled recognition, emulated mobile.
- 155 build 010 hashes unchanged. No launch approval.

These numbers say nothing yet about **how often** the default run fails or where the wait goes. That is what this batch is for.

## 7. Unverified and limits

1. **Nothing was run**: not `tsc`, lint, any test, nor the runner. Check first: types of the new `lockDiagnostics.ts` and the `let release` definite-assignment flow in `runWriteTransaction`; private-field narrowing in `AuthConnection`; the `Record<string, any>` use in the runner; `performance` as a global in the test and child.
2. **AsyncLocalStorage across Kysely and Better Auth**: the auth observer is captured at `begin()` from the caller's context and reused for the hold event, which assumes the context survives Better Auth's awaits and Kysely's connection-mutex wait. The isolation test covers the dialect directly, not the full Better Auth chain; the stress test's parent recorder will show whether `auth` events arrive (expect 8 sign-ups + reset + deletes in the parent).
3. **Not measured**: time waiting for Kysely's `ConnectionMutex` before `begin()` (so a sign-up queued behind another auth operation is only seen end-to-end in the `calls` timings, not in `acquire`); auth autocommit statements (rate-limit writes, session reads); reads. A tail that exists only there would be invisible in `locks` and visible in `calls`.
4. `queueDepth` is sampled when the call arrives, not over its wait.
5. Percentiles are per process and per series. The runner reports peaks, not merged distributions.
6. `node --import tsx --test` must behave like `tsx --test` for these files, and `--test-concurrency=1` must be accepted by this Node (24.20); if not, the runner's `serial` scenario fails immediately (visible in its log) rather than silently running differently.
7. The `load` scenario uses burners at normal priority. It is a bounded synthetic pressure, not a model of Ollama inference or of the target host. The consumer load gate (E1.5 in the 010 review) is still required, with a real inference job.
8. Timing assertions in `lockDiagnostics.test.ts` are lower bounds created by the test plus generous upper bounds; a heavily loaded machine may need those upper bounds read, not loosened blindly.
9. Hard-link, symlink and POSIX caveats from build 010 are unchanged.

## 9. Root's first checks failed: defects and corrections

Root reported: (a) typecheck errors in `scripts/concurrency-matrix.ts:239` (TS2339, `env.STYLE_DATA_DIR` not in the inferred spread type) and `authDialect.ts:152/153` (TS2783, `gateMs`/`sqliteMs` written and then overwritten by `...detailOf(event)`); (b) root's own probe `docs/verification/observer-failure-probe-011.mjs`, which reproduces **both** `getterEscaped:true` and `asyncUnhandled:true`; (c) review of the matrix runner's environment and argument handling. All three were real. I did not run anything to confirm the fixes.

### 9.1 Observer containment (the serious one)
**Defect.** `notifyAcquire`/`notifyHold` read `observer.acquire` / `observer.hold` outside the `try`. A throwing property getter (or Proxy trap) escaped. An `async` observer (assignable to a `void` callback) returned a promise that, when it rejected, nobody handled: an unhandled rejection. On the real paths the escape was worse than cosmetic: a throw at the hold notification in `finally` would skip `release()`, leaving the write gate held; a throw from the success `acquire` notification, placed between BEGIN and the body's `try`, would leave a begun transaction with no body and no rollback. That violated "an observer must never change the outcome", and my first notes overstated the guarantee.

**Fix** (`src/server/lockDiagnostics.ts`, `writeTransaction.ts`, `authDialect.ts`):
- `invoke()` does the property lookup, the call and the handling of the result inside one `try/catch`; `notifyAcquire`/`notifyHold` only delegate. They never throw, return nothing and wait for nothing.
- The callback receives `Object.freeze({ ...event })`, a copy. A callback that mutates it (or tries to) changes nothing the caller uses; the diagnostic detail attached to `WriteContentionError.acquire` and to the auth BUSY error is built from the caller's own object.
- A returned promise or thenable is never awaited. `absorb()` calls its `then(undefined, noop)` so a rejection is handled, and applies itself again to whatever that `then` returned (to depth 3), because a hostile `then` can itself return a rejecting promise. Reading `then`, calling it, and the recursion are inside `try/catch`.
- Production paths no longer rely on that alone. `runWriteTransaction`'s `finally` first rolls back if this call's transaction is still open and uncommitted (`holdStartedAt !== null && !committed && db.isTransaction`; unreachable before, a pure safety net), then notifies inside its own `try/catch`, then **always** calls `release()`. `AuthConnection.finish()` wraps the hold notification in `try/catch` before `release?.()`. The auth `begin()` stores its release function and `began` before the success notification, so a transaction that began can always be finished.
- Documentation was **not** merely narrowed: hostile observers are supported and tested.

**Tests added.**
- `tests/lockDiagnostics.test.ts`: getter-throwing and Proxy-throwing observers on real write transactions (value returned, row committed, body failure rolled back with the real error, no open transaction, gate free); a mutating observer cannot change the numbers on a refusal (`budgetMs`, `attempts`); and a **real child** (`tests/helpers/observerChild.ts`) that counts `unhandledRejection`/`uncaughtException` and also relies on Node's default (an unhandled rejection exits the process with an error). The child runs, for six hostile observers (throwing getters, throwing Proxy, `async` rejecting, hostile thenables, a thenable returning a rejection and a rejecting thenable, event mutation): a success, a throwing body, a refused lock, a refused gate, and auth-dialect begin/commit/rollback/refused begin. It checks results, the thrown error types and messages, committed and rolled-back rows, that no body ran on refusals, that the auth BUSY error keeps its original `gateMs` and `sqliteMs` fields, and that the gate and connections are free; then it waits 20 immediate ticks plus 200 ms for any stray rejection. The parent asserts exit 0, no failures, `unhandled == 0` and no "unhandled" text on stderr.
- The earlier throwing-method test is unchanged.

### 9.2 Type errors
- `authDialect.ts`: the BUSY error's `acquire` is now `{ ...detailOf(event), gateMs, sqliteMs: Date.now() - t0 - gateMs }`. The two **original wall-clock fields keep their original names and meaning** and are written last, as explicit properties, after the spread (which is the order that removes TS2783 without changing which value a reader sees under those names). The other fields (`budgetMs`, `totalMs`, `attempts`, `queueDepth`) are the monotonic detail. This is documented in a comment at the site. Note the monotonic gate/SQLite split is therefore not under the `gateMs`/`sqliteMs` names on this particular error; the observer events and `WriteContentionError.acquire` carry the monotonic values.
- `concurrency-matrix.ts`: the environment is now built by `buildChildEnv` (below), a `Record<string, string>`, so the typed `delete env.STYLE_DATA_DIR` no longer exists.

### 9.3 Matrix runner: environment, arguments, processes
**Defects found by root.** The runner deleted only `STYLE_DATA_DIR` and inherited `APP_URL`, `SMTP_URL`, `MAIL_FROM`, `AUTH_SECRET`, `NODE_OPTIONS`, `NODE_PATH`, `STYLE_PUBLIC_DEPLOYMENT` and any other `STYLE_*` setting; `--reps 0.5` floored to 0 and silently ran an empty matrix that looked complete; a spawn error left the log open and burners running; kill errors were swallowed and reported as success.

**Fixes** (`scripts/matrixConfig.ts`, new, with the rules; `scripts/concurrency-matrix.ts` uses them):
- **Environment**: every child (test runs and burners) gets an **allow-list** of what a Node test process needs (PATH family, SystemRoot/WINDIR/ComSpec, TEMP/TMP/TMPDIR, HOME/USERPROFILE/APPDATA family, locale, timezone, processor facts) plus forced `APP_URL=http://127.0.0.1:3000`, `STYLE_PUBLIC_DEPLOYMENT=false`, `NEXT_TELEMETRY_DISABLED=1`, plus `CONCURRENCY_REPORT_FILE`. Secrets, SMTP, mail, vision/Ollama settings, `NODE_OPTIONS`, `NODE_PATH` and every other `STYLE_*` variable are not passed. No variable value is ever printed; `--dry-run` prints names and a dropped-variable count.
- **Arguments**: strict. Whole decimal numbers only; `--reps` 1..50, `--timeout-sec` 30..7200, `--burners` 1..min(64, 2 × CPUs). Fractions, zero, negatives, exponents, words, empty values, out-of-range values, unknown options, stray positionals, a missing value, `all` combined with names and an empty selection are all refused before anything starts. The plan must be non-empty; the summary records `planned` and `completed`, `complete` is true only when they are equal, and the process exits 2 if the matrix did not complete or any problem was recorded.
- **Spawn and kill**: every tracked child has an `error` listener (a failed spawn no longer crashes the script or leaks a burner); burners are recorded in the run's list the moment they exist, so a failure part way still lets the run stop the ones already started; the log descriptor is closed in a `finally`; `killTree` returns a description of any failure (`taskkill` could not run or exited non-zero while the process was still alive; a POSIX kill that failed with the process alive) instead of swallowing it; after killing, the runner waits up to 5 s for each child to exit and records any that did not. Each result carries `allChildrenStopped` and `stopProblems`; the summary and the console list every problem; nothing says "all stopped" unless each child was confirmed dead. Exit code: 2 (incomplete or problems), 1 (some run failed or timed out), 0 otherwise.
- **Workload, assertions and timeouts of the actual app tests are untouched.** The runner still passes exactly the same test files and only `--test-concurrency=1` for `serial`.

**Tests** (`tests/matrixConfig.test.ts`, new; fake sentinel secrets and a fake public URL; assertions report indexes and booleans, never values):
1. All the malformed argument forms above are refused.
2. Valid arguments are taken as given, the default plan is 10/3/3/3 = 19 runs, `serial` alone carries `--test-concurrency=1`, and an empty file list is refused.
3. `buildChildEnv` with sentinels: no sentinel name (other than the two forced ones) or value survives; `NODE_OPTIONS`/`NODE_PATH` cleared; forced values win.
4. A **real child** started with the built environment reports zero sentinel values and names and the forced settings.
5. The **real runner** in `--dry-run` with the sentinels in its own environment: exit 0, 19 planned runs, names only, no sentinel value on stdout or stderr, and none of the secret names listed for the child.
6. The real runner refuses `--reps 0`, `--reps 0.5`, `--burners 999`, `--timeout-sec 1` and `--scenario ""` with a non-zero exit, nothing on stdout, and no sentinel on stderr.

**Still not tested** (needs a real failure to provoke): the `error`-listener path for a failed spawn, the kill-failure reporting, and the five-second straggler check. They are small and read, not run.

### 9.5 Root's retest and the remaining type correction

**Root's result (not mine):** corrected diagnostics and configuration tests pass, 17 of 17 in 8.762 s, including the real strict child and the observer getter, async and thenable containment cases. The independent original observer probe now reports `getterEscaped:false` and `asyncUnhandled:false`. No load matrix and no production build have been run. Typecheck still failed.

**Remaining defect.** `scripts/concurrency-matrix.ts:166,277` and `tests/matrixConfig.test.ts:149` passed an environment typed `Record<string, string>` to `spawn`. The project's Next typings make `NODE_ENV` a required member of `NodeJS.ProcessEnv`, so that type is not accepted; the failed overload then made the child `never` and produced the implicit-any errors at lines 152-154 of the test. My `buildChildEnv` return type did not describe what it really returns.

**Correction (types stated truthfully, no `any`/`unknown` cast):**
- `scripts/matrixConfig.ts` exports `ChildEnv = NodeJS.ProcessEnv & { readonly NODE_ENV: "development" }` and `FORCED_NODE_ENV = "development"`. `buildChildEnv` builds the allow-listed copy as before, then returns `{ ...copied, NODE_ENV: FORCED_NODE_ENV }` typed as `ChildEnv`; `ChildEnvironment.env` is `ChildEnv`. The runner's `startBurners` takes a `ChildEnv`, and `runOne` passes the same value to `spawn`.
- **One deliberate value change to state plainly:** children now get `NODE_ENV=development`. Before, `NODE_ENV` was not on the allow-list and was simply absent in the child. An absent value behaves as development for Next and Better Auth, so this is the same mode made explicit; its purpose is that a machine value such as `production` cannot be inherited. `NODE_ENV` is still not on the allow-list: an inherited value is dropped and replaced. The workload, assertions, timeouts and every other variable are unchanged; the allow-list and sentinel stripping are untouched.
- `tests/matrixConfig.test.ts`: the unit test now puts `NODE_ENV: "production"` in the source environment and asserts the result is `development`; the real-child test does the same and has the child report its `NODE_ENV`. I also annotated the child stream and event callbacks (`data: Buffer`, `close: number | null`); that is a typing nicety, not a behaviour change, and should not be needed once the environment type is right.

Not run. Please re-run `npm run typecheck` first, then the two test files again (the new `mode` assertions in the real-child test are the only added expectations).

### 9.4 What I still have not verified
Nothing in sections 9.1-9.3 has been run. Please run first: `npm run typecheck`; `tests/lockDiagnostics.test.ts`; `tests/matrixConfig.test.ts`; then root's `observer-failure-probe-011.mjs` against the changed `lockDiagnostics.ts` (it should now report `getterEscaped:false` and `asyncUnhandled:false`). One residual I cannot close by reading: a thenable whose `then` schedules a rejection asynchronously on a path other than its return value or reject callback cannot be absorbed by any wrapper; `invoke` handles what the callback returns, not what an arbitrary observer does on its own. That is the observer's own unhandled rejection, not one caused by this code.

## 10. First runtime evidence and the second correction

### 10.1 What root observed (root's numbers, recorded as given)
- Typecheck passes; matrix configuration tests 6/6; lock and configuration tests previously 17/17.
- Two isolated runs of `tests/concurrency.test.ts`: 7/7 each, integrity problems 0; the parent recorded real Better Auth observations (11 acquisitions and holds).
- **First default-concurrency matrix run** (`docs/verification/matrix-011-default-initial`): 136 total, 131 pass, **1 fail**, 4 skip, 60.4657 s. The concurrency workload passed every operation and every invariant. Its measurements: **maximum writer acquire 9,079.8 ms against the 10,000 ms budget, maximum auth acquire 5,930 ms, zero failed acquires.** That is a pass **close to the budget**, not evidence of margin: one slightly worse overlap would have produced the build 010 failure again. The build 010 default-run failure (`WriteContentionError`, `sinceStart=21820ms`) is retained and is **not** explained or removed by this run.
- The one failure was **in my new test**, not in the application: `tests/lockDiagnostics.test.ts:99` expected `sqliteMs >= 300` and observed 166.9.

### 10.2 Cause: my fixture, plus a measurement flaw it exposed
Root verified that the fixture started the foreign lock's 400 ms release timer **before** the application connection existed. `runWriteTransaction` calls `getDatabase()` first, and the first call opens the file and takes the presence hold, so initialization consumed part of the held interval. The wait the test had created was real; the measured SQLite wait was shorter because part of it had been spent initializing. The assertion was right and the fixture was wrong, so **the lower bound is not loosened.**

The same observation showed a real diagnostic flaw: `startedAt` was taken before `getDatabase()` and `gateMs` was computed from `startedAt`, so **`gateMs` contained connection initialization** (up to the whole first-call cost) although the gate was free. That would have misattributed a cold first call to the gate.

### 10.3 Corrections
**Diagnostics** (`lockDiagnostics.ts`, `writeTransaction.ts`, `authDialect.ts`):
- New numeric `initializationMs` on `AcquireEvent` and on the error detail (`WriteContentionError.acquire`, and the extra fields on the auth BUSY error). Write path: the time `getDatabase()` took on this call (about 0 once open). Auth path: always 0 (its connection exists before a transaction can begin).
- `gateMs` now brackets **only** the wait inside `acquireWriteGate`: from just before the call to just after it resumes (including the microtask resumption, which is unavoidable). On the write path the queue depth is still sampled before the gate request.
- `sqliteMs` is from gate ownership to the instant BEGIN **returned** (see next point), or to the final refusal.
- `totalMs` still starts at the beginning of the call and therefore **includes initialization**: `totalMs ≈ initializationMs + gateMs + sqliteMs` plus a few microseconds. On a gate refusal `totalMs` also includes initialization.
- **BEGIN instant.** The successful-BEGIN timestamp is now read **inside the retried callback, immediately after `db.exec("BEGIN IMMEDIATE")` returns**, on both the write path and the auth dialect, and that value is the hold's start and the end of `sqliteMs`. Before, it was read after the `await`, which lost any microtask delay between the lock being taken and the function resuming (the hold would have started late).
- Unchanged and verified by reading: `deadline` is still computed first (before `getDatabase()`); the gate still receives the whole budget; the retry callback still returns the `exec` result; SQL, ordering, rollback and release are as before; no budget, timeout, workload or `npm test` concurrency was changed; no fairness change.
- Recorder (`tests/helpers/lockRecorder.ts`) gains an `initializationMs` series; the matrix summary gains `writeInitMaxMs`.

**Tests** (`tests/lockDiagnostics.test.ts`):
- The failing fixture now **warms the connection first** (a no-op `runWriteTransaction`), then takes the foreign lock and starts the timer immediately before the call; cleanup is in a `finally` (timer cleared, the foreign transaction rolled back if still open). `sqliteMs >= 300` is unchanged. It also asserts `initializationMs < 5` and `totalMs ≈ initializationMs + gateMs + sqliteMs`.
- New first test: a **cold** call reports `initializationMs > 0`, a warm call about 0, `gateMs` and `sqliteMs` small on both (so initialization is not hidden in either), and the total includes it. It must remain the first test that opens the application connection; the comment says so.
- New boundary tests for the BEGIN instant, on **both** paths: microtasks that block the thread for ~100 ms are queued right after the call starts, so they run between BEGIN returning and the caller resuming. The acquisition is quick (`sqliteMs < 50`) but the hold is `>= 90 ms`. A timestamp read after the `await` would fail this.
- New: a refusal's `acquire` detail carries initialization, gate and SQLite time that add up to its total, with the SQLite wait at least 150 ms of a 250 ms budget.

### 10.4 What stays true
The stress test, its counts, assertions and phases are unchanged by this correction. Nothing here fixes or explains the build 010 contention failure; the 9.08 s observation shows how close a passing run can be to the budget. The matrix (stress ×10, serial ×3, default ×3, load ×3) and the E1.3 decision are still to be done by root. No launch-readiness claim; all release gates remain open. The frozen build 011 snapshot was not touched.

Not run by me. Please re-run: typecheck; `tests/lockDiagnostics.test.ts` (check the new cold-call and boundary tests first); `tests/matrixConfig.test.ts`; then the isolated stress run to see `initializationMs`, `gateMs` and `sqliteMs` in the child and parent reports.

## 8. Remaining release gates (nothing here is closed)

The build 010 failure is not explained or fixed by this batch; E1.2 (the matrix), E1.3 (decision), E1.4 (bounded mitigations, each separately reviewed) and E1.5 (target-host consumer load gate) follow, as do E2 (ledger export script in the image, ledger status, docs), E3 (backup at scale), E4 (Linux/Docker), SMTP TLS/AUTH and real provider, encrypted offsite backup with a recovery drill, physical secure delete, dense whole-wardrobe recognition and a held-out set, real consumer devices, and operations alerts. Root freezes, builds and tests; a fresh independent review follows.
