# Build 006 independent review (Claude)

Reviewer: Claude (second reviewer). Date: 12 October 2026.
Subject: frozen snapshot `release-snapshots/build-006` (99 hashed source files).
Method: static reading only (Read/Glob/Grep). I ran no build, test, browser or server, so every runtime statement below comes from the supplied evidence or from reading code. I did not open `.data`, `.runtime`, `.env` or any other project.

Labels used below:
- **[Reproduced]**: shown by the evidence files or by an existing test in the snapshot.
- **[Code-proven]**: follows directly from the code I read, no runtime assumption needed.
- **[Inferred]**: depends on a runtime or library behaviour I could not observe. The "evidence to clear" line says how to settle it.

Paths are relative to `release-snapshots/build-006`, written as `file:line`.

---

## 1. Verdict

**Not production ready. I do not approve a public launch of build 006.**

The core engineering is better than most first builds, and the author's evidence supports these claims:
- Account isolation, optimistic revisions, the deletion ledger and the SQLite write path are designed with care and tested.
- The queue has lease, cancel and expiry semantics.
- The deployment files fail closed on missing HTTPS, secret and SMTP in public mode (`src/server/auth.ts:27-59`, `src/server/mail.ts:23-28`).

The build is still short of its stated goal, "a real multi-user wardrobe app ready for launch", in three ways:

1. **The photo pipeline is not sized for more than a handful of concurrent users, and the user experience when it is overloaded is bad.**
   - Queue, client timeout, inference timeout and retention TTL are mutually inconsistent (§3.1).
   - A lost job cannot be resumed or found again (§3.2).
   - Cancelling does not stop the model (§3.3).
   - Cheap admission checks run after the expensive image decode (§3.4).
   - A dense "whole wardrobe" photo can exceed the output token budget (§3.5).
2. **Several promises made to consumers are not what the code does.**
   - "Formal outfits require confirmed formal items" is not true for uploaded items (§3.7).
   - A shoe pair becomes two records (§3.6).
   - "Permanently removes your … photos" and "cancellation clears … immediately" are logical deletions only (§3.9).
3. **Disaster recovery cannot be executed with the shipped script on a replacement server** (§3.10), and detached mail failure handling is unverified and could crash the process (§3.8).

I found **no confirmed P0**. One item is **P0-if-confirmed** (§3.8, a possible process crash on SMTP failure), and it needs one cheap test to settle.

Suggested status: **closed/invite-only beta after the P1 code items are fixed and the evidence in §5 exists. Open public launch only after the external gates in §4 pass.**

---

## 2. What I checked that holds up

These are the parts I would not spend more review time on, as far as static reading goes.

- **CSRF and origin.** Every mutation requires an exact `Origin` equal to `APP_URL` (`src/server/access.ts:19-20`). `trustedOrigins` is the single configured origin (`src/server/auth.ts:107`). Responses are `private, no-store`. The `X-Style-Account` header turns a stale-device write into a clean 409 instead of a write to the wrong account (`access.ts:24-25`).
- **Tenant isolation.**
  - Every photo read and write is keyed `id AND user_id` (`src/app/api/photos/[id]/route.ts:17-19`, `src/server/wardrobes.ts:68-71`).
  - Jobs are keyed the same way (`analysisJobs.ts:179-185`, `207-215`).
  - Foreign-key cascade covers every per-user table (`src/server/database.ts:89-152`).
- **Atomic deletion ledger.** The trigger on `DELETE FROM user` writes the tombstone in the same statement (`database.ts:97-102`). That is the right design. The restore script reapplies it (`scripts/restore-database.ts:56-68`).
- **Optimistic save.** The revision check, the byte-identical lost-response acknowledgement and the 409 path are correct (`src/server/wardrobes.ts:96-118`). The client stops auto-saving after a failure and preserves the draft (`src/hooks/useStyleStore.ts:100-110`).
- **Write path.**
  - The bounded gate, the async `BEGIN IMMEDIATE` retry and the rule that the body never replays are sound (`writeTransaction.ts:50-87`, `writeGate.ts`).
  - Worker finish is guarded by status, exact lease and lock owner (`analysisJobs.ts:385-389`).
  - Late results past the one-hour deadline are discarded (`analysisJobs.ts:391-405`).
