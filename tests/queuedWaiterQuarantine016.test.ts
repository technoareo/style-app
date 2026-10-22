import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  closeDatabases,
  DatabaseQuarantineError,
  getDatabase,
} from "../src/server/database";
import { acquireWriteGate, writeGateQueueLength } from "../src/server/writeGate";
import { runWriteTransaction } from "../src/server/writeTransaction";

/**
 * Build 016 revision 3, case W2: queued writers when the quarantined main
 * connection could NOT be closed. Every waiter re-resolves under the gate, is
 * refused with DatabaseQuarantineError (no body, no attempt), and the gate is
 * free afterwards. Own process and data directory: it leaves the main
 * connection refused for the rest of the process.
 */

const dir = path.join(process.cwd(), ".data", "tests", `waiter016-${randomUUID()}`);
mkdirSync(dir, { recursive: true });
process.env.STYLE_DATA_DIR = dir;
const holder = new DatabaseSync(path.join(dir, "app.db"), { timeout: 1 });
holder.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT);");

after(() => {
  closeDatabases();
  if (holder.isOpen) holder.close();
});

/** Rejects (with `label`) if `promise` has not settled within `ms`; the timer never lingers. */
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SETTLE_BOUND_MS = 30_000; // failure only: success returns as soon as the writers settle

test("W2: close-failed branch: the failing call surfaces its own error, every queued waiter is refused with DatabaseQuarantineError without running, the gate and queue are clean", async () => {
  const stuck = getDatabase();
  const original = stuck.exec.bind(stuck);
  (stuck as unknown as { exec: (sql: string) => void }).exec = (sql: string) => {
    if (sql === "ROLLBACK") throw new Error("injected rollback failure");
    return original(sql);
  };
  (stuck as unknown as { close: () => void }).close = () => {
    throw new Error("injected close failure");
  };
  let settled: Promise<unknown> = Promise.resolve();
  let releaseGate: (() => void) | undefined;
  let bodyFailed = false;
  try {
    const release = await acquireWriteGate();
    // Released exactly once, also when an assertion below fails first: a held
    // gate would otherwise stall the queued writers and the cleanup.
    let released = false;
    releaseGate = () => {
      if (released) return;
      released = true;
      release();
    };
    const thrown = new Error("w2 first failed");
    let bodies = 0;
    const first = runWriteTransaction((db) => {
      db.prepare("INSERT INTO t(v) VALUES (?)").run("w2-doomed");
      throw thrown;
    });
    const waiters = [1, 2, 3].map(() =>
      runWriteTransaction(() => {
        bodies++;
      }),
    );
    const all = Promise.allSettled([first, ...waiters]);
    settled = all;
    assert.equal(writeGateQueueLength(), 4);
    releaseGate();
    const results = await bounded(all, SETTLE_BOUND_MS, "the queued writers settling");

    assert.equal(results[0].status, "rejected");
    assert.strictEqual((results[0] as PromiseRejectedResult).reason, thrown);
    for (const r of results.slice(1)) {
      assert.equal(r.status, "rejected");
      assert.ok((r as PromiseRejectedResult).reason instanceof DatabaseQuarantineError);
    }
    assert.equal(bodies, 0);
    assert.equal(writeGateQueueLength(), 0);
    // Same 500 ms budget as before, but the timer is cleared on every path.
    const free = await bounded(
      acquireWriteGate().then((r) => (r(), true)),
      500,
      "the write gate being free",
    ).catch(() => false);
    assert.equal(free, true, "the gate is free");
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    // A cleanup problem is thrown only if the body succeeded, so it can never
    // replace the body's own assertion failure.
    let cleanupError: unknown;
    try {
      releaseGate?.();
      // Bounded and rejecting: a queued writer that never settles must not hang
      // the run, and the timeout is a cleanup error, not a silent success.
      await bounded(settled, SETTLE_BOUND_MS, "cleanup: the queued writers settling");
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      const handle = stuck as unknown as { exec?: unknown; close?: unknown };
      delete handle.exec;
      delete handle.close;
      closeDatabases();
      assert.equal(stuck.isOpen, false);
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined && !bodyFailed) throw cleanupError;
  }
});
