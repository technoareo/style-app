import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { getDataDir } from "./database";
import {
  installLedger,
  LEDGER_FILENAME,
  LedgerError,
  readLedgerFile,
  type Ledger,
  type LedgerEntry,
} from "./deletionLedger";
import { syncDirectory, syncFile } from "./durableFs";
import {
  claimExclusiveAccess,
  PresenceBusyError,
  type PresenceHold,
} from "./processPresence";
import { rateLimitTables, tableExists } from "./sensitiveTables";

/**
 * Restore (build 010; moved here from scripts/restore-database.ts in build 021
 * so the plain and the encrypted-package commands share ONE implementation).
 *
 * Replaces `<data>/app.db` with a verified, sanitised copy of a backup,
 * re-applying account deletions from the strongest sources available, and
 * invalidating every sign-in password.
 *
 * Two modes:
 *  - LIVE: `app.db` exists. Its `account_deletions` table (always the most
 *    current record) is used, merged with `<data>/ledger/deletion-ledger.json`
 *    when that file exists and with any explicit ledger. A file that exists but
 *    does not validate stops the restore.
 *  - FRESH: no `app.db` (a new server, an empty data directory). A deletion
 *    ledger is REQUIRED, because the backup cannot know about accounts deleted
 *    after it was made. Every ledger must validate completely; the newest must
 *    have been exported at or after the backup was made and must not be older
 *    than STYLE_RESTORE_LEDGER_MAX_AGE_HOURS (default 24) unless
 *    STYLE_RESTORE_ACCEPT_STALE_LEDGER=true. Deletions after the newest
 *    ledger's export time cannot be known; the command prints that time.
 *
 * Nothing is replaced unless every check passes. The replacement is the last
 * step: a unique, owner-only staging file in the data directory is built and
 * verified first and removed on any failure.
 *
 * Process coordination: the command first takes an EXCLUSIVE claim on the
 * presence file (processPresence.ts). Every application process that has the
 * database open holds a shared hold there, so an idle running app, worker,
 * mailer or backup makes the restore refuse (RESTORE_E_ACTIVE) before anything
 * is touched. Everything that reads the backup source (including the
 * decryption of an encrypted package) happens AFTER the claim, through the
 * `prepare` callback, and its cleanup always runs.
 *
 * Output: fixed text and codes (RESTORE_E_*, RESTORE_W_*), never an exception
 * message, a path from user input, or an id. Exit 0 done; 1 refused or failed,
 * the existing database unchanged; 2 restored, with a warning to act on.
 */

export class RestoreError extends Error {
  constructor(
    readonly code: string,
    text: string,
  ) {
    super(text);
  }
}
export const refuse = (code: string, text: string) => new RestoreError(code, text);

export type LedgerSource = { file: string } | { ledger: Ledger };

/** What `prepare` hands the shared restore. */
export type RestoreSource = {
  /** A sanitised database file to restore from (copied, never modified). */
  databaseFile: string;
  /** When the backup was made (ms), or null if it cannot be known. */
  madeAt: number | null;
  /** Ledgers given explicitly (a command-line file, or one inside a package). */
  ledgers: LedgerSource[];
  /** Always called once, success or failure (removes decrypted material). */
  cleanup?: () => void;
};

export const STAGING = /^app\.db\.restore-[0-9a-f]{16}\.pending(-wal|-shm|-journal)?$/;

/**
 * Staging files that could not be removed. Names follow the fixed pattern
 * `app.db.restore-<16 hex>.pending[-wal|-shm|-journal]` (no user data, and
 * printed without their directory); they are reported at the end with
 * RESTORE_W_STAGING_LEFT and make an otherwise successful restore exit 2.
 */
const stagingLeft = new Set<string>();

/** Lets a caller report a leftover of its own (e.g. decrypted staging) the same way. */
export function noteLeftover(name: string): void {
  stagingLeft.add(name);
}

