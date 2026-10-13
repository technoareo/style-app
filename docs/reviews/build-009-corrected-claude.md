# Build 009 (corrected) independent review (Claude)

Reviewer: Claude, second reviewer. Date: 12 October 2026.
Subject: `release-snapshots/build-009-corrected` only. `SOURCE_MANIFEST.json` lists 133 entries (I counted them). Root reports zero hash changes and BUILD_ID `uQcx9u-SKHj4_wfgHvJQQ`. I could not recompute hashes; I used no shell.
Method: static reading with Read, Glob and Grep. I ran no build, test, browser, server or network call. I did not open `.data`, `.runtime`, `.env`, secrets or photos. Every runtime statement comes from root's evidence or from reading code.
I changed no source and no snapshot. The only file I wrote is this one.

Labels:
- **[Code-proven]** follows from code I read.
- **[Test-shown]** a snapshot test asserts it. I read the test; root ran it.
- **[Hypothesis]** needs the named test.
- **[External gate]** needs real-world evidence.

Paths are relative to `release-snapshots/build-009-corrected` unless noted.

**Read in full:**
- Evidence and notes: `REVIEW_EVIDENCE.md`, `SOURCE_MANIFEST.json`, `docs/reviews/implementation-009-notes.md`, `docs/verification/BUILD009_FINDINGS.md`, the corrected probe and its JSON, `docs/DEPLOYMENT.md`, and the prior `build-008-claude.md`.
- Source: `src/server/directoryLock.ts`, `backupDatabase.ts`, `mailHealth.ts`, `mailOutbox.ts`, `limits.ts`, `sqliteRetry.ts`, `scripts/backup-database.ts`, `restore-database.ts`, `mail-worker.ts`, `compose.yaml`.
- Tests: `tests/backupSafety.test.ts`, `restoreCredentials.test.ts`, `mailWorker.test.ts`, `helpers/backupChild.ts`, `helpers/mailWorkerFreeze.ts`.

**Read in part:**
- `database.ts` (all but the middle of the schema block), `UploadDialog.tsx` (lines 195-660), `AuthScreen.tsx` (login note only), `tests/backup.test.ts` (60-130), `tests/e2e/review007.spec.ts` (helpers and the two cancel tests), `analysisClient.discardJob`.
- `auth.ts`, `README.md`: by search only.
- Better Auth `rate-limiter/index.mjs` and `utils/ip.mjs`, from the main `node_modules` (not the snapshot). I did not check them against the lockfile.

**Not read, so no claim is made:** `mail.ts` (untouched in 009; 008 review stands), `Dockerfile`, `Caddyfile`, `ci.yml`, `authProbeChild.ts`, the other test files, vision/queue/worker/packaging code, `verify-standalone.ts`.

---

## 1. Verdict

**Not approved for public launch. I agree with root.**

- The three 008 items this batch targeted are closed at code level, with root-run test evidence on Windows: the mail-worker heartbeat and shutdown (008 §4.1, §4.2), failure-safe serialised backups (§3.2), and password revival on restore (§3.1). I found no regression and no reopened 008 finding.
- I found **no P0 and no P1 defect in the frozen code.** I found three P2 items and several P3 items, listed in §4. All are bounded, and none needs Docker or a real provider to fix.
- Two items matter more than the rest for the next batch:
  - **§4 F1:** restore cannot prove that writers are stopped. It is a disaster-time command.
  - **§5 H2:** a possible backup starvation under the system's own heartbeat writes. It is unproven, and it could make backups fail at realistic size.
- Everything root listed as not launch-approved stays open and I add nothing to close it: dense wardrobe, physical secure delete and WAL maintenance, fresh-server restore and ledger export, encrypted offsite backup, SMTP TLS/AUTH/real provider, drop visibility, secret scope, Docker and target host, held-out recognition, real consumer devices.
- Suggested status is unchanged from 008: a closed, invite-only technical beta with the team is defensible after the next batch. Nobody outside the team should rely on it, because the core "photograph the whole wardrobe" promise has no passing evidence.

