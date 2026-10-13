# Build 012 (corrected) independent release review (Claude, second reviewer, fresh session)

Reviewer: Claude. Date: 12 October 2026.
Subject: corrected build 012, 169 hashed files (`docs/verification/build-012-corrected-source-manifest.json`; I counted 169 entries). Build ID `gfVae_5IhelyzlAuq0Cm_` is root's statement; I did not read `.next/BUILD_ID`.
Scope: G14 (shared body deadline) and the G2 Docker export-script rider. No scheduling, read-path or vision change was in scope.

## 0. Method and limits

- Tools: Read, Glob, Grep, and one Write (this file). **I ran no Bash, shell, PowerShell, test, typecheck, build, browser or network call.** I did not touch `.data`, `.runtime`, `.env`, secrets or `sources/`. I changed no source.
- I read the **working-tree** source. That it equals the sibling `../build-012-corrected` snapshot rests on root's statement; I could not reach that sibling (a glob returned nothing), and I recomputed no hash. I did compare the two manifests by SHA256 string (section 2.1).
- Labels: **[Observed]** read in a file root produced, or seen by grep in source. **[Code-proven]** follows from code I read. **[Inferred]** my reasoning from observed data. **[Hypothesis]** needs a named experiment. **[Not examined]**.
- **Read in full:** `BUILD012_CHECKS.md`, `implementation-012-notes.md`, `build-011-claude.md`, `boundedBody.ts`, `access.ts`, `[...all]/route.ts`, `wardrobe/route.ts`, `photos/route.ts`, `limits.ts`, `imageAdmission.ts`, `admission.ts` (lines 60-90), `Dockerfile`, `deploy/Caddyfile`, `package.json`, `scripts/export-deletion-ledger.ts`, `tests/helpers/bodySource.ts`, `tests/boundedBody.test.ts`, `tests/bodyDeadline.test.ts`, `tests/deploymentScripts.test.ts`, `body-http-probe-012.mjs` and `-initial.json`, `owned-body-http-probe-012.mjs` and `.json`, `body-deadline-boundary-probe-012.json` and `-corrected.json`, `auth-body-deadline-probe-012-corrected.json`, `.dockerignore`, both manifests (by search).
- **Read by search only:** `backend-012-corrected-npm.log` (summary lines), `browser-012-corrected.log` (result lines), `build-012-corrected.log` (a few lines), `compose.yaml` (command lines), `DEPLOYMENT.md` (script lines), `src/server` and `src/domain` import lines.
- **Not read, so no claim:** `body-deadline-boundary-probe-012.mjs`, `auth-body-deadline-probe-011.mjs` (the 20 s probe source), the e2e specs, the client code that handles upload errors, `scripts/start-server.ts`, Next.js internals (how its request adapter builds `req.body`, `req.signal` and cancel), `deletionLedger.ts`, and the Docker image itself (nothing was built).
- "Typecheck passes", "compile/lint pass", "isolated standalone passes" and the Build ID are root's statements. I saw only the `Compiled successfully` and `Linting and checking validity of types ...` lines in the build log, and the sanitiser line (86192 entries, 16 manifests, 1 generated entry).

## 1. Verdicts

**Acceptance of this fix (G14 + G2 rider): ACCEPT, with the P3 follow-ups in section 4.** I found no P0, P1 or P2 *defect introduced by build 012*. The shared reader does what it claims, by reading and by the network evidence root produced. The G2 rider is correct by static reading and unrun in Docker.

**Production / public-launch verdict: NOT APPROVED.** I do not give my approval to launch. This is separate from the fix verdict above. Nothing here changes the open gates in section 8. The user's requirement that both reviewers approve launch is not met by me, and nothing in this build could have met it.

Accepting G14 does **not** mean "slow-body holding is closed". Section 4 (F1, F3) lists what is still unbounded or unobserved.

## 2. What changed, and what did not

### 2.1 Manifest comparison [Observed, SHA256 strings, 011-corrected vs 012-corrected]

