# Build 008 implementation notes (Claude)

Scope of this batch (bounded, as instructed): durable account mail, truthful privacy wording, packaging boundary hardening with tests. **Not in this batch** and still required before any launch: dense whole-wardrobe recognition, physical erasure (secure-delete / WAL truncation / marker tests), fresh-server restore with an exported deletion ledger, encrypted/off-server backups, a real SMTP relay, a Docker run, target-host capacity, consumer acceptance. **This build is not production ready.**

Method: Read/Glob/Grep/Edit/Write only. I ran **nothing** (no shell, build, server, browser, network). Every statement below about behaviour is from reading code, including the installed `better-auth` 1.7.7 and `@better-auth/core` 1.7.7 sources (read, never edited). Items I could not verify by reading are listed in section 7. `build006` / `build007` snapshots were not touched.

## 0. Correction to my build 007 review

The suspected SMTP-failure process crash was wrong. Root's closed-port probe (`docs/verification/SMTP_OUTAGE_PROBE.md`) did not reproduce it, and Better Auth 1.7.7 `context/create-context.mjs` 215–224 passes `promise.catch(logger.error)` to the handler. `docs/reviews/build-007-claude.md` §4.3 now says so. The durability defect (a failed or interrupted send is lost) stands, and is what this batch fixes.

## 1. Mail architecture

```
 request (sign-up / sign-in / reset)                mail worker (own process, supervised)
 ───────────────────────────────────                ─────────────────────────────────────
 Better Auth callback ──INSERT──▶ mail_outbox ◀──claim (lease)── processNextMail()
   (fast local write, no SMTP)        │                              │  SMTP outside any transaction
                                      │                              ▼
                                      └──────── outcome ◀── sent / retry(backoff) / failed / expired
```

* `src/server/mailOutbox.ts` — enqueue, claim, finish, sweep, heartbeat, counts, dev capture drain.
* `src/server/mail.ts` — templates, recipient/header checks, `deliverMessage` (SMTP via nodemailer, or private file capture in development), `classifyMailError`. **No request handler calls `deliverMessage`.**
* `scripts/mail-worker.ts` — the loop (`--check` health, `--status` counts only). Compose service `mailer` (restart policy, heartbeat health check, 512 MB). Separate from `analysis-worker`, so a slow model never delays mail and SMTP never waits behind inference; and from the web process, so SMTP I/O never runs in a request.
* `src/server/auth.ts` — the detached `advanced.backgroundTasks` handler is **removed**. Better Auth then *awaits* the callbacks (and logs, never rethrows, their failures). The callbacks only enqueue.
* `mail_outbox` / `mail_worker_state` — migration `008-mail-outbox` in `database.ts`.

### Enqueue paths (the transaction question)

* **Sign-up.** Better Auth runs the whole handler in `runWithTransaction` on the dedicated auth connection (`getAuthDatabase()`), holding the write gate and `BEGIN IMMEDIATE` for the duration. The callback runs inside that async context. `enqueueMail` asks Better Auth's own `AsyncLocalStorage` (`getCurrentDBAdapterAsyncLocalStorage()`, exported by `@better-auth/core/context`) whether **this call chain** is inside an active transaction (`isTransactionActive`) **and** `getAuthDatabase().isTransaction` is true; only then it inserts on the auth connection, taking no gate (no nested gate). `isTransaction` alone is deliberately not trusted: it would be true for any other request's open transaction on the shared handle. That cannot be confused here because the auth connection is held exclusively by the transaction's owner (Kysely connection mutex) and the flag is per async context.
* **Password reset and verification resend.** Not transactional in Better Auth (the reset token is an ordinary committed write, then the callback). Enqueue uses `runWriteTransaction` (gate + async `BEGIN IMMEDIATE`, body never replayed). Order is token first, mail second: a crash between them leaves an unused token (harmless); a mail row without its token cannot exist.
* If the ALS probe fails (library change), `enqueueMail` falls back to the gated path. Inside a sign-up transaction that would wait on the gate this very request holds, hit the 10 s budget and be logged and dropped — a bounded failure, not a hang or a corruption (section 7, A1).