---

## 2. 008 findings: closed, reopened, still open

| 008 item | 009-corrected status | Basis |
|---|---|---|
| §3.1 P1 restore revives revoked passwords | **Closed** | `restore-database.ts:89-91` nulls every credential password inside the restore transaction. `restoreCredentials.test.ts:50-170` asserts old, new and unchanged passwords are all refused by a fresh Better Auth process, and that the email reset recovers A and B. Deleted user C stays deleted; B's photo and wardrobe survive. [Code-proven][Test-shown]. Residuals in §3.3 and F1, F7. |
| §3.2 P1 unsanitised backup under its final name | **Closed** | Partial, sanitise, verify, no-overwrite publish (§3.1 below). [Code-proven][Test-shown]. Residuals F3, F4, F5, F6, H2. |
| §3.3 P1 fresh-server restore and ledger export | **Open, unchanged** | `restore-database.ts:20-23` still throws without a live `app.db`. Nothing writes a ledger. Lines 24-47 are still dead-code-shaped. |
| §4.1 P2 heartbeat outer-loop only | **Closed** | `mailHealth.ts` and the progress-gated beat. Real-child tests (§3.2). Residual F2. |
| §4.2 P2 shutdown cannot cancel a send | **Closed at code and Windows-IPC level** | `mailOutbox.ts:336-345`, `424-479`, `506-582`. The SIGTERM path and Docker are not exercised (§3.2). |
| §4.3 P2 silent drops invisible | **Open** | Not touched. `mailQueueStats` (`mailOutbox.ts:613-628`) has no drop counters. |
| §4.4 P2 SMTP secrets reach four containers | **Open** | `compose.yaml:5,46,66,110`: `env_file` on app, worker, mailer and proxy. Unchanged. |
| §4.5 P3 mail items | **Open, not re-examined** | Sequential sender, sweep only inside the mailer, unsalted `recipient_key` (`mailOutbox.ts:72-73`), sign-up atomicity test. |
| §5 SMTP TLS, STARTTLS, AUTH | **Open** | No TLS test, no startup guard. The relay in `mailWorker.test.ts:49-87` is plain TCP. |
| §6 packaging residuals | **Not examined** | Untouched in 009. |
| 007 items (dense wardrobe, physical erasure, timeouts and refunds, save robustness, read-path write lock) | **Open** | Not in scope. Root's own experiments confirm dense wardrobe is unsolved. |
| Reopened as regressions | **None** | |

---

## 3. Assessment of what 009 changed

### 3.1 Backup lock, publication, cleanup (`directoryLock.ts`, `backupDatabase.ts`)

**The final design is sound for what it claims.**
- **How ownership works.** `acquireProcessLock` (`directoryLock.ts:89-136`) opens the empty `backups/.backup-coordinator.db` with a zero busy timeout and runs `BEGIN IMMEDIATE`. It holds that transaction until `release()`. Waiting happens in a 100 ms async poll bounded by `waitMs`.
- **What it removes.** No timestamp, lease, refresh, keeper thread or takeover rename remains. The two earlier failure shapes (a live owner mistaken for dead; a paused contender acting on an old observation) cannot occur. A contender asks and is answered busy or granted at that moment. [Code-proven]
- **Root's evidence.** The 80 s blocked-owner repro now passes: second backup refused at 65 s, partial kept, owner exit 0 (`live-owner-backup-lock-009-corrected.json`). I read the probe; it exercises the production module. `backupSafety.test.ts` shows genuine SIGKILL with immediate reclaim (lines 310-353), two waiters plus a live owner proceeding one at a time (355-387), a 7 s main-thread block (427-456), same-process refusal and grant after release (389-425), and a link-guarded coordinator. [Test-shown]
- **Partial sweep.** `sweepDeadPartials` (`backupDatabase.ts:179-186`) is run only while the lock is held. That is the correct place: the lock is the only proof that no live backup exists.
- **No overwrite.** `publish` (`backupDatabase.ts:271-291`) hard-links the finished partial to a free final name and then unlinks the partial. `EEXIST` moves to `-1`, `-2`. The fallback rename is reached only when link fails for a reason other than `EEXIST`. [Test-shown] for last-moment collision (458-477) and same-millisecond processes (479-530).
- **Cleanup is observable.** `removeOwned` (144-164) returns whether the name is really gone. `BackupFailure.leftovers` and the exit codes carry that out. The stage-injection test covers failure after each stage with marker bytes absent and the earlier backup byte-identical (186-220). [Test-shown]
- **Path guards.** The backups directory must be a plain directory whose realpath equals its path. The coordinator must be a plain file. Owned names are fixed patterns. A link carrying an owned name is unlinked as a link. No recursion anywhere. [Code-proven]. Link tests skip where links cannot be created.
- **Compatibility.**
  - Prune and retention match `FINAL_BACKUP` only (`backupDatabase.ts:73, 188-199`). The coordinator `.backup-coordinator.db` does not match it, so it is never pruned or restored.
  - The restore filename rule (`restore-database.ts:11`) matches the same pattern. A `.partial` is refused (test 310-353).
  - The `-1`/`-2` suffix stays inside the pattern.
