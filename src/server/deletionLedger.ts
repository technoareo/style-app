import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { acquireProcessLock } from "./directoryLock";
import { renameReplacing, syncDirectory, syncFile } from "./durableFs";
import { privateSubdirectory } from "./privateDirectory";
import { tableExists } from "./sensitiveTables";

/**
 * The exported, current account-deletion ledger (build 010).
 *
 * WHY. A deletion is recorded in the live database (`account_deletions`,
 * written by a trigger in the same statement that deletes the user). A restore
 * of an older backup must delete those users again, or a deleted person's
 * wardrobe and photos come back. When the live database is gone (a fresh
 * server) the only place that knows about deletions made AFTER the backup is a
 * copy of this ledger. A ledger written once at backup time cannot know about
 * later deletions, so the ledger is a separate, continuously maintained file:
 *
 *   <data>/ledger/deletion-ledger.json
 *
 * It is rewritten (atomically) by:
 *   - the mail worker, about once a minute, whenever the database has a
 *     deletion the file does not (and at least every `refreshMs` so its
 *     `exportedAt` stays recent);
 *   - `scripts/backup-database.ts`, after every backup (forced);
 *   - `scripts/export-deletion-ledger.ts`, which an operator can run from cron
 *     right before copying the file off the server.
 * The file is on the same volume as the database. It only protects against a
 * lost volume once the operator copies it off the server, often (it is a few
 * bytes per deleted account and holds only internal user ids and times). The
 * recovery point for deletions is therefore "the last time the file was copied
 * off the server" and nothing in this repository does that copying.
 *
 * FORMAT (JSON, one object, canonical key order, ends with a newline):
 *   format "style-deletion-ledger", version 1, generation (integer, +1 per
 *   write), exportedAt (ms; every deletion committed before the export started
 *   is included), entries [{ userId, deletedAt }] sorted by userId with no
 *   duplicates, sha256 (hex, over the JSON text of all the other fields).
 * The ledger only grows: an export merges the file's previous entries with the
 * database's, so restoring an older database and exporting again cannot make a
 * deletion disappear.
 *
 * VALIDATION IS FAIL-CLOSED. Anything that is not exactly this format (size,
 * JSON, keys, types, id syntax, ordering, duplicates, checksum) is rejected;
 * restore never guesses. The checksum detects truncation and accidental edits;
 * it is not a signature, so keep the file where only the operator can write.
 */

export const LEDGER_FILENAME = "deletion-ledger.json";
const FORMAT = "style-deletion-ledger";
const VERSION = 1;
const MAX_BYTES = 32 * 1024 * 1024;
/** Printable ASCII without spaces: Better Auth ids and the ids used in tests. */
const USER_ID = /^[!-~]{1,128}$/;
const DAY_MS = 86_400_000;

export type LedgerEntry = { userId: string; deletedAt: number };
export type Ledger = {
  generation: number;
  exportedAt: number;
  entries: LedgerEntry[];
};

export type LedgerErrorCode =
  | "missing"
  | "unreadable"
  | "malformed"
  | "checksum"
  | "unsupported";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function canonicalBody(ledger: Ledger) {
  const entries = [...ledger.entries]
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map((e) => ({ userId: e.userId, deletedAt: e.deletedAt }));
  return {
    format: FORMAT,
    version: VERSION,
    generation: ledger.generation,
    exportedAt: ledger.exportedAt,
    entries,
  };
}

export function serializeLedger(ledger: Ledger): string {
  const body = canonicalBody(ledger);
  return JSON.stringify({ ...body, sha256: digest(JSON.stringify(body)) }) + "\n";
}

const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);