- **Outfit composer.** It only uses owned, reviewed, available items and requires a base plus shoes (`src/domain/outfit.ts:51-56`, `69-81`). Formal mode filters on confirmed `formality` (`58-62`). Deterministic tests exist.
- **Dependency posture.** The author's claim of zero production audit findings is plausible, and the development-only advisory is disclosed.

---

## 3. P1 code blockers (fix before any beta with non-team users)

Ordered by launch impact.

### 3.1 P1: queue depth, client deadline, inference timeout and TTL are inconsistent [Code-proven arithmetic; capacity numbers Inferred]

Relevant constants:

| Setting | Value | Where |
|---|---|---|
| Global active cap | 20 | `analysisJobs.ts:34` |
| Inference timeout | 240 s | `src/server/vision.ts:79` |
| Photo and result lifetime | 60 min from upload | `analysisJobs.ts:41` |
| Client polling deadline | 15 min | `src/components/UploadDialog.tsx:79` |
| Observed real-model time | 76.8 s end to end; about 85 s per direct sample (evidence) | |

The worker is strictly sequential (`scripts/analysis-worker.ts:95-115`). The job at queue position k finishes about k·t after upload, where t is the per-job time.

- **At t = 85 s:**
  - Job 11 and later cannot finish inside the client's 15 minutes.
  - Job 20 needs about 28 minutes.
- **At t = 240 s (the timeout, a plausible CPU figure on the documented 4-core target):**
  - Job 4 and later miss the 15-minute client deadline.
  - Job 20 needs 80 minutes, which exceeds the 60-minute server TTL. It would be failed as "expired" before the worker reaches it.
- **When the client gives up**, its `finally` calls `cancelJob()` (`UploadDialog.tsx:150-152`). The photo is lost and the user sees "Analysis is taking too long".
- **The daily quota is still spent.** The usage counter increments at enqueue (`analysisJobs.ts:153-155`) and is never refunded for cancel, timeout or failure. A user can burn their 20 daily analyses on timeouts.
- **The queue message gives no position or ETA.** The UI says only "waiting its turn" (`UploadDialog.tsx:86-90`).

The 20-job cap bounds depth, not wait. Nothing connects the cap to the real inference rate or to the client's patience.

**Fix.**
1. Make admission wait-based. Keep an exponential moving average of recent inference seconds (or use a configured seconds-per-job). On enqueue, compute `estimatedWait = queuedAhead × avg`. Reject with 503 and a retry hint when `estimatedWait + avg` exceeds a budget (for example 10 minutes), instead of using the fixed count of 20.
2. Return `position` and `etaSeconds` from `GET /api/analysis-jobs/:id` and show them in the UI.
3. Take the client's deadline from the server (`expires_at`, or a `maxWaitSeconds` field) instead of the hard-coded 15 minutes.
4. Refund the daily count when the job fails for a server-side reason (worker lost, model unavailable, expired in queue) or is cancelled before it starts running.
5. Make the 240 s timeout configurable by environment variable. Record per-job inference seconds in the DB so the benchmark in §5 can read them.

**Evidence to clear.**
- A test with N queued jobs and a mock model that takes T seconds, asserting that no job is accepted that cannot complete inside the client budget.
- A target-server benchmark with p50 and p95 queue wait at the intended concurrency.

### 3.2 P1: a lost or abandoned job cannot be resumed, found or cancelled; the result is only in browser memory [Code-proven]

- The job id lives only in a React ref (`UploadDialog.tsx:29`, `78`). The server has no "my active job" endpoint, and `GET /api/analyze` returns only `{configured}` (`src/app/api/analyze/route.ts:21-30`).
- If the tab is killed or the phone discards the page (cleanup runs on a normal unmount, not on a discard), the job keeps its slot. Because `MAX_ACTIVE_PER_USER` is 1 (`analysisJobs.ts:33`), the user then gets 409 "You already have a photo analysis in progress" until it finishes or the one-hour sweep runs. They have no way to see or cancel it.
- If the worker is down (the "configured" probe is false, so the UI blocks new uploads), jobs queued before the outage sit until the sweep (`analysisJobs.ts:102-104`).
- On completion the client immediately deletes the server copy: `finally { cancelJob() }` (`UploadDialog.tsx:151`) → `DELETE` clears `result_json` (`analysisJobs.ts:217-219`). That is good for retention. But it means a dropped response on the final poll, a reload, or a crash during the review loses the result and the user must upload again. The review draft is also memory-only (`UploadDialog.tsx:24-27`).