- **Test fixture fix is legitimate.** `backup.test.ts:88-92` now selects with the production `FINAL_BACKUP` export. It does not delete the coordinator or mask a missing table.

**What the lock does not cover (all [Hypothesis] until tested; DEPLOYMENT.md states the first two):**
- Reliability on a non-local volume, or on Docker Desktop / virtiofs bind mounts. Test it on Linux ext4 and a Docker named volume with two containers.
- A frozen but alive owner holds the lock for ever. The documented answer is to kill it; the next contender gives up after 30 s with a clear message.
- The coordinator's own file mode is whatever the umask gives. It holds no data, so this is harmless.
- `assertPlainFileOrAbsent` (`directoryLock.ts:78-87`) checks with `lstat` and then SQLite opens by path. That is a time-of-check gap, but exploiting it needs write access to the private backups directory, which is outside the threat model. I record it and do not rank it.

### 3.2 Mail worker health and shutdown (`mailHealth.ts`, `mail-worker.ts`, `mailOutbox.ts`)

**Sound by reading.**
- **Heartbeat.** The timer writes only while the loop reported progress within `mailStepBoundMs() + 15 s` (63 s). Writes never overlap (`mailHealth.ts:49-63`). `processNextMail` reports at start, after claim, after send, after each record try and on return (`mailOutbox.ts:506-582`). The per-try bound is 5.5 s, so no bounded step can exceed the stuck threshold. [Code-proven]
- **Release outcome.** `finishMailLocked` `released` (336-345) is guarded by `status='sending'` and the exact lease. It gives the attempt back (`MAX(attempts-1,0)`) and keeps address and body. A send that completed before the abort is recorded `sent`. A claim that arrives after shutdown is released without calling the sender. [Code-proven][Test-shown] (`mailWorker.test.ts:337-459`, deterministic latches).
- **Shutdown arithmetic.** `mailShutdownWorstCaseMs` = 16.5 s < 25 s hard exit < 40 s `stop_grace_period`. The test asserts all three relations by parsing `compose.yaml` (240-264). [Test-shown]
- **Real-child tests.** Sustained slow deliveries: 14.4 s of continuous work against 5 s freshness, sampled every 100 ms, with the real `--check` exiting 0. Freeze held by the parent through ack and release files until the real cold `--check` returns 1, then recovery. Shutdown in flight: clean exit 0 in under 10 s, relay sees the socket close, row `queued`/`attempts 0`/`shutdown`, logs free of addresses and URLs. [Test-shown]. The fixed-time fixture races from the first corrected run are replaced by ordering and latches. I found no weakened assertion.
- **Test-only freeze hook.** `mailWorkerFreeze.ts` is never imported by `src/` or `scripts/` (grep: no `TEST_*` env in `src/`). [Code-proven]

