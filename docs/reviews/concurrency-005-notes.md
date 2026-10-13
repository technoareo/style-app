# Concurrency 005 notes: "database is locked" under concurrent app, auth and worker writes

Author ran nothing (file tools only). Codex runs `npm install` (lockfile regeneration), `npm run typecheck`, `npm test` and the E2E suite. No production-ready claim: public TLS, real SMTP, Docker and container capacity remain untested.

## Root causes (from the installed code, read only)
1. **Deferred transaction.** `@better-auth/kysely-adapter` 1.7.7 `NodeSqliteDriver.beginTransaction` issues plain `begin`. A read followed by a write after another connection or process commits fails at once with `SQLITE_BUSY_SNAPSHOT`, and `busy_timeout` is not applied. (Proved by test 1.)
2. **The whole sign-up handler runs inside the transaction.** `better-auth/dist/api/routes/sign-up.mjs` wraps the handler in `runWithTransaction`. Inside it come `password.hash()` (async, many event-loop turns), `createUser`, `linkAccount` and `sendVerificationEmail`. My earlier note that auth transactions "only await resolved promises" was wrong.
3. **Shared handle.** Better Auth's async transactions and the app's synchronous `BEGIN IMMEDIATE ... COMMIT` blocks shared one `DatabaseSync`, so a sync block could land inside, or `ROLLBACK`, an open auth transaction.
4. **Event-loop deadlock.** A synchronous `BEGIN IMMEDIATE` that waits for a lock held by an async transaction in the same process parks the event loop. That transaction needs the loop to finish, so the waiter spins for its whole `busy_timeout` and fails. This is the "write child: database is locked" in the failed run: registrar processes held the lock across hashing for seconds.

## Design
- **Separate auth connection** (`getAuthDatabase()`, [database.ts](../../src/server/database.ts)): foreign keys on, native `timeout: 20` ms. Contention is handled by async retry, not a parked loop. `closeDatabases()` closes both connections.
- **Eager `BEGIN IMMEDIATE`** ([authDialect.ts](../../src/server/authDialect.ts)). This applies review feedback to the earlier lazy-begin draft, which would have moved validation reads outside the transaction. The gate and the write lock are taken when Kysely calls `beginTransaction`. Read-then-write bodies are therefore atomic: two consumers of one reset or verification token cannot both read it as valid.
- **Bounded async acquisition.** `BEGIN IMMEDIATE`, and any autocommit statement that fails with `SQLITE_BUSY`, retry with async backoff (20 ms doubling to 250 ms, plus jitter) up to `acquireTimeoutMs` (10 s). A failed `BEGIN`, and a statement that failed with `SQLITE_BUSY`, never ran, so replaying them is safe. Statements inside an open transaction and the transaction body are **never** replayed.
- **In-process write gate** ([writeGate.ts](../../src/server/writeGate.ts)): FIFO, process-wide (kept on `globalThis` because Next bundles routes separately).
  - It is held by the auth transaction from BEGIN to COMMIT/ROLLBACK.
  - Every application and worker writer takes it through `runWriteTransaction` (see "Application and worker write path"): wardrobe GET and PUT, photo upload, analyze enqueue, job GET and cancel, the `mutation_limits` upsert in `account()`, and the worker's claim, heartbeat and finish.
  - Result: a synchronous writer can only wait on other processes, whose progress does not depend on this event loop.
  - **Bounded:** a waiter gives up after 15 s, is removed from the queue (so it can never be granted later), and the queue is capped at 256. Both failures raise `WriteGateError`, which `errorResponse` reports as a retryable 503.
- **Mail delivery is outside the transaction.** `advanced.backgroundTasks.handler` makes Better Auth start the send without awaiting it, so the SMTP wait is not part of the lock. [mail.ts](../../src/server/mail.ts) bounds every SMTP phase (connection 10 s, greeting 10 s, DNS 10 s, socket 20 s). The dev outbox write is synchronous at call time, so existing tests that read it still see the file. Trade-off: a delivery failure is logged by Better Auth and no longer fails the sign-up or reset request.
- **Deletion tombstone is atomic**: trigger `user_deletion_ledger` (`AFTER DELETE ON user`) inserts into `account_deletions` in the same statement. The post-delete hook in `auth.ts` is removed. Cascade deletes, the restore command and cross-account isolation are unchanged.
- **Dependencies**: `package.json` now declares `@better-auth/kysely-adapter` `1.7.7` and `kysely` `0.29.6` exactly (the installed versions) because the dialect imports `@better-auth/kysely-adapter/node-sqlite-dialect` and Kysely types. `package-lock.json` was not edited; Codex to regenerate.

