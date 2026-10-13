import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  exportDeletionLedger,
  LedgerError,
  LEDGER_FILENAME,
  parseLedger,
  readLedgerFile,
  serializeLedger,
  type Ledger,
} from "../src/server/deletionLedger";
import { forkHelper, sleep } from "./helpers/processes";

/**
 * Build 010: the exported deletion ledger (src/server/deletionLedger.ts).
 * Validation is fail-closed; exports are monotonic and atomic; several REAL
 * processes exporting while deletions arrive never leave a torn or shrinking
 * file. These tests use plain SQLite files with an `account_deletions` table;
 * the end-to-end restore with the real application is in restoreFresh.test.ts.
 */

const base = path.join(process.cwd(), ".data", "tests");
function dataDir(): string {
  const dir = path.join(base, randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}
function database(dir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dir, "app.db"), { timeout: 5000 });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS account_deletions (user_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)",
  );
  return db;
}
const addDeletion = (db: DatabaseSync, id: string, at = Date.now()) =>
  db
    .prepare("INSERT OR REPLACE INTO account_deletions(user_id,deleted_at) VALUES(?,?)")
    .run(id, at);
const ledgerFile = (dir: string) => path.join(dir, "ledger", LEDGER_FILENAME);

const sample: Ledger = {
  generation: 3,
  exportedAt: Date.now() - 1000,
  entries: [
    { userId: "user-b", deletedAt: 1_700_000_000_000 },
    { userId: "user-a", deletedAt: 1_700_000_000_500 },
  ],
};

test("a ledger round-trips in canonical form (sorted, checksummed, newline-terminated)", () => {
  const text = serializeLedger(sample);
  assert.ok(text.endsWith("\n"));
  const parsed = parseLedger(text);
  assert.deepEqual(
    parsed.entries.map((e) => e.userId),
    ["user-a", "user-b"],
  );
  assert.equal(parsed.generation, 3);
  assert.equal(serializeLedger(parsed), text, "serialisation is canonical");
});

test("validation is fail-closed: every kind of damage is rejected with a code, never partially accepted", () => {
  const good = serializeLedger(sample);
  const object = () => JSON.parse(good) as Record<string, unknown>;
  const reject = (label: string, text: string, code?: string) => {
    assert.throws(
      () => parseLedger(text),
      (error: unknown) =>
        error instanceof LedgerError && (code === undefined || error.code === code),
      label,
    );
  };

  reject("empty", "");
  reject("not JSON", "this is not json");
  reject("truncated", good.slice(0, Math.floor(good.length / 2)), "malformed");
  reject("a JSON array", "[]", "malformed");
  reject("null", "null", "malformed");

  const tampered = object();
  (tampered.entries as { deletedAt: number }[])[0].deletedAt += 1;
  reject("an edited entry (checksum no longer matches)", JSON.stringify(tampered), "checksum");

  const removed = object();
  (removed.entries as unknown[]).pop();
  reject("a dropped entry", JSON.stringify(removed), "checksum");

  const extra = { ...object(), note: "x" };
  reject("an extra field", JSON.stringify(extra), "malformed");

  const missing = object();
  delete missing.sha256;
  reject("a missing checksum", JSON.stringify(missing), "malformed");

  reject("another document type", JSON.stringify({ ...object(), format: "other" }), "malformed");
  reject("a newer version", JSON.stringify({ ...object(), version: 2 }), "unsupported");
  reject("generation 0", JSON.stringify({ ...object(), generation: 0 }), "malformed");
  reject("a fractional generation", JSON.stringify({ ...object(), generation: 1.5 }), "malformed");
  reject("a string time", JSON.stringify({ ...object(), exportedAt: "now" }), "malformed");
  reject(
    "an export time far in the future",
    JSON.stringify({ ...object(), exportedAt: Date.now() + 10 * 86_400_000 }),
    "malformed",
  );
  reject("a bad checksum field", JSON.stringify({ ...object(), sha256: "zz" }), "malformed");

  const entries = (o: Record<string, unknown>, e: unknown[]) => JSON.stringify({ ...o, entries: e });
  reject("duplicate ids", entries(object(), [
    { userId: "same", deletedAt: 1 },
    { userId: "same", deletedAt: 2 },
  ]), "malformed");
  reject("unsorted ids", entries(object(), [
    { userId: "b", deletedAt: 1 },
    { userId: "a", deletedAt: 1 },
  ]), "malformed");
  reject("an id with a space", entries(object(), [{ userId: "a b", deletedAt: 1 }]), "malformed");
  reject("an empty id", entries(object(), [{ userId: "", deletedAt: 1 }]), "malformed");
  reject("a negative time", entries(object(), [{ userId: "a", deletedAt: -1 }]), "malformed");
  reject("an entry with an extra key", entries(object(), [{ userId: "a", deletedAt: 1, x: 1 }]), "malformed");
  reject("entries that are not an array", JSON.stringify({ ...object(), entries: {} }), "malformed");
  reject("an oversized file", "x".repeat(33 * 1024 * 1024), "malformed");
});

