import { BackupFailure, createBackup } from "../src/server/backupDatabase";
import { getReadyAuth } from "../src/server/auth";
import {
  closeDatabases,
  getDatabase,
  getDataDir,
} from "../src/server/database";
import { exportDeletionLedger } from "../src/server/deletionLedger";

/**
 * Operator backup. The work is in src/server/backupDatabase.ts: one backup at
 * a time (cross-process lock), the raw copy is written to a `.partial` file,
 * sanitised and verified, and only then renamed to a final `style-*.db` name
 * that did not exist. A failure leaves no final file and removes the partial;
 * earlier backups and the live database are untouched.
 *
 * After a published backup the current deletion ledger is rewritten
 * (src/server/deletionLedger.ts) so its export time is later than the backup.
 * The ledger is NOT part of the backup: it must be copied off the server often
 * and separately (docs/DEPLOYMENT.md).
 *
 * Exit codes: 0 done; 1 failed (nothing published); 2 published, but something
 * needs the operator: an unsanitised/duplicate leftover file named on stderr,
 * a directory flush that hit a real I/O error (BACKUP_W_DIR_SYNC_FAILED), or
 * a ledger export that failed (BACKUP_W_LEDGER_FAILED). Platform limits that
 * are not errors (Windows cannot flush a directory) are printed as
 * informational codes and keep exit 0.
 */
const INFORMATIONAL = new Set([
  "BACKUP_W_FILE_SYNC_UNSUPPORTED",
  "BACKUP_W_DIR_SYNC_UNSUPPORTED",
]);

function reportLeftovers(names: string[]) {
  if (!names.length) return;
  // Names follow a fixed pattern (style-<time>.<hex>.partial[-wal|-shm|-journal]);
  // they hold no user data.
  console.error(
    `WARNING: file(s) remain in the private backups directory and must be deleted by hand: ${names.join(", ")}`,
  );
  process.exitCode = 2;
}

async function main() {
  await getReadyAuth();
  const result = await createBackup(getDatabase(), { dataDir: getDataDir() });
  console.log(
    "Consistent account and photo backup created in the private backups directory.",
  );
  reportLeftovers(result.leftovers);
  for (const code of result.warnings) {
    if (INFORMATIONAL.has(code)) console.log(`Note ${code} (a platform limit, not an error).`);
    else {
      console.error(
        `WARNING ${code}: the backup file is complete but its durability could not be confirmed; copy it off the server and take another backup.`,
      );
      process.exitCode = 2;
    }
  }
  try {
    const ledger = await exportDeletionLedger(getDatabase(), getDataDir(), {
      force: true,
    });
    console.log(
      `Deletion ledger written (generation ${ledger.generation}, ${ledger.entries} entries). Copy it off the server separately and often.`,
    );
    if (ledger.quarantined)
      console.error(
        `WARNING BACKUP_W_LEDGER_QUARANTINED: an unreadable ledger was set aside as ${ledger.quarantined} in the ledger directory.`,
      );
  } catch {
    console.error(
      "WARNING BACKUP_W_LEDGER_FAILED: the deletion ledger could not be written; run scripts/export-deletion-ledger.ts.",
    );
    process.exitCode = 2;
  }
  closeDatabases();
}
main().catch((error) => {
  if (error instanceof BackupFailure) {
    console.error(
      "Backup failed. No backup file was created; earlier backups and the live data were not changed.",
    );
    process.exitCode = 1;
    reportLeftovers(error.leftovers);
  } else {
    console.error(
      error instanceof Error && /^Another backup is running/.test(error.message)
        ? error.message
        : "Backup failed. No backup file was created; earlier backups and the live data were not changed.",
    );
    process.exitCode = 1;
  }
  try {
    closeDatabases();
  } catch {
    // Nothing more to do; the exit code already reports the failure.
  }
});