The deleted-result-on-fetch behaviour and the memory-only review mean "long photo processing" is not resumable across a reload, which was one of the stated concerns.

**Fix.**
1. Add `GET /api/analysis-jobs?active=1` (or put `activeJob: {id,status,position}` into `GET /api/analyze`). On dialog open, resume polling or offer "Cancel and start over".
2. Persist the job id in `sessionStorage` as a hint only, always verified with the server.
3. Do not delete a completed result at fetch time. Delete it when the user explicitly saves or discards the review, or at TTL. The one-hour absolute expiry already bounds retention.
4. Optional but valuable for whole-wardrobe photos: keep the draft items in `sessionStorage` (they are small crops) so a reload does not lose review work. State the retention in the privacy note.

**Evidence to clear.** A browser test that starts an upload, reloads the page mid-queue, and sees the dialog resume or cancel; and one that reloads after completion and recovers the result within the TTL.

### 3.3 P1: cancelling a running job does not stop the model; zombie inference blocks the queue; user's cancel is also rate-limited [Code-proven; test shows the behaviour]

- `cancelAnalysisJobForOwner` only edits the row (`analysisJobs.ts:207-224`). The worker never checks cancellation while the 240 s request is open.
- `tests/queue.test.ts:127-142` proves it: the test cancels a running job, then still has to release the mock model before the tick finishes. The result is dropped correctly, but the inference ran to completion.
- Consequence: a user who cancels and re-uploads (the UI encourages this) queues a new job behind up to 4 minutes of discarded work. Abandoned tabs (§3.2) do the same.
- `DELETE /api/analysis-jobs/:id` is a rate-limited mutation (`access.ts:26-40`). In the 429 case the cleanup `fetch` fails silently (`UploadDialog.tsx:34-38` has no `catch`), so the job is not cancelled.

**Fix.** In the existing worker heartbeat (every 10 s, `analysis-worker.ts:97-109`), read the claimed job's status and lease with a plain SELECT. If it is no longer `running` with the same lease, call `activeController.abort()`. That bounds wasted inference to about 10 s. Also exempt job cancel from the mutation counter, or at least handle failure and retry once.

**Evidence to clear.** A test where cancel during inference aborts the Ollama request within one heartbeat, and the next queued job starts promptly.

### 3.4 P1: image admission is checked after the expensive work, and nothing bounds concurrent decodes [Code-proven order; memory impact Inferred]

Order of work in `POST /api/analyze` (`src/app/api/analyze/route.ts:32-63`):
1. `account()` (session, plus a write transaction for the mutation counter).
2. `readJson` buffers up to 9 MB (`access.ts:44-66`).
3. A regex over the whole base64 string (line 43), then `Buffer.from` of a `split` copy (line 46).
4. `normalizePhoto`: a full sharp decode with `limitInputPixels: 32_000_000` (`vision.ts:44-56`). A 32 MP image decodes to roughly 128 MB of pixels.
5. Only then `enqueueAnalysisJob`, which checks 1 active per user, 20 global, 20 per day (`analysisJobs.ts:121-148`).

So a request that will certainly be refused with 409, 429 or 503 still pays for steps 2–4. `/api/photos` does the same: it decodes first and checks quotas inside the transaction after (`src/app/api/photos/route.ts:27-71`).

There is no process-wide limit on concurrent decodes, no `sharp.concurrency`/`cache` tuning, no Node heap setting, and no `mem_limit` in `compose.yaml`. The per-user mutation limit is 120/minute (`access.ts:36`), and accounts are free to create (5 sign-ups per minute per IP, `auth.ts:164`). The browser client always sends a 1600 px canvas JPEG (`src/services/images.ts:10-19`), so the 32 MP server allowance serves no legitimate user of this client.

Worst case: tens of verified accounts each sending near-limit images concurrently can exhaust container memory. That kills the app container, which also runs auth. SQLite stays consistent, but the service goes down.

