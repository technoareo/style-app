import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { acquireProcessLock } from "./directoryLock";
import { syncDirectory, syncFile, type SyncOutcome } from "./durableFs";
import { privateSubdirectory } from "./privateDirectory";
import { rateLimitTables } from "./sensitiveTables";

/**
 * Failure-safe operator backup (build 009).
 *
 * Build 008 copied the live database straight to its FINAL name
 * (`style-<stamp>.db`) and sanitised it afterwards. A failure or kill between
 * the copy and the end of the sanitising (a full disk during VACUUM is the
 * realistic one) left an unsanitised file under a name the restore command and
 * the 7-day retention both accept, carrying temporary photos, live session
 * tokens, reset tokens and queued mail.
 *
 * Now:
 *  1. ONE backup runs at a time per backups directory, across processes and
 *     containers sharing the volume. Ownership is an operating-system file
 *     lock held by the backup PROCESS on a dedicated coordinator database
 *     (`backups/.backup-coordinator.db`, src/server/directoryLock.ts), from the
 *     first step to the last. The kernel grants it to one process at a time
 *     and releases it the instant that process ends, however it ends; there is
 *     no timestamp, lease or "stale" judgement anywhere, so a slow or blocked
 *     live owner can never be mistaken for a dead one and a paused contender
 *     can never act on an old observation. Holding the lock is what makes the
 *     other steps safe: nobody else is writing a partial, choosing a final name
 *     or pruning;
 *  2. because the held lock proves no live backup exists, every `.partial`
 *     found under it belongs to a dead process and is removed, whatever its
 *     age (the age of a file is never used);
 *  3. the raw copy goes to `style-<stamp>.<12 hex>.partial`. That name matches
 *     neither the restore command's filename rule nor the retention rule, so
 *     nothing treats it as a backup;
 *  4. the partial is sanitised (temporary photos, queued mail, reset tokens,
 *     sessions removed; `secure_delete` on; VACUUM), checkpointed back to a
 *     single rollback-journal file, and verified (integrity, foreign keys, the
 *     sanitised tables empty);
 *  5. the partial is published under a final name by a hard LINK, which fails
 *     if the name exists (a digits-only counter keeps the next name inside the
 *     restore pattern), then the partial name is removed. An existing backup
 *     is never replaced, even if the lock were ever bypassed (a volume whose
 *     file locks do not work). Where hard links are not available the name is
 *     checked and the file renamed under the lock;
 *  6. on any caught failure the partial and its sidecars are removed, and if
 *     one cannot be removed the failure says so (BackupFailure.leftovers); old
 *     backups are pruned only after a backup completed.
 *
 * While a backup runs, and after a kill, the partial exists and is NOT
 * sanitised. It lives in the 0700 backups directory and is never a restore
 * source. Operators copying backups elsewhere must copy `style-*.db` only.
 *
 * Every path touched is built here from the verified data directory and a
 * name this module generated or matched against a fixed pattern; nothing is
 * deleted recursively; links are never followed (a link with an owned name is
 * unlinked, a directory with one is left alone). The live database and its
 * `-wal`/`-shm` live in the data directory, not in `backups/`, and are never
 * candidates.
 */

export const FINAL_BACKUP = /^style-[0-9TZ.-]+\.db$/;
const PARTIAL = /^style-[0-9TZ.-]+\.[0-9a-f]{12}\.partial$/;
const PARTIAL_SIDECAR = /^style-[0-9TZ.-]+\.[0-9a-f]{12}\.partial-(wal|shm|journal)$/;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

export const DEFAULT_RETENTION_MS = 7 * 86_400_000;
export const DEFAULT_LOCK_WAIT_MS = 30_000;
const LOCK_NAME = ".backup-coordinator.db";

export type BackupStage =
  | "copy-started"
  | "raw-copied"
  | "sanitized"
  | "vacuumed"
  | "verified";

/**
 * The few file-system operations whose failure the tests inject (a real I/O
 * error cannot be produced on demand). Defaults are the real operations. This
 * proves the module's REACTION to such an error; it is not evidence about any
 * file system.
 */