test("reading: a missing file, a directory and a link are distinguished and refused", () => {
  const dir = dataDir();
  assert.throws(
    () => readLedgerFile(path.join(dir, "nothing.json")),
    (e: unknown) => e instanceof LedgerError && e.code === "missing",
  );
  mkdirSync(path.join(dir, "a-directory"));
  assert.throws(
    () => readLedgerFile(path.join(dir, "a-directory")),
    (e: unknown) => e instanceof LedgerError && e.code === "unreadable",
  );
  const real = path.join(dir, "real.json");
  writeFileSync(real, serializeLedger(sample));
  assert.equal(readLedgerFile(real).generation, 3);
  try {
    symlinkSync(real, path.join(dir, "link.json"));
  } catch {
    console.warn("Skipped ledger link guard: this account may not create links.");
    return;
  }
  assert.throws(
    () => readLedgerFile(path.join(dir, "link.json")),
    (e: unknown) => e instanceof LedgerError && e.code === "unreadable",
  );
});

test("export: written first, left alone when nothing changed, rewritten on a new deletion, and the ledger only grows", async () => {
  const dir = dataDir();
  const db = database(dir);
  try {
    addDeletion(db, "gone-1", 1_700_000_000_000);
    const first = await exportDeletionLedger(db, dir);
    assert.equal(first.written, true);
    assert.equal(first.generation, 1);
    assert.equal(first.entries, 1);
    assert.equal(first.quarantined, null);
    assert.deepEqual(readdirSync(path.join(dir, "ledger")).filter((n) => n.endsWith(".tmp")), []);

    const again = await exportDeletionLedger(db, dir);
    assert.equal(again.written, false, "nothing changed and the file is recent");
    assert.equal(again.generation, 1);

    addDeletion(db, "gone-2", 1_700_000_001_000);
    const third = await exportDeletionLedger(db, dir);
    assert.equal(third.written, true);
    assert.equal(third.generation, 2);
    assert.deepEqual(
      readLedgerFile(ledgerFile(dir)).entries.map((e) => e.userId),
      ["gone-1", "gone-2"],
    );

    // Forced: written although unchanged, with a later export time.
    const forced = await exportDeletionLedger(db, dir, { force: true });
    assert.equal(forced.written, true);
    assert.equal(forced.generation, 3);
    assert.ok(forced.exportedAt >= third.exportedAt);

    // A refresh age: an unchanged but old file is rewritten.
    const aged = await exportDeletionLedger(db, dir, { refreshMs: 0 });
    assert.equal(aged.written, true);

    // The database "forgets" a row (an older database was restored): the
    // ledger keeps it.
    db.exec("DELETE FROM account_deletions");
    const kept = await exportDeletionLedger(db, dir, { force: true });
    assert.equal(kept.entries, 2);
    assert.deepEqual(
      readLedgerFile(ledgerFile(dir)).entries.map((e) => e.userId),
      ["gone-1", "gone-2"],
    );
  } finally {
    db.close();
  }
});

