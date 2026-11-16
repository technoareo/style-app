# Implementation 034: live-database deletion residue (secure_delete + bounded WAL cleanup)

Status: implemented and tested locally on Windows (Node v24.20.0, SQLite 3.53.4 as bundled in `node:sqlite`). **Not committed, not pushed** (as instructed). Not yet run on Linux CI. The product is not launch-ready; nothing here changes the external launch gates.

## Design review before editing (no serious flaw found)

The requested design holds, with these facts established from the code and the installed Better Auth 1.7.7 source:

1. **`secure_delete` alone does not clean a WAL database.** A deleted row's new page image is zero-filled, but the older image stays in `app.db` and in earlier WAL frames until a checkpoint overwrites them and the log is reset. A negative-control test shows both halves (see Tests).
2. **Better Auth's `deleteUser` does not delete `verification` rows.** It deletes sessions, accounts and the user. Reset and delete-account tokens (`value` = user id) and any token addressed to the user's e-mail (`identifier`) outlived the account. The deletion trigger now deletes them in the same statement (behaviour change, additive and required by the brief).
3. **`CREATE TRIGGER IF NOT EXISTS` never upgrades an existing trigger**, so current databases would silently keep the old trigger. The migration drops and recreates it inside the migration transaction.
4. **`afterDelete` is not used.** The handler's deletes are separate commits and a hook would run in the request path. The durable mark lives in the database instead, so a crash between commit and cleanup cannot lose the obligation.
5. A truncating checkpoint can be blocked indefinitely by a reader with an old snapshot (another process). It is therefore bounded, never throws, and leaves the obligation recorded.

## What was built

- `src/server/database.ts`
  - `openConnection` runs `PRAGMA secure_delete = ON` and reads it back; only `1` passes (`2`/FAST is rejected). Failure closes the handle, releases presence and throws `SecureDeleteError`. Covers both live connections (main and auth). Other `DatabaseSync` users are the backup/restore staging copies (already `secure_delete=ON`), the lock/presence anchor databases (no user data) and read-only CI inspection.
  - `secureDeleteActive(db)` / `secureDeleteVerified()` (pure reads) and `mainConnectionOpen()`.
  - Migration `034-physical-cleanup` (inside `migrateApplicationSchema`, so it runs under the existing schema lock and `BEGIN IMMEDIATE`): table `physical_cleanup` (single row), `legacy_deletions` = ledger rows present at first migration, trigger `user_deletion_ledger` replaced. The fast "already migrated" check now also requires the migration row, the table and a trigger body that mentions `physical_cleanup`. Skipped (not recorded) if `user`/`account_deletions` do not exist yet.
- `src/server/physicalCleanup.ts`: `runPhysicalCleanup` (single-flight per process on `globalThis`, because Next bundles routes separately), `schedulePhysicalCleanup`, `readCleanupStatus`.
  - Reads `requested` before the checkpoint; runs `wal_checkpoint(TRUNCATE)` with the in-process write gate held (no async auth transaction can be open in this process, so only other processes can make it busy); a result with `busy = 0` then sets `completed = max(completed, requested-as-read)`. A deletion that commits during the checkpoint stays owed.
  - Bounds: 5 s default budget per run (30 s for the command), gate wait ≤ 2 s, native busy wait is the connection's own 50 ms/20 ms, backoff ≤ 250 ms between attempts. In-process retries after 2 s, 10 s, 60 s and 5 min, then the durable sweep owns it.
  - Never throws; never opens a connection just to clean (`unavailable` after shutdown); never touches user rows.
  - Failure is recorded (`attempts`, `last_attempt_at`, `last_failure_code` = `busy`|`error`) and logged as one fixed line with counters only.