### Atomicity guarantees and the tests that prove them

| Claim | Proof |
|---|---|
| The mail row joins the surrounding Better Auth transaction (commits or rolls back with it) | `mailOutbox.test.ts` "commits or rolls back with the surrounding Better Auth transaction": `runWithTransaction(authAdapter, …)` enqueues, asserts the row is **invisible to the other connection before commit**, throws, asserts no row; repeats with commit, asserts exactly one row. **Scope of this proof:** it shows the mail insert joins an enclosing transaction. It does not by itself prove that the real sign-up handler's user row and credential row are in that same transaction; that rests on reading `sign-up.mjs` (`runWithTransaction` wraps `createUser`, `linkAccount` and the callback) and has not been exercised end to end by a test that fails the real sign-up after the callback. |
| Process death before COMMIT leaves no mail; after COMMIT leaves exactly one | same file, `tests/helpers/mailCrashChild.ts`: a real child process opens a transaction on the auth connection, inserts via the production function, `process.exit(9)` without ROLLBACK (abort) or after COMMIT (commit). Parent checks row counts, DB integrity and that the lock is gone. |
| A request never touches SMTP | "sign-up request only enqueues": relay in `hang` mode; asserts **zero connections** during and 250 ms after the request. Static guard: `auth.ts` has no `backgroundTasks: {`, no nodemailer; `mailOutbox.ts` does not import the AI queue or vision. |
| Delivered link works; token security unchanged | same test: the token is read from what the fake relay actually received, `verifyEmail` accepts it, unverified sign-in is refused before it. Verification links are stateless signed tokens; reset tokens stay in Better Auth's `verification` table, consumed by Better Auth exactly as before. The outbox stores only the rendered message. |

**Not claimed — sign-up can complete without any mail.** Two ways, both leave a created, unverified account:
1. the enqueue throws inside sign-up (Better Auth catches and logs it in both of its branches; the sign-up is not rolled back);
2. the enqueue is **silently dropped** by a bound (per-address, per-day, queue full, per-hour, or an invalid/oversized message): `insertMailLocked` returns `dropped`, nothing throws, sign-up succeeds, and the response is identical by design.

So "user and mail commit together" means *if a mail row is written it commits with the user*, not *every sign-up produces a mail*. Recovery is by signing in (an unverified sign-in enqueues a new link) once the bound allows; during a service-wide cap that can take up to an hour, and there is no operator alert on drops beyond a log line (`Account mail not queued (<reason>)`). The sign-up screen tells the user mail can take minutes and is limited. Stated in `mailOutbox.ts` and the README.

### Delivery semantics

**At-least-once. Not exactly-once.** A worker that dies after SMTP accepted the message but before the outcome is recorded sends it again after its lease lapses. Mitigation only: the outbox id is the SMTP `Message-ID` (`<id@sender-domain>`), identical on every attempt. Test "worker that dies after claiming…": simulates both (a) death after claim → redelivery after lease, and (b) accepted-then-unrecorded → **two copies received, same Message-ID**.

### Exact bounds (all env-overridable, defaults in `limits.ts` `mailLimits()`, out-of-range values ignored)

| Bound | Default | Variable |
|---|---|---|
| Delivery window; then `expired`, body cleared | 45 min (links live 60 min) | `STYLE_MAIL_WINDOW_MS` (1 s–55 min) |
| Attempts per message | 5 | `STYLE_MAIL_MAX_ATTEMPTS` (1–10) |
| Backoff before attempt n+1 | min(cap, 30 s · 4^(n−1)) +≤10 % jitter → 30 s, 2 min, 8 min, 20 min | `STYLE_MAIL_BACKOFF_MS`, `STYLE_MAIL_BACKOFF_CAP_MS` |
| Whole-send deadline: at expiry the attempt's own connection is **destroyed** (see 3b); nodemailer's phase timeouts 10/10/20/10 s apply inside it | 45 s | `STYLE_MAIL_SEND_TIMEOUT_MS` |
| Claim lease | send timeout + 60 s | derived |
| Per address **and kind**, trailing hour | 4 | `STYLE_MAIL_PER_RECIPIENT_HOUR` |
| Per address, all kinds, trailing 24 h | 12 | `STYLE_MAIL_PER_RECIPIENT_DAY` |
| Waiting + sending, whole service | 1000 | `STYLE_MAIL_MAX_PENDING` |
| Accepted per trailing hour, whole service | 600 | `STYLE_MAIL_MAX_PER_HOUR` |
| Body size | 8 KiB each | fixed |
| Terminal metadata kept | 24 h (no address, no body) | fixed |

