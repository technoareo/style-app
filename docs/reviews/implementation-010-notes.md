# Build 010 implementation notes (Claude): batch D1

Scope: the requirements from my corrected-009 review (`build-009-corrected-claude.md` §7, batch D1): fresh-server restore with a separately exported current deletion ledger, F1 (restore cannot prove writers are stopped), F3-F7, and the H2 large-database backup test. **No vision, queue, mail-delivery or UI changes. Whole-wardrobe product scope is untouched.** This build is **not production ready**.

Method: Read/Glob/Grep/Edit/Write only. **I ran nothing** (no shell, tsc, tests, server, browser, network). Every behaviour below is from reading code; nothing is verified until root runs it. I read, never edited, the installed Better Auth sources to identify the rate-limit table. I did not touch `sources/` or `release-snapshots/`, and I read no `.data`, `.runtime`, `.env` or secrets.

## 1. Design

### 1.1 The deletion ledger (`src/server/deletionLedger.ts`)

A deletion is recorded in the live DB by the existing trigger (`account_deletions`). A backup-time ledger cannot know about later deletions, so the ledger is a **separate, continuously maintained file**: `<data>/ledger/deletion-ledger.json`.

* **Format:** one JSON object, canonical key order: `format`, `version` (1), `generation` (+1 per write), `exportedAt`, `entries [{userId, deletedAt}]` sorted and unique, `sha256` over the other fields. Only internal user ids and times.
* **Append-only:** an export merges the previous file's entries with the database's (earliest time wins). Restoring an older database and exporting again cannot make a deletion vanish.
* **Maintained by:** the mail worker (about every 60 s, writes only when something changed or the file is older than 15 min); every backup (forced, after the backup so `exportedAt` is later than the backup); `scripts/export-deletion-ledger.ts` (forced; for cron before the operator copies it off the server).
* **Serialised and atomic:** an OS lock on `ledger/.ledger-coordinator.db` (the backup lock mechanism, a different file) serialises exporters across processes; each write is a unique `wx` temporary file (0600), fsynced strictly, renamed over the final name (bounded retry for a Windows reader), directory flushed where supported. `exportedAt` is taken before the DB is read.
* **Fail-closed validation (`parseLedger`):** size cap, JSON, exact key set, format, version, integer ranges, id syntax, strict sort and uniqueness, future-time bound, checksum. A link, directory or unreadable file is refused. Damaged existing ledger at export time: moved aside as `deletion-ledger.invalid-<hex>.json` and rebuilt from the DB (reported); unreadable or newer-version ledger: the export fails and the file is left alone. A DB row the ledger cannot represent makes the export fail (never skipped silently).
* **Honest limit:** the file lives on the same volume. The software does **not** copy it off the server. The recovery point for deletions is the age of the operator's last off-server copy (documented in `docs/DEPLOYMENT.md`). Deletions committed after `exportedAt` of the copy are not known to a fresh-server restore; the command prints that time. The checksum is not a signature.

### 1.2 Restore (`scripts/restore-database.ts`, rewritten)

`restore-database.ts <style-….db> [--ledger <file>]` (`STYLE_RESTORE_LEDGER` may stand in for `--ledger`).