**Fix.**
1. Move the cheap checks first: active-job, global count, daily count, and storage quota, before reading the body when possible, and always before decoding. Keep the transactional re-check at enqueue.
2. Add a process-wide semaphore around `normalizePhoto` (for example 2 at a time, bounded queue, 503 when full).
3. Tighten the server limits to what the app client can legitimately send: for example reject if the metadata says either side is over 2400 px or the pixel count is over 6 MP, and reject payloads over about 2 MB for `/api/analyze` and `/api/photos`. Read dimensions with `sharp(...).metadata()` before decoding.
4. Set `sharp.cache(false)` and `sharp.concurrency(1-2)`.
5. Add `mem_limit` and `--max-old-space-size` to the `app` service, and size the Ollama service separately.
6. Keep Caddy's 10 MB body cap (`deploy/Caddyfile:3-5`); it is useful.

**Evidence to clear.**
- A test that fires 30 concurrent over-quota and oversize requests and shows bounded RSS and fast 4xx.
- A test with a 32 MP PNG under 6 MB: it must be rejected after reading metadata only, before decoding.
- `docker stats` peak memory under a scripted upload burst on the target server.

### 3.5 P1: a dense "whole-wardrobe" photo can exceed the output token budget and fail whole [Inferred; not covered by any fixture]

- The prompt and schema allow up to 30 items (`src/domain/analysis.ts:38`, `50`, `105`). Each item object has about 12 fields including a 150-character evidence string (`analysis.ts:64-100`).
- Generation is capped at `num_predict: 2048` (`vision.ts:88`). My estimate is 100–150 tokens per item, so JSON for roughly 15–20 or more items would be cut off.
- A truncated response fails `JSON.parse`, which becomes "The analysis could not be verified. Try another photo." (`vision.ts:143-146`). There is no salvage of the items already emitted and no retry with a shorter schema.
- The model sees the photo at 768 px (`vision.ts:69-72`). A full-wardrobe image downscaled to that size gives small boxes in a 0..1000 grid, so even complete output would have coarse crops.
- The evidence and `docs/VISION_EVALUATION.md` show only one-to-three-item samples. Nothing exercises more than a handful of items, yet "whole-wardrobe photo extraction" is a stated product requirement.

**Fix.**
1. Short term: compact the schema (shorter `evidence`, drop optional fields on dense images), and raise `num_predict` with a matching `num_ctx` after measuring memory and time.
2. Better: tile. Split the 1600 px normalized image into overlapping tiles (for example 2×2 with 15% overlap), run each tile as a sub-step of the same job, merge by box IoU and category, and report progress "tile 2 of 4".
3. Tiling also gives resumability: store each tile's result in the job row so a worker restart continues from the last finished tile instead of redoing everything. It also bounds every Ollama call to a fixed, measurable duration, which makes the timeout and queue maths in §3.1 predictable.
4. Salvage partial JSON (items parsed before truncation) and show a warning rather than failing.

**Evidence to clear.** A held-out set (see `docs/VISION_EVALUATION.md`) that includes images with 10, 20 and 30 visible garments, reporting recall, schema-failure rate and latency p50/p95 on the target server.

### 3.6 P1 (consumer): a shoe pair becomes two records [Reproduced in author's evidence]

The prompt says "A shoe pair is one item" (`analysis.ts:105`), but the author's own direct-model samples still produced two records (`REVIEW_EVIDENCE.md:11`). The 4B model does not obey it reliably. There is no post-processing: no overlap merge and no merge control in the review UI (`UploadDialog.tsx:230-372` offers only discard).

Impact: the wardrobe inventory is wrong (two "pairs"), outfit rotation includes duplicate shoe options (`outfit.ts:68`, `96-98`), and users must find and delete the duplicate.

**Fix.**
1. Add a server-side normalisation step after parsing: for items with category `Shoes`, merge when the boxes are adjacent or overlapping (IoU or centre distance under a threshold) and the colours are compatible. Use the union box and keep one record.
2. Add a "These are one pair / Merge" action in the review card as the user-visible safety net.
3. Add the two real shoe fixtures (`tests/fixtures/candidates/handmade-shoes.jpg`) to a regression test that runs the post-processor on recorded model output.

**Evidence to clear.** Recorded model output for the shoe fixture goes in and exactly one `Shoes` item comes out; one review-UI test for merge.

### 3.7 P1 (consumer): "confirmed formal" is not confirmed for uploaded items [Code-proven]

