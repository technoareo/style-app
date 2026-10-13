import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isSqliteBusy } from "./sqliteRetry";

/**
 * Cooperative "who has the live database open" coordination (build 010, F1).
 *
 * Problem: the restore command replaces `app.db`. A `wal_checkpoint` probe only
 * notices a connection that is in the middle of a transaction; a process that
 * merely has the database open and idle is invisible to it, and on Linux its
 * later writes would go to the replaced (unlinked) file. No SQLite probe on
 * app.db itself can see an idle WAL-mode connection, so this does not try to.
 *
 * Mechanism: every process that opens the live database through
 * `getDatabase()` / `getAuthDatabase()` (the app, the AI worker, the mail
 * worker, init-auth, the backup and ledger commands, tests) first takes a SHARED
 * hold on a separate file, `<data>/.process-presence.db`, and keeps it for as
 * long as it has the database open. The hold is an open read transaction on a
 * rollback-journal SQLite file: the operating system's shared file lock, which
 * any number of processes can hold together. The restore command asks for
 * `BEGIN EXCLUSIVE` on the same file with a zero busy timeout: granted only
 * when nobody holds a shared lock, refused at once otherwise.
 *
 * Properties:
 *  - the kernel releases a dead process's lock: a crashed or SIGKILLed holder
 *    never blocks a restore (no lease, no timestamp, no takeover);
 *  - while restore holds the exclusive lock, a starting process cannot take its
 *    shared hold; it waits at most `timeoutMs` and then fails with
 *    PresenceBusyError (bounded; the supervisor restarts it);
 *  - the presence file is never written after its one-table creation, and is
 *    kept in rollback-journal mode: in WAL mode EXCLUSIVE would not exclude
 *    readers, so nothing here ever sets WAL on it.
 *
 * What this does NOT cover: a process that opens app.db by some other path (a
 * raw `sqlite3` shell, an ad-hoc script using `new DatabaseSync`). It is
 * cooperation between this application's own processes; the restore procedure
 * still tells the operator to stop every service. It also assumes a local
 * volume (file locks on NFS/SMB are unreliable), like the backup lock.
 */

export class PresenceBusyError extends Error {
  readonly code = "PRESENCE_BUSY";
  constructor() {
    super("Another process is using, or restoring, the live database.");
    this.name = "PresenceBusyError";
  }
}

export type PresenceHold = { release(): void };

export const PRESENCE_FILE = ".process-presence.db";

function openPresence(dataDir: string, timeoutMs: number): DatabaseSync {
  return new DatabaseSync(path.join(dataDir, PRESENCE_FILE), {
    timeout: timeoutMs,
  });
}

function closeQuietly(db: DatabaseSync): void {
  try {
    if (db.isOpen) db.close();
  } catch {
    // The original error is the one worth reporting.
  }
}

function releaser(db: DatabaseSync): PresenceHold {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } finally {
        closeQuietly(db);
      }
    },
  };
}

/**
 * Takes a shared hold. Synchronous because `getDatabase()` is. The wait (only
 * while a restore holds the exclusive lock, or for the one-time table
 * creation) is bounded by `timeoutMs`.
 */
export function holdPresence(dataDir: string, timeoutMs = 3000): PresenceHold {
  const db = openPresence(dataDir, timeoutMs);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS presence (id INTEGER)");
    db.exec("BEGIN");
    // A read inside the transaction is what takes (and keeps) the shared lock.
    db.prepare("SELECT COUNT(*) AS n FROM presence").get();
  } catch (error) {
    closeQuietly(db);
    if (isSqliteBusy(error)) throw new PresenceBusyError();
    throw error;
  }
  return releaser(db);
}

/**
 * Takes the exclusive claim for the restore command, or throws
 * PresenceBusyError at once if any process holds a shared hold. Held until
 * `release()` (or the process ends).
 */
export function claimExclusiveAccess(dataDir: string): PresenceHold {
  const db = openPresence(dataDir, 0);
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    closeQuietly(db);
    if (isSqliteBusy(error)) throw new PresenceBusyError();
    throw error;
  }
  return releaser(db);
}