**Not proven:**
- The SIGTERM path itself. The tests deliver the IPC message `"shutdown"`; production registers the same `beginShutdown` for `SIGINT`/`SIGTERM` (`mail-worker.ts:57-61`). The equivalence is by reading. `docker stop` on a Linux container with node as PID 1 has never run.
- The `mailer` service, its health check and `stop_grace_period` in Docker.
- Persistent processing failure (F2 below).

### 3.3 Restore and credentials (`restore-database.ts`)

- The restore transaction (59-94) applies the deletion ledger, deletes mail, nulls credential passwords, clears jobs, sessions and verification rows, and drops both worker-state tables. They are recreated at the next start: `worker_state` by `CREATE TABLE IF NOT EXISTS` in `database.ts:115`, and `mail_worker_state` because `applicationMigrationApplied` checks the table exists (`database.ts:282-286`) and re-runs the idempotent migration. [Code-proven]
- Session cookie cache is not configured (`auth.ts` has `expiresIn`/`updateAge` at 151-152 and no `cookieCache`), so cleared `session` rows end old sessions. [Code-proven by search]
- Product consequence, accepted by root: every user must use "Forgot password" after any restore, and that needs a working mailer. A user who never changed a password is forced too. The `credential_changes` refinement is not built, which is fine for now.
- The DELETE of a ledger user fires the `user_deletion_ledger` trigger, which writes the restore time; the explicit `INSERT OR REPLACE` that follows restores the original deletion time. [Code-proven]

### 3.4 UI: cancel, save, account invariants (`UploadDialog.tsx`, `AuthScreen.tsx`)

- `cancelAnalysis` (461-492) captures the flow's controller and the job id at press time. After `discardJob` it clears review data for that job. It touches dialog state only if `controller.current` is still that flow, and a superseded failure no longer writes an error over the newer flow. A second press while one is pending is ignored by a ref guard, and the Cancel button is disabled while a cancel is pending (`:673`). [Code-proven]
- `discardJob` treats 404 as success (`analysisClient.ts:79`), so a lost-response retry is safe.
- The new e2e test `review007.spec.ts:417-501` holds the DELETE and the old poll on latches, asserts exactly one DELETE and a disabled second press, and drives the real overlap by `setInputFiles` on the disabled picker. It asserts the newer review keeps its edited name and sees no "Analysis cancelled." The older test (332-415) now waits for completion and an enabled picker. It uses `settle` frames and a latch instead of a 2.2 s sleep. [Test-shown]. I read the specs, not the browser run.
- A person cannot reach the superseded race: the picker is disabled while busy or while drafts exist (`:653`). The guard is defence in depth and is correct. `discardResults` (493-517) has a duplicate guard but no superseded check. That is safe because drafts keep the picker disabled until the discard clears them. [Code-proven]
- Save invariants are unchanged and good: `finishAndSave` (573-607) discards the server result only after the acknowledged save, keeps the drafts for retry on failure, and stable item ids make a retry idempotent. [Code-proven]. The account-id header and `purgeForeignReviews` are unchanged.
- Actual iOS and Android phones are not tested (root says so).

---

## 4. Confirmed defects

None of these is P0 or P1. IDs are used again in §7.