- Retry triggers (all idempotent, all based on the durable mark): after a successful `/delete-user` or `/delete-user/callback` response in the auth route (scheduled 250 ms later, never awaited, never changes the response); 1 s after `getReadyAuth()` (every process start: app, AI worker, mailer); the mail worker once a minute; `scripts/cleanup-deleted-data.ts` (`npm run cleanup:deleted-data`).
- `/api/health`: fixed `{ready:false}` if any open connection **of the web process** is not `secure_delete=ON` (readiness is per process; workers verify at open and refuse to start, their health checks do not look at it). A merely **owed** cleanup does not make readiness fail (the deletion is committed; a restart would not help). Status is exposed to operators through the command, not the public route.
- Dockerfile copies the new script (the deployment-scripts test requires it because DEPLOYMENT.md now references it).

## Guarantees

- A committed account deletion always leaves a durable owed mark; a rolled-back one leaves none (tested).
- A cleanup failure, busy database, crash or restart cannot resurrect data or change the deletion result (tested via the route: response 200, user gone, cleanup stuck busy, then completes).
- No user id, address, path, SQL or error text is logged or printed by the cleanup (tested for the log line and the command).
- Counters are exact under three concurrent processes (12 deletions → `requested` = 12).
- Existing behaviour is preserved: the auth dialect, gate, write path, ledger, backup and restore are unchanged; the full existing suite is run (see Results).

## Tests (all new, all real files)

- `tests/physicalCleanup034.test.ts`: secure_delete verified on both connections and readiness fails when off; **physical markers** (saved photo, queued photo, queued mail, verification token, session, account) are present in `app.db` before, still present after the deletion without cleanup (control), and absent from `app.db` and `app.db-wal` after cleanup, WAL ≤ 3 frames (the only post-truncate write is the bookkeeping UPDATE); busy (real reader holding an old snapshot) leaves it owed and a later run finishes; injected checkpoint error → `failed`, fixed log line with no user data; route scheduling plus busy plus automatic retry; restart recovery (connections closed, mark still owed, reopened connection re-verified, finished).
- `tests/physicalCleanupConcurrency034.test.ts`: three real processes create/delete/clean concurrently, exact counters, integrity check, no markers; the **negative control** (without `secure_delete` the same truncating checkpoint leaves the bytes in `app.db`); the operator command's exit codes (0/3) and `--run`.
- `tests/physicalCleanupMigration034.test.ts`: a database put back into its exact pre-034 state (old trigger, no table, two legacy tombstones, existing users/photos/tokens) is migrated in place, idempotently; legacy count fixed at first migration; verification rows removed by user id and by e-mail address while someone else's token is untouched; rolled-back deletion leaves no mark.
- Test determinism note: the marker tests set `wal_autocheckpoint=0` on their connections so nothing checkpoints behind the test's back. Production keeps SQLite's default.

## Results (run by the builder in this session)

See the "Results" section at the end of this file for the exact commands and outcomes.

## Candid limits (also in README and docs/DEPLOYMENT.md)

- **Pre-034 residue is not scrubbed.** Deletions made before this build had no `secure_delete`; freed pages may still hold old bytes. `legacyDeletions` counts them. A live `VACUUM` is unbounded (rewrites the file, needs about the database size in free disk and an exclusive lock), so it was deliberately not added. The tested route to a clean file is restore onto a fresh volume (its staging step uses `secure_delete` + `VACUUM`); an offline VACUUM of a stopped service is untested.
- **Only account deletion forces truncation.** Cancel/discard/expiry get `secure_delete` but older WAL copies persist until the log cycles or the next account-deletion cleanup.
- **Rate-limit rows (client IPs) are not removed on account deletion** (keyed by IP and path, not by account). Unchanged.
- **Backups, encrypted packages, off-server copies, snapshots**: untouched and still contain the account until their own retention ends.
- **Filesystem / SSD / COW / journaling / swap / crash dumps**: out of reach of any application-level overwrite; wear levelling and snapshots can keep old blocks. Full-disk encryption with an off-volume key is the control and remains the operator's job.
- **Evidence is two files only** (`app.db`, `app.db-wal`) on Windows with SQLite 3.53.4. Linux CI and Docker were not run by the builder. The `-shm` file holds no row content and was not scanned.
- A cleanup can stay owed while any process holds an old read snapshot; the command and the log line make that visible, nothing forces the other process to let go.
- Closing the last connection normally checkpoints and removes the WAL, which would also clean it; that is incidental and not relied on.