/** Removes one owned staging name (a file or a link, never a directory); true if nothing is left. */
export function removeStagingName(target: string): boolean {
  try {
    const info = lstatSync(target);
    if (info.isFile() || info.isSymbolicLink()) unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
  }
  try {
    lstatSync(target);
    return false;
  } catch {
    return true;
  }
}

/** Removes leftovers of earlier crashed restores (fixed pattern); reports any that stay. */
function sweepStaging(directory: string): void {
  for (const name of readdirSync(directory)) {
    if (!STAGING.test(name)) continue;
    if (!removeStagingName(path.join(directory, name))) stagingLeft.add(name);
  }
}

function loadLedger(source: LedgerSource): Ledger {
  if ("ledger" in source) return source.ledger;
  try {
    return readLedgerFile(source.file);
  } catch (error) {
    if (error instanceof LedgerError && error.code === "missing")
      throw refuse("RESTORE_E_LEDGER_MISSING", "The deletion ledger file does not exist.");
    throw refuse(
      "RESTORE_E_LEDGER_INVALID",
      "The deletion ledger is damaged, unreadable or not a ledger. It was not used and nothing was changed.",
    );
  }
}

function mergeInto(map: Map<string, number>, entries: LedgerEntry[]): void {
  for (const e of entries) {
    const existing = map.get(e.userId);
    if (existing === undefined || e.deletedAt < existing) map.set(e.userId, e.deletedAt);
  }
}

