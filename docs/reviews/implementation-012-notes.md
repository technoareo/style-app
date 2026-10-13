# Implementation 012 notes

Scope: build-011-claude.md section 8 Part A (G14, authentication and body-read deadline) plus the optional G2 Docker rider. Written with Read/Glob/Grep/Edit/Write only. **Nothing was run**: no tests, typecheck, build, Docker, network or browser. Root verifies. The frozen siblings (build011, build-011-corrected) were not touched, and nothing under `sources/`, `.data`, `.runtime` or `.env` was read or changed.

No readiness claim is made. Part B diagnostics and any read-path behaviour change are out of this batch.

## Root's initial results and the fixes (revision 2)

Root's first run: targeted tests 18/18 passed, but two real failures were found. Both are fixed in source below; neither is re-verified (nothing run by me).

1. **Typecheck failure, `access.ts` line 113 `read.bytes`.** `BoundedBody` declared `{ status: "timeout" | "aborted" | "too_large" }` as one union member, so separate `status ===` checks did not narrow it to the `ok` member. Fix: the type is now a truthful discriminated union with one member per status (`ok | empty | timeout | aborted | too_large`). `readJson`'s existing exhaustive checks now narrow to `ok` without a cast. No `any`.
2. **Real absolute-deadline flaw** (root probe `docs/verification/body-deadline-boundary-probe-012.mjs`, ready stream, 50 ms budget, a 120 ms blocking microtask queued first: returned `ok` after 124.69 ms). Timer callbacks cannot run while microtasks drain, so checking only the timer-set `state.stopped` let already-available bytes or EOF through after the deadline. Fix in `boundedBody.ts`: a monotonic deadline (`performance.now() + budget`) is computed with the timer, and `stoppedReason()` checks the clock as well as the recorded reason **before each read, after each read result (before accepting a chunk, a zero-byte chunk or EOF), and once more before returning `ok`**. A clock-detected expiry goes through the same `stop("timeout")`, which records only the first reason, so an earlier client abort still reports `aborted`. The timer and abort wakeups, cleanup in `finally`, size caps, 20 s default, and the 250 ms cancel grace are unchanged. Remaining unavoidable gap: time that passes after the final check but before the caller runs is outside the helper.

New regression tests in `tests/boundedBody.test.ts` (no timing assertion was widened): for data+EOF, a zero-byte chunk then EOF, and EOF only, a blocking microtask queued before the read holds the thread 150 ms past a 50 ms budget with the timer unfired, and the result must be `timeout` (the test also asserts the delay really exceeded the budget); an abort that precedes the same delay must stay `aborted`; and an unblocked in-budget body is still `ok`. The real network proof remains root's.

## Changed files

| File | Change |
| --- | --- |
| `src/server/boundedBody.ts` | **new**: the shared bounded raw body reader |
| `src/server/access.ts` | `readJson` now uses the shared reader (imports `readBoundedBody`) |
| `src/app/api/auth/[...all]/route.ts` | auth wrapper uses the shared reader; fixed 408 / 413 / 400 JSON answers; imports `readBoundedBody`, `limits` |
| `src/app/api/wardrobe/route.ts` | comment only (documents order and quota); behaviour comes from `readJson` |
| `Dockerfile` | one added `COPY` for `scripts/export-deletion-ledger.ts` in the runtime stage |
| `tests/helpers/bodySource.ts` | **new**: controllable body sources (stall, trickle, hanging / rejecting cancel, error) |
| `tests/boundedBody.test.ts` | **new**: unit tests of the reader with short internal budgets |
| `tests/bodyDeadline.test.ts` | **new**: direct-handler tests of auth, wardrobe PUT and photos |
| `tests/deploymentScripts.test.ts` | **new**: local contract check that deployed operator scripts are packaged |

Unchanged on purpose: `limits.ts` (and so the 20 s default and the 1 s..120 s valid range of `STYLE_BODY_READ_TIMEOUT_MS`), `imageAdmission.ts`, `photos` routes, `contention.ts`, `auth.ts`, every scheduling / yield / poll / gate / auth timeout, the stress workload, `package.json` and `npm test`.

## Semantics of `readBoundedBody(req, { maxBytes, timeoutMs, cancelGraceMs })`

- **Absolute deadline.** One timer starts before the first read and is never re-armed. Progress (a trickle) does not extend it. A chunk that arrives in the same tick as the deadline is discarded, not accepted.
- **Budget source.** Both callers pass `limits().bodyReadTimeoutMs` (default 20 s). `readJson` also uses it when the caller passes nothing, so `PUT /api/wardrobe` now has a deadline. A missing, zero, negative or non-finite `timeoutMs` falls back to that same value (`effectiveBodyTimeoutMs`); there is no argument and no public setting that turns the bound off. `readJson` previously treated `timeoutMs: 0` as "no timeout"; that path is gone.
- **Client abort.** `request.signal` is honoured, including a signal already aborted before the first read.
- **Early exits** (timeout, abort, over-limit, stream error): the stream is cancelled, the reader's lock is released, the timer is cleared and the abort listener removed, all in `finally`.
- **Cancel is bounded.** `reader.cancel()` is raced against `cancelGraceMs` (250 ms internal default, not configurable by a request). A cancel callback that never settles delays the answer by at most that grace; one that rejects is swallowed. A read abandoned mid-flight has its own rejection handled. Tests cover hang and reject, with an `unhandledRejection` listener.
- **Result.** `ok | empty | timeout | aborted | too_large`. A genuine stream error is rethrown after cleanup (callers keep their existing handling).

## Auth wrapper (`/api/auth/*`)

