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
  isQuarantined,
  quarantinedConnectionCount,
} from "../src/server/database";
import { acquireWriteGate, writeGateQueueLength } from "../src/server/writeGate";
import { inTransaction, runWriteTransaction } from "../src/server/writeTransaction";
import { createLockRecorder } from "./helpers/lockRecorder";
import { runWithLockObserver } from "../src/server/lockDiagnostics";

/**
 * Build 016 revision 2: a transaction that cannot be rolled back.
 *
 * If the body (or COMMIT) fails and ROLLBACK then fails too, the shared main
 * connection can still be inside the transaction. The write gate must not be
 * released in that state: the next caller would join the stale transaction
 * (`inTransaction`) or fail every BEGIN, and SQLite's write lock would stay held
 * against every other process. The connection is quarantined instead
 * (database.ts, quarantineMainConnection): marked, closed (which rolls back what
 * was never committed) and replaced on demand, or, if it cannot even be closed,
 * refused loudly until the process restarts. The original error is always the
 * one reported.
 *
 * Each case forces the failure with an instance-level `exec` override (the same
 * technique as the COMMIT test in lockDiagnostics.test.ts). This file has its
 * own process and data directory: its last case deliberately leaves the main
 * connection refused.
 */

const dir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dir, { recursive: true });
process.env.STYLE_DATA_DIR = dir;
const file = path.join(dir, "app.db");

// Stands in for "another process": it can take the SQLite write lock only if
// this process no longer holds it.
const holder = new DatabaseSync(file, { timeout: 1 });
holder.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT);",
);

after(() => {
  closeDatabases();
  if (holder.isOpen) holder.close();
});

type Overridable = { exec?: unknown; close?: unknown };
const values = () =>
  (getDatabase().prepare("SELECT v FROM t ORDER BY id").all() as { v: string }[]).map(
    (r) => r.v,
  );
const insert = (value: string) => (db: DatabaseSync) => {
  db.prepare("INSERT INTO t(v) VALUES (?)").run(value);
};
const sqliteError = (errcode: number, message: string) =>
  Object.assign(new Error(message), { errcode });

async function gateIsFree(): Promise<boolean> {
  const wait = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500));
  return Promise.race([acquireWriteGate().then((release) => (release(), true)), wait]);
}

/** The foreign connection can take (and give back) the write lock. */
function foreignLockIsFree(): boolean {
  try {
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("ROLLBACK");
    return true;
  } catch {
    if (holder.isTransaction) holder.exec("ROLLBACK");
    return false;
  }
}

/** Makes every ROLLBACK on `db` throw (and optionally COMMIT too). */
function breakRollback(db: DatabaseSync, commitError?: Error): { rollbacks: () => number } {
  const original = db.exec.bind(db);
  let rollbacks = 0;
  (db as unknown as { exec: (sql: string) => void }).exec = (sql: string) => {
    if (sql === "ROLLBACK") {
      rollbacks++;
      throw sqliteError(10, "ROLLBACK failed");
    }
    if (sql === "COMMIT" && commitError) throw commitError;
    return original(sql);
  };
  return { rollbacks: () => rollbacks };
}