- `README.md:27` says "Formal outfits require confirmed formal items."
- Formal mode keeps only `formality === "formal"` (`outfit.ts:58-62`).
- For uploaded items, `formality` is whatever the 4B model returned. The upload review card shows only name, category, colour, crop and evidence (`UploadDialog.tsx:299-334`). Dress code is editable only afterwards in `ItemEditor.tsx:84-92`.
- The single "Details checked" checkbox (`UploadDialog.tsx:335-345`) is therefore a confirmation of fields the user cannot see for the one attribute that gates formal outfits. `warmth` is likewise forced to `"unknown"` (`UploadDialog.tsx:141`), which also means the hot-weather exclusion (`outfit.ts:61`) can never trigger for uploaded items.

**Fix.** Add a "Dress code" selector (casual / smart / formal / unknown, default unknown) to the review card, and make `reviewed` require it to be touched or explicitly left as unknown. Optionally add a warmth selector. Update the README sentence to match behaviour.

**Evidence to clear.** A browser test: an AI "formal" suggestion is visible in review; formal mode excludes it until the user keeps it as formal.

### 3.8 P1, and P0 if confirmed: detached mail has no verified failure path, no durability, and may crash the process [Inferred]

`auth.ts:115-119` replaces Better Auth's background-task handler with `(promise) => { void promise; }`. The comment says "failures are logged by Better Auth and never fail the request". I cannot confirm that from this snapshot (the library is not in it), and no test sends through a failing SMTP transport. All mail tests use the file outbox (`tests/accounts.test.ts:26-30`, `tests/concurrency.test.ts:415`).

Two risks:
- **Process crash [P0 if confirmed].** If the library passes a promise with no rejection handler, a rejected SMTP send (provider down, bad credentials, 10–20 s timeouts at `mail.ts:38-45`) becomes an unhandled rejection. Node 24 terminates the process on that by default. With `sendOnSignIn: true` (`auth.ts:134`), any sign-in attempt on an unverified account triggers a send, so an outage would turn into a crash loop that any visitor can trigger.
- **No durability.** Even when handled, a failed or interrupted send (process restart, SMTP 4xx) is lost. There is no outbox, retry or user-visible "we could not send". Users recover only by retrying (verification re-send is rate limited to 3 per minute per IP; reset 3 per minute, `auth.ts:162-165`). Throttling is per IP only, so a shared NAT can lock out legitimate users while a distributed attacker can mail-bomb one victim and damage sender reputation.

**Fix.**
1. Write the handler so it always attaches a catch: `handler: (p) => { void Promise.resolve(p).catch(logMailFailure); }`. Add `process.on("unhandledRejection")` logging as a backstop only, not as the design.
2. Add a small durable outbox table (`mail_outbox`: id, to, subject, body, attempts, next_attempt_at, last_error), written inside the same transaction as the token (or immediately after), with the worker process sending, retrying with backoff (for example 5 attempts over an hour) and dropping bodies after success or expiry. This removes SMTP I/O from the web process entirely.
3. Add per-recipient throttles (for example 3 verification and 3 reset mails per address per hour) in addition to the per-IP rules.
4. Surface "If an account exists, we have sent an email; check spam or request another" and a resend control.

**Evidence to clear.**
- A test with an unreachable SMTP URL: sign-up and sign-in return normally and the process stays alive.
- A test where the process is killed after commit: the mail is still delivered from the outbox after restart.
- Real delivery to at least two independent mailbox providers with SPF, DKIM and DMARC passing (external gate).

### 3.9 P1: erasure and retention wording overstate what SQLite does [Code-proven]

What the code does:
- Live deletes are ordinary `DELETE`s. No connection sets `secure_delete`, and there is no `auto_vacuum` or periodic `VACUUM` (grep over the snapshot finds `secure_delete` only in the backup and restore scripts, `backup-database.ts:22`, `restore-database.ts:57`).
- Deleted BLOB pages therefore sit in the file's free list, and older page images stay in the `-wal` file until it is overwritten. Nothing runs `wal_checkpoint(TRUNCATE)` on the live database outside restore.
- Operator backups keep deleted users' wardrobes and photos for up to 7 days (`backup-database.ts:25-31`, `DEPLOYMENT.md:47`). Only temporary AI payloads are stripped from backups.
- The tombstone keeps a pseudonymous user id indefinitely and is copied into every backup.

