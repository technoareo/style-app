import { getReadyAuth } from "../src/server/auth";
import { BackupFailure } from "../src/server/backupDatabase";
import { loadPassphrase } from "../src/server/backupPassphrase";
import { createEncryptedBackup } from "../src/server/encryptedBackup";
import { PackageError } from "../src/server/encryptedPackage";
import { closeDatabases, getDatabase, getDataDir } from "../src/server/database";

/**
 * Operator command: one encrypted, portable backup package (build 021).
 *
 *   backup-encrypted.ts [--keep-local]
 *   env STYLE_BACKUP_PASSPHRASE_FILE or STYLE_BACKUP_PASSPHRASE   the passphrase
 *
 * Takes the ordinary sanitised backup, exports the deletion ledger after it,
 * and publishes both as ONE encrypted package in the private
 * `<data>/exports` directory (src/server/encryptedBackup.ts). The ordinary
 * plain backup made by this run is removed AFTER the package is published and
 * verified; --keep-local keeps it. A failure at any earlier point publishes
 * nothing and leaves the live database and earlier packages untouched.
 *
 * The passphrase is read from the environment or a protected file only, never
 * from arguments, and is never printed. The package is still on the server's
 * own disk: copying it off the server, and keeping the passphrase somewhere
 * else, are the operator's job (docs/DEPLOYMENT.md).
 *
 * Output is fixed text and codes. Exit: 0 done; 1 failed, nothing published;
 * 2 published, but something needs the operator (a named leftover file, a
 * directory flush that failed, the plain backup not removed).
 */

function parseArguments(argv: string[]): { keepLocal: boolean } {
  let keepLocal = false;
  for (const arg of argv) {
    if (arg === "--keep-local") keepLocal = true;
    else throw new PackageError("INPUT", "Unexpected argument. Only --keep-local is accepted.");
  }
  return { keepLocal };
}

async function main() {
  const { keepLocal } = parseArguments(process.argv.slice(2));
  // Before any backup work: a missing or weak passphrase fails closed.
  const passphrase = loadPassphrase();
  try {
    await getReadyAuth();
    const result = await createEncryptedBackup(getDatabase(), {
      dataDir: getDataDir(),
      passphrase,
      keepLocal,
    });
    console.log(
      `Encrypted backup package published in the private exports directory: ${result.file}`,
    );
    console.log(
      `It holds the sanitised database backup and the deletion ledger (generation ${result.ledger.generation}, ${result.ledger.entries} entries) exported after it.`,
    );
    console.log(
      "It is still on this server's disk. Copy it off the server, keep the passphrase somewhere else, and test a restore. Without the passphrase the data cannot be recovered.",
    );
    if (result.plainRemoved)
      console.log("The ordinary local backup made by this run was removed after publication.");
    if (result.leftovers.length) {
      console.error(
        `WARNING: file(s) remain in the private backups or exports directory and must be deleted by hand: ${result.leftovers.join(", ")}`,
      );
      process.exitCode = 2;
    }
    for (const code of result.warnings) {
      if (code === "BACKUP_W_DIR_SYNC_UNSUPPORTED")
        console.log(`Note ${code} (a platform limit, not an error).`);
      else {
        console.error(
          code === "BACKUP_W_PLAIN_NOT_REMOVED"
            ? `WARNING ${code}: the package is published, but the ordinary plain backup made by this run could not be removed; delete it by hand.`
            : `WARNING ${code}: the package is complete but its durability could not be confirmed; copy it off the server and take another.`,
        );
        process.exitCode = 2;
      }
    }
  } finally {
    passphrase.fill(0);
    try {
      closeDatabases();
    } catch {
      // The exit code already reports the outcome.
    }
  }
}

main().catch((error) => {
  if (error instanceof PackageError) {
    console.error(`BACKUP_E_PKG_${error.code}: ${error.message}`);
  } else if (error instanceof BackupFailure) {
    console.error(
      "Encrypted backup failed. No package was published; the live data and earlier packages were not changed.",
    );
  } else {
    console.error(
      error instanceof Error && /^Another backup is running/.test(error.message)
        ? error.message
        : "Encrypted backup failed. No package was published; the live data and earlier packages were not changed. An ordinary local backup may have been created and was kept.",
    );
  }
  process.exitCode = 1;
});
