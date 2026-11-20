# Implementation 035: low-risk hardening from the approved Build 034 rereview

Status: implemented and tested locally on Windows 11 (Node v24.20.0). **Not committed, not pushed** (as instructed). Not run on Linux CI. The product is not launch-ready.

## Evidence recorded from outside this session

Build 034 GitHub Actions run **43983514771 was fully green** (reported to the builder by the requester; the builder did not fetch or re-verify the run). It is the Linux/Docker evidence that Build 034 notes listed as "not run".

## Items

| # | Item | What changed | Where it is tested |
|---|---|---|---|
| 1 | A missing `physical_cleanup` counter row must never become clean | `migratePhysicalCleanup` (src/server/database.ts) decides first-migration vs damage **before** creating the table: first migration = no table and no recorded migration row. Only that starts clean. Anything else with no counter row is recreated with `requested = 1, completed = 0, pending_since = now` and `legacy_deletions = COUNT(account_deletions)`. **Why this choice:** the ledger holds tombstones only, so which deletions were already cleaned is unknowable; one owed cleanup is the conservative answer (one verified truncating checkpoint cleans every committed deletion), and counting every ledger row as legacy is an upper bound that may over-report possible residue but never under-reports. The cost of being wrong is one extra checkpoint. | `physicalCleanupMigration034`: row deleted, whole table dropped with the migration row kept (both come back owed, idempotent, cleared only by a real cleanup), and the genuine first migration still starts clean. |
| 2 | Explicit checkpoint proof | `checkpointComplete` (exported) accepts only `busy = 0` with `log = 0`, or `log = -1` (SQLite's documented value for a non-WAL database). `log` undefined, null, strings and missing `busy` are refused. | `physicalCleanup034`: table of accepted/refused values, and a run whose checkpoint returns `{busy:0}` is `busy` and stays owed. |
| 3 | `/delete-user/` too | `isDeleteUserPath(pathname)` (src/server/physicalCleanup.ts), used by the route on `new URL(request.url).pathname`: `/delete-user`, `/delete-user/callback`, each with an optional trailing slash. Query and fragment are not in the pathname, so `?next=/delete-user` neither fakes nor hides a match. | pure matcher cases, and the route test (POST `/delete-user/`, `?x=1`, GET callback with and without slash schedule; `get-session` with a hostile query does not). |
| 4 | Status must not create anything | `resolveDataDir()` (pure, no mkdir/stat) split from `getDataDir()` (creates). The command resolves, `stat`s `app.db` and refuses with the same fixed `CLEANUP_NO_DATABASE` text (names no path). It only calls `getDatabase()` (which creates) after the file exists. | `physicalCleanupConcurrency034`: real child process, data directory under an absent parent; neither parent nor target exists afterwards, for status and `--run`; stderr names no path. |
| 5 | Per-kind physical negative controls | `assertEveryMarkerKindStillOnDisk`: every one of the six kinds (saved photo, queued photo, queued mail, verification token, session, account) must still be in `app.db` after the deletion and before cleanup, in the main test and in the busy test. **All six are deterministic**, so none is exempted: `plant()` checkpoints them into `app.db`, autocheckpoint is 0 on both live connections and nothing checkpoints before the check, so SQLite has no reason to touch the old images (`secure_delete` only zero-fills the new images in the WAL). The earlier `some(...)` check could pass with five kinds missing. | same two tests. Not mutation-tested against a deliberately broken build. |
| 6 | Real-timer flakiness | Scheduler seam `setCleanupTestHooks({clock, runOptions})` (test-only; production never sets it). Tests use a manual clock and fire the scheduled run by hand, awaiting the run it returns; the route test no longer polls with `sleep`, the 2 s backoff is asserted as exactly 2000 ms, and scheduled runs get a 400 ms budget instead of 5 s. The single-timer, pull-forward and backoff logic is the production code on either clock. Removed every `sleep` from `physicalCleanup034.test.ts`. | route test, pull-forward test, `drainTimer`. Remaining real time: SQLite's own busy waits inside runs that deliberately face a held reader (bounded by the 300-400 ms budgets). |
| 7 | `TINY_WAL` magic | Replaced by a named invariant, `assertWalHoldsBookkeepingOnly`: the WAL must hold fewer frames than one leaked planted photo needs (`floor(PHOTO_FILLER_BYTES / page_size)`), with the page size read from the database and the WAL header/frame header sizes named from the documented file format. The marker-absence checks remain the residue proof; this is the growth check, and the failure message reports frame count and bytes. | main test and restart test. |
| 8 | Docs and notes | README, `docs/DEPLOYMENT.md` and this file. The requested path `reviews/implementation-035-notes.md` does not exist in this repository; notes live in `docs/reviews/`, so this file follows the existing convention. | n/a |

## Behaviour preserved

No change to detection scope (easy single items; crowded wardrobe photos not touched), privacy, fail-safe semantics, the checkpoint/bookkeeping/retry logic, or the command's exit codes. A previously accepted checkpoint result with no `log` field is now refused (the only behaviour change, by request); SQLite's real `wal_checkpoint` always returns the field.

## Remaining external launch blockers (not addressed here, honestly stated)

- Real SMTP delivery has not been exercised; a public domain/TLS deployment has not been exercised.
- Backups, encrypted packages, off-server copies, volume snapshots and the storage layer still hold deleted accounts until their own retention ends; pre-034 deletions may have left residue (`legacyDeletions`); full-disk encryption with an off-volume key is the operator's job.
- Only account deletion forces WAL truncation; rate-limit rows (client IPs) are not removed on account deletion.
- Build 035 itself has no Linux CI/Docker evidence yet; run 43983514771 covers Build 034 only.
- The open items in the project's blocker list (see the memory/launch notes) are unchanged by this build.

## Results

See the checks run by the builder at the end of this file.

Builder, Windows 11, Node v24.20.0, 2026-11-17 (about 00:15 to 00:45 UTC). Nothing committed or pushed.

- `npx tsc --noEmit`: exit 0. `npm run lint` (`eslint src`): exit 0.
- Focused: `physicalCleanup034` 13/13, `physicalCleanupMigration034` 3/3, `physicalCleanupConcurrency034` 4/4 (all pass).
- Full `npm test`: 787 tests, 778 pass, **3 fail**, 6 skipped.
  - `tests/queue007.test.ts` "quota refunds are one-time..." and "cancelling, deleting the account or expiry aborts running model work..." (`expiry is refunded`: usage `count` 1, expected 0). **They fail identically on the committed HEAD with this build's changes stashed**, so they are not caused by Build 035. Cause not established. Untested suspicion: the run happened within minutes of UTC midnight and the quota is per UTC day; re-run after the day has settled, and see what Linux CI says. Build 034's recorded full run (777 pass) predates this.
  - `tests/concurrency.test.ts` "simultaneous HTTP auth ... never hit 'database is locked'" failed in the full run and **passed (49.7 s) when re-run on its own**; the Build 034 notes record the same test failing under load once. Still unproven either way.
- Not run: `npm run build`, e2e, Docker/Compose, Linux CI.