| ID | Pri | Defect | Where | Label |
|---|---|---|---|---|
| F1 | P2 | Restore cannot prove that no process has the live database open. | `scripts/restore-database.ts:29-33, 109-111` | Code-proven |
| F2 | P2 | The mail worker reports healthy while every tick fails, and nothing watches queue age. | `scripts/mail-worker.ts:116-120` | Code-proven; trigger Hypothesis |
| F3 | P3 | Backup durability: fsync errors are swallowed and the directory is never synced. | `src/server/backupDatabase.ts:249-262, 271-291` | Code-proven |
| F4 | P3 | A failure after the link succeeded is reported as "no backup file was created". | `backupDatabase.ts:287`, `scripts/backup-database.ts:41-44` | Code-proven |
| F5 | P3 | Backups directory mode is applied only when the directory is created. | `backupDatabase.ts:119-129` | Code-proven |
| F6 | P3 | The Better Auth rate-limit table (keys contain client IPs) is not sanitised in backups. | `src/server/auth.ts:166-168`, `backupDatabase.ts:201-206` | Code-proven for storage; table name Hypothesis |
| F7 | P3 | Restore failure leaves its staging copy and hides all detail; dead code remains. | `restore-database.ts:24-47, 48, 119-124` | Code-proven |
| F8 | P3 | UI copy and edge cases (list in the notes below). | `UploadDialog.tsx`, `AuthScreen.tsx` | Code-proven |
| F9 | P2 | SMTP URL and `AUTH_SECRET` still reach four containers, including the proxy. | `compose.yaml:5,46,66,110` | Code-proven (008 §4.4 carried) |
| F10 | P3 | `--check` imports the full auth stack per run on a 30 s cadence with a 20 s timeout and 512 MB. | `scripts/mail-worker.ts:1-12`, `compose.yaml:87-93` | Hypothesis (unmeasured) |
| F11 | P3 | Restore recovery load is bounded by the 600/hour mail cap and one sequential sender, with silent drops. | `limits.ts:138`, `mailOutbox.ts:121-132` | Hypothesis (capacity) |

**Notes per finding:**

- **F1.**
  - `wal_checkpoint(TRUNCATE).busy` is non-zero only when another connection is mid-transaction or holds a reader at that instant. Idle open connections from `app`, `worker` or `mailer` return 0.
  - On Linux, `renameSync` then replaces the inode. The still-running processes keep writing to the orphaned file. Their later writes are silently lost, and removing `-wal`/`-shm` under a live mapping is also unsafe.
  - The documented procedure (stop all services) prevents this. It is operator discipline only.
  - Fix: take an exclusive probe on the live file (for example `PRAGMA locking_mode=EXCLUSIVE` followed by a write transaction) and refuse if it fails.
  - Test: hold a second connection open and idle, run restore, assert exit 1 and an unchanged `app.db`. [Hypothesis] for the mechanism until that test passes.
- **F2.**
  - `mail-worker.ts:116-120` calls `heartbeat.progress()` in the catch. A claim or sweep that throws on every pass (a constraint error, a corrupted row at the head of the queue) keeps the beat fresh while nothing is delivered.
  - `--status` has `oldestPendingAgeMs`, but nothing consumes it: `/api/health` is unchanged and there is no alert wiring.
  - Fix: count consecutive failed ticks and stop beating after a small bound, and expose oldest-pending age in a check that something reads.
  - Test: break the claim path (for example a row that violates a constraint) and assert health turns unhealthy within the bound.
- **F3.**
  - `flushToDisk` swallows every error, including EIO.
  - `publish` links and unlinks with no directory fsync, so on power loss the final name can vanish.
  - The script prints success regardless.
  - Fix: fsync the file and the backups directory after publish, treat EIO as failure, and tolerate only EINVAL/ENOTSUP.
  - Test: needs fault injection and cannot be proven on Windows.
- **F4.** `publish` calls `linkSync` and then `unlinkSync(partial)` (287). If the unlink fails, the exception becomes a `BackupFailure`, the cleanup removes the partial, and the script says no file was created. A valid final file exists. Retention was not applied. Low probability. Handle unlink failure after link as success with a leftover warning.
- **F5.** `mkdirSync(..., { mode: 0o700 })` applies only to directories it creates. An existing `backups` directory with looser mode (or another owner) is accepted, and the raw partial inherits the process umask. On POSIX, check `(mode & 0o077) === 0` and that the owner is the current uid, or `chmod`. Files should be created 0600. The Docker image's user and volume ownership are untested.
- **F6.**
  - Rate-limit storage is `"database"` (`auth.ts:168`). Keys are `${ip}|${path}` (`@better-auth/core/utils/ip.mjs:228-230`).
  - Rows are pruned opportunistically when a window rolls over (`rate-limiter/index.mjs:174-184`), so recent rows with IPs sit in the live DB and in every backup for seven days.
  - `SANITISED_TABLES` does not include the rate-limit table, and the backup test seeds no such row.
  - I did not confirm the SQLite table name from the migration output; check it and add the table to the sanitise list and to the restore clear.