## Not verified

- Linux/Docker/Compose behaviour (CI), real SMTP, a public domain, large databases (checkpoint time grows with WAL size; the bound is time-based, not size-based), NFS/network volumes (WAL is unsupported there anyway).
- No attempt was made to inspect raw disk blocks, snapshots or SSD remapping.

## Results

Run by the builder on Windows 11, Node v24.20.0, 2026-11-11. Nothing was committed or pushed.

- `npx tsc --noEmit`: exit 0.
- `npm run lint` (`eslint src`): exit 0, no output.
- Focused: `tests/physicalCleanup034.test.ts` 6/6, `tests/physicalCleanupConcurrency034.test.ts` 3/3, `tests/physicalCleanupMigration034.test.ts` 1/1.
- Full `npm test`, run alone on an otherwise idle machine: 776 tests, **770 pass, 0 fail, 6 skipped** (the existing POSIX-only and opt-in large-database tests).
- **An earlier full run had 2 failures** (`tests/concurrency.test.ts` "simultaneous HTTP auth ... never hit 'database is locked'" and `tests/contention.test.ts` "a write that cannot get the lock within its budget..."). That run overlapped with my own heavy focused tests on the same machine (my three-process test took 84 s instead of about 16 s). Both tests passed when re-run on their own and in the clean full run above. I attribute the failures to CPU/IO starvation from my parallel runs, which is consistent with the logged `sqliteMs: 10005, attempts: 83`, but I did not prove it by reproducing the failure on demand or by running these two tests against the pre-034 tree. Treat it as unconfirmed; the Linux CI run is the second opinion.
- Not run: `npm run build`, e2e, Docker/Compose, Linux CI.

## Independent review (verdict: CHANGES REQUIRED) and the fixes

The independent review of the first Build 034 candidate returned **CHANGES REQUIRED** with ten actionable items. The message that commissioned this revision carries only the verdict and the list below; it did not include the reviewer's full text, root's own evidence or any reproduction output, so none is quoted or invented here. If root has run the candidate (Linux CI, Docker), append that evidence in a "Root evidence" section; at the time of writing there is none.