test("body error and a failing ROLLBACK (twice): the original error surfaces, the connection is quarantined and replaced, the gate and SQLite lock are free", async () => {
  await runWriteTransaction(insert("seed"));
  const old = getDatabase();
  const before = quarantinedConnectionCount();
  const recorder = createLockRecorder();
  const probe = breakRollback(old);
  const thrown = new Error("body failed");
  let caught: unknown;
  try {
    await runWithLockObserver(recorder.observer, () =>
      runWriteTransaction((db) => {
        insert("doomed")(db);
        throw thrown;
      }),
    );
    assert.fail("the body error must surface");
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught, thrown, "the body's error, by identity");
  assert.ok(probe.rollbacks() >= 2, `the in-block and the safety-net ROLLBACK both failed (${probe.rollbacks()})`);
  assert.equal(recorder.holds.length, 1);
  assert.equal(recorder.holds[0].outcome, "rollback");

  assert.equal(isQuarantined(old), true);
  assert.equal(quarantinedConnectionCount(), before + 1);
  let joined = false;
  assert.throws(
    () =>
      inTransaction(old, () => {
        joined = true;
      }),
    DatabaseQuarantineError,
  );
  assert.equal(joined, false, "a stale handle cannot join (or open) a transaction");

  const fresh = getDatabase();
  assert.notStrictEqual(fresh, old);
  assert.equal(fresh.isOpen, true);
  assert.equal(fresh.isTransaction, false);
  assert.deepEqual(values(), ["seed"], "committed data kept, the uncommitted row is gone");
  assert.equal(foreignLockIsFree(), true, "the SQLite write lock was released");
  assert.equal(await gateIsFree(), true, "the gate was released");

  await runWriteTransaction(insert("after"));
  assert.deepEqual(values(), ["seed", "after"], "later callers work on the new connection");
  // The fresh connection must not have a trace of the override.
  assert.ok(!Object.prototype.hasOwnProperty.call(fresh, "exec"));
});

test("a COMMIT failure followed by failing ROLLBACKs reports the COMMIT error and quarantines the connection", async () => {
  const old = getDatabase();
  const commitFailure = sqliteError(5, "commit busy");
  breakRollback(old, commitFailure);
  let runs = 0;
  let caught: unknown;
  try {
    await runWriteTransaction((db) => {
      runs++;
      insert("commit-doomed")(db);
    });
    assert.fail("the COMMIT error must surface");
  } catch (error) {
    caught = error;
  }
  assert.equal(runs, 1, "the body ran once and was not replayed");
  assert.strictEqual(caught, commitFailure);
  assert.equal(isQuarantined(old), true);
  assert.notStrictEqual(getDatabase(), old);
  assert.deepEqual(values(), ["seed", "after"]);
  assert.equal(foreignLockIsFree(), true);
  assert.equal(await gateIsFree(), true);
});

test("inTransaction used directly: a failing ROLLBACK does not replace the body's error, and the connection is quarantined", () => {
  const old = getDatabase();
  breakRollback(old);
  const thrown = new Error("direct body failed");
  assert.throws(
    () =>
      inTransaction(old, () => {
        insert("direct-doomed")(old);
        throw thrown;
      }),
    (error: unknown) => error === thrown,
  );
  assert.equal(isQuarantined(old), true);
  assert.throws(() => inTransaction(old, () => undefined), DatabaseQuarantineError);
  assert.notStrictEqual(getDatabase(), old);
  assert.deepEqual(values(), ["seed", "after"]);
  assert.equal(foreignLockIsFree(), true);
});

test("a rollback that works never quarantines: an ordinary body error leaves the connection and the counter alone", async () => {
  const connection = getDatabase();
  const before = quarantinedConnectionCount();
  await assert.rejects(
    runWriteTransaction((db) => {
      insert("plain-doomed")(db);
      throw new Error("plain failure");
    }),
    /plain failure/,
  );
  assert.strictEqual(getDatabase(), connection);
  assert.equal(isQuarantined(connection), false);
  assert.equal(quarantinedConnectionCount(), before);
  assert.deepEqual(values(), ["seed", "after"]);
});

/**
 * Revision 3: callers queued behind the gate captured the main handle before
 * waiting. If the gate holder quarantines and closes it, each waiter must
 * resolve the live connection under the gate (inside the guaranteed release),
 * keep its entry budget, and run its body exactly once on the fresh handle.
 * (W5, the original failure, stays recorded in
 * docs/verification/quarantine-waiter-probe-016.mjs/.json.)
 */
const WAITER_BUDGET_MS = 7_000;