- **F7.**
  - `copyFileSync(source, staging)` (48) leaves `app.db.restore-pending` (a full copy, photos included) if any later step throws, and nothing removes it.
  - `catch {}` (121) prints only a fixed line, so the operator cannot distinguish integrity failure from a locked file.
  - Fix: remove the staging file in a `finally` and print a fixed error code, not the message.
  - Remove the dead `existsSync` branch at 24-47.
- **F8.** Four small UI items:
  - The always-visible login note "After a service recovery your old password may no longer work…" (`AuthScreen.tsx:143-149`) is shown to every sign-in visitor all the time. Show it only after a recovery, or reword it as general help.
  - The privacy note "server backups never include temporary photos" (`UploadDialog.tsx:622-625`) is true for completed `style-*.db` files and not for a killed backup's `.partial`. Say "completed backups".
  - `cancelAnalysis` with no job id yet (461-468) aborts the POST in the browser, but the server may already have accepted it. The user then sees a hidden active job, and the next upload follows it ("Showing the photo you already have in progress"). It is recoverable and not harmful.
  - The Discard button is guarded but not disabled while pending (`:911` uses `saving` only).
- **F9.** Carried from 008 §4.4. The web process holds `SMTP_URL` only to run `assertMailConfigured`. Split that check from the credential and remove `env_file` from `proxy`.
- **F10.** Compose runs `--check` as a full cold `tsx` start importing Better Auth, every 30 s with a 20 s timeout. Under memory pressure or a slow disk it could flap unhealthy. A tiny script that only reads the heartbeat row with `node:sqlite` would avoid that. Measure on the target host first.
- **F11.** After a restore every user must request a reset mail. Above about 600 users inside an hour, the hourly cap drops mail silently and the UI says it is on its way. It is the same open item as drop visibility (008 §4.3). Restores with many users should stagger or raise the cap deliberately.

---

## 5. Hypotheses and external gates

**H1. Lock behaviour on other file systems and in containers [Hypothesis].**
- Run `backupSafety.test.ts` on Linux ext4 and on a Docker named volume with two containers sharing it.
- Also try a bind mount from a Windows or macOS host and decide whether to refuse it.

**H2. Backup starvation by the system's own writes [Hypothesis, high impact].**
- `createBackup` uses `node:sqlite` `backup(source, partial)` (`backupDatabase.ts:320`). SQLite's backup restarts when another connection or process modifies the source between steps.
- The mailer writes a heartbeat every 10 s, the AI worker writes its own, and the app writes sessions and jobs.
- Photos live in the database, so a real DB can reach hundreds of MB to GB. A copy that takes longer than the gap between external writes may restart repeatedly and not finish.
- Not a 009 regression: 008 used the same API, and I did not flag it then. Tests use tiny databases, so none would show it.
- Test: a 300 MB or larger database, a second process writing every 5 s, assert the backup completes within a stated bound and passes `integrity_check`.
- If it fails, candidate fixes are `VACUUM INTO` (one read snapshot, no restart) or a very large `rate`. Decide after the test.

**H3. SIGTERM, PID 1 and `stop_grace_period` in Docker [External gate].** The IPC trigger is a Windows stand-in. Run `docker stop` against the real container during a hung send.

**H4. Sign-up atomicity, drop counters, SMTP TLS and AUTH, real providers [carried].** See 008 §4.3, §4.5, §5. No change.