What users are told:
- "Your photo is held temporarily … up to one hour" (`UploadDialog.tsx:184-189`).
- "cancellation clears their queue data immediately" (`README.md:31`).
- "This permanently removes your wardrobe, saved looks and photos." (`AccountDialog.tsx:101`).

The logical statements are true. The physical ones are not. Deleted data remains recoverable from the database file, WAL and backups for a period that is never stated. The "one hour" promise also does not mention that a completed result lives until fetched, then is deleted logically at once (§3.2).

**Fix, in order of preference.**
1. **Temporary photos off the main database.** Keep queued images and results out of `app.db`. Use a tmpfs mount shared by `app` and `worker`, or per-job encrypted files with a key held only in the worker process and discarded on completion (crypto-shredding). This is the only way to make the "one hour" claim physical for the highest-churn sensitive data.
2. **Enable `PRAGMA secure_delete=ON` (or FAST) on both connections** and schedule `PRAGMA wal_checkpoint(TRUNCATE)` plus an occasional `VACUUM` or `incremental_vacuum` from the worker at idle. Measure the write cost.
3. **At minimum, change the copy.**
   - Upload note: "removed from our active systems when you finish or after one hour; remnants may remain in storage until overwritten".
   - Deletion dialog: "Your account and photos are deleted immediately from the live service. Encrypted operator backups are kept for up to 7 days and then removed. We keep an anonymous deletion record so deleted accounts are not restored."
4. State the backup retention for off-server copies in the same text.

**Evidence to clear.** A test that uploads a distinctive marker image, cancels or deletes, runs the chosen cleanup, then scans `app.db` and `app.db-wal` for the marker bytes. Plus the revised copy reviewed against the real backup schedule.

### 3.10 P1: the restore script cannot restore onto a replacement server, and the deletion ledger is not replicated off-server [Code-proven]

- `scripts/restore-database.ts:20-23` throws if `app.db` does not exist: "The latest live deletion ledger is required". That is exactly the disaster-recovery case (server lost, new empty volume). The documented restore (`DEPLOYMENT.md:49-55`) assumes the old live database survives.
- The ledger lives only inside `app.db` and inside backups. Anyone deleted after the most recent off-server backup is silently resurrected on restore from an old copy. `DEPLOYMENT.md:47` tells the operator to "preserve the latest deletion ledger separately", but there is no command to export it, and backups run only when someone runs the command (no schedule exists in compose).
- Backups are written to `/data/backups` on the same volume as the live database (`backup-database.ts:12`). Losing the volume loses both.

**Fix.**
1. Add `scripts/export-ledger.ts` that writes a tiny signed or checksummed file of `account_deletions` rows, and have the backup command run it and write the file next to each backup. Document uploading both off-server together.
2. Teach the restore script an explicit fresh-server mode (`STYLE_RESTORE_FRESH=true` plus `--ledger file`) that applies a supplied ledger instead of requiring a live database.
3. Add a scheduled backup (a `backup` compose service with a cron loop, or a host cron line in the docs) and an encrypted off-server copy step.
4. Add a restore smoke test that restores into an empty data dir and checks that deleted users stay deleted when a ledger is supplied.

**Evidence to clear.** The off-server restore drill from §4, run on a clean machine, with a deletion made between the backup and the drill.

---

## 4. External release gates (not code defects; each needs real evidence)

None of these is verified. The author's evidence says so and I agree. Local tests and a Windows development run do not cover any of them.

