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

function releasePresenceIfIdle(): void {
  if (database || authDatabase || !presence) return;
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
  closeAuthDatabase();
  if (!database) return;
  const db = database;
  database = null;
  try {
    if (db.isOpen) db.close();
  } finally {
    releasePresenceIfIdle();
  }
}

/** Closes the auth connection if open. The caller closes {@link getDatabase} itself. */
export function closeAuthDatabase(): void {
  if (!authDatabase) return;
  const db = authDatabase;
  authDatabase = null;
  try {
    if (db.isOpen) db.close();
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
    return (
      Boolean(recorded) &&
      Boolean(mailRecorded) &&
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
