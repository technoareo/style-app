import { randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createBackup, FINAL_BACKUP, type BackupOptions } from "./backupDatabase";
import { acquireProcessLock } from "./directoryLock";
import { exportDeletionLedger, ledgerPath, readLedgerFile, serializeLedger } from "./deletionLedger";
import { syncDirectory, syncFile, type SyncOutcome } from "./durableFs";
import {
  DEFAULT_KDF,
  DEFAULT_LIMITS,
  PackageError,
  verifyPackage,
  writePackage,
  type KdfParams,
  type PackageLimits,
  type PackageStage,
} from "./encryptedPackage";
import { privateSubdirectory } from "./privateDirectory";

/**
 * Operator command core: one encrypted portable backup package (build 021).
 *
 *   1. take the ordinary sanitised backup (backupDatabase.ts, unchanged);
 *   2. export the deletion ledger AFTER it (so its export time is at or after
 *      the backup's) and read the validated ledger back;
 *   3. write database + ledger as one encrypted package (encryptedPackage.ts)
 *      to a PARTIAL name in the private `<data>/exports` directory;
 *   4. re-open the partial exactly as a restore would (full authentication);
 *   5. publish it under a final name that did not exist, by hard link (fails
 *      with EEXIST instead of replacing), then remove the partial name;
 *   6. only now remove the ordinary plain backup this run created (unless the
 *      caller asked to keep it). Any failure before step 5 leaves the plain
 *      backup, the live database and every earlier package untouched and
 *      removes the partial.
 *
 * `exports` is a private subdirectory with the same guards as `backups` and
 * `ledger` (a link or junction in its place is refused; POSIX owner check and
 * mode 0700). One package is made at a time per exports directory (an OS file
 * lock, like the backup lock). Under that lock, every partial of the fixed
 * pattern `style-package-<stamp>.<12 hex>.partial` is removed, because the lock
 * proves its writer is dead; nothing else in the directory is ever deleted.
 *
 * Final names are `style-package-<UTC stamp>[-n].stylepkg`, where the stamp is
 * the one in the plain backup's own name, i.e. the backup creation time the
 * restore command compares the ledger with.
 *
 * The package is on the same disk as the database until the operator copies it
 * off the server; nothing here does that.
 */

export const PACKAGE_FINAL =
  /^style-package-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?\.stylepkg$/;
const PACKAGE_PARTIAL = /^style-package-[0-9TZ-]+\.[0-9a-f]{12}\.partial$/;
const BACKUP_TIME =
  /^style-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?\.db$/;
const BACKUP_STAMP = /^style-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-\d+)?\.db$/;
const EXPORT_LOCK = ".export-coordinator.db";

const utc = (m: RegExpExecArray) =>
  Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);

/** Creation time (ms) encoded in a backup file name, or null. */
export function backupFileTime(name: string): number | null {
  const m = BACKUP_TIME.exec(name);
  return m ? utc(m) : null;
}

export function exportsDirectory(dataDir: string): string {
  return privateSubdirectory(dataDir, "exports", "exports");
}

export type EncryptedBackupStage =
  | "backup-created"
  | "ledger-exported"
  | PackageStage
  | "verified";

export type EncryptedBackupIo = {
  syncFile: (file: string) => SyncOutcome;
  syncDirectory: (dir: string) => SyncOutcome;
  linkFile: (existing: string, target: string) => void;
  unlinkPartial: (file: string) => void;
};
const REAL_IO: EncryptedBackupIo = {
  syncFile,
  syncDirectory,
  linkFile: linkSync,
  unlinkPartial: unlinkSync,
};

export type EncryptedBackupOptions = {
  dataDir: string;
  passphrase: Buffer;
  /** Keep the ordinary plain backup this run created (default: remove it after publication). */
  keepLocal?: boolean;
  kdf?: KdfParams;
  limits?: PackageLimits;
  lockWaitMs?: number;
  now?: () => Date;
  /** A throw aborts like a real failure at that point (failure-injection tests). */
  onStage?: (stage: EncryptedBackupStage, context: { partial: string }) => void | Promise<void>;
  io?: Partial<EncryptedBackupIo>;
  backup?: Pick<BackupOptions, "retentionMs" | "lockWaitMs">;
};

export type EncryptedBackupResult = {
  /** Final package name inside `<data>/exports`. */
  file: string;
  /** The plain backup's name, and whether it was removed after publication. */
  plainBackup: string;
  plainRemoved: boolean;
  ledger: { generation: number; entries: number };
  /** Owned partials or other files that could not be removed (names only). */
  leftovers: string[];
  /** Fixed BACKUP_W_* codes, no user data. */
  warnings: string[];
};