Over-limit requests are **dropped silently** (reason code logged, no address) so responses stay generic and do not reveal whether an address has an account. A newer link of the same kind **supersedes** older unsent ones (`cancelled`, body cleared). Recipient counting uses `sha256(lowercased address)` so history can be kept after the address itself is cleared. Permanent SMTP refusals (5xx / EENVELOPE) fail at once; 4xx and connection errors retry. Rows past their window, or `sending` with a lapsed lease and no attempts left, are expired/failed by the sweep. The UI copy states "a few minutes", the spam folder, and "at most 4 an hour" (`AuthScreen.tsx`); change both together if the default changes.

### What is cleared, when

Address, subject and both bodies are `NULL`ed on: delivery, expiry, failure, cancellation (supersession), and — by `ON DELETE CASCADE` on `user(id)` — **account deletion** (the whole row goes). A message in flight when its account is deleted records nothing (`finishMailLocked` is guarded by status + exact lease). Tests: "deleting an account deletes its queued mail…", "messages expire…", "temporary failures… nothing leaks into logs", "each recipient's message carries only that recipient's link" (two tenants, fake relay, per-message body inspection; nothing readable remains afterwards).

### Logs and health

Logged: `Account mail attempt N failed (<fixed code>) for message <uuid>.` and `Account mail not queued (<reason>).` Never: addresses, subjects, bodies, links, tokens, error text. `classifyMailError` allow-lists the code. A test captures `console.error/warn` during failing sends and asserts no `@example.test`, no `token=`, no `http(s)://`, no marker text. Public `/api/health` is unchanged (`{ready:true}`, asserted). Queue counts are available only to the operator: `mail-worker.ts --status`.

### Local development capture (preserved, now eventual)

With no `SMTP_URL` and not public, the **web process** drains its own outbox into `.data/mail-outbox` ~15 ms after each enqueue (`kickLocalCapture`), and the mail worker does too if running. Capture is therefore **eventual**. All fixtures that read the folder synchronously now poll via `tests/helpers/mailCapture.ts` (`accounts.test.ts`, `concurrency.test.ts`, `contention007.test.ts`, `tests/e2e/accounts.ts`, `tests/e2e/auth.spec.ts`, `scripts/verification-account.ts`). With `SMTP_URL` set, nothing in the web process ever speaks SMTP. A public deployment never captures (`usesLocalCapture()` is false; `deliverMessage` refuses without SMTP; tested).

### Backup / restore

Backup now also deletes `mail_outbox`, `verification` (reset tokens) and `session` from the **copy** before `VACUUM`, and drops `mail_worker_state`. Restore deletes `mail_outbox` (if present) in addition to jobs, sessions and tokens, so **no stale message is ever replayed after recovery**. `backup.test.ts` inserts a queued message with a canary link: asserts it is absent from the backup tables **and from the backup file's bytes**, and absent after restore.

### Migration `008-mail-outbox`

Additive only: two `CREATE TABLE IF NOT EXISTS`, three indexes, one `schema_migrations` row; nothing existing is altered. The read-only fast path now also requires the 008 record and both tables, otherwise the locked, idempotent migration runs (same lock discipline as 007). `tests/migration008.test.ts`: builds a populated DB (users, wardrobe revision, photo, queued AI job, a **real reset token** in `verification`), rewinds to the 007 shape (drops the tables and the record), runs the real initializer in 3 concurrent processes then once more, and asserts: tables and record exactly once, every prior row byte-identical, token count unchanged, CHECK constraints enforced, cascade works, `integrity_check` ok. `migration007.test.ts` is unchanged and should still pass (it only drops 007 objects).