test("W1/W4: queued writers behind a quarantined-and-replaced connection all succeed on the fresh connection, once each, with honest budgets", async () => {
  const old = getDatabase();
  const priorValues = values();
  breakRollback(old);
  const recorder = createLockRecorder();
  const release = await acquireWriteGate();
  // The gate is released exactly once, from the failure path too: a failed
  // assertion below must not leave it held and stall the rest of this file.
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  let settled: Promise<unknown> = Promise.resolve();
  try {
    const thrown = new Error("w1 first failed");
    let bodies = 0;
    const first = runWithLockObserver(recorder.observer, () =>
      runWriteTransaction(
        (db) => {
          insert("w1-doomed")(db);
          throw thrown;
        },
        { acquireTimeoutMs: WAITER_BUDGET_MS },
      ),
    );
    const waiters = [1, 2, 3, 4].map((n) =>
      runWithLockObserver(recorder.observer, () =>
        runWriteTransaction(
          (db) => {
            bodies++;
            insert(`w1-${n}`)(db);
          },
          { acquireTimeoutMs: WAITER_BUDGET_MS },
        ),
      ),
    );
    const all = Promise.allSettled([first, ...waiters]);
    settled = all;
    assert.equal(writeGateQueueLength(), 5);
    releaseOnce();
    const results = await all;

    assert.equal(results[0].status, "rejected");
    assert.strictEqual(
      (results[0] as PromiseRejectedResult).reason,
      thrown,
      "the first caller's own error, by identity",
    );
    for (const r of results.slice(1))
      assert.equal(r.status, "fulfilled", JSON.stringify(r));
    assert.equal(bodies, 4, "each waiter's body ran exactly once");
    assert.equal(isQuarantined(old), true);
    assert.notStrictEqual(getDatabase(), old);
    assert.deepEqual(values(), [...priorValues, "w1-1", "w1-2", "w1-3", "w1-4"]);
    assert.equal(writeGateQueueLength(), 0);
    assert.equal(foreignLockIsFree(), true);
    assert.equal(await gateIsFree(), true);

    // W4 (success side): the waiters' budgets are their entry values, the first
    // BEGIN is attempt 1, and the reopen is not folded into the gate wait.
    assert.equal(recorder.acquires.length, 5);
    for (const event of recorder.acquires.slice(1)) {
      assert.equal(event.ok, true);
      assert.equal(event.outcome, "acquired");
      assert.equal(event.attempts, 1);
      assert.equal(event.budgetMs, WAITER_BUDGET_MS);
      assert.ok(event.gateMs >= 0 && event.sqliteMs >= 0 && event.initializationMs >= 0);
    }
  } finally {
    releaseOnce();
    await settled; // never rejects (allSettled); lets queued writers finish
    const handle = old as unknown as Overridable;
    delete handle.exec;
    delete handle.close;
  }
});

