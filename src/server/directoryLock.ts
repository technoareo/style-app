import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isSqliteBusy, sleep } from "./sqliteRetry";

/**
 * Cross-process ownership of the backups directory (build 009, second
 * correction). The file keeps its earlier name; the mechanism is new.
 *
 * What went wrong before, twice:
 *  1. a lock refreshed from the owner's event loop made a live owner whose
 *     main thread was busy look dead (root's live-owner probe);
 *  2. the repair, a keeper thread plus "take over a lock older than the lease
 *     by renaming the lock directory", still treated an OLD observation of age
 *     as authority: a contender that had seen the stale lock and then paused
 *     renamed the CURRENT lock (a fresh owner's) out from under it (root's
 *     takeover probe, docs/verification/directory-lock-takeover-009.json).
 *     Age, however it is refreshed, and a rename of "whatever is at this path
 *     now" are not ownership.
 *
 * Now ownership is an operating-system lock held by the owning PROCESS, with
 * no timestamp anywhere:
 *
 *  - the lock is a SQLite write reservation (`BEGIN IMMEDIATE`, held for the
 *    whole backup) on a dedicated coordinator database file,
 *    `backups/.backup-coordinator.db`. It is a different file from the live
 *    application database and uses none of its write gate, so a backup never
 *    waits for, or blocks, application writes;
 *  - SQLite implements it with the platform's file lock (fcntl on POSIX,
 *    LockFileEx on Windows), which the kernel grants to exactly one process at
 *    a time and RELEASES THE INSTANT THAT PROCESS ENDS, however it ends
 *    (SIGKILL, crash, power-off of the container). So:
 *      * live owner, even with its main thread blocked for minutes in native
 *        code: still holds it, nobody else can get it;
 *      * dead owner: gone at once, no lease to wait out, and no way for a slow
 *        or paused contender to mistake a live owner for a dead one, because
 *        nobody ever decides anything from age or from an earlier look. A
 *        contender simply asks for the lock and is told yes or busy at that
 *        moment, atomically, by the kernel;
 *      * two contenders racing for a freed lock: the kernel grants one; the
 *        other is told busy and retries. Neither can take it from the holder;
 *  - because a granted lock proves no other live backup exists, whatever
 *    `.partial` files are found while holding it belong to dead processes.
 *
 * Residual cases, stated rather than hidden:
 *  - SQLite file locks are only as good as the file system. On a local volume
 *    (a Docker named volume, a local disk) they are reliable; on NFS/SMB they
 *    may not be. Keep `/data` on a local volume. Containers sharing one local
 *    volume share the lock;
 *  - a process that is alive but frozen (SIGSTOP, a hung VM) still holds the
 *    lock; backups wait (up to `waitMs`) and then give up with a clear message.
 *    The operator kills that process; the lock is then free at once;
 *  - the coordinator file is created empty and never written to; if it is a
 *    link or not a regular file the lock refuses to open it.
 *
 * Nothing here deletes anything.
 */

export class LockBusyError extends Error {
  constructor() {
    super("Another backup is running (it holds the backups lock).");
    this.name = "LockBusyError";
  }
}

export type ProcessLock = {
  /** Throws unless this process still holds the lock. */
  assertHeld(): void;
  /** Releases the lock (also released by the OS if the process ends first). */
  release(): void;
};

export type ProcessLockOptions = {
  /** How long to wait for a busy lock. 0 = fail at once. */
  waitMs: number;
  pollMs?: number;
};

function assertPlainFileOrAbsent(file: string): void {
  let info;
  try {
    info = lstatSync(file);
  } catch {
    return; // not there yet: SQLite will create an empty file
  }
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error("The backup coordinator file is not a plain file.");
}

export async function acquireProcessLock(
  file: string,
  options: ProcessLockOptions,
): Promise<ProcessLock> {
  assertPlainFileOrAbsent(file);
  // timeout: 0 = never wait inside SQLite; waiting is done here, off the
  // event loop's critical path, and bounded by waitMs.
  const db = new DatabaseSync(file, { timeout: 0 });
  const deadline = Date.now() + options.waitMs;
  try {
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        if (Date.now() >= deadline) throw new LockBusyError();
        await sleep(
          Math.min(options.pollMs ?? 100, Math.max(5, deadline - Date.now())),
        );
      }
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // Closing releases nothing we hold; the original error is the one to report.
    }
    throw error;
  }

  let released = false;
  return {
    assertHeld() {
      if (released || !db.isOpen || !db.isTransaction)
        throw new Error("The backup lock is not held; refusing to continue.");
    },
    release() {
      if (released) return;
      released = true;
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } finally {
        if (db.isOpen) db.close();
      }
    },
  };
}