* **Live mode** (`app.db` exists): deletions = live `account_deletions` ∪ `<data>/ledger/deletion-ledger.json` when it exists (must validate or the restore stops) — the implicit file is ignored when `--ledger` is given — ∪ `--ledger` when given.
* **Fresh mode** (no `app.db`): `--ledger` is **required**; it must validate; `exportedAt` must be ≥ the backup's creation time (parsed from the file name; unparsable → refuse); and not older than `STYLE_RESTORE_LEDGER_MAX_AGE_HOURS` (24) unless `STYLE_RESTORE_ACCEPT_STALE_LEDGER=true`.
* **Unchanged guarantees:** every credential password set to NULL; deleted users removed (cascade) and re-recorded; `mail_outbox`, `analysis_jobs`, `session`, `verification` emptied; worker-state tables dropped; foreign-key check; VACUUM; journal mode DELETE. New: the rate-limit table is emptied; the backup must pass integrity and contain `user` and `account`.
* **Staging:** unique `app.db.restore-<16 hex>.pending`, created `wx` 0600, removed in `finally` on any failure; leftovers of that exact pattern from a crashed restore are swept (only while holding the exclusive claim). The live `app.db` is replaced last (`-wal`/`-shm`/`-journal` removed, rename, directory flush where supported).
* **After the replacement:** the merged ledger is installed as the new current ledger (generation continues). A failure there or in the directory flush is exit code **2** with a `RESTORE_W_*` warning, not a false success.
* **Diagnostics:** fixed text and codes only (`RESTORE_E_CONFIRM, _ARGS, _FILENAME, _ACTIVE, _LEDGER_REQUIRED, _LEDGER_MISSING, _LEDGER_INVALID, _LEDGER_STALE, _BACKUP_INVALID, _LIVE_UNREADABLE, _FAILED`). No exception message, user id or user-supplied path is printed. Exit 0 / 1 / 2.

### 1.3 F1: cooperative process coordination (`src/server/processPresence.ts`)

I did **not** build or claim an exclusive-SQLite-probe idle check on `app.db` (it cannot see an idle WAL connection). Instead:

* Every process that opens the live database through `getDatabase()`/`getAuthDatabase()` first takes a **shared hold** on `<data>/.process-presence.db` (an open read transaction on a rollback-journal file = the OS shared lock) and keeps it until its last connection closes (`database.ts`: `ensurePresence`, `releasePresenceIfIdle`). This covers the app, AI worker, mail worker, init-auth, the backup and ledger commands and tests.
* Restore takes `BEGIN EXCLUSIVE` on the same file with a zero busy timeout: granted only if nobody holds a shared lock, otherwise `RESTORE_E_ACTIVE` before anything is touched. It keeps the claim until after the replacement.
* **Crash recovery:** the OS releases a dead process's lock; no lease, timestamp or takeover anywhere. **Bounded failure:** a starting process waits at most 3 s for a restore, then throws `PresenceBusyError` (the supervisor restarts it).
* **Not covered:** a process that opens `app.db` by other means (raw `sqlite3`, an ad-hoc script); non-local volumes (NFS/SMB); Docker/Linux (not run). The old `wal_checkpoint(...).busy` check is kept as a second guard, not as the idle check.
* **Claim status:** "an idle process makes restore refuse" is tested only by `tests/processPresence.test.ts` and `tests/restoreFresh.test.ts` (a real child that opened the DB through `getDatabase()` and idles). It is unproven until root runs them.

### 1.4 F3-F7 and H2

* **F3** (`durableFs.ts`, `backupDatabase.ts`): `isUnsupportedSyncError` accepts only EINVAL/ENOTSUP/EOPNOTSUPP/ENOSYS; everything else, including EIO/ENOSPC, throws. A file-flush I/O error before publication fails the backup (partial removed). After publication, a directory-flush I/O error returns `durable:false` + `BACKUP_W_DIR_SYNC_FAILED` (exit 2) and **skips pruning** old backups; "unsupported" (Windows has no directory fsync) is an informational warning, exit 0.
* **F4:** once the hard link to the final name exists, a failure removing the partial's name is reported as a published backup with the leftover named (exit 2), never as "no backup was created".
* **F5:** `privateSubdirectory` (shared by `backups` and `ledger`): real directory, realpath equal, POSIX owner must be the current user, mode narrowed to 0700 **for that directory only** (no recursion, no file chmod). The raw partial is created `wx` 0600 before SQLite writes it.
* **F6:** the rate-limit table is the Better Auth model `rateLimit` (key = `<ip>|<path>`). The table name is discovered from `sqlite_master` (`rateLimitTables`), emptied and verified empty in every backup, emptied in every restore. `restoreFresh.test.ts` asserts that exactly one such table exists in the real application database and puts a marker row in it.
* **F7:** see 1.2 (unique guarded staging, cleanup, fixed codes, dead code removed).
* **H2 mitigation** (not a proven fix): `backup()` now copies with `rate: BACKUP_PAGES_PER_STEP` (1,000,000 pages) so a normal database is one SQLite step and cannot be restarted by another process's writes. `tests/backupLarge.test.ts` measures it.

