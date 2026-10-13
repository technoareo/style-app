import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * A private child directory of the data directory (`backups`, `ledger`), with
 * the physical guards the backup module has used since build 009 plus POSIX
 * ownership and mode (build 010):
 *
 *  - the data directory is resolved through `realpath` once; the child is built
 *    from that;
 *  - the child must be a real directory (not a link, not a junction) whose own
 *    `realpath` equals its path;
 *  - on POSIX it must be owned by the current user, and if it is readable or
 *    writable by group/others it is `chmod`ed to 0700. ONLY this one directory
 *    is touched: never recursive, never a file inside it. (`mkdir`'s mode only
 *    applies when the directory is created, so a pre-existing wider directory
 *    was previously accepted as it was.)
 *
 * Windows has no POSIX mode; there the user profile's ACLs apply.
 */
export function privateSubdirectory(
  dataDir: string,
  name: string,
  label: string,
): string {
  if (path.basename(name) !== name) throw new Error("Invalid directory name.");
  const real = realpathSync(dataDir);
  const dir = path.join(real, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`The ${label} directory is not a plain directory.`);
  if (path.relative(realpathSync(dir), dir) !== "")
    throw new Error(`The ${label} directory resolves through a link.`);
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
      throw new Error(`The ${label} directory is owned by another user.`);
    if ((info.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return dir;
}