export type BackupIo = {
  syncFile: (file: string) => SyncOutcome;
  syncDirectory: (dir: string) => SyncOutcome;
  /** Removes the partial's name after the final name was linked. */
  unlinkPartial: (file: string) => void;
  /**
   * Creates the final name as a hard link to the partial (fails with EEXIST if
   * the name exists). Some environments refuse hard links (EPERM); publication
   * then uses the check-then-rename fallback under the backup lock.
   */
  linkFile: (existing: string, target: string) => void;
};

const REAL_IO: BackupIo = {
  syncFile,
  syncDirectory,
  unlinkPartial: unlinkSync,
  linkFile: linkSync,
};

/**
 * Pages copied per step of the SQLite online backup. SQLite restarts a backup
 * from the beginning whenever ANOTHER connection writes to the source between
 * two steps; the application itself writes every few seconds (heartbeats,
 * sessions, jobs), so many small steps on a large database may never finish.
 * One step for any realistic database (1,000,000 pages is 4 GB) takes a single
 * read snapshot and cannot be restarted. This is a mitigation chosen from
 * SQLite's documented behaviour; tests/backupLarge.test.ts measures it.
 */
export const BACKUP_PAGES_PER_STEP = 1_000_000;

export type BackupOptions = {
  dataDir: string;
  /** How long to wait for another running backup to finish before giving up. */
  lockWaitMs?: number;
  /** Completed backups older than this are removed after a successful backup. */
  retentionMs?: number;
  now?: () => Date;
  /**
   * Called after each stage. A throw aborts the backup exactly like a real
   * failure at that point (used by the failure-injection tests).
   */
  onStage?: (stage: BackupStage) => void | Promise<void>;
  /** Test seam for injected I/O failures (see {@link BackupIo}). */
  io?: Partial<BackupIo>;
};

/** A backup failed; `leftovers` names any unsanitised file that could NOT be removed. */
export class BackupFailure extends Error {
  constructor(
    message: string,
    readonly leftovers: string[],
    readonly reason: unknown,
  ) {
    super(message);
    this.name = "BackupFailure";
  }
}

export type BackupResult = {
  file: string;
  /**
   * Unsanitised files (crash leftovers or cleanup residue) that could not be
   * removed. The backup itself is complete; the operator must remove these.
   */
  leftovers: string[];
  /**
   * False when the published file's durability could not be confirmed because
   * a real I/O error occurred while flushing the backups directory. The file
   * is complete and verified; copy it off the server and take another backup.
   * (A platform that cannot flush a directory at all, such as Windows, is not
   * an error: see `warnings`.)
   */
  durable: boolean;
  /** Fixed diagnostic codes, no user data: BACKUP_W_* . */
  warnings: string[];
};

function privateBackupDirectory(dataDir: string): string {
  return privateSubdirectory(dataDir, "backups", "backups");
}

const exists = (target: string): boolean => {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Removes one file this module owns by name; never a directory, never
 * recursive. Returns true when nothing is left under that name afterwards.
 */
function removeOwned(dir: string, name: string): boolean {
  if (path.basename(name) !== name) return false;
  if (!PARTIAL.test(name) && !PARTIAL_SIDECAR.test(name)) return false;
  const target = path.join(dir, name);
  try {
    const info = lstatSync(target);
    if (info.isFile()) unlinkSync(target);
    else if (info.isSymbolicLink()) {
      // The link itself, never what it points at. Windows removes a directory
      // link or junction with rmdir, which on a link removes only the link.
      try {
        unlinkSync(target);
      } catch {
        rmdirSync(target);
      }
    }
  } catch {
    // Fall through: judged by whether it still exists.
  }
  return !exists(target);
}

/** Removes a partial and its sidecars; returns the names that are still there. */
function removePartial(dir: string, partialName: string): string[] {
  const left: string[] = [];
  for (const name of [partialName, ...SIDECARS.map((s) => partialName + s)])
    if (!removeOwned(dir, name)) left.push(name);
  return left;
}

/**
 * Removes every partial in `dir`. Only called while this process holds the
 * backups lock, which proves no backup is running, so none of them is live.
 * Returns the names that could not be removed.
 */
function sweepDeadPartials(dir: string): string[] {
  const left: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!PARTIAL.test(name) && !PARTIAL_SIDECAR.test(name)) continue;
    if (!removeOwned(dir, name)) left.push(name);
  }
  return left;
}