- **Identical hash:** `limits.ts`, `imageAdmission.ts`, `admission.ts`, `writeTransaction.ts`, `writeGate.ts`, `authDialect.ts`, `contention.ts`, `package.json`, `compose.yaml`, `deploy/Caddyfile`, `docs/DEPLOYMENT.md`, `photos/route.ts`, `photos/[id]/route.ts`.
- **Changed hash:** `access.ts`, `Dockerfile`, `[...all]/route.ts`, `wardrobe/route.ts` (comment only, per notes).
- 162 + 5 new code/test files (`boundedBody.ts`, `bodySource.ts`, `boundedBody.test.ts`, `bodyDeadline.test.ts`, `deploymentScripts.test.ts`) + 2 net document changes = 169. That arithmetic is consistent with the manifest count; I did not enumerate every path.
- So: no timeout, workload, scheduling, queue, gate, `npm test` or package change. `limits.ts` still gives `STYLE_BODY_READ_TIMEOUT_MS` a 20 s default and a 1 s..120 s valid range. This matches the scope root set.

### 2.2 Test counts [Observed]

- `backend-012-corrected-npm.log`: `tests 163, pass 159, fail 0, cancelled 0, skipped 4`. 140 (build 011) + 23 new = 163. I counted 17 tests in `boundedBody.test.ts`, 3 in `bodyDeadline.test.ts` and 3 in `deploymentScripts.test.ts`, which is 23. Consistent.
- `browser-012-corrected.log`: `1 skipped`, `33 passed (1.9m)`. I did not read the specs or the log body.

## 3. Audit of `boundedBody.ts` [Code-proven unless marked]

**Cleanup.** The timer is cleared and the abort listener removed in `finally`; `releaseLock()` is in a `try`. `getReader()` runs before the timer and listener exist, so a locked or disturbed body throws without leaking anything. A thrown error from `reader.read()` goes to `catch`, which abandons (unless already finished) and rethrows. Good.

**Pending reads and cancel rejections.** Every `reader.read()` has `.catch(() => {})` attached before the race, so a read that is abandoned cannot surface as an unhandled rejection. `abandon()` converts a cancel rejection to success and races a 250 ms grace timer that is cleared in `finally`. A cancel callback that never settles delays the answer by at most the grace and cannot leak the timer. On a standard `ReadableStream`, `cancel()` resolves outstanding read requests as done before the source callback settles, and `releaseLock()` after that is safe; the `try/catch` covers older behaviour. Tests with hang and reject sources plus an `unhandledRejection` listener cover this (direct-helper, not network).

**Abort / timeout precedence.** `stop()` records only the first reason. A pre-aborted signal is recorded before the first read. A clock-detected expiry goes through the same `stop("timeout")`, so an earlier abort stays `aborted`. One benign residual: if the client aborts while the thread is blocked and the abort event has not been dispatched yet, the clock check reports `timeout`. The status goes to a client that is gone; it affects logs only.

**Late EOF / late data.** `stoppedReason()` is evaluated before each read, after each read result (before a chunk, a zero-byte chunk or EOF is accepted), and once more before `ok`. This is the fix for the initial failure. I agree with the notes that the remaining gap is time spent after the final check, which no helper can bound.
- Evidence: the original probe JSON shows `acceptedAfterDeadline: true` at 124.69 ms for a 50 ms budget; the corrected JSON shows `status: timeout`, `acceptedAfterDeadline: false`, 127.93 ms [Observed]. Both are preserved and both are `networkTest: false` direct-helper results. As root says, the 120 ms thread block means this proves rejection *after resumption*, not on-time service.

**Bounds.** Byte cap is checked per chunk after adding (the buffer can exceed the cap by one chunk before refusal; harmless). `effectiveBodyTimeoutMs` ignores zero, negative and non-finite values; the only configurable path is the operator variable, clamped to 1 s..120 s by `int()` in `limits.ts`. I found no request-controlled way to disable the deadline. `readJson` no longer treats `timeoutMs: 0` as "none".