| # | Finding | Fix | Where it is tested |
|---|---|---|---|
| 1 | After a successful checkpoint and `markDone`, a deletion committed meanwhile left `completed < requested` but the call still returned `clean`; a caller that joined an in-flight run could return clean while owed. | `doCleanup` loops: after bookkeeping it re-reads the counter and runs another pass (within the budget) until nothing is owed; out of budget returns the new retryable outcome `pending`. `runPhysicalCleanup` re-checks after the run for the starter AND every joiner and reruns (max 3), else `pending`. | `physicalCleanup034`: "a deletion that commits between the target read and the bookkeeping...", "every caller, including one that joined...". |
| 2 | No deterministic test of that race. | Test seam: the checkpoint hook commits a second deletion after the target was read and before `markDone`; asserts the target was stale (still pending after the first bookkeeping), exactly 2 checkpoints, clean only when not pending. A second seam (`beforeReportClean`) injects a deletion plus a joining caller after the final read. | same two tests. Not mutation-tested against the old code (I did not run the old code); the assertions `pendingAtSecondCall === true` and `calls === 2` fail by construction on a single-pass implementation. |
| 3 | A fresh deletion did not shorten a pending long (up to 5 min) retry timer. | The single timer now records its due time; a call that wants an earlier run clears and replaces it (and restarts the backoff), a later request changes nothing. `scheduledCleanupDueInMs()` exposes it for diagnostics and tests. | "a fresh deletion pulls a long pending retry timer forward...". |
| 4 | `markDone` and `recordFailure` wrote on the main connection without the write gate and could in principle run inside another writer's open transaction. | Both run under `acquireWriteGate` (`underGate`); `markDone` is retried by re-acquiring the gate each time; `recordFailure` is best effort. | "bookkeeping takes the write gate...": the test holds the gate with `BEGIN IMMEDIATE` open on the main connection; the checkpoint hook must not run, the transaction is untouched, and no counter changes. |
| 5 | Cleanup was scheduled only for responses with status < 400, and not for the early returns (busy 503, 413/408/400) inside the handler. | The route wraps the whole handler (`withCleanup`): any response (and any thrown error) to `/delete-user` or `/delete-user/callback` schedules a run, which is a no-op when nothing is owed. | "the route schedules the cleanup for EVERY delete-user and delete-user/callback response...": a signed-out (refused) delete and the callback both schedule; `/get-session` does not. |
| 6 | The command accepted loose arguments (`--force` alone, any `--budget-ms` text silently replaced by the default) and built Better Auth, so it needed mail and launch-information configuration even for status. | Strict `parseArgs` (exit 2, fixed text, before touching the database): unknown arguments, `--force` or `--budget-ms` without `--run`, duplicate or non-integer or out-of-range (100..300000) budgets. It no longer builds Better Auth; it never creates or migrates a database (`CLEANUP_NO_DATABASE`, `CLEANUP_NOT_MIGRATED`, exit 1). | "the operator command: strict arguments..." (also runs status as a public deployment with no SMTP or launch information). |
| 7 | Docs said "every database connection" and implied one global health answer. | README, DEPLOYMENT and these notes now say every live app/auth connection (main and Better Auth's), and that `/api/health` is per process (workers verify at open and refuse to start). | doc text only. |
| 8 | The "already migrated" shortcut accepted any trigger that mentioned `physical_cleanup`, so a trigger written before the `verification` table existed (partial or direct migration) skipped the repair; a missing counter row was also trusted. | The shortcut requires the verification delete in the trigger whenever the table exists, and the counter row. Otherwise the locked migration drops and recreates the trigger and re-inserts the row. `applicationMigrationApplied` is exported for the test. | "readiness is not claimed for a partial or direct migration...": three repaired states (trigger without the delete, missing row, old trigger). |
| 9 | `busy = 0` alone was treated as proof. | A truncating checkpoint counts only with `busy = 0` and `log = 0` (or `-1` when not in WAL mode). Observed on this machine: success `{busy:0, log:0}`, blocked `{busy:1, log:1}`, non-WAL `{busy:0, log:-1}`. | "a checkpoint only counts when the log was reset too...". |
| 10 | Notes lacked the review findings. | This section. | n/a |

New retryable outcome: `pending` (counter not drained within the budget). The server's retry chain treats `busy`, `failed` and `pending` alike; the mailer's minute sweep and the command are unchanged.

### Results of this revision (builder, Windows 11, Node v24.20.0)

See "Results (revision 2)" at the end of this file.

## Results (revision 2)

Builder, Windows 11, Node v24.20.0, 2026-11-17. Nothing committed or pushed. Nothing else was running during the full run.

- `npx tsc --noEmit`: exit 0. `npm run lint` (`eslint src`): exit 0.
- Focused: `tests/physicalCleanup034.test.ts` 12/12, `tests/physicalCleanupConcurrency034.test.ts` 3/3, `tests/physicalCleanupMigration034.test.ts` 2/2.
- Full `npm test`: 783 tests, **777 pass, 0 fail, 6 skipped** (the same existing POSIX-only and opt-in large-database skips).
- Not run: `npm run build`, e2e, Docker/Compose, Linux CI. No root evidence has been supplied for this revision.