New dependency declaration: `@better-auth/core` `1.7.7` added to `package.json` **and** the lockfile root entry (it was already installed as a transitive dependency; the code now imports it directly). I could not run `npm ci`; Codex should confirm the lockfile is accepted.

## 2. Copy changes (truthful, current behaviour only)

* `AccountDialog.tsx`: replaces "permanently removes" with: immediate removal from the live service (incl. queued emails), **not a secure wipe**, can remain in unused database space until overwritten, and in backups made before deletion for up to 7 days by default; "backups are not encrypted by the app itself"; "pseudonymous deletion record (an internal ID and date, not your name or email)".
* `UploadDialog.tsx` note: removed from the live database on save/discard/cancel/expiry; not a secure wipe; backups never include temporary photos (true: the backup command deletes `analysis_jobs`, tested).
* `README.md`, `docs/DEPLOYMENT.md`: retention paragraph rewritten ("logical delete", WAL/free pages, backups **not encrypted**, same disk, 7-day local retention, "pseudonymous", fresh-server restore **not supported yet**); mail section with the bounds table, at-least-once, operator commands, "real SMTP relay behaviour untested".
* Nothing claims encryption, OS-level erasure, or "anonymous".

## 3. Packaging boundary hardening

Files: `scripts/packaging-rules.ts` (rewritten), `scripts/packaging-sanitize.ts` (new: all logic, testable), `scripts/sanitize-build-output.ts` (thin CLI), `scripts/verify-standalone.ts` (new), `tests/packaging.test.ts` (new), CI.

**What was wrong:** `assertInside` was lexical only, `.next` itself was never `lstat`ed, manifests were rewritten with `writeFileSync` (follows a symlink), and `rel.startsWith("..")` mis-flagged names such as `..data`.