function pruneCompleted(dir: string, retentionMs: number, now: number): void {
  for (const name of readdirSync(dir)) {
    if (!FINAL_BACKUP.test(name)) continue;
    const target = path.join(dir, name);
    try {
      const info = lstatSync(target);
      if (info.isFile() && info.mtimeMs < now - retentionMs) unlinkSync(target);
    } catch {
      // Leave it; retention is best effort and never blocks a good backup.
    }
  }
}

const SANITISED_TABLES = [
  "analysis_jobs",
  "mail_outbox",
  "verification",
  "session",
] as const;

/**
 * The tables emptied in every backup: the four fixed ones plus the rate-limit
 * table(s) found in this very database (client IP addresses; see
 * sensitiveTables.ts). Names are plain identifiers, quoted when used.
 */
function sanitisedTableNames(copy: DatabaseSync): string[] {
  return [...SANITISED_TABLES, ...rateLimitTables(copy)];
}

function sanitise(copy: DatabaseSync): void {
  copy.exec("PRAGMA secure_delete=ON");
  copy.exec("BEGIN IMMEDIATE");
  try {
    // Temporary analysis photos; queued account mail (addresses and one-time
    // links); reset tokens; live session tokens; rate-limit rows (client IPs).
    // All useless after a restore (links expire within the hour, restore never
    // replays mail, sessions are cleared) and dangerous to keep.
    for (const table of sanitisedTableNames(copy))
      copy.exec(`DELETE FROM "${table}"`);
    copy.exec(
      "DROP TABLE IF EXISTS worker_state; DROP TABLE IF EXISTS mail_worker_state;",
    );
    copy.exec("COMMIT");
  } catch (error) {
    if (copy.isTransaction) {
      try {
        copy.exec("ROLLBACK");
      } catch {
        // The original error is the one worth reporting.
      }
    }
    throw error;
  }
}

function verify(copy: DatabaseSync): void {
  const integrity = copy.prepare("PRAGMA integrity_check").get() as {
    integrity_check: string;
  };
  if (integrity.integrity_check !== "ok")
    throw new Error("Backup integrity verification failed.");
  if (copy.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("Backup relationship verification failed.");
  for (const table of sanitisedTableNames(copy)) {
    const row = copy.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
      n: number;
    };
    if (row.n !== 0) throw new Error("Backup sanitising verification failed.");
  }
}

/**
 * Publishes the finished partial under a final name that did not exist, and
 * returns it. A hard link fails with EEXIST instead of replacing anything, so
 * even a second process that somehow got past the lock cannot overwrite a
 * completed backup. Where hard links are unavailable, falls back to
 * check-then-rename (safe under the lock).
 *
 * Once the final name exists the backup IS published: failing to remove the
 * partial's name afterwards (it holds the same sanitised bytes) is reported as
 * `partialLeft`, never as a failed backup.
 */