/** Parses and fully validates ledger text. Throws LedgerError; never partial. */
export function parseLedger(text: string, now: number = Date.now()): Ledger {
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new LedgerError("malformed", "The ledger is too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerError("malformed", "The ledger is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new LedgerError("malformed", "The ledger is not an object.");
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "entries,exportedAt,format,generation,sha256,version")
    throw new LedgerError("malformed", "The ledger has unexpected fields.");
  if (o.format !== FORMAT)
    throw new LedgerError("malformed", "This is not a deletion ledger.");
  if (o.version !== VERSION)
    throw new LedgerError("unsupported", "Unsupported ledger version.");
  if (!isInt(o.generation) || o.generation < 1)
    throw new LedgerError("malformed", "Invalid ledger generation.");
  if (!isInt(o.exportedAt) || o.exportedAt <= 0 || o.exportedAt > now + DAY_MS)
    throw new LedgerError("malformed", "Invalid ledger export time.");
  if (typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256))
    throw new LedgerError("malformed", "Invalid ledger checksum field.");
  if (!Array.isArray(o.entries))
    throw new LedgerError("malformed", "Invalid ledger entries.");
  const entries: LedgerEntry[] = [];
  let previous = "";
  for (const item of o.entries as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new LedgerError("malformed", "Invalid ledger entry.");
    const e = item as Record<string, unknown>;
    if (Object.keys(e).sort().join(",") !== "deletedAt,userId")
      throw new LedgerError("malformed", "Invalid ledger entry fields.");
    if (typeof e.userId !== "string" || !USER_ID.test(e.userId))
      throw new LedgerError("malformed", "Invalid user id in the ledger.");
    if (!isInt(e.deletedAt) || e.deletedAt < 0 || e.deletedAt > now + DAY_MS)
      throw new LedgerError("malformed", "Invalid deletion time in the ledger.");
    if (previous !== "" && e.userId <= previous)
      throw new LedgerError("malformed", "Ledger entries are not sorted and unique.");
    previous = e.userId;
    entries.push({ userId: e.userId, deletedAt: e.deletedAt });
  }
  const ledger: Ledger = {
    generation: o.generation,
    exportedAt: o.exportedAt,
    entries,
  };
  if (digest(JSON.stringify(canonicalBody(ledger))) !== o.sha256)
    throw new LedgerError("checksum", "The ledger checksum does not match.");
  return ledger;
}

/** Reads a ledger file: a plain file only (a link is refused). */
export function readLedgerFile(file: string): Ledger {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new LedgerError("missing", "The ledger file does not exist.");
    throw new LedgerError("unreadable", "The ledger file cannot be read.");
  }
  if (info.isSymbolicLink() || !info.isFile())
    throw new LedgerError("unreadable", "The ledger is not a plain file.");
  if (info.size > MAX_BYTES)
    throw new LedgerError("malformed", "The ledger is too large.");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new LedgerError("unreadable", "The ledger file cannot be read.");
  }
  return parseLedger(text);
}

/**
 * Writes a ledger atomically: a unique temporary file (exclusive create, 0600),
 * flushed, renamed over the final name, directory flushed where supported.
 * A real I/O error is thrown; the temporary file is removed on any failure.
 * Callers hold the ledger lock.
 */
