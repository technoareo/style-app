import { loadPassphrase } from "../src/server/backupPassphrase";
import { PACKAGE_FINAL } from "../src/server/encryptedBackup";
import { PackageError } from "../src/server/encryptedPackage";
import { encryptedRestorePreparer } from "../src/server/encryptedRestore";
import { refuse, runRestoreCommand } from "../src/server/restoreDatabase";

/**
 * Restore from an encrypted backup package (build 021).
 *
 *   restore-encrypted.ts <style-package-....stylepkg> [--ledger <deletion-ledger.json>]
 *   env STYLE_RESTORE_CONFIRMED=true               required
 *   env STYLE_BACKUP_PASSPHRASE_FILE or STYLE_BACKUP_PASSPHRASE   the passphrase
 *
 * The package is looked up by name in `<data>/exports`; copy it there first
 * (on a fresh server too). It carries its own deletion ledger, exported at or
 * after the backup; `--ledger` may add a NEWER copy, which is merged. Every
 * check, the process-presence claim, the ledger-freshness policy and the
 * outputs are those of scripts/restore-database.ts (src/server/restoreDatabase.ts).
 * The passphrase is never an argument and is never printed.
 */

function parseArguments(argv: string[]): { filename: string; ledger: string | null } {
  let filename: string | null = null;
  let ledger: string | null = process.env.STYLE_RESTORE_LEDGER?.trim() || null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ledger") {
      const value = argv[++i];
      if (!value) throw refuse("RESTORE_E_ARGS", "--ledger needs a file path.");
      ledger = value;
    } else if (arg.startsWith("--ledger=")) {
      ledger = arg.slice("--ledger=".length) || null;
    } else if (!arg.startsWith("--") && filename === null) {
      filename = arg;
    } else {
      throw refuse("RESTORE_E_ARGS", "Unexpected argument.");
    }
  }
  if (!filename || !PACKAGE_FINAL.test(filename))
    throw refuse(
      "RESTORE_E_FILENAME",
      "Choose a package filename (style-package-<time>.stylepkg) from the private exports directory.",
    );
  return { filename, ledger };
}

void runRestoreCommand((directory) => {
  const { filename, ledger } = parseArguments(process.argv.slice(2));
  let passphrase: Buffer;
  try {
    passphrase = loadPassphrase();
  } catch (error) {
    if (error instanceof PackageError)
      throw refuse(`RESTORE_E_PKG_${error.code}`, error.message);
    throw error;
  }
  return encryptedRestorePreparer({
    directory,
    filename,
    passphrase,
    extraLedgerFile: ledger,
  });
});
