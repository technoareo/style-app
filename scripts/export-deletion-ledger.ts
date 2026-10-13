import { getReadyAuth } from "../src/server/auth";
import {
  closeDatabases,
  getDatabase,
  getDataDir,
} from "../src/server/database";
import { exportDeletionLedger, ledgerPath } from "../src/server/deletionLedger";

/**
 * Writes the current deletion ledger (a forced export) and prints where it is.
 * Run it from cron right before copying `<data>/ledger/deletion-ledger.json`
 * off the server; the copy's age is the recovery point for account deletions
 * after a total loss of the volume (docs/DEPLOYMENT.md).
 *
 * Exit codes: 0 written; 1 failed. Output is a fixed text and counts; no user
 * ids are printed.
 */
async function main() {
  await getReadyAuth();
  const result = await exportDeletionLedger(getDatabase(), getDataDir(), {
    force: true,
  });
  console.log(
    `Deletion ledger written: ${ledgerPath(getDataDir())} (generation ${result.generation}, ${result.entries} entries).`,
  );
  if (result.quarantined)
    console.error(
      `WARNING LEDGER_QUARANTINED: an invalid earlier ledger was set aside as ${result.quarantined} in the ledger directory.`,
    );
  closeDatabases();
}

main().catch(() => {
  console.error("LEDGER_EXPORT_FAILED: the deletion ledger could not be written.");
  process.exitCode = 1;
  try {
    closeDatabases();
  } catch {
    // The exit code already reports the failure.
  }
});
