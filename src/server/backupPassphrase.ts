import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { PackageError } from "./encryptedPackage";

/**
 * The backup passphrase (build 021). It is read ONLY from the process
 * environment or a protected file, never from a command-line argument (argv is
 * visible to every local user and lands in shell history), and it is never
 * printed, logged, or written anywhere by this software.
 *
 *   STYLE_BACKUP_PASSPHRASE_FILE   path to a file holding the passphrase
 *                                  (preferred: a mounted secret)
 *   STYLE_BACKUP_PASSPHRASE        the passphrase itself
 *
 * Exactly one must be set. A passphrase file must be a regular file (a link is
 * refused), at most 4 KiB, and on POSIX owned by the current user with no
 * group/other permission bits. One trailing line break is dropped from a file
 * (editors add it); an environment value is used exactly as given.
 *
 * Strength is enforced, fail closed: at least 20 characters, at least 10
 * different characters, no NUL, at most 1,024 bytes. `openssl rand -base64 32`
 * produces a suitable one. The scrypt cost makes guessing slow; it does not
 * rescue a short or reused phrase.
 *
 * The returned buffer is the caller's to wipe (`fill(0)`) when finished; the
 * environment entry is deleted from the env object once read, so a child
 * process started later does not inherit it.
 */

export const PASSPHRASE_ENV = "STYLE_BACKUP_PASSPHRASE";
export const PASSPHRASE_FILE_ENV = "STYLE_BACKUP_PASSPHRASE_FILE";
export const MIN_PASSPHRASE_CHARS = 20;
export const MIN_PASSPHRASE_DISTINCT = 10;
export const MAX_PASSPHRASE_BYTES = 1024;
const MAX_FILE_BYTES = 4096;

export function validatePassphrase(value: string): void {
  if (
    Array.from(value).length < MIN_PASSPHRASE_CHARS ||
    new Set(Array.from(value)).size < MIN_PASSPHRASE_DISTINCT ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PASSPHRASE_BYTES
  )
    throw new PackageError(
      "PASSPHRASE_WEAK",
      `The backup passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters with at least ${MIN_PASSPHRASE_DISTINCT} different ones (and under ${MAX_PASSPHRASE_BYTES} bytes). Generate one with 'openssl rand -base64 32'.`,
    );
}

function readProtectedFile(file: string): string {
  const unsafe = () =>
    new PackageError(
      "PASSPHRASE_FILE",
      "The passphrase file must be a plain file of at most 4 KiB that only its owner can read.",
    );
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw unsafe();
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_FILE_BYTES || info.size === 0) throw unsafe();
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw unsafe();
      if ((info.mode & 0o077) !== 0) throw unsafe();
    }
    const buffer = Buffer.alloc(info.size);
    if (readSync(fd, buffer, 0, info.size, 0) !== info.size) throw unsafe();
    const text = buffer.toString("utf8");
    buffer.fill(0);
    return text.replace(/\r?\n$/, "");
  } finally {
    closeSync(fd);
  }
}

export function loadPassphrase(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const direct = env[PASSPHRASE_ENV];
  const file = env[PASSPHRASE_FILE_ENV];
  if (direct && file)
    throw new PackageError(
      "PASSPHRASE_AMBIGUOUS",
      `Set only one of ${PASSPHRASE_ENV} and ${PASSPHRASE_FILE_ENV}.`,
    );
  if (!direct && !file)
    throw new PackageError(
      "PASSPHRASE_MISSING",
      `Set ${PASSPHRASE_FILE_ENV} (a protected file) or ${PASSPHRASE_ENV} in the environment. The passphrase is never accepted as an argument.`,
    );
  // An empty variable counts as unset (checked above), so `||`, not `??`.
  const value = direct || readProtectedFile(file as string);
  validatePassphrase(value);
  delete env[PASSPHRASE_ENV];
  return Buffer.from(value, "utf8");
}