## Application and worker write path (final helper)
Failure observed: with auth fixed, a direct-writer child still got "database is locked", because its synchronous `BEGIN IMMEDIATE` waited only the native 5 s `busy_timeout` while auth transactions held the lock across password hashing. The fix is one production helper used by every non-auth write:

`runWriteTransaction(fn, { acquireTimeoutMs })` in [writeTransaction.ts](../../src/server/writeTransaction.ts):
1. Take the in-process write gate (bounded, FIFO, waiters removed on timeout).
2. `BEGIN IMMEDIATE` with bounded **async** retry (`retryBusy` in [sqliteRetry.ts](../../src/server/sqliteRetry.ts): 20 ms doubling to 250 ms plus jitter) within the same time budget. The main connection's native wait is now 50 ms (was 5000), so the event loop is never parked.
3. Run `fn` synchronously (a Promise result is rejected and rolled back), then `COMMIT`; any throw `ROLLBACK`s.

Only step 2 is retried; a failed `BEGIN` did nothing. The body runs at most once. Budget exhaustion throws `WriteContentionError` (or `WriteGateError`) before the body runs; `errorResponse` reports it as a retryable 503.

Repositories (`wardrobes.ts`, `analysisJobs.ts`) use `inTransaction(db, fn)`, which joins the transaction opened by the helper (so their synchronous signatures and the existing tests are unchanged), or opens its own `BEGIN IMMEDIATE` when called standalone. Routes (`wardrobe`, `photos`, `analyze`, `analysis-jobs/[id]`) and the `mutation_limits` upsert in `access.ts` call `runWriteTransaction`. The `worker_state` table moved into the startup schema, and startup DDL/WAL setup uses `retryBusy` (idempotent statements).

Worker ([analysis-worker.ts](../../scripts/analysis-worker.ts), [analysisJobs.ts](../../src/server/analysisJobs.ts)):
- Lock acquire, renew, release and startup sweep have `...Async` variants built on the helper. The claim in `runWorkerTick` is one `runWriteTransaction`; contention rejects before any job state changes and the worker retries on its next tick.
- `heartbeatWorker` returns `ok`, `lost` (another owner holds the lock), `degraded` (renewal blocked by contention; keep working, retry next beat) or `critical` (no successful renewal for more than half the 5-minute lease; stop). Beats never stack (one in flight), and each waits at most 5 s. A healthy worker is no longer stopped by a transient failed beat.
- `finishJob` records the outcome through the helper and retries **only** failed acquisition, holding the finished result in memory, until `min(leaseUntil - 30 s, now + 10 min)` (`finishRetryMs`). Inference is never repeated for transient contention. If the budget is exhausted it logs, returns, and leaves the job `running` with its photo. The normal lease sweep then requeues it, and `MAX_ATTEMPTS` (2) bounds total inference runs, so a worst case is one bounded re-run, never data loss.

Documented bounds: write acquire budget 10 s default (heartbeat 5 s, test overrides 100–300 ms); native waits 50 ms (main) and 20 ms (auth); gate queue 256 and 15 s; auth `BEGIN` retry 10 s; job finish retry up to 10 min but not past the lease margin.

Stress children now use the production path: `write` runs `runWriteTransaction` and `worker` runs `acquireWorkerLockAsync`, `heartbeatWorker`, `cleanupOnStartupAsync` and `releaseWorkerLockAsync`. Counts and account outcomes asserted are unchanged (3 registrars × 4, 3 writers × 150, 1 worker × 60, plus the in-process HTTP, token and deletion races). Load was not reduced.

Over-bound behavior is proved separately in [tests/contention.test.ts](../../tests/contention.test.ts), with a raw second connection standing in for another process:
- a write that cannot get the lock fails within its budget as a 503, its body never runs, and timers keep firing meanwhile;
- a contended heartbeat is `degraded`, then `critical` only after half a lease, `ok` once the lock frees, and `lost` for a foreign owner;
- transient contention during job completion records the result with exactly one model call;
- contention past the budget leaves the job `running` with its photo, and after lease lapse a second tick completes it with `attempts == 2` and exactly one bounded re-run.