async function restoreUnderClaim(
  directory: string,
  prepare: () => Promise<RestoreSource> | RestoreSource,
): Promise<number> {
  const destination = path.join(directory, "app.db");
  let staging: string | null = null;
  let cleanup: (() => void) | undefined;
  const warnings: string[] = [];
  try {
    const source = await prepare();
    cleanup = source.cleanup;

    sweepStaging(directory);

    const deleted = new Map<string, number>();
    let baseGeneration = 0;
    const liveExists = existsSync(destination);
    const fresh = !liveExists;

    if (liveExists) {
      let current: DatabaseSync;
      try {
        current = new DatabaseSync(destination);
      } catch {
        throw refuse(
          "RESTORE_E_LIVE_UNREADABLE",
          "The existing live database cannot be opened. Move it aside deliberately and restore as a fresh server with a ledger.",
        );
      }
      try {
        // Fold committed WAL data into the live database before touching
        // sidecars. A failed replacement then leaves a complete, usable
        // current database. (Idle connections are NOT detected by this; the
        // presence claim is what does that.)
        const checkpoint = current
          .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
          .get() as { busy: number };
        if (checkpoint.busy !== 0)
          throw refuse("RESTORE_E_ACTIVE", "Stop all database writers before restoring.");
        if (tableExists(current, "account_deletions"))
          for (const row of current
            .prepare("SELECT user_id,deleted_at FROM account_deletions")
            .all() as { user_id: string; deleted_at: number }[])
            deleted.set(row.user_id, row.deleted_at);
      } finally {
        current.close();
      }
      const implicit = path.join(directory, "ledger", LEDGER_FILENAME);
      if (!source.ledgers.length && existsSync(implicit)) {
        const ledger = loadLedger({ file: implicit });
        mergeInto(deleted, ledger.entries);
        baseGeneration = ledger.generation;
      }
    }

    let ledgerExportedAt: number | null = null;
    if (source.ledgers.length) {
      // Load all of them first: any invalid one stops the restore.
      const loaded = source.ledgers.map((s) =>
        loadLedger("file" in s ? { file: path.resolve(s.file) } : s),
      );
      for (const ledger of loaded) {
        mergeInto(deleted, ledger.entries);
        baseGeneration = Math.max(baseGeneration, ledger.generation);
        ledgerExportedAt = Math.max(ledgerExportedAt ?? 0, ledger.exportedAt);
      }
      if (fresh && ledgerExportedAt !== null) {
        if (source.madeAt === null)
          throw refuse(
            "RESTORE_E_BACKUP_INVALID",
            "The backup's creation time cannot be read from its file name, so the ledger cannot be checked against it.",
          );
        if (ledgerExportedAt < source.madeAt)
          throw refuse(
            "RESTORE_E_LEDGER_STALE",
            "The ledger was exported before this backup was made, so it says nothing about later deletions. Use the ledger exported most recently.",
          );
        const maxHours = Number(process.env.STYLE_RESTORE_LEDGER_MAX_AGE_HOURS);
        const maxAgeMs =
          (Number.isFinite(maxHours) && maxHours > 0 ? maxHours : 24) * 3_600_000;
        if (
          Date.now() - ledgerExportedAt > maxAgeMs &&
          process.env.STYLE_RESTORE_ACCEPT_STALE_LEDGER !== "true"
        )
          throw refuse(
            "RESTORE_E_LEDGER_STALE",
            "The ledger is older than the allowed age. Accounts deleted since it was exported would come back. Use a newer copy, or set STYLE_RESTORE_ACCEPT_STALE_LEDGER=true to accept that loss knowingly.",
          );
      }
    } else if (fresh) {
      throw refuse(
        "RESTORE_E_LEDGER_REQUIRED",
        "There is no live database here, so a current deletion ledger is required: pass --ledger <deletion-ledger.json> copied from the old server. Without it, accounts deleted after the backup would come back.",
      );
    }

    // Unique, owner-only staging file in the data directory; removed on any
    // failure by the finally block below.
    staging = path.join(
      directory,
      `app.db.restore-${randomBytes(8).toString("hex")}.pending`,
    );
    closeSync(openSync(staging, "wx", 0o600));
    copyFileSync(source.databaseFile, staging);
    if (process.platform !== "win32") chmodSync(staging, 0o600);

    const restored = new DatabaseSync(staging);
    try {
      let integrity: string;
      try {
        integrity = (
          restored.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
        ).integrity_check;
      } catch {
        integrity = "unreadable";
      }
      if (
        integrity !== "ok" ||
        !tableExists(restored, "user") ||
        !tableExists(restored, "account")
      )
        throw refuse(
          "RESTORE_E_BACKUP_INVALID",
          "Backup integrity verification failed. The existing database was not replaced.",
        );
      restored.exec(
        "PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS account_deletions(user_id TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL);",
      );
      restored.exec("BEGIN IMMEDIATE");
      try {
        for (const [userId, when] of deleted) {
          restored.prepare("DELETE FROM user WHERE id=?").run(userId);
          restored
            .prepare(
              "INSERT OR REPLACE INTO account_deletions(user_id,deleted_at) VALUES(?,?)",
            )
            .run(userId, when);
        }
        // Never replay stale account mail after a recovery.
        if (tableExists(restored, "mail_outbox")) restored.exec("DELETE FROM mail_outbox;");
        // Password revival protection: EVERY credential password is emptied.
        // Better Auth refuses a sign-in against an empty stored password with
        // its ordinary "invalid email or password", and its password-reset
        // endpoint overwrites it, so each user recovers through "Forgot
        // password". No password or secret is generated, stored or printed.
        restored.exec("UPDATE account SET password=NULL WHERE providerId='credential';");
        // Rate-limit rows hold client IP addresses.
        for (const table of rateLimitTables(restored))
          restored.exec(`DELETE FROM "${table}";`);
        restored.exec(
          "DELETE FROM analysis_jobs; DELETE FROM session; DELETE FROM verification; DROP TABLE IF EXISTS worker_state; DROP TABLE IF EXISTS mail_worker_state; COMMIT;",
        );
      } catch (e) {
        if (restored.isTransaction) restored.exec("ROLLBACK");
        throw e;
      }
      if (restored.prepare("PRAGMA foreign_key_check").all().length)
        throw refuse(
          "RESTORE_E_BACKUP_INVALID",
          "Backup relationship verification failed. The existing database was not replaced.",
        );
      restored.exec(
        "VACUUM; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;",
      );
    } finally {
      restored.close();
    }
    syncFile(staging);

    // Replacement. We hold the exclusive presence claim, so no application
    // process has the old database open; stale WAL sidecars must not be
    // replayed against the new file.
    for (const suffix of ["-wal", "-shm", "-journal"])
      rmSync(destination + suffix, { force: true });
    renameSync(staging, destination);
    staging = null;

    try {
      syncDirectory(directory);
    } catch {
      warnings.push(
        "RESTORE_W_DURABILITY: the restored database was written but the data directory could not be flushed; check the disk and take a backup soon.",
      );
    }
    try {
      await installLedger(
        directory,
        [...deleted].map(([userId, deletedAt]) => ({ userId, deletedAt })),
        baseGeneration,
      );
    } catch {
      warnings.push(
        "RESTORE_W_LEDGER: the restored database is in place but the current deletion ledger could not be written; run scripts/export-deletion-ledger.ts before anything else.",
      );
    }

    console.log(
      "Restore verified. Deleted accounts stayed deleted; old sessions and temporary analysis data were removed.",
    );
    console.log(
      "ALL sign-in passwords were invalidated. Every user must choose a new one with 'Forgot password' (an email link). Start the mail worker with working SMTP before telling users the service is back; without it nobody can sign in.",
    );
    if (ledgerExportedAt !== null)
      console.log(
        `Account deletions made after ${new Date(ledgerExportedAt).toISOString()} (the ledger's export time) are not known to this restore; if any exist, delete those accounts again.`,
      );
    for (const warning of warnings) console.error(`WARNING ${warning}`);
    return warnings.length ? 2 : 0;
  } finally {
    if (staging) {
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        if (!removeStagingName(staging + suffix))
          stagingLeft.add(path.basename(staging + suffix));
    }
    try {
      cleanup?.();
    } catch {
      // The cleanup reports its own leftovers through noteLeftover().
    }
  }
}