const exists = (target: string): boolean => {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

/** Removes one owned partial by exact name; never a directory, never recursive. */
function removeOwnedPartial(dir: string, name: string): boolean {
  if (path.basename(name) !== name || !PACKAGE_PARTIAL.test(name)) return false;
  const target = path.join(dir, name);
  try {
    const info = lstatSync(target);
    if (info.isFile()) unlinkSync(target);
    else if (info.isSymbolicLink()) {
      try {
        unlinkSync(target);
      } catch {
        rmdirSync(target);
      }
    }
  } catch {
    // Judged by whether it still exists.
  }
  return !exists(target);
}

function sweepDeadPartials(dir: string): string[] {
  const left: string[] = [];
  for (const name of readdirSync(dir))
    if (PACKAGE_PARTIAL.test(name) && !removeOwnedPartial(dir, name)) left.push(name);
  return left;
}

function publish(
  dir: string,
  partialName: string,
  stamp: string,
  io: EncryptedBackupIo,
): { name: string; partialLeft: boolean } {
  const partialPath = path.join(dir, partialName);
  const candidates = [`style-package-${stamp}.stylepkg`];
  for (let n = 1; n < 1000; n++) candidates.push(`style-package-${stamp}-${n}.stylepkg`);
  for (const name of candidates) {
    const target = path.join(dir, name);
    try {
      io.linkFile(partialPath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      // No hard links on this file system: check, then an atomic rename under the lock.
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
  throw new Error("Could not choose an unused package name.");
}

export async function createEncryptedBackup(
  source: DatabaseSync,
  options: EncryptedBackupOptions,
): Promise<EncryptedBackupResult> {
  const io: EncryptedBackupIo = { ...REAL_IO, ...options.io };
  const dir = exportsDirectory(options.dataDir);
  const lock = await acquireProcessLock(path.join(dir, EXPORT_LOCK), {
    waitMs: options.lockWaitMs ?? 30_000,
  });
  let partialName = "";
  try {
    const leftovers = sweepDeadPartials(dir);
    const warnings: string[] = [];
    const stage = async (s: EncryptedBackupStage) => {
      await options.onStage?.(s, { partial: partialName ? path.join(dir, partialName) : "" });
    };

    // 1 and 2: the ordinary backup, then a ledger exported at or after it.
    const plain = await createBackup(source, {
      dataDir: options.dataDir,
      now: options.now,
      ...options.backup,
    });
    leftovers.push(...plain.leftovers);
    await stage("backup-created");
    const madeAt = backupFileTime(plain.file);
    if (madeAt === null) throw new Error("The backup name carries no creation time.");
    await exportDeletionLedger(source, options.dataDir, { force: true });
    const ledger = readLedgerFile(ledgerPath(options.dataDir));
    if (ledger.exportedAt < madeAt) throw new Error("The ledger predates the backup.");
    await stage("ledger-exported");

    // The stamp of the plain backup's own name ("-n" duplicate suffix excluded).
    const stamp = BACKUP_STAMP.exec(plain.file)?.[1];
    if (!stamp) throw new Error("The backup name carries no creation time.");
    partialName = `style-package-${stamp}.${randomBytes(6).toString("hex")}.partial`;
    const partialPath = path.join(dir, partialName);

    try {
      await writePackage({
        databaseFile: path.join(options.dataDir, "backups", plain.file),
        ledgerText: serializeLedger(ledger),
        backupCreatedAt: madeAt,
        passphrase: options.passphrase,
        destination: partialPath,
        kdf: options.kdf ?? DEFAULT_KDF,
        limits: options.limits ?? DEFAULT_LIMITS,
        syncFile: io.syncFile,
        onStage: (s) => stage(s),
      });
      // Open the finished file the way a restore will: the full authentication.
      const info = verifyPackage(partialPath, options.passphrase, options.limits ?? DEFAULT_LIMITS);
      if (info.backupCreatedAt !== madeAt)
        throw new PackageError("VERIFY", "The finished package did not verify.");
      await stage("verified");
      lock.assertHeld();
      const published = publish(dir, partialName, stamp, io);
      if (published.partialLeft) leftovers.push(partialName);
      partialName = "";
      try {
        if (io.syncDirectory(dir) === "unsupported")
          warnings.push("BACKUP_W_DIR_SYNC_UNSUPPORTED");
      } catch {
        warnings.push("BACKUP_W_DIR_SYNC_FAILED");
      }

      // The package exists: from here nothing may turn this into a failure.
      let plainRemoved = false;
      if (!options.keepLocal && FINAL_BACKUP.test(plain.file)) {
        const target = path.join(options.dataDir, "backups", plain.file);
        try {
          if (lstatSync(target).isFile()) unlinkSync(target);
          plainRemoved = !exists(target);
        } catch {
          plainRemoved = false;
        }
        if (!plainRemoved) warnings.push("BACKUP_W_PLAIN_NOT_REMOVED");
      }
      return {
        file: published.name,
        plainBackup: plain.file,
        plainRemoved,
        ledger: { generation: ledger.generation, entries: ledger.entries.length },
        leftovers,
        warnings,
      };
    } catch (error) {
      if (partialName && !removeOwnedPartial(dir, partialName)) leftovers.push(partialName);
      partialName = "";
      throw error;
    }
  } finally {
    try {
      lock.release();
    } catch {
      // The OS releases the lock when this process ends.
    }
  }
}
