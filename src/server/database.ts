import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMigrations } from "better-auth/db/migration";
import type { BetterAuthOptions } from "better-auth";
import lockfile from "proper-lockfile";
import { holdPresence, type PresenceHold } from "./processPresence";
import { retryBusy } from "./sqliteRetry";
import { acquireWriteGate } from "./writeGate";

/**
 * Private, single-node data directory for the SQLite file, the generated
 * auth secret, and the dev mail outbox. Always derived from env/cwd, never
 * from request input.
 */
export function getDataDir(): string {
  const dir =
    process.env.STYLE_DATA_DIR?.trim() || path.join(process.cwd(), ".data");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

let database: DatabaseSync | null = null;
let authDatabase: DatabaseSync | null = null;
let presence: PresenceHold | null = null;

/**
 * While this process has the live database open it holds a shared "presence"
 * lock (src/server/processPresence.ts) so the restore command can refuse to
 * replace app.db under it, even when the connection is idle. Taken before the
 * first connection opens; released when the last one closes. Throws
 * PresenceBusyError (bounded wait) while a restore is running.
 */
function ensurePresence(): void {
  if (presence) return;
  presence = holdPresence(getDataDir());
}

/**
 * Every handle taken out of service whose closure is not proven (a close that
 * threw and left it open, or that cannot be asked). Presence is never released
 * while one survives: the restore command must keep being told the database is
 * in use.
 */
const unclosed = new Set<DatabaseSync>();

/**
 * Closes `db` and records whether that is proven. Never throws; a close error is
 * returned so the caller can still propagate it after its bookkeeping. A handle
 * whose `close()` threw but that now reports closed counts as closed.
 */
function closeTracked(db: DatabaseSync): { failed: boolean; error?: unknown } {
  let failed = false;
  let error: unknown;
  try {
    if (db.isOpen) db.close();
  } catch (e) {
    failed = true;
    error = e;
  }
  let open = true; // Cannot be asked => assume open.
  try {
    open = db.isOpen;
  } catch {
    // Judged as open.
  }
  if (open) unclosed.add(db);
  else unclosed.delete(db);
  return { failed, error };
}

function anyHandleOpen(): boolean {
  for (const handle of unclosed) {
    let open = true;
    try {
      open = handle.isOpen;
    } catch {
      // Judged as open.
    }
    if (open) return true;
    unclosed.delete(handle);
  }
  return Boolean(database) || Boolean(authDatabase);
}

function releasePresenceIfIdle(): void {
  if (anyHandleOpen() || !presence) return;
  const hold = presence;
  presence = null;
  hold.release();
}

function openConnection(timeoutMs: number): DatabaseSync {
  ensurePresence();
  try {
    return new DatabaseSync(path.join(getDataDir(), "app.db"), {
      // Explicit despite matching the node:sqlite default: a schema with
      // ON DELETE CASCADE relies on this being on for every connection.
      enableForeignKeyConstraints: true,
      // Busy timeout (ms) so a brief writer overlap waits instead of
      // immediately failing with SQLITE_BUSY.
      timeout: timeoutMs,
    });
  } catch (error) {
    releasePresenceIfIdle();
    throw error;
  }
}

/**
 * Lazy singleton connection used for the application tables and for all
 * synchronous write transaction bodies (wardrobe, photos, queue, worker).
 * Those bodies never contain an `await`, so they never span event-loop turns
 * on this handle.
 */
export function getDatabase(): DatabaseSync {
  if (unusableMain) throw unusableMain;
  if (database) return database;
  // Very short native wait on purpose. Production writes go through
  // runWriteTransaction (writeTransaction.ts), which acquires the write lock
  // with bounded *asynchronous* retry, so a lock held by another process
  // never parks this event loop for seconds. Plain reads do not block under
  // WAL.
  database = openConnection(50);
  return database;
}

/**
 * Raised for a main connection that was quarantined after it could not leave a
 * transaction (a failed ROLLBACK), and for any attempt to use it again.
 */
export class DatabaseQuarantineError extends Error {
  constructor(
    message = "The database connection was quarantined after a failed rollback.",
  ) {
    super(message);
    this.name = "DatabaseQuarantineError";
  }
}

/** Handles that must never be joined or used again (see below). */
const quarantined = new WeakSet<DatabaseSync>();
/** Set only if a quarantined main connection could not even be closed. */
let unusableMain: DatabaseQuarantineError | null = null;
let quarantineCount = 0;

/** Whether `db` was quarantined (or has been closed). */
export function isQuarantined(db: DatabaseSync): boolean {
  return quarantined.has(db) || !db.isOpen;
}

/** How many main connections this process has quarantined (diagnostics). */
export function quarantinedConnectionCount(): number {
  return quarantineCount;
}

/**
 * True once a quarantined main connection could not be closed, so this process
 * refuses every {@link getDatabase} until it is restarted. A pure read of one
 * flag: it opens, queries and allocates nothing and cannot throw, so a health
 * probe may call it at any time.
 */
export function mainConnectionUnusable(): boolean {
  return unusableMain !== null;
}

type QuarantineOutcome = "replaceable" | "unclosed" | "marked-only";

/**
 * One operator-visible line per quarantine: fixed text, the outcome (one of the
 * literals above) and the running count only. No SQL, path, error text or user
 * data is ever included, and a failing logger can neither throw nor change the
 * quarantine, so the caller's original failure is always the one reported.
 */
function logQuarantine(outcome: QuarantineOutcome): void {
  try {
    console.error(
      `[database] main connection quarantined: outcome=${outcome} count=${quarantineCount}`,
    );
  } catch {
    // Diagnostics never alter the state or the error being reported.
  }
}

/**
 * Called, with the process write gate still held, when a failed ROLLBACK left
 * `db` inside a transaction. Releasing the gate in that state would let the
 * next caller join the stale transaction (`inTransaction`) or fail every later
 * BEGIN, and the open transaction would keep SQLite's write lock from every
 * other process.
 *
 * The handle is marked first, so no code can use or join it again. If it is
 * the shared main connection it is then taken out of service and closed (closing
 * rolls back anything uncommitted; committed data is untouched) and the next
 * {@link getDatabase} opens a fresh connection to the same file, with the same
 * options, under the presence hold this process already has (the hold is
 * deliberately kept, not released and retaken). If even the close fails, the
 * process refuses every later {@link getDatabase} with
 * {@link DatabaseQuarantineError} until it is restarted: there is no reset
 * function. Nothing is deleted, migrated or recreated, and the auth connection
 * and any other handle are not touched. Never throws, so the caller's original
 * error is the one reported.
 */
export function quarantineMainConnection(db: DatabaseSync): void {
  try {
    quarantined.add(db);
    quarantineCount++;
    if (database !== db) {
      // Not the shared connection: marking is enough.
      logQuarantine("marked-only");
      return;
    }
    database = null;
    // Presence is deliberately not touched here: kept across a successful close
    // and reopen, and kept (via `unclosed`) while the handle survives.
    closeTracked(db);
    if (unclosed.has(db)) {
      unusableMain = new DatabaseQuarantineError(
        "The database connection could not be closed after a failed rollback. Restart the process.",
      );
      logQuarantine("unclosed");
    } else {
      logQuarantine("replaceable");
    }
  } catch {
    // Nothing here may replace the failure being reported.
  }
}

/**
 * Dedicated connection for Better Auth. Its Kysely transactions are async
 * (several statements separated by awaited promises), so sharing one handle
 * with the synchronous code above is unsafe: a direct statement or
 * BEGIN/ROLLBACK from another request could land inside, or roll back, an
 * open auth transaction. A separate connection makes the two kinds of
 * writer contend only through SQLite's own file locking, exactly as the
 * app and worker processes already do. See docs/reviews/concurrency-005-notes.md.
 */
export function getAuthDatabase(): DatabaseSync {
  if (authDatabase) return authDatabase;
  // Very short native wait: lock contention on this connection is handled by
  // the dialect's bounded *asynchronous* retry (authDialect.ts), so the event
  // loop is never parked for seconds inside SQLite.
  authDatabase = openConnection(20);
  return authDatabase;
}

/** Closes every connection this process opened (auth first, then main). */
export function closeDatabases(): void {
  // Handles from earlier failed closes, retried below. Their errors were
  // already reported when they happened; the refusal in getDatabase for a
  // quarantined main stays (only a restart clears it).
  const earlier = [...unclosed];
  let failed = false;
  let firstError: unknown;
  const note = (error: unknown) => {
    if (failed) return;
    failed = true;
    firstError = error;
  };
  try {
    try {
      closeAuthDatabase();
    } catch (error) {
      note(error);
    }
    if (database) {
      const db = database;
      database = null;
      const outcome = closeTracked(db);
      if (outcome.failed) note(outcome.error);
    }
    for (const handle of earlier) closeTracked(handle);
  } finally {
    // Released only now, and only if no handle survives.
    releasePresenceIfIdle();
  }
  if (failed) throw firstError;
}

/** Closes the auth connection if open. The caller closes {@link getDatabase} itself. */
export function closeAuthDatabase(): void {
  if (!authDatabase) return;
  const db = authDatabase;
  authDatabase = null;
  const outcome = closeTracked(db);
  try {
    if (outcome.failed) throw outcome.error;
  } finally {
    releasePresenceIfIdle();
  }
}

// Fixed DDL only — never built from request input. References user(id) so
// deleting a user cascades into every per-user application row.
const APPLICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_deletions (
  user_id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
-- The ledger row is written by the same statement that deletes the user, so
-- a rolled-back or crashed deletion leaves no tombstone and a committed one
-- always has it. (Replaces a separate post-delete hook write.)
CREATE TRIGGER IF NOT EXISTS user_deletion_ledger
AFTER DELETE ON user
BEGIN
  INSERT OR REPLACE INTO account_deletions(user_id, deleted_at)
  VALUES (OLD.id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
CREATE TABLE IF NOT EXISTS mutation_limits (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wardrobe_spaces (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  lease_until INTEGER,
  heartbeat_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  input_image BLOB,
  result_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS analysis_jobs_user_id_idx ON analysis_jobs(user_id);
CREATE INDEX IF NOT EXISTS analysis_jobs_status_lease_idx ON analysis_jobs(status, lease_until);

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS photo_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  data BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photo_assets_user_id_idx ON photo_assets(user_id);
`;

export const QUEUE_METADATA_MIGRATION = "007-queue-metadata";

function columnExists(
  db: DatabaseSync,
  table: string,
  column: string,
): boolean {
  // `table` is always a literal from this file, never request input.
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((c) => c.name === column);
}

/**
 * Additive, idempotent application migrations (build 006 -> 007). Nothing is
 * dropped, rewritten or recreated, so users, wardrobes, photos, saved looks
 * and queued jobs survive, and running it again is a no-op. The caller holds
 * the cross-process schema lock and a BEGIN IMMEDIATE transaction.
 *
 *  analysis_jobs.started_at / finished_at  inference timing (admission ETA)
 *  analysis_jobs.refunded                  one-time quota refund marker
 *  analysis_jobs.failure_kind              'server' | 'model' | 'expired' ...
 *  usage_daily.attempts                    accepted attempts, never refunded
 *  analysis_timings                        anonymous recent job durations
 */
export function migrateApplicationSchema(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const add = (table: string, column: string, ddl: string) => {
    if (!columnExists(db, table, column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  };
  add("analysis_jobs", "started_at", "INTEGER");
  add("analysis_jobs", "finished_at", "INTEGER");
  add("analysis_jobs", "refunded", "INTEGER NOT NULL DEFAULT 0");
  add("analysis_jobs", "failure_kind", "TEXT");
  add("usage_daily", "attempts", "INTEGER NOT NULL DEFAULT 0");
  // Existing days keep their already-spent allowance as attempts too.
  db.exec("UPDATE usage_daily SET attempts = count WHERE attempts < count");
  db.exec(
    "CREATE TABLE IF NOT EXISTS analysis_timings (finished_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS analysis_timings_finished_idx ON analysis_timings(finished_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS analysis_jobs_user_status_idx ON analysis_jobs(user_id, status)",
  );
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations(id, applied_at) VALUES(?, ?)",
  ).run(QUEUE_METADATA_MIGRATION, Date.now());
  migrateMailOutbox(db);
  migrateAnalysisMode(db);
}

export const ANALYSIS_MODE_MIGRATION = "018-analysis-mode";

/**
 * Build 018: the analysis mode a job was ACCEPTED under ('single' | 'multi').
 * Jobs queued by an earlier build have no value (NULL), which the worker reads
 * as 'multi', the only behaviour they were admitted under, so an upgrade with
 * photos still in the queue neither changes their prompt nor their result
 * shape. Purely additive and idempotent; no existing row is rewritten.
 */
function migrateAnalysisMode(db: DatabaseSync): void {
  if (!columnExists(db, "analysis_jobs", "analysis_mode"))
    db.exec("ALTER TABLE analysis_jobs ADD COLUMN analysis_mode TEXT");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations(id, applied_at) VALUES(?, ?)",
  ).run(ANALYSIS_MODE_MIGRATION, Date.now());
}

export const MAIL_OUTBOX_MIGRATION = "008-mail-outbox";

/**
 * Build 007 -> 008: the durable account-mail outbox (src/server/mailOutbox.ts).
 * Purely additive: two new tables and their indexes. No existing table, column,
 * row, verification token, session or queued job is touched. Rows reference
 * user(id) ON DELETE CASCADE, so deleting an account deletes its queued mail
 * (address, subject and body) in the same statement.
 *
 *  mail_outbox        one row per message; `id` is the stable message id.
 *                     Address and body columns are NULLed whenever a message
 *                     stops being deliverable; the metadata row stays for
 *                     24 hours so per-recipient limits still count it.
 *  mail_worker_state  one heartbeat row written by the mail worker.
 */
function migrateMailOutbox(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS mail_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify-email', 'reset-password')),
  recipient_key TEXT NOT NULL,
  to_address TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'expired', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_attempt_at INTEGER,
  sent_at INTEGER,
  last_error_code TEXT
);
CREATE INDEX IF NOT EXISTS mail_outbox_due_idx ON mail_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS mail_outbox_recipient_idx ON mail_outbox(recipient_key, created_at);
CREATE INDEX IF NOT EXISTS mail_outbox_user_idx ON mail_outbox(user_id, kind, status);
CREATE TABLE IF NOT EXISTS mail_worker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  heartbeat_at INTEGER NOT NULL
);
`);
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations(id, applied_at) VALUES(?, ?)",
  ).run(MAIL_OUTBOX_MIGRATION, Date.now());
}

/**
 * Read-only check (no write lock): true when this migration is recorded and
 * every object it adds exists. Every cold start after the first one takes
 * this path, so a fleet of processes starting together does not queue for the
 * write lock just to learn there is nothing to do. Any doubt (including a
 * read error) returns false and the locked, idempotent migration runs.
 */
function applicationMigrationApplied(db: DatabaseSync): boolean {
  try {
    const recorded = db
      .prepare("SELECT 1 AS ok FROM schema_migrations WHERE id=?")
      .get(QUEUE_METADATA_MIGRATION);
    const mailRecorded = db
      .prepare("SELECT 1 AS ok FROM schema_migrations WHERE id=?")
      .get(MAIL_OUTBOX_MIGRATION);
    const tablePresent = (name: string) =>
      Boolean(
        db
          .prepare(
            "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name),
      );
    const modeRecorded = db
      .prepare("SELECT 1 AS ok FROM schema_migrations WHERE id=?")
      .get(ANALYSIS_MODE_MIGRATION);
    return (
      Boolean(recorded) &&
      Boolean(mailRecorded) &&
      Boolean(modeRecorded) &&
      columnExists(db, "analysis_jobs", "analysis_mode") &&
      tablePresent("mail_outbox") &&
      tablePresent("mail_worker_state") &&
      ["started_at", "finished_at", "refunded", "failure_kind"].every((c) =>
        columnExists(db, "analysis_jobs", c),
      ) &&
      columnExists(db, "usage_daily", "attempts") &&
      Boolean(
        db
          .prepare(
            "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='analysis_timings'",
          )
          .get(),
      )
    );
  } catch {
    return false;
  }
}

async function runApplicationMigrations(timeoutMs: number): Promise<void> {
  const db = getDatabase();
  if (applicationMigrationApplied(db)) return;
  // Same discipline as every other writer: the in-process gate first, then an
  // asynchronously retried BEGIN IMMEDIATE, then a synchronous body.
  const release = await acquireWriteGate(timeoutMs);
  try {
    // Unlike a signup or token transaction, this one is atomic AND idempotent
    // (every statement is conditional, nothing is read-modify-written from
    // outside), so a lock refusal at any statement, including COMMIT, can roll
    // back and replay the whole transaction safely within the time budget.
    await retryBusy(
      async () => {
        await retryBusy(() => db.exec("BEGIN IMMEDIATE"), { timeoutMs });
        try {
          migrateApplicationSchema(db);
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // The original error is the one worth reporting.
            }
          }
          throw error;
        }
      },
      { timeoutMs },
    );
  } finally {
    release();
  }
}

let readyPromise: Promise<void> | null = null;

/**
 * Runs Better Auth's own migrations against the exact options used to build
 * the auth instance, then creates the application tables. The in-flight
 * promise is cached so concurrent callers in this process share one run
 * instead of racing; a failed run clears the cache so a later call can
 * retry once the underlying problem is fixed.
 */
export function ensureDatabaseReady(
  authOptions: BetterAuthOptions,
): Promise<void> {
  if (!readyPromise) {
    readyPromise = runReady(authOptions).catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

async function runReady(authOptions: BetterAuthOptions): Promise<void> {
  const release = await lockfile.lock(getDataDir(), {
    lockfilePath: path.join(getDataDir(), "schema.lock"),
    stale: 300_000,
    update: 10_000,
    retries: { retries: 60, factor: 1, minTimeout: 500, maxTimeout: 1000 },
  });
  try {
    // Idempotent statements that have no effect when refused with BUSY, so
    // they are retried asynchronously instead of waiting inside SQLite.
    const bound = { timeoutMs: 30_000 };
    await retryBusy(
      () => getDatabase().exec("PRAGMA journal_mode = WAL;"),
      bound,
    );
    const { runMigrations } = await getMigrations(authOptions);
    await runMigrations();
    await retryBusy(() => getDatabase().exec(APPLICATION_SCHEMA), bound);
    await runApplicationMigrations(bound.timeoutMs);
  } finally {
    await release();
  }
}