/** Reports staging files that could not be removed; they never go unmentioned. */
function reportStagingLeft(): boolean {
  for (const name of stagingLeft)
    console.error(
      `WARNING RESTORE_W_STAGING_LEFT: ${name} in the data directory could not be removed and holds a copy of account data; delete it by hand.`,
    );
  return stagingLeft.size > 0;
}

/**
 * The whole restore command. `parse` runs after the confirmation check and
 * before anything is claimed; it validates arguments and secrets and returns
 * the `prepare` callback that runs UNDER the exclusive presence claim.
 */
export async function runRestoreCommand(
  parse: (directory: string) => () => Promise<RestoreSource> | RestoreSource,
): Promise<void> {
  try {
    if (process.env.STYLE_RESTORE_CONFIRMED !== "true")
      throw refuse(
        "RESTORE_E_CONFIRM",
        "Stop the app, workers and mailer and explicitly confirm the restore (STYLE_RESTORE_CONFIRMED=true) before running this command.",
      );
    const directory = getDataDir();
    const prepare = parse(directory);
    let claim: PresenceHold;
    try {
      claim = claimExclusiveAccess(directory);
    } catch (error) {
      if (error instanceof PresenceBusyError)
        throw refuse(
          "RESTORE_E_ACTIVE",
          "A process still has the live database open (the app, a worker, the mailer or a backup). Stop all of them and run the restore again. Nothing was changed.",
        );
      throw error;
    }
    let code: number;
    try {
      code = await restoreUnderClaim(directory, prepare);
    } finally {
      claim.release();
    }
    process.exitCode = reportStagingLeft() ? Math.max(code, 2) : code;
  } catch (error) {
    if (error instanceof RestoreError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error("RESTORE_E_FAILED: Restore failed. The existing database was not replaced.");
    }
    reportStagingLeft();
    process.exitCode = 1;
  }
}
