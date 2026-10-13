# Build 007 independent review (Claude)

Reviewer: Claude, second reviewer. Date: 12 October 2026.
Subject: `release-snapshots/build-007` (107 hashed source files, plus `REVIEW_EVIDENCE.md`, `FINAL_LIVE_EVIDENCE.md`, `evidence/live-browser.json`).
Method: static reading only (Read/Glob/Grep). I ran no build, test, browser or server. I did not open `.data`, `.runtime`, `.env`, secrets or `node_modules`. Every runtime statement comes from the supplied evidence or from reading code.

Labels:
- **[Code-proven]**: follows from the code I read.
- **[Test-shown]**: shown by a test in the snapshot, read but not run by me.
- **[Hypothesis]**: depends on behaviour I could not observe; the "smallest test" settles it.
- **[External gate]**: not a code defect; needs real-world evidence.

Paths are relative to `release-snapshots/build-007`.

Not read in full: `tests/accounts.test.ts`, `concurrency.test.ts`, `admission.test.ts`, `pairs.test.ts`, `domain.test.ts`, `api.spec.ts`, `auth.spec.ts`, `consumer.spec.ts`, `outfit.ts` and the other UI components. I make no claim about them beyond what the evidence says.

---

## 1. Verdict

**Not ready for public launch. I do not approve build 007 for open public launch.**

**Batch A is largely accepted at code level** (§3). The queue, discovery, abort, upload-bounding, shoe-pairing and dress-code repairs do what they claim, and several are tested with real failure injection. The build is better than 006 on every item batch A set out to fix.

The four 006 items that batch A did not set out to fix are all still open and unchanged:
- Dense whole-wardrobe output (§4.1).
- Detached mail failure and durability (§4.3).
- Physical erasure, with user-facing wording that still overstates it (§4.4).
- Fresh-server restore preserving deletions (§4.2).

Whole-wardrobe photos are a stated core requirement, and today they cannot work for dense images.

**The new live evidence (242.586 s):**
- It shows the compiled app can do upload → local Qwen3-VL 4B detection → review → acknowledged save → reload, once, on one repeated shirt fixture.
- It is a smoke test. It is not accuracy, a latency percentile or capacity evidence, and I do not use it as any of those.
- It does show one thing that matters: a single easy photo takes about 214–243 s. The inference timeout is 240 s. There is almost no headroom (§4.1, §5.2).

**Suggested status:**
- Closed, invite-only technical beta with team and friendly testers is reasonable once the P1 items in §4 have fixes and tests.
- Public launch is gated on the §6 external items, which are all absent.

---

## 2. What holds up (not worth more review time)

