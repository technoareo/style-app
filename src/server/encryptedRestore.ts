import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import { LedgerError, parseLedger } from "./deletionLedger";
import { exportsDirectory } from "./encryptedBackup";
import {
  authenticatePackage,
  DEFAULT_LIMITS,
  extractPackage,
  PackageError,
  type Authenticated,
  type PackageLimits,
} from "./encryptedPackage";
import { privateSubdirectory } from "./privateDirectory";
import { noteLeftover, refuse, removeStagingName, type RestoreSource } from "./restoreDatabase";

/**
 * Restore from an encrypted package (build 021). Builds the `prepare` step of
 * the shared restore (restoreDatabase.ts), which runs UNDER the exclusive
 * process-presence claim:
 *
 *   1. the package is looked up by exact file name in the private
 *      `<data>/exports` directory (never an arbitrary path; a link, a directory
 *      or a missing file is refused);
 *   2. fixed-pattern leftovers of earlier crashed restores are swept from
 *      `<data>/restore-staging` (owner-only; only `package-<16 hex>.pending`);
 *   3. format, version, KDF settings, declared sizes and the real file size are
 *      validated and the whole file is AUTHENTICATED with the passphrase
 *      (encryptedPackage.ts pass 1) before anything is written;
 *   4. only then is the database decrypted, to a unique owner-only file in the
 *      staging directory, and the embedded ledger parsed and checked against
 *      the backup time;
 *   5. the shared restore verifies the database completely, applies the
 *      ledgers (the embedded one plus an optional newer `--ledger` file), and
 *      replaces `app.db` last.
 *
 * The decrypted staging file is removed in every outcome (success, refusal,
 * exception). If it cannot be removed it is reported by name
 * (RESTORE_W_STAGING_LEFT) and the exit code is 2. Removal is an unlink, not
 * a secure wipe: deleted bytes can remain on the disk until overwritten, so
 * run restores on an encrypted volume where that matters.
 *
 * The passphrase buffer is wiped when the step finishes.
 */

export const RESTORE_STAGING_DIR = "restore-staging";
const PACKAGE_STAGING = /^package-[0-9a-f]{16}\.pending$/;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

function mapPackageError(error: unknown): never {
  if (error instanceof PackageError)
    throw refuse(`RESTORE_E_PKG_${error.code}`, error.message);
  throw error;
}

export type EncryptedRestoreOptions = {
  directory: string;
  filename: string;
  passphrase: Buffer;
  /** A separately copied, possibly newer deletion ledger, merged with the packaged one. */
  extraLedgerFile: string | null;
  limits?: PackageLimits;
};

export function encryptedRestorePreparer(
  options: EncryptedRestoreOptions,
): () => RestoreSource {
  return () => {
    let staged: string | null = null;
    const cleanup = () => {
      if (staged && !removeStagingName(staged)) noteLeftover(path.basename(staged));
      staged = null;
    };
    try {
      let exportsDir: string;
      let stagingDir: string;
      try {
        exportsDir = exportsDirectory(options.directory);
        stagingDir = privateSubdirectory(
          options.directory,
          RESTORE_STAGING_DIR,
          "restore staging",
        );
      } catch {
        throw refuse(
          "RESTORE_E_PACKAGE_INVALID",
          "The exports or staging directory is not a plain private directory.",
        );
      }
      const file = path.join(exportsDir, options.filename);
      let info;
      try {
        info = lstatSync(file);
      } catch {
        throw refuse("RESTORE_E_BACKUP_INVALID", "The package file does not exist.");
      }
      if (!info.isFile())
        throw refuse("RESTORE_E_BACKUP_INVALID", "The package is not a plain file.");

      for (const name of readdirSync(stagingDir))
        if (PACKAGE_STAGING.test(name) && !removeStagingName(path.join(stagingDir, name)))
          noteLeftover(name);

      const limits = options.limits ?? DEFAULT_LIMITS;
      let authenticated: Authenticated;
      try {
        authenticated = authenticatePackage(file, options.passphrase, limits);
      } catch (error) {
        mapPackageError(error);
      }
      let ledgerText: string;
      try {
        staged = path.join(
          stagingDir,
          `package-${randomBytes(8).toString("hex")}.pending`,
        );
        try {
          ledgerText = extractPackage(file, authenticated, staged, limits);
        } catch (error) {
          mapPackageError(error);
        }
      } finally {
        authenticated.key.fill(0);
      }

      let ledger;
      try {
        ledger = parseLedger(ledgerText);
      } catch (error) {
        if (error instanceof LedgerError)
          throw refuse(
            "RESTORE_E_LEDGER_INVALID",
            "The deletion ledger inside the package is damaged. Nothing was changed.",
          );
        throw error;
      }
      if (ledger.exportedAt < authenticated.info.backupCreatedAt)
        throw refuse(
          "RESTORE_E_PACKAGE_INVALID",
          "The package's ledger was exported before its backup was made; it is not a package this software creates.",
        );

      const fd = openSync(staged, "r");
      try {
        const head = Buffer.alloc(SQLITE_MAGIC.length);
        if (
          readSync(fd, head, 0, head.length, 0) !== head.length ||
          !head.equals(SQLITE_MAGIC)
        )
          throw refuse(
            "RESTORE_E_BACKUP_INVALID",
            "The database inside the package is not a SQLite database. The existing database was not replaced.",
          );
      } finally {
        closeSync(fd);
      }

      return {
        databaseFile: staged,
        madeAt: authenticated.info.backupCreatedAt,
        ledgers: [
          { ledger },
          ...(options.extraLedgerFile ? [{ file: options.extraLedgerFile }] : []),
        ],
        cleanup: () => {
          cleanup();
          options.passphrase.fill(0);
        },
      };
    } catch (error) {
      cleanup();
      options.passphrase.fill(0);
      throw error;
    }
  };
}