## 2. Files

Added: `src/server/{deletionLedger,processPresence,durableFs,privateDirectory,sensitiveTables}.ts`; `scripts/export-deletion-ledger.ts`; `tests/{deletionLedger,processPresence,restoreFresh,backupDurability,backupLarge}.test.ts`; `tests/helpers/{processes,presenceChild,ledgerExportChild,slowWriterChild}.ts`; this file.
Changed: `src/server/backupDatabase.ts`, `src/server/database.ts` (presence hold only), `scripts/{backup-database,restore-database,mail-worker}.ts`, `docs/DEPLOYMENT.md`.
No existing test was edited, relaxed or skipped. No schema change, no migration, no new dependency.

## 3. Tests (written, not run)

* `deletionLedger.test.ts`: canonical round trip; ~25 damage cases rejected with codes; missing/directory/link; export (first, unchanged, new deletion, forced, refresh, monotonic when the DB forgets a row); damaged ledger quarantined and newer-version ledger preserved; unrepresentable row; **three real processes exporting while the parent inserts deletions and samples the file**: every sample valid, generation and entries never go backwards, final file complete, generation == writes + 1, no temp files.
* `processPresence.test.ts`: **real idle child** holds the DB via `getDatabase()` → claim refused (twice, 500 ms apart) → child SIGKILLed → claim granted without any lease; bounded failure of a starting holder under an exclusive claim; many holders; in-process `getDatabase`/`closeAuthDatabase`/`closeDatabases` wiring.
* `restoreFresh.test.ts` (real scripts as real children, real application DB): backup T0 → post-backup password reset and deletion → ledger exported separately → **empty data directory restored with that ledger**: C stays deleted (including the ledger-only knowledge), no credential hash survives, A/B kept, photo and wardrobe intact, rate-limit rows gone from backup and restore, sessions/tokens/mail/jobs empty, new ledger installed with continued generation, fresh Better Auth process refuses old/new/unchanged/deleted and the email reset recovers A and B. Policy: ledger required, missing file, truncated, tampered, empty, a directory, valid-but-exported-before-the-backup, too old (and accepted only with the explicit override), unconfirmed, bad arguments, missing backup — each refusal leaves no `app.db`, no staging file, and no user id in the diagnostic. **Idle existing process:** a real child holding the restored DB → restore refused with `RESTORE_E_ACTIVE`, database and ledger byte-identical; child killed → restore succeeds. Staged failures: garbage file, foreign SQLite file, directory named like a backup, damaged implicit ledger → original database byte-identical, no staging file; crash leftovers swept, a look-alike name left alone.
* `backupDurability.test.ts` (injected I/O, labelled as reaction tests, not file-system proof): error classification; file-flush EIO fails the backup cleanly; unsupported flush tolerated and reported; directory-flush EIO → published but `durable:false`, pruning withheld, next backup prunes; directory-flush unsupported → limit, pruning proceeds; real flushes per platform; unlink failure after link → published + leftover named, next backup sweeps; rate-limit rows never in a backup; POSIX permission test (skipped on Windows with a stated reason).
* `backupLarge.test.ts`: ≥300 MB database, a **separate process writing immediately and every 5 s**, real `createBackup`, explicit bound (default 300 s), integrity check, row counts, sanitised tables empty, no partial; prints a JSON line including `writesDuringCopy`. **Opt-in** (resource-intensive).

## 4. Commands for root