- **Admission arithmetic.** `analysisJobs.ts:231-298` uses a worst case per job of `max(estimate, inference timeout + 10 s)`. With defaults, that is 250 s per job ahead plus the 10 min review budget inside the 60 min life. At most 12 jobs are in line, and 11 ahead of a new one are admitted, matching the README and `queue007.test.ts:192-212`. The ETA shown to users is the lower estimate, and that split is honestly documented.
- **Quota refunds.** One-time marker flipped by a conditional UPDATE (`:124-137`), separate never-refunded `attempts` counter, and a day taken from `created_at`. `queue007.test.ts:250-331` covers queued cancel, running cancel (no refund), server failure, unverified output (charged), completed-then-discarded (charged), expiry and the attempts cap. This is meaningful.
- **Abort and ownership.** The read-only watcher (`analysisJobs.ts:892-920`) catches cancel, account deletion, lease change, lock-owner change and expiry. Finish is guarded by status, exact lease and worker lock (`:699`). A shutdown requeues instead of failing (`:948-958`). `queue007.test.ts:373-465` tests cancel, delete and expiry mid-inference against a holding mock, and checks the mock saw the abort. The live evidence (next job started after 2.61 s) agrees.
- **Owner-only discovery.** `listJobsForOwner` is a plain read keyed by `user_id`. Other accounts get 404 or an empty list (`queue007.test.ts:333-371`). Results survive repeated fetch and go only on explicit discard or expiry.
- **Cancel despite change quota.** `access.ts:66-69` skips the 120/min counter for cancel. Origin, session and `x-style-account` checks still apply. The in-memory 300/min bound is fine. It resets on restart and when it holds more than 5,000 entries; this is a minor weakness, not a defect.
- **Bounded image work.** The cheap admission pre-check runs before the body is read (`analyze/route.ts:48`). A shared semaphore (2 running, 6 waiting, 15 s wait) covers body read plus decode. Waiters hold no body. The header is inspected before decode. The semaphore is released before any DB write. This answers 006 §3.4.
- **Additive migration.** `database.ts:180-207` only adds columns and tables, is idempotent, and has a read-only fast path. `migration007.test.ts` rewinds a populated DB to the 006 shape, runs concurrent cold starts and checks users, wardrobe JSON, photo bytes, a queued job, a completed job, usage carry-over and `integrity_check`. That is a real test.
- **Refused-BEGIN signup and verify.** `contention007.test.ts` shows 503 plus `Retry-After`, no user created, and the verification token not consumed. Matches the claim.
- **Dress code and shoe pair.** The AI formality is a suggestion only. The item stays "unknown" until the user chooses (`UploadDialog.tsx:324,792-806`). Pair merge is suggestion-only, bounded by gap and size ratio, and resets review (`pairs.ts`). Both have browser tests (`review007.spec.ts`).
- **Brand and size.** They are enforced empty in the schema (`analysis.ts:86-87`), in the prompt, and again after parsing (`vision.ts:180`). Review restore also forces `""` (`UploadDialog.tsx:121-122`).
- **Account binding.** Review data in `sessionStorage` is keyed by account and job. Foreign entries are purged on open, and it is used only after the server confirms the job (`UploadDialog.tsx:57-70,199-247`). Mutations require `x-style-account`.

---

## 3. Batch A: accept or reopen

| Item | Status | Notes |
|---|---|---|
| Queue admission, deadlines, ETA | **Accept** | Worst-case arithmetic is correct. Server `expiresAt` and `serverNow` drive the client. See §5.2 for the ETA floor and the timeout refund. |
| Refunds | **Accept with P2** | Mechanism is sound. Policy has an abuse hole: §5.1. |
| Owner-only discovery and resume | **Accept** | |
| Abort and cancel | **Accept** | Tested against a mock and once live. |
| Cancel despite change quota | **Accept** | |
| Watcher, ownership, lease | **Accept** | |
| Bounded uploads and image memory | **Accept** | One residual: §5.7. |
| Explicit shoe pairing | **Accept** | |
| Dress-code confirmation | **Accept** | |
| Acknowledged-save retention | **Accept with P2** | Retry with the same bytes is safe. Retry after a lost response plus an edit self-conflicts: §5.3. |
| Stable IDs `${jobId}-${index}` | **Accept** | Upsert by id prevents duplicates. Limits are in §5.4. |
| Additive migration | **Accept** | |
| Private-build packaging | **Accept as a fail-closed gate, with P2 gaps** | §5.5. Docker untested. |
| Generic-error / mail / erasure / restore / dense | **Not part of batch A; still open** | §4. |

I reopen nothing in batch A as a regression. I found no regression against 006 in the files I read.

---

## 4. Confirmed P1 defects (fix before any beta with non-team users)

### 4.1 P1: dense wardrobe photos cannot succeed, fail whole, and are charged [Code-proven; capacity numbers Hypothesis]