**Fixed statuses and headers.**
- Auth route [Code-proven]: 413 / 408 / 400 are `return`ed from `withSafety` before `runWithContention`, `getReadyAuth()` or any database call, and are not inside the path the outer `catch` can rewrite to 503 (the `return` is inside the `try` but exits it normally). Headers: `Content-Type: application/json`, `Cache-Control: private, no-store`. `X-Content-Type-Options` is not set on these three answers; the other auth responses do not set it either (pre-existing). No delegation to Better Auth on timeout.
- `readJson`: 408 / 413 / 400 are `RequestError`s, rendered by `errorResponse` with `privateHeaders`. TypeScript narrowing is now truthful (union with one member per status; `read.bytes` is reached only after all four refusal checks). The `empty` check after the read is unreachable but harmless.

**Quota before the body read.** Order is `account(req, true)` then `readJson`. `account()` runs origin, session, account-binding and the change-quota `runWriteTransaction` before any body wait [Code-proven; `bodyDeadline.test.ts` asserts quota 0 for 401/403/409 and exactly 1 after a timed-out PUT]. A request refused by origin, session or account binding costs no quota and never waits on the body; a timed-out, aborted or oversized authenticated PUT keeps its consumed slot. I agree with keeping the order (reading first would let unauthenticated clients hold reads open). The cost is F4.