test("export: a damaged previous ledger is set aside, not overwritten blindly or trusted; an unreadable or newer-version one stops the export", async () => {
  const dir = dataDir();
  const db = database(dir);
  try {
    addDeletion(db, "gone-1");
    await exportDeletionLedger(db, dir);
    const file = ledgerFile(dir);

    const damaged = readFileSync(file, "utf8").slice(0, 40);
    writeFileSync(file, damaged);
    const rebuilt = await exportDeletionLedger(db, dir);
    assert.equal(rebuilt.written, true);
    assert.ok(rebuilt.quarantined, "the damaged file was set aside");
    assert.equal(
      readFileSync(path.join(dir, "ledger", rebuilt.quarantined!), "utf8"),
      damaged,
      "its bytes are kept for the operator",
    );
    assert.equal(readLedgerFile(file).entries.length, 1, "a valid ledger again");

    // A ledger from a newer version is not destroyed by an older exporter.
    const newer = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    newer.version = 2;
    writeFileSync(file, JSON.stringify(newer));
    await assert.rejects(exportDeletionLedger(db, dir));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 2, "left in place");
  } finally {
    db.close();
  }
});

test("export refuses a database row the ledger cannot represent instead of skipping it", async () => {
  const dir = dataDir();
  const db = database(dir);
  try {
    addDeletion(db, "has a space");
    await assert.rejects(exportDeletionLedger(db, dir), /cannot represent/);
    assert.equal(existsSync(ledgerFile(dir)), false);
  } finally {
    db.close();
  }
});

test("concurrent exports from several real processes while deletions arrive: every sample is a valid ledger, generations and entries never go backwards, and the final file has every deletion", async () => {
  const dir = dataDir();
  const db = database(dir);
  const children = [0, 1, 2].map(() =>
    forkHelper("tests/helpers/ledgerExportChild.ts", {
      STYLE_DATA_DIR: dir,
      LEDGER_ROUNDS: "25",
      LEDGER_PAUSE_MS: "20",
    }),
  );
  const file = ledgerFile(dir);
  let samples = 0;
  let lastGeneration = 0;
  let lastIds = new Set<string>();
  let running = true;
  const sampler = (async () => {
    while (running) {
      let text: string | null = null;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        // The file does not exist yet, or a Windows rename is replacing it
        // for a few milliseconds. Not a torn read.
        const code = (error as NodeJS.ErrnoException).code;
        if (!["ENOENT", "EPERM", "EBUSY", "EACCES"].includes(code ?? ""))
          throw error;
      }
      if (text !== null) {
        const ledger = parseLedger(text); // throws on a torn or invalid file
        assert.ok(ledger.generation >= lastGeneration, "generation never decreases");
        const ids = new Set(ledger.entries.map((e) => e.userId));
        for (const id of lastIds) assert.ok(ids.has(id), "an entry never disappears");
        lastGeneration = ledger.generation;
        lastIds = ids;
        samples++;
      }
      await sleep(5);
    }
  })();
  try {
    const TOTAL = 40;
    for (let i = 0; i < TOTAL; i++) {
      addDeletion(db, `conc-user-${String(i).padStart(3, "0")}`, 1_700_000_000_000 + i);
      await sleep(15);
    }
    const results = await Promise.all(
      children.map(async (c) => {
        assert.equal(await c.exited, 0, c.stdout() + c.stderr());
        return JSON.parse(c.stdout().trim().split("\n").at(-1)!) as {
          written: number;
          last: number;
        };
      }),
    );
    // One last export so the final file includes the last deletions.
    const final = await exportDeletionLedger(db, dir, { force: true });
    running = false;
    await sampler;
    const ledger = readLedgerFile(file);
    assert.equal(ledger.entries.length, TOTAL, "every deletion is in the final ledger");
    const written = results.reduce((n, r) => n + r.written, 0);
    // Generations are +1 per write under the lock: no two writers ever
    // produced the same generation or skipped one.
    assert.equal(ledger.generation, written + 1, "one generation per write, none lost or repeated");
    assert.equal(final.generation, ledger.generation);
    assert.ok(samples > 5, `the file was sampled while changing (${samples})`);
    assert.deepEqual(
      readdirSync(path.join(dir, "ledger")).filter((n) => n.endsWith(".tmp")),
      [],
      "no temporary files left",
    );
  } finally {
    running = false;
    await sampler.catch(() => {});
    for (const c of children) if (c.proc.exitCode === null) c.proc.kill("SIGKILL");
    db.close();
  }
});