Evidence:
- `vision.ts:105`: `num_predict: 2048`, `num_ctx: 4096`.
- `analysis.ts:38,47-104`: up to 30 items; each item has about 12 fields and a 150-char evidence string. At roughly 100–150 tokens per item, about 15–20 items fill the budget.
- `vision.ts:142-176`: the output is `JSON.parse`d whole. Truncation throws, which becomes `VisionError("unverified")`. Nothing is salvaged.
- `analysisJobs.ts:961-962`: unverified output is recorded as `failure_kind='model'`. It is not refunded, and the user gets "This photo could not be analyzed. Try again."
- The model sees only a 768 px image (`vision.ts:86-89`). Boxes on a crowded wardrobe photo are coarse.
- Time: CPU decode is likely to be limited by `num_predict`, not only by the image. At the observed 214–243 s for one garment, a dense answer will hit the 240 s timeout (`vision.ts:96`) first. A timeout is recorded as a server failure and refunded. The user then retries the same photo, which fails the same way.
- No fixture or test has more than three garments. `tests/fixtures/two-garments.jpg` is the densest.

**Impact:** "Upload a whole wardrobe photo" fails on exactly the inputs it exists for. The user loses up to 4 minutes of queue per attempt and gets a generic message.

**Fix, in order:**
1. Salvage: parse the longest valid prefix of `items` and set a `warning` ("Only the first N items were read; photograph the rest separately").
2. Shrink the per-item schema for dense images. Drop `evidence`, `sleeve`, `neckline`, `closure`, `length` from the first pass.
3. Tile: 2×2 with overlap, one bounded call per tile as sub-steps of the same job, merge by box IoU, progress "part 2 of 4". Persist each tile's result so a worker restart resumes. Each call then has a fixed, measurable duration, and the queue arithmetic in §2 becomes honest.
4. Do not claim whole-wardrobe support in README, UI copy or marketing until a fixture with 10, 20 and 30 garments passes.

**Smallest test:** a mock Ollama returning JSON truncated after item 12 must yield 12 items plus a warning, not a failed job. Then a recorded real response for a 15+ garment fixture on the target host, reporting recall, schema-failure rate and latency p50/p95.

### 4.2 P1: restore cannot run on a fresh server, and the deletion ledger is not exported [Code-proven; unchanged from 006 §3.10]

- `scripts/restore-database.ts:20-23` throws when `app.db` does not exist. That is exactly the disaster-recovery case.
- The ledger exists only inside `app.db` and inside backups. Backups go to `/data/backups` on the same volume as the live DB (`backup-database.ts:12-14`), unencrypted.
- A user deleted after the latest off-server backup is silently resurrected if the operator restores an older copy to a new machine. `DEPLOYMENT.md:70` says "preserve the latest deletion ledger separately", but no command produces one.
- There is no scheduled backup in `compose.yaml`.
- `backup.test.ts` covers only the case where the live DB survives.

**Fix:**
- `scripts/export-ledger.ts` writes a small checksummed file from `account_deletions`. The backup command runs it every time and writes it next to the backup.
- Add a fresh-server restore mode that takes a ledger file instead of requiring a live DB.
- Schedule backups and add the encrypted off-server copy.
- State the ledger and backup retention honestly (§4.4).

**Smallest test:** back up, delete a user, export the ledger, wipe `app.db`, restore into an empty data dir with the ledger, and assert the deleted user is absent and the sessions are cleared.

### 4.3 P1: detached mail has no durability [Code-proven absence; unchanged from 006 §3.8]