**Now:**
1. `resolveOutputRoots(root)`: `realpath(root)`, then `.next` and `.next/standalone` must be real directories (`lstat` not a link) whose `realpath` equals the path built from the real project root. A symlink/junction at either, or any link between them and the project, throws `PackagingBoundaryError` **before any change**.
2. Every manifest: must be a regular file inside `.next` (`manifestProblem`); a symlink or junction named `*.nft.json` is refused (never written through); unreadable, non-JSON, `files` not an array of strings → throw. All manifests are **validated first** (plan phase); writes happen only if every one is valid, so a bad file cannot leave the output half-sanitized. Rewrites are temp file + `rename` in the same folder.
3. Deletions: `assertSafeToTouch(boundary, target)` requires the target strictly inside `.next/standalone` lexically **and** `realpath(dirname(target)) + basename === target`, so a link anywhere in the chain aborts. The target itself is judged by `lstat`: link → `removeLink` (unlink, falling back to `rmdir`, which removes only a Windows junction), directory → own `removeTree` (entry by entry; a link, or a directory whose `realpath` differs from its path, is removed *as a link* and never entered), file → unlink (chmod retry on EPERM). `fs.rmSync(recursive)` is no longer used on generated output.
4. Traversals (`manifests`, `entries`) use `lstat`, not the `Dirent` flag, so Windows junctions are links on every platform and are never descended.
5. Links inside the bundle: removed when their name is forbidden **or** they resolve outside the bundle (or cannot be read); links that stay inside are kept. `collectPackagingProblems` reports any link that leaves the bundle.
6. Required dependencies "bundled vs external": instead of a hand-kept list, `tracedPackages` reads the build's **own** non-standalone trace manifests (paths only) and requires every `node_modules/<pkg>` the tracer marked as an external runtime file to exist in `standalone/node_modules`. Packages webpack bundled into chunks never appear in manifests, so they are not demanded. The old `node_modules/next` minimum stays.
7. `scripts/verify-standalone.ts` (`npm run verify:standalone`, now in CI): runs the packaging check, copies `.next/standalone` (+ `static`, `public`) to a fresh folder **directly under the OS temp dir** (so Node has **no ancestor `node_modules`** to fall back to; `verbatimSymlinks: true` so links are not re-pointed at the project), strips `NODE_PATH`, `NODE_OPTIONS`, `STYLE_*`, `APP_URL`, `AUTH_SECRET`, `SMTP_URL`, `MAIL_FROM`, `OLLAMA_URL` from the environment, gives it an empty data directory and a loopback port, starts `server.js`, and drives: health, sign-up, mail capture, verification, sign-in, anonymous 401, wardrobe, analysis status/jobs, **photo upload + download (sharp's native binary)**, home page. It never opens the project's `.data`. Its only deletion is the folder it created, via `removeGenerated` after proving the folder is a direct child of the real temp dir with this script's prefix.
8. Docker mock-model CI (job `docker` in `ci.yml`, `deploy/ci/mock-ollama.mjs`, `scripts/ci-docker-smoke.ts`): builds the image, starts the mock model, `app`, `worker` and `mailer` containers, then signs up, verifies, waits for `configured`, submits a generated JPEG, waits for the single mock garment, discards it, checks the list is empty. Written, **not run**.

### Packaging tests (`tests/packaging.test.ts`, isolated temp trees, junction decoys)

Each test builds `proj/` with canary files for real source, `.data`, `.runtime`, `.env`, tests, docs and an `outside/` canary, plus junctions aimed at them. Asserts: private copies, trace entries and escaping links removed; **every canary byte-identical**, including through links placed inside doomed directories and under kept folders; harmless internal link kept; manifests keep `version`; verification clean afterwards; second run is a no-op. Refusal tests: `.next` as a junction, `.next/standalone` as a junction, a junction named `*.nft.json`, a file symlink manifest (skipped where Windows denies the privilege), five malformed manifest shapes (each also proves nothing was rewritten or deleted before the abort); missing traced `sharp` / `next` fail verification while an untraced (bundled) `zod` does not; `removeGenerated` refuses a path through a link, removes a link without touching its target, refuses paths outside the bundle and the bundle root itself; `..data` is a child, not an escape.

**Codex: please review before first execution** (they delete files, though only under `.next/standalone` of the project passed to them, or under their own temp folder): `packaging-sanitize.ts` (`removeTree`, `removeGenerated`, `removeLink`), `verify-standalone.ts` (`finally` block), and `tests/packaging.test.ts` `cleanup()` (unlinks every created link before recursive temp removal).

### 3a. Round 2 (root feedback)

* Typecheck: `ci-docker-smoke.ts` now copies the checked `STYLE_DATA_DIR` into a `const dataDir: string` so closures keep the type; `verify-standalone.ts` builds the child environment in one `NodeJS.ProcessEnv` literal (spread of the filtered inherited variables plus `NODE_ENV: "production"`), because Next's augmentation makes `NODE_ENV` a required key.
* Sanitizer temp file: the predictable `manifest + ".sanitizing"` written with `flag: "w"` is gone. `writeManifestAtomically` now (1) takes an unpredictable name `manifest.<16 hex>.sanitizing` (suffix validated `^[A-Za-z0-9]{1,32}$`), (2) runs `assertSafeToTouch(.next, temp)` so the folder's physical path is re-checked, (3) creates it with `openSync(temp, "wx")` (O_CREAT|O_EXCL: refuses an existing file, symlink or junction instead of following it), (4) writes through that descriptor, (5) `rename`s over the already-validated regular-file manifest, (6) on any failure unlinks the temp path only if `lstat` says it is a regular file this call created. Physical guards were not loosened; the existing-path case now fails the build. `sanitizeBuildOutput(root, { tempSuffix })` exists only so tests can plant a decoy at the exact path.
* Tests (`packaging.test.ts`): decoy at the temp path as (a) a regular file (not truncated, still `DECOY-FILE`), (b) a junction to an outside folder, (c) a file symlink to an outside file (skipped with a diagnostic where Windows denies the privilege). Each asserts the build throws `EEXIST`, both manifests are byte-identical, the outside canary and the outside target file are unchanged, and the planted link is still a link; then, with decoys removed, the same name succeeds and leaves no temp file. A second test: a default run leaves no `*.sanitizing` file and an unsafe suffix (`../escape`) is refused before any write.
* A crash between create and rename can still leave a stale `*.sanitizing` file in generated output. It is ignored by every scan (not `*.nft.json`), cannot be followed, and a rebuild replaces `.next`; it is not cleaned automatically.

### 3b. Round 3: the send deadline now cancels the connection

**Defect (root):** the first version bounded a send with `Promise.race` against a timer. The race rejected, but the SMTP conversation kept running on a shared cached transport, so a slow or trickling relay could still accept the old attempt while a retry was already in flight. A race is not cancellation.

**Now (`mail.ts`, `mailOutbox.ts`):**
* No shared transport. Each attempt builds its **own** nodemailer transport (`sendOverSmtp`) and uses nodemailer's supported `getSocket` hook to hand it a socket that this attempt opened and tracks (`openSocket`: `net.connect`, or `tls.connect` for `smtps://` with `secured: true`; 10 s connect timeout; `error` listener kept for the socket's life). The installed nodemailer 10 `smtp-transport` creates one `SMTPConnection` per message and merges `socketOptions.connection`; I read that code, I did not run it.
* `processNextMail` runs delivery through `deliverWithDeadline`: an `AbortController` fires at `STYLE_MAIL_SEND_TIMEOUT_MS`. The signal reaches `deliverMessage` → `sendOverSmtp`, which on abort **destroys every socket of that attempt** (a STARTTLS wrapper dies with its underlying socket), so nodemailer fails the send and clears its own connection timers. The error is reported as the fixed code `timeout`.
* A 3 s `ABORT_GRACE_MS` backstop exists **only** for a non-cooperating `send` (the test seam): if a delivery ignores the signal, the worker stops waiting after the grace period. The real SMTP path settles within milliseconds of the abort. The backstop is not the cancellation mechanism.
* Because nothing is shared, aborting one attempt cannot close or disturb a concurrent legitimate send. After a successful send nodemailer ends its socket; a 2 s unref'd timer destroys any straggler.

