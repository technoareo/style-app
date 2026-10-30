import { lstatSync } from "node:fs";
import path from "node:path";
import { refuse, runRestoreCommand } from "../src/server/restoreDatabase";

/**
 * Restore from a plain backup in `<data>/backups` (build 010). The work, the
 * modes (LIVE and FRESH), the ledger policy and the output codes are in
 * src/server/restoreDatabase.ts, shared with scripts/restore-encrypted.ts.
 *
 *   restore-database.ts <style-....db> [--ledger <deletion-ledger.json>]
 *   (env STYLE_RESTORE_CONFIRMED=true is required; STYLE_RESTORE_LEDGER may
 *    stand in for --ledger)
 */

const BACKUP_NAME = /^style-[0-9TZ.-]+\.db$/;
const BACKUP_TIME =
  /^style-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?\.db$/;

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
  if (!filename || !BACKUP_NAME.test(filename))
    throw refuse(
      "RESTORE_E_FILENAME",
      "Choose a backup filename from the private backups directory.",
    );
  return { filename, ledger };
}

function backupTime(filename: string): number | null {
  const m = BACKUP_TIME.exec(filename);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

void runRestoreCommand((directory) => {
  const { filename, ledger } = parseArguments(process.argv.slice(2));
  const source = path.join(directory, "backups", filename);
  return () => {
    let info;
    try {
      info = lstatSync(source);
    } catch {
      throw refuse("RESTORE_E_BACKUP_INVALID", "The backup file does not exist.");
    }
    if (!info.isFile())
      throw refuse("RESTORE_E_BACKUP_INVALID", "The backup is not a plain file.");
    return {
      databaseFile: source,
      madeAt: backupTime(filename),
      ledgers: ledger ? [{ file: ledger }] : [],
    };
  };
});