## Trade-offs and residual risks (honest)
- **Lock held during hashing.** Because validation reads stay inside the transaction, the SQLite write lock and the gate are held for the password-hash duration of each sign-up. Throughput of sign-ups is serialized per process, and other writers retry asynchronously within their budget and can see added latency or a 503. Moving hashing out of the transaction would require changing Better Auth's handler, which is out of scope. Not measured under load.
- **Cross-process starvation.** SQLite's busy handler is not fair. A process doing sync `BEGIN IMMEDIATE` could in theory lose repeatedly to a stream of auth transactions. Worker and script writes are short, and failures surface as errors, never silently. No fairness measurement was made.
- **Unwrapped paths.** Read-only routes (photo GET) are not gated, which is fine under WAL. Any future writer must go through `runWriteTransaction`; nothing enforces that mechanically, and a raw synchronous write on the main connection now fails fast (50 ms native wait) under contention instead of waiting.
- **Module duplication.** The gate is shared across bundles through `globalThis`, but each bundle still lazily opens its own `getDatabase()` and `getAuthDatabase()` connection. That is correct (the gate serializes the writers) but uses more file handles.
- **Detached mail** means no backpressure on sign-up bursts beyond the SMTP timeouts.
- **Windows:** tests clean up generated temp directories only through `tests/helpers/tempDir.ts` (real path must be a direct child of the real OS temp dir with the expected prefix, otherwise it refuses). Locked SQLite files get `maxRetries`.
- **Not run by me**: every check below.

## Tests ([tests/concurrency.test.ts](../../tests/concurrency.test.ts), [scripts/concurrency-child.ts](../../scripts/concurrency-child.ts))
1. Deferred `BEGIN` read-to-write upgrade fails immediately despite `busy_timeout` 5000. `BEGIN IMMEDIATE` succeeds.
2. Dialect unit test:
   - The write lock and gate are taken at begin.
   - Commit and rollback release them.
   - A lock that never clears fails after `acquireTimeoutMs` with no half-open transaction, and the gate is freed.
   - A lock that clears during backoff succeeds while timers keep firing (the loop is not parked).
3. A delayed async auth transaction (open across real macrotasks) with a gated sync writer on a 5 s-timeout connection: the writer queues, then runs, with no multi-second block.
4. Tombstone atomicity:
   - A rolled-back deletion leaves no ledger row.
   - A child process that deletes and exits before COMMIT leaves the user and no tombstone.
   - A committed deletion has user, cascade and tombstone together, and a bystander account is untouched.
5. Two delayed async consumers of one token on separate connections: exactly one wins (read-then-write atomicity).
6. Gate bounds: a timed-out waiter is removed, the queue is capped at 256, and there is no stale grant afterwards.
7. The combined run, all released at one epoch-ms start time:
   - **Children:** 3 registrar processes (4 sign-ups each), 3 direct-writer processes (150 transactions each) and a worker-style process (lock heartbeats plus sweeps).
   - **In this process:**
     - real Better Auth HTTP-handler sign-ups;
     - API sign-ups;
     - wardrobe GET/PUT route handlers for three accounts;
     - three concurrent consumers of one reset token (exactly 1 succeeds);
     - two concurrent self-service deletions of one account.
   - **Checks:** no failures, every user has a credential account, no orphan accounts, all writer rows present, wardrobe revision 3 per account, each account's data matches its own name, and exactly one tombstone for the deleted account.

Test lifecycle: the tombstone and combined stress scenarios share one private integration database. `STYLE_DATA_DIR` is set exactly once, before the first import of the server singletons, and the connections are closed only in an `after` hook. An earlier version closed them between scenarios, so the cached auth instance was reused on a closed handle ("database is not open"). No test-only reset API was added to production code. The `streamQuery` wrapper in the dialect now defaults `chunkSize` to 100 to satisfy the installed Kysely interface.

Also fixed: `tests/backup.test.ts` now closes both connections (`closeDatabases()`) before the stopped-process restore drill, and deletes via the trigger instead of inserting the ledger row by hand. `tests/queue.test.ts` no longer narrows `releaseResponse` to `never`. Scripts `init-auth`, `backup-database` and `analysis-worker` use `closeDatabases()`.