**What this does and does not guarantee.** After the deadline, this attempt's connection is closed from our side, so its acceptance can never be received and never completes the abandoned attempt; the next attempt (earliest after the 30 s backoff) starts with no connection from the old one. It does **not** undo what the relay already did: if the relay had received the full message bytes before we closed, it may still deliver it, and the retry then delivers a second copy. That is the at-least-once caveat, unchanged, and why both copies carry the same `Message-ID`. A worker crash between SMTP acceptance and recording is the same caveat.

**Tests (`mailOutbox.test.ts`), fake relay modes:**
* `hang`: accepts TCP, never greets → attempt ends at the deadline, row `queued` with code `timeout`, and the relay sees the connection close.
* `slow`: complete handshake and DATA, final `250` delayed 3 s past the 1.5 s deadline → the call returns before 3 s; the relay observes the close; after waiting out the delay `acked === 0` (the late acceptance was never delivered to a live client) and the row is still `queued`; the next attempt succeeds (`acked === 1`, `attempts === 2`), the relay holds two copies with the same `Message-ID` (the caveat, asserted rather than hidden).
* `trickle`: greeting dribbled one byte per 100 ms indefinitely (steady progress that resets idle timers) → ends at the deadline, relay sees the close, no reconnect afterwards.
* isolation: two concurrent `processNextMail()` calls, the relay stalls one connection and serves the other → exactly one `sent`, one `queued` with `timeout`, one message received, all connections closed.

**Not asserted (cannot be, without running):** that no nodemailer timer remains after the abort. By reading, `SMTPConnection.close()` clears its phase timers and the per-attempt transport is discarded; the observable proxies tested are the relay seeing the close and no reconnect.

## 4. Files changed / added

Changed: `src/server/{auth,database,limits,mail}.ts`, `src/components/{AccountDialog,AuthScreen,UploadDialog}.tsx`, `scripts/{backup-database,restore-database,packaging-rules,sanitize-build-output,start-local.ps1,verification-account}.ts|ps1`, `tests/{accounts,backup,concurrency,contention007}.test.ts`, `tests/e2e/{accounts.ts,auth.spec.ts}`, `package.json`, `package-lock.json` (root entry only), `compose.yaml`, `Dockerfile`, `.github/workflows/ci.yml`, `README.md`, `docs/DEPLOYMENT.md`, `docs/reviews/build-007-claude.md` (correction).
Added: `src/server/mailOutbox.ts`, `scripts/{mail-worker,packaging-sanitize,verify-standalone,ci-docker-smoke}.ts`, `deploy/ci/mock-ollama.mjs`, `tests/{mailOutbox,mailCapture,migration008,packaging}.test.ts`, `tests/helpers/{mailCapture,mailCrashChild}.ts`, this file.
Untouched on purpose: queue/worker (`analysisJobs.ts`, `analysis-worker.ts`), save/revision logic, vision, outfit code, write gate/transaction code, `authDialect.ts`, snapshots.