- Cap stays 32,768 bytes; content-type is still not inspected by the wrapper; body-bearing non-GET/HEAD requests are still rebuilt with `new Request(request, { body: <utf8 string> })`.
- Over cap: 413 `{"error":"Account request is too large."}` with `Content-Type: application/json` and `Cache-Control: private, no-store` (same as before).
- Timeout: **408** `{"error":"The request took too long. Please try again."}`, same headers. It is `return`ed, not thrown, and happens before `runWithContention`, `getReadyAuth()` and any database work, so the outer `catch {}` (which yields 503) cannot see it. Abort: 400 `{"error":"The request was cancelled."}`, same headers (the client is gone; the status is only for logs and tests).
- A stream error (not timeout) still reaches the outer `catch` and becomes the existing 503.

## `readJson`, `PUT /api/wardrobe`, photos

- `readJson` order is unchanged: 415 content type, 400 empty, then the read. Mapping: timeout 408 "The upload took too long. Please try again.", over `max` 413 "This request is too large.", abort 400 "The request was cancelled.", bad JSON 400 "The request could not be read." Default `max` (3,000,000) is unchanged.
- **Wardrobe order is kept**: `account(req, true)` (origin, session, account binding, **change quota**) runs before the body is read. Quota implication: a PUT whose body then times out, is aborted or is oversized **has already used one slot of the 120-changes-per-minute counter, and it is not refunded**. A request refused by origin, session or account binding costs no quota and never waits on the body. Reordering was not done, because reading the body first would let unauthenticated clients hold a read open before any check. The timeout answers 408 before `saveWardrobe` / `runWriteTransaction` runs, so nothing is written.
- Photos keep `readUploadRequest` (`maxBodyBytes`, `bodyReadTimeoutMs`) and their image-work semaphore; only the reader underneath is shared. Their 413/408/400 semantics and messages are the same, except that an abort is now reported (400) instead of being a hang until the timeout.

## G2 rider (Docker packaging)

- `Dockerfile` runtime stage now copies `scripts/export-deletion-ledger.ts`. `docs/DEPLOYMENT.md` line 122 tells operators to run it with `docker compose exec app ./node_modules/.bin/tsx scripts/export-deletion-ledger.ts`; before this it was absent from the image.
- `tests/deploymentScripts.test.ts` is a **local contract check**: it parses `compose.yaml` and the `docker compose exec|run` lines of `docs/DEPLOYMENT.md` for `scripts/*.ts`, requires each to exist, to be `COPY`'d into the runtime stage, and its relative imports to land in copied folders (`src/server`, `src/domain`, copied scripts). It has a self-test that fails on an unpackaged script, a missing script and an import leaving the image. It does **not** build the image or execute any script in a container. **Docker execution of the export script (and of the whole image) remains unrun.** It checks direct imports only, not transitive ones from `src/server` into other folders.

## Tests written (all unrun)

`tests/boundedBody.test.ts` (reader only, internal budgets of 60-200 ms): normal body, no body, stall, steady trickle not extending the total, ongoing abort with listener removal counted, pre-aborted, over-limit, exactly-at-cap, hanging cancel, rejecting cancel with no unhandled rejection (timeout / over-limit / abort), mid-stream error, `locked === false` and no extra live timers, and that no timeout value can disable the bound.

`tests/bodyDeadline.test.ts` (direct handler calls, `STYLE_BODY_READ_TIMEOUT_MS=1000`, the smallest valid operator value; production default not weakened):
- auth: stall, trickle, hanging cancel, mid-body abort, pre-abort, over-cap 413, all before any database work. The proof is by side effect: the data directory listing is identical before and after (the database file and auth secret are only created by `getReadyAuth()` / `getDatabase()`), and the test is first in its file. It is not a spy on the delegate or on `runWithContention`.
- auth ordinary cases: exactly 32,768 bytes not refused, valid sign-up 200, invalid and malformed 4xx, GET passes.
- wardrobe: no session / wrong origin / wrong account answer 401 / 403 / 409 with a stalled body without waiting and with **zero** quota used; a stalled authenticated PUT gives 408, **one** quota slot used, revision still 0, wardrobe empty; trickle 408; abort 400; oversize 413; valid 200, bad JSON 400, wrong content type 415.
- photos: stalled 408, valid fixture 200, bad image 400.

**This is a direct-handler test, not a network test.** No socket, no HTTP server and no real client disconnect is involved.

## Not run / not verified

Typecheck, lint, every test above, `npm test`, the production build and packaging check, the 21 s original probe, real compiled loopback HTTP slow-body tests, Docker build/run. Specific things root should watch when first running: (a) `NextRequest` with a streamed body and `duplex: "half"` under tsx; (b) the `Request` + `getActiveResourcesInfo` timer comparison could be flaky if other timers start concurrently; (c) the test assumes importing the auth route does not create files in the data directory; (d) timing windows are generous (budget + 2.5 s) but unmeasured; (e) sign-up returning 200 without extra mail environment mirrors `contention007.test.ts` and is unverified here.

Also not measured: what Node's own HTTP server does with no application deadline (section 8 item 5), which root owns.

## Remaining launch blockers (this batch closes none by itself)

From the 011 review's open gates: G1 (write-lock design question), G16 (authenticated requests stall behind sign-ups) and the Part B evidence items G17-G19, disaster-recovery path, real SMTP, physical erasure, worker health, offsite backup, Linux/Docker execution, dense wardrobe recognition, real devices, a target host. G14 is implemented here but unverified until root's tests and the compiled loopback check pass and the fresh independent review accepts it.