function publish(
  dir: string,
  partialName: string,
  stamp: string,
  io: BackupIo,
): { name: string; partialLeft: boolean } {
  const partialPath = path.join(dir, partialName);
  const candidates = [`style-${stamp}.db`];
  for (let n = 1; n < 1000; n++) candidates.push(`style-${stamp}-${n}.db`);
  for (const name of candidates) {
    const target = path.join(dir, name);
    try {
      io.linkFile(partialPath, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      // No hard links here: rename is atomic and the lock makes the check safe.
      if (exists(target)) continue;
      renameSync(partialPath, target);
      return { name, partialLeft: false };
    }
    try {
      io.unlinkPartial(partialPath);
    } catch {
      return { name, partialLeft: true };
    }
    return { name, partialLeft: false };
  }
  throw new Error("Could not choose an unused backup name.");
}

/**
 * Creates one sanitised backup of `source` (the live main connection).
 * Resolves to the final file name inside `<dataDir>/backups`. Rejects with a
 * BackupFailure, leaving no partial and no final file behind (or naming the
 * file that could not be removed), if any step fails; earlier backups and the
 * live database are never modified.
 */
export async function createBackup(
  source: DatabaseSync,
  options: BackupOptions,
): Promise<BackupResult> {
  const now = options.now ?? (() => new Date());
  const io: BackupIo = { ...REAL_IO, ...options.io };
  const dir = privateBackupDirectory(options.dataDir);
  const lock = await acquireProcessLock(path.join(dir, LOCK_NAME), {
    waitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
  });
  const stage = async (s: BackupStage) => {
    await options.onStage?.(s);
  };
  let partialName = "";
  try {
    const leftovers = sweepDeadPartials(dir);
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    partialName = `style-${stamp}.${randomBytes(6).toString("hex")}.partial`;
    const partialPath = path.join(dir, partialName);
    const warnings: string[] = [];

    try {
      // Created first with owner-only permissions (SQLite keeps an existing
      // file's mode), so the unsanitised copy is never created world-readable
      // even inside a directory that was wider than 0700 before.
      closeSync(openSync(partialPath, "wx", 0o600));
      // Marks the moment the SQLite copy begins (directory, lock and sweep
      // work is not copying); tests/backupLarge.test.ts measures from here.
      await stage("copy-started");
      await backup(source, partialPath, { rate: BACKUP_PAGES_PER_STEP });
      await stage("raw-copied");
      const copy = new DatabaseSync(partialPath);
      try {
        sanitise(copy);
        await stage("sanitized");
        copy.exec("VACUUM");
        await stage("vacuumed");
        // Fold the WAL into the single file and leave it in rollback-journal
        // mode, so the finished backup has no sidecars.
        copy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        copy.exec("PRAGMA journal_mode=DELETE");
        verify(copy);
      } finally {
        copy.close();
      }
      for (const suffix of SIDECARS) {
        const name = partialName + suffix;
        if (exists(path.join(dir, name)) && !removeOwned(dir, name))
          throw new Error("A backup sidecar file could not be removed.");
      }
      // A real I/O error here fails the backup (the partial is removed and
      // nothing is published). Only "this file system cannot fsync" is
      // tolerated, and is reported.
      if (io.syncFile(partialPath) === "unsupported")
        warnings.push("BACKUP_W_FILE_SYNC_UNSUPPORTED");
      await stage("verified");
      // The OS lock cannot be taken from a live holder; this only catches a
      // programming error (a released or closed lock) before publishing.
      lock.assertHeld();
      const published = publish(dir, partialName, stamp, io);
      // From here the backup exists under its final name: nothing below may
      // turn it into a reported failure.
      if (published.partialLeft) leftovers.push(partialName);
      partialName = "";
      let durable = true;
      try {
        if (io.syncDirectory(dir) === "unsupported")
          warnings.push("BACKUP_W_DIR_SYNC_UNSUPPORTED");
      } catch {
        durable = false;
        warnings.push("BACKUP_W_DIR_SYNC_FAILED");
      }
      // Older backups are removed only once the new one is known to be durable.
      if (durable)
        pruneCompleted(
          dir,
          options.retentionMs ?? DEFAULT_RETENTION_MS,
          now().getTime(),
        );
      return { file: published.name, leftovers, durable, warnings };
    } catch (error) {
      const left = partialName ? removePartial(dir, partialName) : [];
      partialName = "";
      throw new BackupFailure(
        left.length
          ? "Backup failed and an unsanitised file could not be removed."
          : "Backup failed.",
        [...leftovers, ...left],
        error,
      );
    }
  } finally {
    try {
      lock.release();
    } catch {
      // The OS releases the lock when this process ends, whatever happens here.
    }
  }
}