```sh
npm run typecheck
npx tsx --test tests/deletionLedger.test.ts tests/processPresence.test.ts tests/backupDurability.test.ts
npx tsx --test tests/restoreFresh.test.ts
npm test                                  # whole backend suite (picks up the new files; backupLarge is skipped)
# H2, separately (≈1.5 GB disk, minutes):
STYLE_LARGE_BACKUP_TEST=1 npx tsx --test tests/backupLarge.test.ts      # PowerShell: $env:STYLE_LARGE_BACKUP_TEST=1
# also rebuild and run the browser suite and the packaging checks: database.ts changed
```

## 5. Unverified: check these first

1. **`tsc`** on everything above, notably: `backup(source, path, { rate })` typing; `import { holdPresence, type PresenceHold }`; the `previous` narrowing in `exportDeletionLedger`; `let claim` definite assignment in the restore script.
2. **`rate: 1_000_000`** accepted by `node:sqlite` `backup()` on Node 24.20 (I did not read its validator).
3. **SQLite behaviour I rely on:** a read statement inside `BEGIN` on `.process-presence.db` keeps the shared lock; `BEGIN EXCLUSIVE` with a zero timeout fails with a busy `errcode` while another process (and another connection in the same process) holds it; a SIGKILLed holder's lock is released promptly on Windows.
4. **Backup into a pre-created empty 0600 file** works with `backup()` (SQLite keeps the existing file; a 0-byte file is a valid empty database).
5. **`restoreFresh.test.ts`:** the rate-limit table is found by name (`rateLimit`) and my generic row insert handles its real columns; `authProbeChild` works on a directory created by restore; time ordering (ledger `exportedAt` ≥ backup stamp) holds because the ledger is exported after the backup.
6. **Browser suite and packaging:** `database.ts` now takes a presence hold on first connection; the standalone server, `verify-standalone`, trace sanitising and the mail worker's real-child tests (which now also run the ledger tick) should be re-run.
7. **H2 may still fail.** If `backupLarge` times out, the one-step copy is not enough and the next candidate is `VACUUM INTO`; I did not implement it.

## 6. Platform limitations

* Windows is the only platform root has run; no Linux, no Docker. Directory fsync does not exist on Windows (reported as `BACKUP_W_DIR_SYNC_UNSUPPORTED`, `unsupported` outcome); the POSIX permission and ownership code is untested here (one test, skipped on Windows).
* File locks (backup, ledger, presence) assume a local volume. Not tested on NFS/SMB, Docker bind mounts or named volumes shared by two containers.
* The presence coordination is cooperation between this application's processes; it cannot see foreign processes.
* The fsync/unlink failure tests inject errors; they prove the reaction, not any file system's behaviour.

## 8. Correction batch after root's verification of build 010

Root's results: typecheck PASS; D1 targeted suite 24 total / 22 pass / 1 fail / 1 POSIX skip (111.97 s). PASSED: fresh server with the latest ledger, post-backup deletion and reset, real idle-process refusal with an unchanged database, staging refusals, multi-process ledger consistency, fsync error reactions. Again I ran nothing; the corrections below are unverified until root reruns.