function writeLedgerLocked(dir: string, ledger: Ledger): void {
  const tmp = path.join(dir, `deletion-ledger.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, serializeLedger(ledger));
    } finally {
      closeSync(fd);
    }
    syncFile(tmp);
    renameReplacing(tmp, path.join(dir, LEDGER_FILENAME));
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone or renamed.
    }
    throw error;
  }
  syncDirectory(dir);
}

export function ledgerDirectory(dataDir: string): string {
  return privateSubdirectory(dataDir, "ledger", "ledger");
}

export function ledgerPath(dataDir: string): string {
  return path.join(ledgerDirectory(dataDir), LEDGER_FILENAME);
}

function readDeletions(db: DatabaseSync): LedgerEntry[] {
  if (!tableExists(db, "account_deletions")) return [];
  const rows = db
    .prepare("SELECT user_id, deleted_at FROM account_deletions")
    .all() as { user_id: string; deleted_at: number }[];
  return rows.map((r) => {
    if (typeof r.user_id !== "string" || !USER_ID.test(r.user_id) || !isInt(r.deleted_at))
      // Never skip a row silently: a missing tombstone would let a deleted
      // account come back after a restore.
      throw new Error("account_deletions holds a row the ledger cannot represent.");
    return { userId: r.user_id, deletedAt: r.deleted_at };
  });
}

function mergeEntries(...lists: LedgerEntry[][]): LedgerEntry[] {
  const map = new Map<string, number>();
  for (const list of lists)
    for (const e of list) {
      const existing = map.get(e.userId);
      // Keep the earliest recorded deletion time.
      if (existing === undefined || e.deletedAt < existing) map.set(e.userId, e.deletedAt);
    }
  return [...map].map(([userId, deletedAt]) => ({ userId, deletedAt }));
}

export type LedgerExportOptions = {
  /** Write even if nothing changed and the file is recent. */
  force?: boolean;
  /** Rewrite an unchanged file when its exportedAt is older than this (default 15 min). */
  refreshMs?: number;
  now?: () => number;
  /** How long to wait for another exporter (default 15 s). */
  lockWaitMs?: number;
};

export type LedgerExportResult = {
  written: boolean;
  generation: number;
  exportedAt: number;
  entries: number;
  /** Name of an invalid previous ledger that was set aside, if any. */
  quarantined: string | null;
};

/**
 * Brings `<data>/ledger/deletion-ledger.json` up to date with the live
 * database. Serialised across processes by an OS lock (the same mechanism as
 * the backup lock, a different file), so concurrent exporters produce
 * strictly increasing generations and never a torn file.
 *
 * `exportedAt` is taken BEFORE the database is read, so every deletion
 * committed before that instant is in the file; one still in flight appears in
 * the next export.
 *
 * An existing ledger that fails validation is renamed to
 * `deletion-ledger.invalid-<hex>.json` (kept for the operator) and the new
 * file is built from the database alone; this is reported in the result.
 */
export async function exportDeletionLedger(
  db: DatabaseSync,
  dataDir: string,
  options: LedgerExportOptions = {},
): Promise<LedgerExportResult> {
  const now = options.now ?? Date.now;
  const dir = ledgerDirectory(dataDir);
  const lock = await acquireProcessLock(path.join(dir, ".ledger-coordinator.db"), {
    waitMs: options.lockWaitMs ?? 15_000,
  });
  try {
    const startedAt = now();
    const fromDb = readDeletions(db);
    const file = path.join(dir, LEDGER_FILENAME);
    let previous: Ledger | null = null;
    let quarantined: string | null = null;
    try {
      previous = readLedgerFile(file);
    } catch (error) {
      if (error instanceof LedgerError && error.code === "missing") {
        previous = null;
      } else if (
        error instanceof LedgerError &&
        (error.code === "malformed" || error.code === "checksum")
      ) {
        // Damaged content: keep it for the operator, rebuild from the database.
        quarantined = `deletion-ledger.invalid-${randomBytes(6).toString("hex")}.json`;
        if (existsSync(file)) renameSync(file, path.join(dir, quarantined));
        else quarantined = null;
      } else {
        // Unreadable or from a newer version: do not destroy it; fail instead.
        throw error;
      }
    }
    const merged = mergeEntries(previous?.entries ?? [], fromDb);
    const previousTimes = new Map(
      (previous?.entries ?? []).map((e) => [e.userId, e.deletedAt]),
    );
    const changed =
      !previous || merged.some((e) => previousTimes.get(e.userId) !== e.deletedAt);
    const recent =
      previous !== null &&
      startedAt - previous.exportedAt < (options.refreshMs ?? 15 * 60_000);
    if (!changed && recent && !options.force && previous)
      return {
        written: false,
        generation: previous.generation,
        exportedAt: previous.exportedAt,
        entries: previous.entries.length,
        quarantined,
      };
    const ledger: Ledger = {
      generation: (previous?.generation ?? 0) + 1,
      exportedAt: Math.max(startedAt, previous?.exportedAt ?? 0),
      entries: merged,
    };
    writeLedgerLocked(dir, ledger);
    return {
      written: true,
      generation: ledger.generation,
      exportedAt: ledger.exportedAt,
      entries: merged.length,
      quarantined,
    };
  } finally {
    lock.release();
  }
}

/**
 * Used by the restore command: records the merged deletions of a restore as
 * the new current ledger, continuing the generation counter of the best known
 * ledger. Same lock and atomic write as an export.
 */
export async function installLedger(
  dataDir: string,
  entries: LedgerEntry[],
  baseGeneration: number,
  options: { now?: () => number; lockWaitMs?: number } = {},
): Promise<Ledger> {
  const dir = ledgerDirectory(dataDir);
  const lock = await acquireProcessLock(path.join(dir, ".ledger-coordinator.db"), {
    waitMs: options.lockWaitMs ?? 15_000,
  });
  try {
    let existing: Ledger | null = null;
    try {
      existing = readLedgerFile(path.join(dir, LEDGER_FILENAME));
    } catch {
      existing = null;
    }
    const ledger: Ledger = {
      generation: Math.max(baseGeneration, existing?.generation ?? 0) + 1,
      exportedAt: Math.max((options.now ?? Date.now)(), existing?.exportedAt ?? 0),
      entries: mergeEntries(existing?.entries ?? [], entries),
    };
    writeLedgerLocked(dir, ledger);
    return ledger;
  } finally {
    lock.release();
  }
}