## 5. Regression baseline

I changed nothing in the queue, cancel, save, revision or account-binding code, and removed no assertion from any existing test; the existing mail-reading fixtures changed only from "read now" to "poll until captured". Expect the 40 backend and 31 browser passes to hold, plus the new tests above. The existing sign-up concurrency tests now include one more fast INSERT per sign-up inside the auth transaction and a few background writes from the local capture drain; if those tests become flaky, that is the first place to look.

## 6. Unresolved assumptions and open items (candid)

* **Not run.** Nothing was executed, so syntax, types and test expectations are unverified. `tsc` includes `tests/**` and `scripts/**` (tsconfig `**/*.ts`); type errors in the new tests are possible.
* No real SMTP relay, credentials, deliverability (SPF/DKIM/DMARC), provider rate limits or bounce handling. The fake relay proves protocol-level behaviour of nodemailer against a simple server only.
* Delivery is at-least-once; there is no inbound bounce processing, so a mailbox that does not exist after SMTP acceptance is invisible.
* Silent drop at the caps means a legitimate user who exhausts 4/hour sees nothing new; the copy says so. A per-IP signup/mail-bombing policy beyond Better Auth's existing per-IP rules is not added.
* Mail rows keep the one-time link in plaintext in `app.db` until sent/expired (≤45 min). Unavoidable for reset (the token is only available at enqueue); it shares the logical-delete caveat (free pages / WAL) from section 2. Backups strip it.
* Erasure, WAL truncation, secure-delete, marker-byte tests, encrypted/off-server backups, fresh-server restore + exported ledger: **future required batches**, unchanged and now described candidly.
* Dense recognition and the vision architecture: untouched, as instructed.

## 7. Things I could not verify by reading (check first when running)

* **A1** `getCurrentDBAdapterAsyncLocalStorage()` returns the store with `isTransactionActive` during Better Auth's sign-up transaction, and the callback runs inside that async context. Read in `@better-auth/core/dist/context/transaction.mjs` (`runWithTransaction` runs `fn` inside `als.run({adapter: trx, …, isTransactionActive: true})`) and `sign-up.mjs` 144/245; not executed. The rollback test is the guard: if the ALS probe fails, that test fails (the row would be committed separately).
* **A2** Whether a thrown error from a callback inside `runWithTransaction` is swallowed (assumed, from `create-context.mjs` 215–224) — it affects only the "enqueue failed" corner, not the tests.
* **A3** nodemailer's `err.code`/`responseCode` for connect failures (`ECONNECTION` vs `ECONNREFUSED`) — the test accepts any `conn*` code; classification of 4xx/5xx relies on `responseCode`.
* **A4** On Windows, `lstat` reports junctions as symlinks and `unlink`/`rmdir` removes only the junction. The traversal uses `lstat` and `removeLink` tries both; the junction tests will show whether this holds on the build machine.
* **A5** `tracedPackages` could report a package the tracer lists but Next intentionally does not copy into standalone, which would fail verification (fail closed, not unsafe). If that happens the message names the package; the right fix is to look at why it is traced, not to loosen the check.
* **A6** `@better-auth/core` resolves from the project root in Next's bundle and in `npm ci` with the edited lockfile root entry.
* **A7** `docker compose` health check `tsx scripts/mail-worker.ts --check` start-up time (~seconds) fits the 20 s timeout; Docker CI job and the `mailer` service have never been run.

Stable source tree: see the file list in section 4. No generated output, `.data`, `.runtime`, `.env` or `node_modules` was edited.