**Request reconstruction / content type.** `new Request(request, { body: <utf8 string> })` is unchanged from build 011. Headers (including the original `content-length`) are copied. For a body that is not valid UTF-8, the string round trip changes the byte length against the copied header [Hypothesis; pre-existing; Better Auth reads the body through `request.json()`]. Content type is still not inspected by the wrapper. Direct-handler sign-up (200), invalid (4xx), malformed (4xx), exactly-32,768-byte (not 413) and GET session passes are tested, and root reports 33 browser checks passing against the compiled build, which exercise real sign-up and sign-in through the wrapper [root's statement; I read only the result line].

## 4. Findings

IDs continue from G20 in the build 011 review. Priority is for the product as a public service; none is a regression from 011.

| ID | Pri | Finding | Where | Label |
|---|---|---|---|---|
| G21 (F3) | P2, public-launch gate (pre-existing; made explicit, not caused by 012) | **A slow authenticated upload holds a shared image-work slot for up to the full 20 s.** `POST /api/photos` calls `withImageWork`, and `readUploadRequest` (the body read) runs *inside* it. Default `STYLE_IMAGE_CONCURRENCY` is 2 and the queue is 6 with a 15 s wait. Two stalled or trickling uploads from one signed-in account therefore occupy both slots until the deadline, and other users' uploads get the busy refusal. The 120-changes-per-minute quota does not stop it: two connections re-issued every 20 s is about 6 quota slots a minute. Build 012 bounds the hold (it was already 20 s on this path), it does not remove it. The network probe's `photo-stall` 408 at 1286.70 ms with a 1000 ms budget is consistent with the slot being held for the whole budget. The same applies to `/api/analyze`, which wraps `readUploadRequest` in `withImageWork` as well (by grep; I did not read that route). | `photos/route.ts:65-66`; `admission.ts:82-89`; `imageAdmission.ts:102-108` | Code-proven; impact Inferred, not tested |
| G22 (F1) | P3 | **What the server does with the connection after a 408 is not observed.** (a) Stall 408s took 1288.33, 1286.70 and 1320.47 ms against a 1000 ms budget; trickle 408s took 1105.61 and 1009.87 ms. The extra ~290-320 ms in the stall cases against ~10-105 ms in the trickle cases is consistent with `reader.cancel()` on the real compiled request body *not settling* and the 250 ms grace expiring [Inferred; no timing inside the helper was recorded]. If so, the underlying request source is not torn down by the cancel. (b) Both probes send `connection: close` and the client destroys the request right after the reply, so what a keep-alive client that keeps sending would see, whether the socket is dropped or drained, and how long the server holds it, is unobserved. Node's own `requestTimeout` is probably the backstop [Hypothesis; `start-server.ts` not read]. The pre-auth 20 s intent is met for the *response*; the *connection lifetime* is not shown. | `boundedBody.ts:52-69`; `body-http-probe-012.mjs:12-13`; `owned-body-http-probe-012.mjs:22` | Inferred / Hypothesis |
| G23 (F2) | P3 (evidence) | **The "client disconnect" results are the client's own destroy, not a server observation.** `auth-abort`, `photo-abort`: `networkError: ECONNRESET` at ~201-202 ms is the probe's `req.destroy()` surfacing in its own client. Nothing records that the compiled server's `req.signal` fired, that `readBoundedBody` returned `aborted`, that the stream was cancelled, or that a photo image slot was released early. `health 200` afterwards proves only that the strict-rejection server stayed up. The real-signal path (`request.signal` under the compiled Next adapter) is shown only with a synthetic `AbortController` in direct-handler tests. If the signal never fires in production, behaviour falls back to the 20 s deadline, so this is bounded either way. The notes' claim "an abort is now reported (400) instead of being a hang until the timeout" is therefore true of the helper, **not shown for a real disconnect**. | `body-http-probe-012.mjs:21,28`; `owned-body-http-probe-012.mjs:36,41` | Observed (what the probe records) / Inferred |
| G24 (F4) | P3 | **`PUT /api/wardrobe` gained a 20 s total body deadline it did not have.** For slow uplinks this is a user-visible behaviour change: the 3,000,000-byte ceiling needs about 1.2 Mbit/s sustained to finish in 20 s. Real wardrobe JSON size and client behaviour on a 408 (retry, message) are **not examined**: grep finds no client code mapping 408 specially (it may show the server's message). Each timed-out PUT also burns one change-quota slot. Probably acceptable; worth one line in `DEPLOYMENT.md` and one check of the client error path. | `wardrobe/route.ts:30-31`; `access.ts:89-117` | Code-proven; impact Hypothesis |
| G25 | P3 | **Many tiny chunks cost memory out of proportion to the cap.** `chunks` keeps every `Uint8Array` until the end, and each loop iteration adds a reaction to the single `interrupted` promise through `Promise.race`, so the reaction list on that promise grows with the chunk count for the life of the read. With a 32 KiB auth cap this is bounded by 32,768 chunks; with a 3 MB wardrobe cap and one-byte chunks it is bounded only by the 20 s deadline and the sender's packet rate. Magnitude unmeasured. A one-line mitigation is a per-read race against a fresh promise or counting chunks, but that is a judgment for root after measurement, not a defect I can show. | `boundedBody.ts:91-93,114,129,145` | Code-proven mechanism; magnitude Hypothesis |
| G26 | P4 | **Test gaps, none changes my verdict.** (a) The clock check *before* a read (`before` branch, `boundedBody.ts:119-124`) is not exercised: every delayed-continuation test blocks before the first result. A test that delivers one in-budget chunk, blocks past the deadline, then lets the loop iterate would cover it. (b) The wardrobe trickle test asserts only an upper bound (`< WITHIN_MS`), so it would also pass if the 408 arrived early. (c) The "no database work ran" proof for auth is a directory-listing comparison: it shows `getReadyAuth()` / `getDatabase()` did not run, not that `runWithContention` did not (it creates nothing). Code order proves the latter. (d) `readBoundedBody` is only unit-tested with `Date.now()` bounds of 1.5 s; no flakiness seen in the one logged run. | `boundedBody.test.ts`; `bodyDeadline.test.ts:75,249` | Code-proven |
| G27 | P4 | **`deploymentScripts.test.ts` is narrower than its comment.** It matches `from "<relative>"` only, so a side-effect `import "../x"` or a dynamic `import()` is not seen; it filters `DEPLOYMENT.md` to lines containing `docker compose (exec\|run)` (misses `docker-compose` and backslash continuations); and it checks direct imports only. For *this* script the transitive closure is fine by my grep: `src/server` imports only `./` files and `../domain` (two files), `src/domain` has no import leaving itself, and every runtime package the script reaches (`better-auth`, `kysely`, `tsx`, `sharp`, `nodemailer`, `proper-lockfile`) is in `dependencies` [Observed]. `.dockerignore` does not exclude `scripts/`. | `deploymentScripts.test.ts:23,64-69,81` | Observed (grep) |

### 4.1 Evidence audit of the network probes

- **What they establish [Observed].** Against the compiled loopback server with the 1000 ms operator budget and strict unhandled rejections: auth stall 408 at 1320.47 ms, trickle 408 at 1009.87 ms, oversize 413 at 9.18 ms, health 200; authenticated wardrobe stall 408 at 1288.33 ms, trickle 408 at 1105.61 ms, photo stall 408 at 1286.70 ms; every 408 had `private, no-store` and the fixed JSON body; afterwards the synthetic account's wardrobe revision was 0, its photo asset count 0, and health 200. The trickle result (≈ budget, not later) shows progress does not extend the deadline on a real socket.
- **Default 20 s vs 1 s.** `auth-body-deadline-probe-012-corrected.json` shows the *default* budget only as a direct-handler result: settled at 20038.95 ms, 408, body cancelled by observation, `deploymentDeadlineTest: false`, `syntheticOnly: true`. The 20 s default has **not** been exercised over a network; the 1 s network results exercise the same code with a different input. I accept the mapping (the code path has no budget-dependent branch) but it is an inference.
- **Not covered [Observed from the probes' own flags / Caddyfile].** No Caddy hop (`deployedProxyTest: false`); the Caddyfile sets `request_body max_size 10MB` and no body-read timeout, so by reading the app's deadline is the only body bound behind the proxy [Inferred; Caddy's own server defaults and HTTP/2 behaviour not examined]. No internet path, no TLS, no HTTP/2, no keep-alive reuse, no chunked request without `content-length` (the probes always declare 1000 or 33000), no concurrent slow connections, no run at the 20 s default.
- **Synthetic verification bypass.** `owned-body-http-probe-012.mjs:19` sets `emailVerified=1` directly in the fixture database for a disposable `@example.test` account and says so in its output (`fixtureVerificationBypass: true`). The probe also writes into the same `.data/release-012-browser` fixture the live compiled server was using, from a second process. I consider this acceptable and honestly labelled; it is not evidence about real mail delivery. The normal verification interaction is covered by the browser run (33 passed) and by `bodyDeadline.test.ts` (captured mail), not by real SMTP.
- The probes refuse to overwrite existing evidence (`fs.existsSync(out)` throws), and the initial failing boundary JSON is preserved next to the corrected one. I saw no erased evidence.

## 5. G2 rider: Docker operator-contract check

- `Dockerfile:28` now copies `scripts/export-deletion-ledger.ts`; `DEPLOYMENT.md:122` runs `docker compose exec app ./node_modules/.bin/tsx scripts/export-deletion-ledger.ts`. `compose exec` runs as the image `USER style` with the container's environment, so `getReadyAuth()` sees the same configuration as the app [Inferred from Docker semantics; not run].
- Static closure: the script imports `../src/server/auth`, `database`, `deletionLedger`; `src/server` and `src/domain` are copied whole; `tsconfig.json` and `node_modules` (production dependencies, `tsx` included) are copied (section 4, G27).
- **Unrun [Observed absence of evidence]:** no image was built, no container started, no script executed in a container. The test is a text contract check, and the notes say so honestly. What remains unproven: that the image builds and starts as `style`, that `tsx` resolves `tsconfig.json` and the relative imports at runtime in `/app`, that `exec` against a running app container works with the volume's permissions (`chmod 700 /data`, uid 1001), that the script's `getReadyAuth()` has all required environment in `exec` (it needs the same variables as the app), that it behaves while the app and workers hold the database, and that the ledger lands where the cron/off-server copy expects. Carried G9 (`docker compose run` without `--no-deps`, uid note) is unchanged.
- I accept the packaging fix as correct on reading. It is not a Docker verification.

## 6. Hold-window and lock evidence

Not in scope and not touched. Per instruction I do **not** infer lock occupancy from the SQL-wrapper bracket durations. The hold-time series is still unreconcilable (G17 in the build 011 review: summed holds exceeded wall time), so no capacity, fairness or starvation conclusion can be drawn from it. The concern from my previous review that the hold windows may include time after the lock is released is **unresolved** by build 012, and nothing in this build was intended to resolve it. G1, G16, G17, G18 remain open exactly as written.

## 7. Consumer-goal status (unchanged by 012)

- Whole-wardrobe photo upload and recognition: the UI flows are tested against *controlled* analysis responses (root: 33 pass, 1 skipped duplicate mobile sign-up, desktop Chrome and a mobile-size viewport, no phone, no recognition accuracy). **Dense real-closet recognition remains unproven or failed.** Root states that whole-wardrobe DINO tiles and letterbox were unhelpful and that the research runtime SDK now works but nothing changed in the app's AI. I did not read the detector research files and make no accuracy claim.
- Owned-item outfits, minimal typing, and free local AI: no new evidence in 012.
- Multi-user accounts: sign-up, verification, sign-in and the new body bounds work against captured mail and a loopback server. Real mail delivery, HTTPS behind Caddy, and a load run on a target host are missing.

## 8. Carried gates (nothing in 012 touched them)

All files below are hash-identical across 011 and 012 where listed in section 2.1; others are untouched by the notes.

- **G1** cross-process write starvation (P1 gate); **G16** authenticated requests queue behind sign-ups; **G17/G18** evidence validity.
- **G3** ledger staleness invisible; **G4** one-step backup ceiling, no free-space precheck; **G5** read paths take the write lock; **G8** auth route's "busy, nothing written" rewrite; **G9, G10, G11, G12, G13**; **G15** validate-before-lock; **G19, G20**.
- Mail worker health (a healthy heartbeat while every tick can fail), SMTP TLS/STARTTLS/AUTH with a real provider, SMTP secret scope (the URL and `AUTH_SECRET` reach four containers), physical erasure (`secure_delete`, checkpoint, vacuum, marker test), encrypted offsite backup and recovery drill, Linux/Docker execution (ext4, two containers on one volume, POSIX permissions, directory flush), dense wardrobe recognition on a held-out set, real consumer phones, and a target host with a domain, HTTPS and a real inference job.
- New from this review: **G21** (image slot held by slow uploads) for the public-launch list; G22-G27 as follow-ups.

## 9. What was and was not verified, in one place

| Claim | Status |
|---|---|
| Typecheck passes; 23 targeted tests pass | root's statement; I saw the logged totals of the full run only |
| `npm test`: 163 total, 159 pass, 4 skipped, 0 fail | **Observed** in `backend-012-corrected-npm.log` (summary lines) |
| Compile / lint / types / sanitiser | root's statement; I saw "Compiled successfully", the lint/type heading and the sanitiser line |
| 33 browser checks pass, 1 skipped | **Observed** result lines in `browser-012-corrected.log` |
| Real compiled loopback 408/413/disconnect/health (auth, wardrobe, photo) at 1000 ms budget | **Observed** in the two evidence JSONs; probe source read |
| Default 20 s over a network | **Not tested**; direct-handler only (20038.95 ms) |
| Caddy or internet path | **Not tested** |
| Server-side behaviour on a real client disconnect | **Not observed** (G23) |
| Connection state after 408 | **Not observed** (G22) |
| Docker image builds and runs the export script | **Not tested** |
| Source equals the hashed snapshot | root's statement; manifests compared by me, hashes not recomputed |

## 10. Next concrete implementation batch (Claude, Read/Glob/Grep/Edit/Write only, nothing run)

Constraints for Claude: no change to any timeout, workload, queue cap, `npm test`, scheduling, or AI behaviour; no public switch that disables a bound; no secrets or user ids in logs; state what was not run. Root runs everything. Ordered by value toward the goal (a public, self-service app where a user photographs a closet or an item, gets owned items with minimal typing, and gets outfit suggestions).

**Batch 013-A: finish the lock evidence, no behaviour change (the 011 review's Part B).** This is the blocker for every later reliability decision and for answering the hold-window question.
1. Epoch-aligned per-process lock timeline (wall-clock begin and end of every acquire and hold, bounded), merged in the test parent: lock occupancy share, the longest idle gap while a caller was waiting, and any two overlapping holds as a *named problem*.
2. Time the Kysely connection mutex wait on the auth driver and the whole `account()` call in the wardrobe chain, so G16 is measured.
3. Late-start flag per child, run facts (Node, OS, CPU count, wall start/end) and self-measuring CPU burners in `summary.json`. Do not change the 8 s offset or the workload.
4. G19: one clock in the auth BUSY error, no `commit` hold without a COMMIT, a test that forces the `runWriteTransaction` safety net.

**Batch 013-B: small body-path follow-ups from this review (also no timing change).**
1. G21: bound per-account concurrent upload reads (for example one in-flight photo/analyze body read per signed-in account, refusing the second with a retryable 429 before it takes an image slot). This is a concurrency rule, not a timeout. Alternatively read the body before taking the slot; that needs a memory-per-connection decision first, so I would not choose it blind.
2. G22/G23 instrumentation without PII: a bounded in-process counter of body outcomes by route and status (`ok`, `timeout`, `aborted`, `too_large`) and the cancel-settled-or-grace-expired flag, exposed the way existing health/diagnostic counters are. Then a root probe can *observe* the server side of a real disconnect and a stalled-cancel, and also run once with a keep-alive client and no `content-length`.
3. G26 tests: the `before` clock path; a lower bound in the wardrobe trickle test; strengthen the deploy check to cover side-effect/dynamic imports and `docker-compose`.
4. G24: one line in `DEPLOYMENT.md` on the 20 s body deadline and the 3 MB wardrobe ceiling, and a check of how the client shows a 408.

**Batch 014 (behaviour-changing, reviewed separately): demand reduction** as in the 011 review Part C: read-first wardrobe GET and job GET (G5), validate-before-lock for `saveWardrobe` (G15), then rerun the same matrix and compare with the 011-corrected numbers. Only then consider any polling or scheduling change.

**Batch 015 (the product goal itself): a recognition evaluation harness, no app change.** The app cannot be called a whole-wardrobe tool until dense closet photos produce usable items, and every attempt so far (tiles, letterbox) has been judged by eye on a handful of images. Write, for root to run: a held-out set definition (photos, hand-labelled item boxes and categories, with a train/test split fixed in advance), a scorer (precision/recall at an IoU threshold, category accuracy, count error, and "fields the user would still have to type"), and a runner that takes any detector/crop strategy and writes a comparable JSON. Then candidate strategies (overlapping tiles with box merging; segment-then-classify; per-item crops from a first-pass detector) can be compared on the same set and the decision gate for "ship or redesign the whole-wardrobe flow" becomes a number. The research SDK that now works can be the first runner. This does not improve recognition by itself; it makes the next improvement measurable.

**Root, host or later (not Claude's batch):** Docker build and a real run of the export script; Caddy and internet slow-body test at the default 20 s, with keep-alive and chunked bodies; mail health; real SMTP; secret scope; physical erasure; offsite encrypted backup and recovery drill; Linux/POSIX tests; target-host load with real inference; real phones.

## 11. Acceptance, restated

- **Accepted:** `boundedBody.ts`, its use in the auth wrapper, `readJson` and (through `readJson`) the photo and wardrobe routes; the truthful `BoundedBody` union; the monotonic late-data/EOF check; the fixed-status private-header auth answers; the quota ordering as documented; the `Dockerfile` copy of the export script as a packaging fix; the corrected evidence set, with its limits stated in section 9.
- **Not accepted:** any claim that slow-body holding is fully closed (G21), that real client disconnects are proven server-side (G23), that connection teardown after a 408 is known (G22), that the 20 s default has been exercised over a network, that the export script runs in Docker, or that the Caddy path is covered.
- **Not approved for production or public launch.** My vote on launch is no.
- I ran nothing; every number above came from a file root produced or from arithmetic on those files.