### 8.1 `backupDurability.test.ts:197` (leftovers 0, expected 1) — a test that assumed hard links
**Cause (agreed, production correct):** root's environment answers `EPERM` to `fs.linkSync`, so `publish` correctly takes its check-then-rename fallback, and the injected `unlinkPartial` (which only runs after a successful link) never ran. The test assumed a branch the environment cannot take. I did not delete or loosen the assertion; the native expectation now only runs where it can be true.
* New `linkFile` seam in `BackupIo` (default `fs.linkSync`), used by `publish`. No other production behaviour changed.
* The existing assertions are kept verbatim in **"NATIVE hard-link publication…"**, gated by a capability probe (a real `linkSync` in the test area) and **skipped with the reason** (`hard links are refused here (EPERM)…`) where links are refused. It runs and asserts everything where links work (Linux, most Windows volumes).
* **"REAL fallback…"** runs only where links are refused and tests the REAL outcome with the real `linkSync`: rename published the file, the partial name is gone, `leftovers` is empty, the post-link unlink step was never reached (counted), integrity ok.
* **"REACTION (injected link refusal, any platform)":** an injected `EPERM` from `linkFile` must give the same fallback outcome, deterministically everywhere.
* **"REACTION (injected; a copy stands in for the link…)":** `linkFile` returns `EEXIST` once (publication moves to `-1`), then a **copy** stands in for the link; `unlinkPartial` fails → published, `durable`, leftover named and present, markers absent, next backup sweeps it. Labelled reaction-only: it is NOT hard-link or file-system proof.
* Net: where links are refused the native branch is reported as skipped, not passed; nothing pretends hard links worked.

### 8.2 `backupLarge.test.ts` proved no overlap (`writesDuringCopy` 0)
Root's run (315,011,072 bytes, 13,194 ms, one write) completed and passed integrity, but the parent counted IPC messages received after the whole backup, so it showed neither that a write committed inside the copy nor that one could have. Rewritten, keeping the real child, the real `createBackup`, the explicit per-backup bound and the integrity/row-count checks:
* The writer (`slowWriterChild.ts`) commits each write as one autocommit `INSERT INTO writes(at)` with its own clock; IPC is a hint only.
* **Stop barrier:** after each backup the parent tells the writer to exit and awaits its exit (SIGKILL fallback after 30 s), then reads the committed `writes` rows from the database.
* **Interval:** `startedAt` (just before `createBackup`) to the `onStage('raw-copied')` timestamp, recorded separately from sanitising/VACUUM/verification (which run on the copy), minus a 50 ms margin. A write overlaps only if its committed timestamp lies strictly inside.
* **Three runs:** calibration (no writer) measures this machine's raw-copy time; the specified 5 s period; a documented **shorter period = a quarter of the calibrated copy time, clamped to 20 ms-5 s**. The shorter run must show **≥ 2 overlapping commits and 0 failed writes or the test FAILS as inconclusive** (the message says to use a larger `STYLE_LARGE_BACKUP_MB`). The 5 s run must show ≥ 1 if its copy outlasted the period; otherwise it is printed as `inconclusiveAtSpecifiedPeriod: true` (a fast machine can copy 300 MB between two writes 5 s apart). Output is one JSON line with all three runs.
* Each run deletes its finished backup to bound disk use (about 1.3 GB peak). Cost: three backups, several minutes.
* If the shorter run completes with ≥ 2 commits inside the copy, that is evidence the one-step copy is not restarted by a concurrent writer **on that machine and volume**; it says nothing about Linux/Docker volumes.

### 8.3 Restore cleanup no longer silent
`scripts/restore-database.ts`: removal of a stale staging name (sweep) or of this run's staging name (`finally`) is now checked afterwards; anything still present is collected and reported at the end as `WARNING RESTORE_W_STAGING_LEFT: <fixed-pattern file name> …` (name only, no directory, no ids). A successful restore with a leftover now exits **2** (database replaced; warning), a failed restore stays exit **1** with its own `RESTORE_E_*` code plus the warning. The sweep still never removes a directory. The generic failure text still says the existing database was not replaced, which remains true (the replacement is the last step).
* Test (`restoreFresh.test.ts`, no mocks): a real **directory** carrying the staging pattern cannot be removed by the sweep, so removal genuinely fails: a successful restore exits 2 and names it, prints no directory path or user id, still replaces the database, leaves the directory alone; a failing restore (garbage backup) exits 1 with `RESTORE_E_BACKUP_INVALID` and the warning, database byte-identical; after the fixture is removed the next restore exits 0.
* **Not tested:** a failure to remove THIS run's randomly named staging file in `finally` (it cannot be provoked without a mock or a hostile process); that path uses the same checked removal but has no test of its own.