**Correction (added after root's probe, see `docs/verification/SMTP_OUTAGE_PROBE.md`):** the crash hypothesis in my first draft was wrong and did not reproduce. Root ran signup against a closed local SMTP port in an isolated DB; signup returned normally, Better Auth logged ECONNREFUSED, and the process survived and exited 0. Better Auth 1.7.7 (`context/create-context.mjs` 215–224) passes `promise.catch(logger.error)` to the configured handler. This is **not** a P0. The probe does not cover every callback path. The durability defect below stands.

- `auth.ts:130-134`: `handler: (promise) => { void promise; }`. Failures are logged by the library and the message is then lost.
- Mail is lost on failure or restart. There is no outbox, retry, bounce handling or user-visible "we could not send". Users recover only by retrying under the rate limit (3/min per IP).
- No test sends through a failing transport. All mail tests use the file outbox (`mail.ts:100-112`).
- Per-IP throttling only. A shared NAT can lock out real users, and a distributed attacker can mail-bomb one address.

**Fix:**
- Always attach a catch: `handler: (p) => { void Promise.resolve(p).catch(logMailFailure); }`.
- Add a durable `mail_outbox` table written with the token. The worker sends with backoff and clears bodies when done.
- Add per-recipient hourly caps.
- Show "If an account exists we sent an email; check spam or resend".

**Smallest test:** point `SMTP_URL` at a closed port, sign up and sign in. Both must return normally and the process must stay alive. Then kill the process after commit and assert the mail is delivered after restart.

### 4.4 P1: erasure is logical only, and the deletion dialog says otherwise [Code-proven; unchanged from 006 §3.9]

- `AccountDialog.tsx:101`: "This permanently removes your wardrobe, saved looks and photos."
- `README.md:31` already admits "Erasure from SQLite free pages and backups is logical only". The user-facing text does not.
- Live DB: no `secure_delete`, no `auto_vacuum`, no checkpoint-and-truncate outside the restore script. Deleted BLOB pages stay in the file's free list and in the `-wal` until overwritten. Temporary analysis photos live in `app.db` (`analysis_jobs.input_image`), the highest-churn sensitive data.
- Backups: 7-day local retention, unencrypted, same volume. A deleted user's photos remain in them for up to a week. The backup strips only the temporary photos.
- The tombstone keeps a pseudonymous id indefinitely.

**Fix, in order of preference:**
1. Keep temporary photos and results out of `app.db`: tmpfs, or per-job encrypted files with a key held in the worker and discarded after use.
2. `PRAGMA secure_delete=ON` on both connections, plus a periodic `wal_checkpoint(TRUNCATE)` and occasional `VACUUM` or `incremental_vacuum` from the worker when idle.
3. At minimum, change the copy now: "Deleted from the live service immediately. Encrypted backups are kept for up to 7 days. We keep an anonymous deletion record so deleted accounts are not restored." Do the same for the upload note.

**Smallest test:** upload a distinctive marker image, delete the account, run the chosen cleanup, then scan `app.db` and `app.db-wal` for the marker bytes.

---

## 5. Confirmed P2 and lower defects

### 5.1 P2: a deterministic timeout is refunded, so a hard photo can burn worker time for free [Code-proven]
- `analysisJobs.ts:964-970`: any non-"unverified" error, including the 240 s timeout, becomes `failure_kind='server'`, and `:736-737` refunds it.
- Each failed attempt costs the single worker up to 240 s. The only bound is `dailyAttempts` (40). Forty attempts is 2.7 hours of worker time per account per day. A few verified accounts can keep the 12-deep queue full.
- It also hides a real problem from the user, who sees "not counted. Try again" for a photo that will never succeed.

**Fix:** distinguish "model unreachable" (refund) from "timed out while running" (charge, or refund once per hour). Lower `dailyAttempts` to about 10. Add a per-IP or per-new-account throttle on uploads.
**Smallest test:** a mock that holds past the timeout; assert the second consecutive timeout for one account is charged or refused.

### 5.2 P2: the displayed ETA is below the observed time, and there is no headroom against the timeout [Code-proven + live evidence]
- Default ETA floor is 120 s (`limits.ts:56-60`). The live evidence shows one easy photo at about 214 s (cancel run) and 242.586 s (end-to-end browser run). The first user sees "about 2 min" and waits about 4.
- `perJobEstimateMs` adapts after five completions, and only within a 6 h window pruned at startup (`analysisJobs.ts:559`).
- The 240 s timeout is under 15% above the measured easy case. One slow CPU moment or model reload makes an ordinary photo fail and be refunded (§5.1).

**Fix:** raise the default estimate and timeout after a target-host benchmark. The 4B CPU numbers need a p95 on the real host. Keep `OLLAMA_KEEP_ALIVE` long so the model stays loaded. Do not use the single fixture as that benchmark.

### 5.3 P2: a lost success response followed by an edit produces a false "changed on another device" conflict [Code-proven; not covered by the lost-response test]
- `wardrobes.ts:100-108` acknowledges only a byte-identical retry. `useStyleStore.ts:111-115` keeps `revision.current` stale when the response is lost.
- Sequence: save commits at revision N→N+1, response lost, the user corrects an item name and saves again. The request carries `(N, new bytes)`. The server sees revision N+1 and different JSON, and returns 409 with "changed on another device. Export your unsaved changes, then reload."
- Nothing is lost (the first version is saved), but the user gets a wrong, alarming message and a forced export-and-reload.
- `review007.spec.ts` "lost success response" retries unchanged bytes; "latest values" fails before commit. Neither covers this case.
- Related, 006 P2 #6 is still open: conflict recovery is export-and-reload only, with no merge by item id.

**Fix:** after any ambiguous failure (network error, 5xx, timeout), `GET /api/wardrobe` first. If the server's revision is newer, rebase local edits onto it by item id (the ids are stable now). A cheaper alternative is a client-generated mutation id stored with the revision, so the server can recognise "this write already applied".
**Smallest test:** the lost-response browser test with an edit between the two attempts, expecting one item, the edited name and no conflict message.

### 5.4 P2: save retries re-upload every unsent image and consume the change quota [Code-proven; 006 P2 #5 still open]
- `serverRepository.ts:46-53`: every `data:` image is uploaded again on each save attempt, sequentially. A failed `PUT` returns nothing, so the uploaded ids are never written back into state.
- Each upload is a mutation (`access.ts:70-83`, 120/min).
- A 30-item whole-wardrobe save is 30 uploads plus one PUT. Two failed attempts inside a minute exhaust the quota and the user gets 429 "Please wait a minute". Backup import (many distinct images) hits the same wall.

**Fix:** write uploaded ids back to state as they succeed, and meter photo uploads by bytes instead of the change counter.

### 5.5 P2: packaging gate is fail-closed but thin [Code-proven gaps; Docker is External gate]
What is good: the sanitizer removes only paths inside `.next`, reads manifest lists and names (not contents), unlinks links instead of following them, and fails the build on anything odd. `start-server.ts` re-checks at startup. The verify step is path-only.

Gaps:
- `assertInside` (`packaging-rules.ts:54-60`) is lexical (`path.resolve`), not physical. It does not `realpath` `.next` itself. A `.next` that is a junction or symlink would pass. `standalone` is `lstat`-checked, but its parent is not. Resolve both with `realpathSync` and compare to the project root.
- A name beginning with `..` (for example `..data`) makes `rel.startsWith("..")` throw. That fails closed, which is acceptable, but it is a false positive.
- Missing required dependencies are checked only for `node_modules/next` (`packaging-rules.ts:134`). Nothing proves `sharp` and its native `@img/*` package, `better-auth`, `kysely`, `@better-auth/kysely-adapter`, `nodemailer`, `proper-lockfile` or `zod` survived the Windows sanitizer or the Linux excludes. A missing one only shows at the first request.
- The build briefly copies real `.data` (database, auth secret) into `.next/standalone` before the sanitizer deletes it. That window is on the builder's disk only, but it is real. On Docker, `COPY . .` also brings `tests/` and `docs/` into the build stage.
- Docker/Linux has never been run. The Windows glob workaround is what actually makes the build safe locally, and the Linux excludes are untested.

**Smallest tests:**
1. A unit test of `forbiddenReason` and the sanitizer on a temp tree: a junction to a decoy directory, a `.data` copy, a `..x` name, and a missing `sharp`; assert the decoy target survives and verify fails closed.
2. Add a required-dependency list to `collectPackagingProblems`.
3. A CI job that builds the Docker image, starts the standalone server, and hits `/api/health` and one analyze → worker round trip with a mock model.

### 5.6 P2: model free text is not checked for brand or material claims [Hypothesis; needs a recorded-output test]
- Only `brand` and `size` are zeroed (`vision.ts:180`). `name`, `pattern`, `color` and `evidence` are model text saved as-is. The prompt asks the model not to infer fabric, but the schema (`analysis.ts:67-69`) does not stop "Cotton tee", "Leather boots" or "Nike hoodie" in `name`, and nothing filters `evidence`.
- The review card shows `evidence` as fact under "AI suggestion · confirm the visible details".

**Fix:** a small post-parse check that strips or flags known material and brand words in `name` and `evidence`, plus a UI note on the card. Add recorded outputs containing such words to a regression test.

### 5.7 P2: read endpoints still take the write lock [Code-proven; 006 P2 #1 unchanged]
- `analysis-jobs/[id]/route.ts:21` and `wardrobe/route.ts:15` use `runWriteTransaction` for GET. Poll and page load queue behind sign-up transactions that hold the gate during password hashing (`authDialect.ts:35-39`). With 12 active users polling every 2–3 s that is a few write transactions per second.
- Make the poll a read with expiry applied in memory. Move orphan-photo reclaim (`wardrobes.ts:18-38`) to a worker maintenance tick.

### 5.8 P3 and operational items
- Sweeps are event-driven (startup, enqueue, claim, own GET). If the worker is down and nobody enqueues, a photo can outlive the hour in the database. Add a periodic sweep in the web process. `analysis_timings` is pruned only at startup.
- `compose.yaml`: no model pull or readiness check (a missing model shows only as "temporarily unavailable"), no Ollama memory limit, no worker health check, and the `proxy` still gets `.env.production` including `AUTH_SECRET` and `SMTP_URL` (006 P2 #8). `VISION_MODEL` is documented but hard-coded (`vision.ts:26`; 006 P2 #9).
- No Content-Security-Policy in `deploy/Caddyfile` (006 P2 #7). Per-account login backoff is still absent.
- `photoHash` for a resumed job is computed from the server's re-encoded image, but for a fresh upload from the client's image. The duplicate-photo guard can miss the same photo across the two paths. Cancel while the POST is in flight can leave an orphan job that later reappears as "Your earlier photo is still being analyzed".
- `mail.ts:124,136` interpolates the URL into HTML without escaping. The URL is server-built, so this is low risk.
- `Delete account` needs the password; a user who forgot it must reset first. That is fine, but say it.

---

## 6. Claims I could and could not verify

- **No earlier autocommit side effects.** Only the refused-BEGIN signup and verify path has proof (`contention007.test.ts`). `authDialect.ts:104-118` also replays any single autocommit statement refused with BUSY. That is safe if SQLite refuses a statement before it runs, which is the normal case for a write-lock refusal, but no test holds the lock and fires the auth autocommit statements (rate-limit upsert, session refresh, token delete, password reset). **[Hypothesis]**; smallest test: hold the lock, fire each of those, release, and assert no duplicate or lost effect.
- **Concurrency.** The 7/7 and 40/40 results are real evidence of the gate design. As the author states, polling and yield improve the odds but do not guarantee FIFO. I agree the BEGIN exhaustion is mitigated rather than eliminated. A bounded 503 with `Retry-After` is the right failure mode.
- **Meaningful tests.** `queue007`, `migration007`, `contention007` and `review007.spec` use real DB state, a real HTTP mock model and failure injection. They are meaningful. The browser tests fulfil API routes with mocks, so they prove client behaviour only, not server and client together.
- **Live evidence.** The single repeated shirt run (242.586 s) and the cancel run (214.303 s for the next shirt) prove the path works once. They prove nothing about multi-garment accuracy, dense photos, p95, concurrent users or the target host.

---

## 7. External release gates (not code defects; all absent)

| Gate | Needed |
|---|---|
| Real host, domain, DNS, TLS | Provisioned host, ports 80/443 only, HSTS, `Secure` cookies, correct client IP behind Caddy (Better Auth per-IP limits depend on it), cross-origin POST 403. |
| Real SMTP | SPF, DKIM, DMARC aligned. Delivery to at least two providers, with timings. Behaviour with SMTP blocked (§4.3). |
| Docker build and cold start | `docker compose build` and `up` on the target OS. Check the `node_modules` overlay in the runtime image, that `tsx` runs as the non-root user, and that app and worker share WAL safely through the volume. Worker supervisor and shutdown. |
| Ollama in the container | Model pulled, memory behaviour, idle unload and cold-load time, CPU versus GPU choice recorded. |
| Target capacity | A single worker at 214–243 s per easy photo is about 15–17 photos an hour for the whole service. Measure p50/p95 queue and inference, peak RSS, disk growth and lock waits at intended concurrency. |
| Offsite encrypted recovery | Backup, encrypt, copy off server, restore on a clean machine with the ledger, with a deletion made between backup and drill (§4.2). |
| Recognition | The held-out, licensed or consented set in `docs/VISION_EVALUATION.md`, by slice including dense, shoes, patterns, dark and light, and negatives. |
| Real devices and consumers | At least five non-team users complete sign-up, upload, review and an outfit unaided, on real phones. |
| Monitoring | Alerts for stale worker heartbeat, oldest job age, disk, mail failures, restarts. |
| Policy | Privacy and terms that match §4.4, retention, and a contact route. |
| Abuse and cost | Throwaway-account policy: 2 GB global photo cap versus 100 MB per account, unverified-account cleanup, and the refund abuse in §5.1. |

---

## 8. Prioritised next repair batch (batch B)

1. **Dense wardrobe (§4.1)**: salvage partial JSON, compact schema, tiling with persisted tile results, a 10/20/30-item fixture. Pair it with the timeout and refund policy (§5.1, §5.2).
2. **Mail (§4.3)**: add the catch now (a one-line fix), then the durable outbox, the failing-SMTP test and per-recipient throttles.
3. **Erasure and copy (§4.4)**: correct the deletion and upload wording now; then `secure_delete`, checkpoint and vacuum; then move temporary photos off `app.db`. Add a marker-byte test.
4. **Restore (§4.2)**: ledger export, fresh-server mode, scheduled and encrypted offsite backup, restore-into-empty-dir test.
5. **Save robustness (§5.3, §5.4)**: GET-then-rebase after an ambiguous failure, write back uploaded ids, byte-based upload metering.
6. **Packaging tests (§5.5)**: `realpath` boundaries, required-dependency list, sanitizer unit tests, Docker build plus health plus round trip in CI.
7. **Read paths and sweeps (§5.7, §5.8)**: GET without write lock, periodic sweep, compose health and model readiness, CSP, secrets scoped to the proxy.
8. **Free-text guard (§5.6)** and the autocommit lock-hold test (§6).

---

## 9. What must still pass before I would approve

1. Every P1 in §4 fixed, with its smallest test green.
2. Dense-wardrobe fixtures (10, 20, 30 garments) passing on the target host with measured recall, schema-failure rate and latency p50/p95.
3. A restore drill on a clean machine with the ledger and a deletion made after the backup.
4. A failing-SMTP test, then real delivery to two providers.
5. A Docker build and cold start passing the packaging check on Linux, including a worker round trip.
6. Target-host capacity numbers that replace the starting limits.
7. Copy that matches what deletion and retention actually do.
8. Real-device and non-team consumer acceptance, and the remaining §7 gates.

Passing local tests and the single live run do not substitute for any of these, and I have not treated them as such.