**H5. Evidence limits.**
- Test totals overlap and must not be summed. Root ran the final backend suite (88 pass, 1 Windows symlink skip) and the browser suite (33 pass, 1 skip) once each on this source. I only know the counts from root's text.
- The AI-load runs in the notes were concurrent with other work. Root says so, and I agree they are not benchmarks.
- `README.md`, `docs/DEPLOYMENT.md` and the notes are not in `SOURCE_MANIFEST.json`. They are what I relied on for operator claims, so a hash covering them would make the evidence complete.
- Windows only. No Linux, no Docker.

---

## 6. Launch gates that remain closed

Root's list stands, and nothing in 009 changes any of these:
- **Dense whole-wardrobe recognition.** The 4B closet run timed out at 240 s with zero items. The 2B full schema was cut at length 2048 and invalid. The compact 2B finished in 202 s with invalid geometry. The native corner probe timed out under concurrent load. None of that is an accuracy or capacity benchmark.
- **Physical secure delete, WAL maintenance and markers.** Backups use `secure_delete`; the live database never does (`database.ts:25-34`, only the backup copy sets it).
- **Fresh-server restore, exported latest ledger, scheduled encrypted offsite backup and a recovery drill.**
- **SMTP.** TLS and STARTTLS enforcement, AUTH tests, a real provider with SPF/DKIM/DMARC, drop visibility, secret scope.
- **Docker, Linux, target host, domain and HTTPS.**
- **Held-out recognition set and real consumer devices.**
- **Operational alerts and policies.**
- **Detector research.** The GroundingDINO work is not in this app, and I reviewed no detector code. The Python benchmark failed before inference and the Node variant is only being prepared, so I make no performance or accuracy claim.

---

## 7. Bounded next work, in priority order

1. **Batch D1, restore and backup completion (carried P1 plus F1, F3-F7, H2).**
   - Write a deletion-ledger export beside each backup; make restore accept the ledger file and run on an empty data directory.
   - Add the exclusive-writer probe (F1), staging cleanup and fixed error codes (F7), directory fsync and fsync-failure handling (F3), the F4 and F5 fixes, and sanitise the rate-limit table (F6).
   - Tests: restore onto a clean directory with a ledger, post-backup password reset and post-backup deletion; idle second connection refuses restore; a 300 MB backup with a concurrent writer (H2).
2. **Batch D2, SMTP (008 §5, §4.3, §4.4 and F9, F11).**
   - Require `smtps://` or `requireTLS` in public mode; decide the `smtps` URL-options policy.
   - Add the local TLS relay tests from 008 §5; scope secrets per service; persist drop counters and show them in `--status`; reserve mail budget for resets.
3. **Batch D3, health honesty (F2, F10).**
   - Stop beating after consecutive failed ticks.
   - Expose oldest-pending age to a watched check; replace the heavy `--check` with a small reader if measurement shows flapping.
4. **Operations track, run in parallel by root:** a Linux/Docker run of the full backend suite and the lock tests (H1, H3), then scheduled encrypted offsite backups with a drill.
5. **Physical erasure batch** (`secure_delete`, checkpoint, vacuum, temporary photos off `app.db`, marker-byte test). Do this after D1, so the restore and backup paths are not rewritten twice.
6. **Dense wardrobe: a separate track with its own decision gate.** It is the largest product risk and cannot be settled in a small batch. Decide on the target host whether the closet-photo promise stays, narrows to per-item or few-item photos, or waits for a detector that passes a held-out set.

---

## 8. Independent launch verdict

**Not approved for public launch.** I will re-review after batch D1 and D2 and a clean Linux/Docker run on the target host. Before I would approve, I need to see root run:
- every test named in §4 and §5 (F1, F2, F6, H2 at minimum), passing;
- a restore drill on a clean machine with a ledger, a post-backup reset and a post-backup deletion;
- Docker cold start including `mailer`, `docker stop` during a send, and the container health checks;
- real SMTP to two providers, with a TLS-stripped and a bad-certificate case;
- the dense-wardrobe fixtures on the target host, or a decision that narrows the promise;
- target-host capacity, real-device consumer acceptance, and the monitoring and policy items.

Code-only review is not execution evidence. Nothing here should be read as a pass of any test I did not see root run.