### 8.4 Files changed in this correction
`src/server/backupDatabase.ts` (`linkFile` seam only), `scripts/restore-database.ts`, `tests/backupDurability.test.ts`, `tests/backupLarge.test.ts`, `tests/helpers/slowWriterChild.ts`, `tests/restoreFresh.test.ts`, this file. Commands for root: as in section 4; `backupDurability` should now report the native test as skipped on this host and run the other three publication tests.

### 8.5 H2 evidence correction: a write must be entirely inside the copy
Defect in 8.2 (root): `slowWriterChild` stored `Date.now()` taken BEFORE the INSERT, and the parent counted a write when that start time fell inside the interval. A writer blocked until after the copy finished would still have a pre-statement time inside it, so it would be falsely counted as an overlapping commit. Also, the interval started at the call to `createBackup`, so directory, lock and sweep work counted as "copying". Corrections (source only, nothing run; the `>= 2` overlap requirement is unchanged):
* **`copy-started` stage** (`backupDatabase.ts`, new `BackupStage`): fired immediately before `node:sqlite` `backup()` (after the directory guard, lock, sweep and partial creation). It is a pure hook (an awaited no-op unless a caller supplies `onStage`); existing stage consumers ignore stages they do not name. The copy interval is `copy-started` .. `raw-copied`; sanitising, VACUUM and verification stay outside it.
* **Writer intervals** (`slowWriterChild.ts`): the child reads its clock before the statement (`start`) and again after `run()` returned (`end`); a returned autocommit INSERT is committed, so the commit lies within `[start, end]`. The table still stores `start`.
* **Acknowledged barrier:** the parent sends `"stop"`; the child clears its timer, closes its database and sends ONE message with every `[start, end]` and its failed-write count, then exits when that message was handed to the pipe. Overlap is computed only from that message's contents; IPC delivery time decides nothing. A writer that does not answer is killed and the run fails (no snapshot).
* **Durable cross-check:** after the barrier the parent reads the `writes` table and asserts that the number of new rows equals the reported intervals and that the stored start times equal the reported starts.
* **Predicate:** `writeInsideCopy(start, end, copyStart, copyEnd)` requires `end >= start && start > copyStart && end < copyEnd` (strict on both edges). A separate, always-running test checks it: fully inside (true); starts inside but completes after the copy ended, i.e. a blocked writer (false); completes exactly at the end (false); starts before the copy (false); starts exactly at the start (false); entirely before / after / spanning (false); end before start (false).
* **Unchanged:** real separate writer, explicit per-backup bound, three runs (calibration, 5 s period, shorter derived period), `>= 2` overlapping commits and 0 failed writes required of the shorter run, the 5 s run's conditional rule, integrity and row-count checks. The run's JSON output keeps `rawCopyMs` (now `copy-started` to `raw-copied`), `overlapping`, `failedWrites` and `writesInRun`. Files touched: `src/server/backupDatabase.ts` (stage only), `tests/backupLarge.test.ts`, `tests/helpers/slowWriterChild.ts`, this file. Root's suite still running was not edited otherwise.

## 7. Remaining release gates (nothing here is closed)

Off-server transport of the ledger and the backups (and **encrypted** scheduled offsite backups with a recovery drill) — the ledger's recovery point is only as good as the operator's copying; Docker/Linux/target host/domain/HTTPS runs of backup, restore, lock and shutdown paths; physical secure delete/WAL maintenance and marker tests; dense whole-wardrobe recognition (invalid/timeouts) and held-out recognition; SMTP TLS enforcement, AUTH, real provider, drop visibility and secret scoping (008 §4.3-4.4, §5); mail-worker health honesty (F2) and a lighter health check (F10); recovery mail throughput after a restore (F11); the `credential_changes` refinement; real consumer devices; operational alerts and policies; UI copy items (F8). The new detector research is not part of this app and no performance claim exists. An independent review of the frozen build 010 must follow root's tests.
