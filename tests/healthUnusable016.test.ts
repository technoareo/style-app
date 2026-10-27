import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Build 016 revision 4: /api/health must stop saying "ready" once this process
 * has a main connection it quarantined and could not close, and a quarantine
 * must leave one fixed-text, data-free line for the operator.
 *
 * Own process and synthetic data directory: the last case leaves the main
 * connection refused for the rest of the process (there is no reset function).
 * Everything here runs in this process against the real route handler; it does
 * not exercise Compose, Caddy or any real restart policy (see the notes).
 */

const dir = path.join(process.cwd(), ".data", "tests", `health016-${randomUUID()}`);
mkdirSync(dir, { recursive: true });
const previousDir = process.env.STYLE_DATA_DIR;
process.env.STYLE_DATA_DIR = dir;
process.env.APP_URL = "http://127.0.0.1:3000";
delete process.env.STYLE_PUBLIC_DEPLOYMENT;
delete process.env.SMTP_URL;

type Database = typeof import("../src/server/database");
type WriteTransaction = typeof import("../src/server/writeTransaction");
let database: Database;
let write: WriteTransaction;
let health: () => Promise<Response>;

after(() => {
  try {
    database?.closeDatabases();
  } finally {
    if (previousDir === undefined) delete process.env.STYLE_DATA_DIR;
    else process.env.STYLE_DATA_DIR = previousDir;
  }
});

type Overridable = { exec?: unknown; close?: unknown };
const restore = (db: DatabaseSync) => {
  delete (db as unknown as Overridable).exec;
  delete (db as unknown as Overridable).close;
};
function breakRollback(db: DatabaseSync): void {
  const original = db.exec.bind(db);
  (db as unknown as { exec: (sql: string) => void }).exec = (sql: string) => {
    if (sql === "ROLLBACK") throw new Error("injected rollback failure");
    return original(sql);
  };
}
function breakClose(db: DatabaseSync): void {
  (db as unknown as { close: () => void }).close = () => {
    throw new Error("injected close failure");
  };
}

/** Records (and optionally breaks) console.error for the duration of `body`. */
async function withConsoleError<T>(
  body: (lines: string[]) => Promise<T>,
  fail = false,
): Promise<T> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
    if (fail) throw new Error("the logger itself failed");
  };
  try {
    return await body(lines);
  } finally {
    console.error = original;
  }
}
const databaseLines = (lines: string[]) => lines.filter((l) => l.startsWith("[database]"));

async function failedWrite(): Promise<unknown> {
  const original = new Error("injected body failure");
  try {
    await write.runWriteTransaction((db) => {
      db.exec("INSERT INTO probe VALUES(1)");
      throw original;
    });
  } catch (error) {
    assert.strictEqual(error, original, "the body's own error is the one reported");
    return error;
  }
  return assert.fail("the body error must surface");
}

async function assertNotReady(label: string): Promise<void> {
  const response = await health();
  assert.equal(response.status, 503, label);
  assert.equal(response.headers.get("cache-control"), "no-store", label);
  const text = await response.text();
  assert.equal(text, JSON.stringify({ ready: false }), `${label}: the fixed body, no reason text`);
}

test("before any fault the route is ready; the flag is false", async () => {
  const { getReadyAuth } = await import("../src/server/auth");
  await getReadyAuth();
  database = await import("../src/server/database");
  write = await import("../src/server/writeTransaction");
  health = (await import("../src/app/api/health/route")).GET;
  const response = await health();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ready: true });
  assert.equal(database.mainConnectionUnusable(), false);
  database.getDatabase().exec("CREATE TABLE IF NOT EXISTS probe(v INTEGER)");
});

test("a quarantine whose close succeeds logs one fixed line, keeps the route ready, and a failing logger changes nothing", async () => {
  const before = database.quarantinedConnectionCount();
  const old = database.getDatabase();
  breakRollback(old);
  try {
    await withConsoleError(async (lines) => {
      await failedWrite();
      const logged = databaseLines(lines);
      assert.deepEqual(logged, [
        `[database] main connection quarantined: outcome=replaceable count=${before + 1}`,
      ]);
      for (const line of lines) {
        assert.ok(!line.includes(dir), "no path");
        assert.doesNotMatch(line, /probe|injected|INSERT|ROLLBACK/i, "no SQL or error text");
      }
    });
    assert.equal(database.isQuarantined(old), true);
    assert.equal(database.mainConnectionUnusable(), false);
    assert.equal((await health()).status, 200, "a replaced connection is healthy");
  } finally {
    restore(old);
  }

  // A logger that throws must not replace the original failure or the recovery.
  const second = database.getDatabase();
  breakRollback(second);
  try {
    await withConsoleError(async (lines) => {
      await failedWrite(); // asserts the body's own error is still reported
      assert.equal(databaseLines(lines).length, 1, "the logger was reached");
    }, true);
    assert.equal(database.isQuarantined(second), true);
    assert.equal(database.quarantinedConnectionCount(), before + 2);
    assert.equal(database.getDatabase().isOpen, true, "the next caller has a fresh connection");
    assert.equal((await health()).status, 200);
  } finally {
    restore(second);
  }
});

// Keep this LAST: it leaves the main connection refused for the rest of the
// process (there is deliberately no reset function).
test("own process: healthy, then a failed rollback and failed close: the route answers exactly 503 {ready:false} with no-store and the operator line says unclosed", async () => {
  assert.equal((await health()).status, 200, "healthy first");
  assert.equal(database.mainConnectionUnusable(), false);

  const stuck = database.getDatabase();
  const before = database.quarantinedConnectionCount();
  breakRollback(stuck);
  breakClose(stuck);
  let bodyFailed = false;
  try {
    await withConsoleError(async (lines) => {
      await failedWrite();
      assert.deepEqual(databaseLines(lines), [
        `[database] main connection quarantined: outcome=unclosed count=${before + 1}`,
      ]);
      for (const line of lines) {
        assert.ok(!line.includes(dir), "no path");
        assert.doesNotMatch(line, /probe|injected|INSERT|ROLLBACK/i, "no SQL or error text");
      }
    });
    assert.equal(stuck.isOpen, true, "the close really failed");
    assert.equal(database.mainConnectionUnusable(), true);
    assert.throws(() => database.getDatabase(), database.DatabaseQuarantineError);
    await assertNotReady("while the handle is stuck");
    // Repeated probes stay identical (the route never opens or queries anything).
    await assertNotReady("second probe");
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    // A cleanup problem is thrown only if the body succeeded, so it can never
    // replace the body's own assertion failure.
    let cleanupError: unknown;
    try {
      restore(stuck);
      database.closeDatabases();
      assert.equal(stuck.isOpen, false);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError !== undefined && !bodyFailed) throw cleanupError;
  }
  // Even after the stuck handle really closed, only a restart clears the state,
  // so the route keeps saying not ready (the signal that a restart is needed).
  assert.equal(database.mainConnectionUnusable(), true);
  await assertNotReady("after the handle closed");
});
