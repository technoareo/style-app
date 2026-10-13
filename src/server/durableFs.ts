import { closeSync, fsyncSync, openSync, renameSync } from "node:fs";

/**
 * Durability helpers (build 010).
 *
 * Build 009 swallowed EVERY fsync error, so a real I/O failure (EIO, ENOSPC,
 * EDQUOT) was indistinguishable from "this file system cannot fsync". Now:
 *
 *  - an error that only says "not supported here" (EINVAL, ENOTSUP, EOPNOTSUPP,
 *    ENOSYS) is reported as `unsupported`, a documented platform limitation;
 *  - directories cannot be opened for fsync on Windows; that is `unsupported`
 *    there by platform, not by error;
 *  - everything else, including a failure to open the file, is thrown.
 *
 * Callers decide what a thrown error means (fail the backup before publishing,
 * or report an unconfirmed-durability warning after it).
 */

export type SyncOutcome = "synced" | "unsupported";

const NOT_SUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** True only for errors that say "this file system cannot fsync", never for I/O failure. */
export function isUnsupportedSyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && NOT_SUPPORTED.has(code);
}

function fsyncPath(target: string, flags: "r" | "r+"): SyncOutcome {
  const fd = openSync(target, flags);
  try {
    fsyncSync(fd);
    return "synced";
  } catch (error) {
    if (isUnsupportedSyncError(error)) return "unsupported";
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** Flushes one regular file to stable storage. */
export function syncFile(file: string): SyncOutcome {
  return fsyncPath(file, "r+");
}

/**
 * Flushes a directory's entries (a new link or rename) to stable storage.
 * Windows has no directory fsync: `unsupported` by platform.
 */
export function syncDirectory(dir: string): SyncOutcome {
  if (process.platform === "win32") return "unsupported";
  return fsyncPath(dir, "r");
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const TRANSIENT_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * rename() that replaces an existing file. On Windows the replace can fail for
 * a few milliseconds while a reader has the target open; retry briefly, then
 * give up and throw. Bounded: about one second in total.
 */
export function renameReplacing(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 40 || !code || !TRANSIENT_RENAME.has(code)) throw error;
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
}