| Gate | Evidence needed to clear |
|---|---|
| Domain, DNS, public server | Provisioned host, domain pointing at it, ports 80/443 only, firewall rules shown. |
| TLS, secure cookies, proxy headers | On the real domain: HSTS, `Secure` + `HttpOnly` + `SameSite` cookies, redirect from http, correct client IP seen by the app (Better Auth's per-IP limits rely on Caddy's `X-Forwarded-For`), unauthenticated API 401s, cross-origin POST 403. |
| Real SMTP | SPF, DKIM and DMARC aligned for the sender. Verification and reset delivered to at least Gmail and one other provider, with timings and spam-folder check. Behaviour with SMTP deliberately blocked (see §3.8). |
| Docker build and cold start | `docker compose build` and `up` from a clean checkout on the target OS. Confirm the traced Next `node_modules` and the full dependency layer merge correctly in the runtime image, `tsx` runs `init-auth` as the non-root user, and the app and worker containers really share WAL safely through the named volume. CI never builds the image (`.github/workflows/ci.yml`). |
| Ollama in the container | Model pulled in the volume, `ollama/ollama:0.40.3` exists and runs `qwen3-vl:4b-instruct`, memory and swap behaviour, behaviour after an idle model unload (cold load time), GPU or CPU choice recorded. No memory limits are set in `compose.yaml:54-63`. |
| Target-server capacity | Load test at intended concurrency: sign-ups, wardrobe loads, photo uploads and a queue of real analyses. Report p50 and p95 for queue wait and inference, peak RSS per container, disk growth, and database lock-wait counts. This number replaces the single 76.8 s observation. |
| Off-server encrypted restore drill | Backup, encrypt, copy off the server, restore on a clean machine with the deletion ledger (see §3.10). Record timings and the checks performed. |
| Recognition accuracy | The held-out set described in `docs/VISION_EVALUATION.md` run, with results by slice (single item, multi-item, dense, shoes, patterns, dark and light, negatives). The plan itself says no accuracy claim is currently supported, and I agree. |
| Consumer usability | At least five non-team users complete sign-up, upload, review and an outfit unaided, with edit counts and time recorded. |
| Monitoring and alerting | Alerts for worker heartbeat stale, queue depth or oldest-job age, disk free, mail failures and container restarts. `compose.yaml` has no worker health check (`37-53`); only the app is probed. |
| Legal and policy | Privacy policy and terms that match §3.9, a data-processing statement (all processing on the operator's server), and a contact route for requests. |
| Abuse and cost controls | Policy for throwaway accounts: the global photo cap is 2 GB (`photos/route.ts:59`) while each account may hold 100 MB (`49`), so about 20 free accounts could fill it and cause 503 for everyone. Decide on a lower per-account cap, an unverified-account cleanup job (I found none) and a sign-up throttle suited to the real audience. |

---

## 5. P2 findings (fix before general availability; do not block a small beta)

Each of these is Code-proven unless marked.

1. **Polling and page loads take the write lock.**
   - Every job poll runs through `runWriteTransaction` (`src/app/api/analysis-jobs/[id]/route.ts:21`) and a write `UPDATE` (`analysisJobs.ts:165-178`).
   - Every `GET /api/wardrobe` does too, because `loadWardrobe` reclaims orphan photos (`src/app/api/wardrobe/route.ts:15`, `wardrobes.ts:39-51`).
   - Twenty waiting users polling every 2 s is about 10 write transactions per second, queued behind sign-up transactions that hold the gate for password hashing (`authDialect.ts:35-39`).
   - Make polling a read with expiry applied in memory, and move orphan reclaim to a worker maintenance tick.
2. **Planned restarts fail in-flight jobs.** On SIGTERM the abort is caught and recorded as a normal failure (`analysisJobs.ts:542-544`), consuming an attempt and sending the user a generic error. Requeue the job on shutdown instead.
3. **Failed inference gets no automatic retry.** Only lease loss retries (`analysisJobs.ts:92-101`). A transient Ollama error fails the job immediately and spends the daily quota. A single automatic retry for transport errors would help.
4. **Sweeps are event-driven.** Expiry runs on enqueue, claim, startup, and a job's own GET (`analysisJobs.ts:120`, `496`, `166`). If the worker is down and nobody enqueues, photos can outlive one hour. Add a periodic sweep in the web process or worker.
5. **Backup import and large saves hit the mutation limit.** `saveAccountWardrobe` uploads one photo per request, sequentially (`serverRepository.ts:36-60`), and each counts against 120 per minute (`access.ts:36`). Importing a backup with more than about 100 distinct images fails with 429 partway and shows "Changes have not been saved". Batch uploads or exempt uploads from this counter in favour of a byte quota.
6. **Conflict recovery is export-and-reload only** (`wardrobes.ts:104-108`, `useStyleStore.ts:231-236`). Safe, but two-device users will hit it often. A merge-by-item-id path is the natural next step.
7. **No Content-Security-Policy** in `deploy/Caddyfile:6-12` or Next config. Add a strict CSP (`default-src 'self'`; `img-src 'self' data: blob:`) as defence in depth.
8. **Secrets reach the proxy container.** `proxy` uses `env_file: .env.production` (`compose.yaml:67`), so Caddy receives `AUTH_SECRET` and `SMTP_URL`. Pass only `STYLE_DOMAIN`.
9. **`VISION_MODEL` is documented and exampled** (`.env.example:2`, `DEPLOYMENT.md:23`) **but ignored.** The model name is hard-coded (`vision.ts:12`). Either honour it or remove it, because an operator who changes it will believe the change took effect.
10. **Credential-stuffing defence is per IP only** (`auth.ts:155-168`). Add a per-account failed-attempt backoff.
11. **Outfit gaps** (low severity): warmth/season is not considered for footwear; hot-weather filtering is inert for uploaded items (§3.7); a cold day with no layer still returns a "complete" look with only a note (`outfit.ts:113-120`).
12. **Unverified accounts and idle rate-limit rows** have no cleanup that I could find. [Inferred: could not see Better Auth's defaults.]
13. **Unused repository code:** `localStorageRepository.ts`, `indexedDbRepository.ts`, `repository.ts` are in the source set. Confirm they are unreachable, or remove them, so a future change cannot reintroduce browser-only storage by accident.
14. **Development audit:** the five high-severity advisories are in development tooling and `braces` is documented; keep them out of the production image (the Dockerfile does use `--omit=dev` for the dependency stage, `Dockerfile:12`).
15. **Operator wording:** `DEPLOYMENT.md:35` says a local test passed for three simultaneous cold starts. That is true of the author's test but is not container evidence; keep the unverified caveat visible near the first run commands.

---

## 6. Root concerns: direct answers

1. **15-minute client polling versus 20 queued jobs, 4-minute timeout, 1-hour TTL.** They do not fit together (§3.1). Under plausible CPU timings, the tail of a full queue either exceeds the client's patience or expires on the server. Fix with wait-based admission, server-supplied deadlines, and a position/ETA display.
2. **Resumable long processing and cancellation.** Not resumable (§3.2): no way to rediscover a job, result deleted on fetch, review draft in memory only. Cancel is a row edit; the model keeps running (§3.3; the existing test demonstrates it).
3. **Aggregate decode and admission limits before normalisation.** Per-image limits exist; aggregate limits do not (§3.4). Admission is evaluated after the decode, there is no concurrency cap, and no container memory limit.
4. **Shoe pairs.** Reproduced defect; needs server merge plus a review-UI merge action (§3.6).
5. **Logical SQLite and WAL erasure versus the wording.** Wording is stronger than the mechanism (§3.9). Best fix is to keep temporary photos out of the main database; at minimum change the copy and enable secure-delete plus periodic checkpoints.
6. **Detached mail durability.** Not durable, and the rejection path is untested and possibly fatal (§3.8). Move mail to a database outbox sent by the worker, with an explicit catch.
7. **Gate coverage and stale account/device conflicts.** I found the gate and stale-account design sound. The remaining gate weakness is load, not correctness (§5 item 1). Stale devices fail safe through the account header and the revision check.

---

## 7. Evidence checklist to reach "ready for invite-only beta"

1. Tests for §3.1, §3.2, §3.3, §3.4, §3.8 as listed above, all green.
2. Recorded-output regression for shoe merge (§3.6) and a browser test for dress-code review (§3.7).
3. A dense-wardrobe fixture (10, 20, 30 items) with measured recall, schema-failure rate and latency (§3.5).
4. A marker-bytes erasure test and the revised privacy and deletion copy (§3.9).
5. A fresh-server restore test using an exported ledger (§3.10).
6. A passing run of the full gate list in §4 that applies to a beta: domain/TLS, real SMTP, Docker cold start, restore drill, capacity numbers, monitoring.

For open public launch add the recognition benchmark, usability sessions and the abuse-control decisions from §4.

---

## 8. Limits of this review

- I read the frozen source; I did not execute it. Every "Inferred" item above needs the stated test to be settled either way.
- I did not inspect `node_modules`, so statements about Better Auth, Next and sharp internals are labelled Inferred where they matter.
- I did not review `src/components` styling or accessibility beyond the files cited.
- I make no claim about model accuracy; the supplied evidence does not support one.