test("W3/W4: a waiter whose reopen fails rejects with that error, releases the gate, runs no body, makes no attempt, and leaks no presence", async () => {
  const { claimExclusiveAccess } = await import("../src/server/processPresence");
  const old = getDatabase();
  breakRollback(old);
  const badDir = path.join(process.cwd(), ".data", "tests", randomUUID());
  mkdirSync(path.join(badDir, "app.db"), { recursive: true }); // unopenable as a database
  const recorder = createLockRecorder();
  const release = await acquireWriteGate();
  let bodies = 0;
  const first = runWriteTransaction(
    (db) => {
      insert("w3-doomed")(db);
      throw new Error("w3 first failed");
    },
    { acquireTimeoutMs: WAITER_BUDGET_MS },
  );
  const waiter = runWithLockObserver(recorder.observer, () =>
    runWriteTransaction(
      () => {
        bodies++;
      },
      { acquireTimeoutMs: WAITER_BUDGET_MS },
    ),
  );
  const settled = Promise.allSettled([first, waiter]);
  const goodDir = process.env.STYLE_DATA_DIR;
  process.env.STYLE_DATA_DIR = badDir; // only the reopen sees this
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  try {
    releaseOnce();
    const [firstResult, waiterResult] = await settled;
    assert.equal(firstResult.status, "rejected");
    assert.match(String((firstResult as PromiseRejectedResult).reason), /w3 first failed/);
    assert.equal(waiterResult.status, "rejected");
    const reason = (waiterResult as PromiseRejectedResult).reason as Error;
    assert.ok(reason instanceof Error);
    assert.ok(!(reason instanceof DatabaseQuarantineError), "not a quarantine refusal");
    assert.notEqual(reason.name, "WriteContentionError", "not mapped to contention");
    assert.notEqual((reason as { code?: string }).code, "ERR_INVALID_STATE");
    assert.equal(bodies, 0);
    assert.equal(writeGateQueueLength(), 0);
    assert.equal(await gateIsFree(), true, "the gate was released");
    assert.equal(
      claimExclusiveAccess(goodDir as string).release(),
      undefined,
      "no handle is open, so the presence hold was released",
    );

    const event = recorder.acquires[0];
    assert.equal(event.ok, false);
    assert.equal(event.outcome, "error");
    assert.equal(event.attempts, 0);
    assert.equal(event.budgetMs, WAITER_BUDGET_MS, "no extended or reset budget");
    assert.ok(event.sqliteMs >= 0);
    // A consistency bound only: it holds wherever the reopen time is counted, so
    // it does NOT prove the reopen sits in sqliteMs. That placement is true by
    // construction (the reopen runs after the gate is acquired and before the
    // first BEGIN, inside the sqlite phase) and is not asserted numerically.
    assert.ok(
      event.totalMs + 0.5 >= event.initializationMs + event.gateMs + event.sqliteMs,
      "the three phase fields do not sum to more than totalMs (consistency only; says nothing about where the reopen is counted)",
    );
  } finally {
    releaseOnce();
    await settled;
    process.env.STYLE_DATA_DIR = goodDir;
    const handle = old as unknown as Overridable;
    delete handle.exec;
    delete handle.close;
  }
  // The next caller works: a later getDatabase() retries and succeeds.
  const inserted = values().length;
  await runWriteTransaction(insert("w3-after"));
  assert.equal(values().length, inserted + 1);
});

// Keep this LAST: it leaves the main connection refused for the rest of the
// process (there is deliberately no reset function).
test("if the stuck connection cannot even be closed, every later use fails loudly, and the limit is real: the SQLite lock stays held until it is closed", async () => {
  const stuck = getDatabase();
  breakRollback(stuck);
  (stuck as unknown as { close: () => void }).close = () => {
    throw new Error("close failed");
  };
  let cleanupError: unknown;
  try {
    const thrown = new Error("body failed again");
    let caught: unknown;
    try {
      await runWriteTransaction((db) => {
        insert("unclosable")(db);
        throw thrown;
      });
      assert.fail("the body error must surface");
    } catch (error) {
      caught = error;
    }
    assert.strictEqual(caught, thrown, "still the original error");
    assert.equal(isQuarantined(stuck), true);
    assert.throws(() => getDatabase(), DatabaseQuarantineError);
    await assert.rejects(
      runWriteTransaction(insert("refused")),
      (error: unknown) => error instanceof DatabaseQuarantineError,
    );
    assert.throws(() => inTransaction(stuck, () => undefined), DatabaseQuarantineError);
    assert.equal(await gateIsFree(), true, "the in-process gate is free; nothing waits on it");
    // The documented limit: an open transaction on a handle that will not close
    // keeps the write lock for other processes until the process ends.
    assert.equal(foreignLockIsFree(), false);

    // Shutdown tries once more to close it (here the override is removed first).
    delete (stuck as Overridable).close;
    delete (stuck as Overridable).exec;
    closeDatabases();
    assert.equal(foreignLockIsFree(), true, "closing the handle released the lock");
    assert.throws(() => getDatabase(), DatabaseQuarantineError, "still refused: only a restart clears it");
  } finally {
    // If an assertion above failed midway the overrides are still installed;
    // remove them and close here instead of leaving it to after(), whose
    // closeDatabases() could not close an overridden handle. A cleanup error
    // never masks the failure being reported.
    delete (stuck as Overridable).close;
    delete (stuck as Overridable).exec;
    try {
      closeDatabases();
      assert.equal(stuck.isOpen, false, "the stuck handle is closed on every path");
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
});
