import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runWithLockObserver } from "../src/server/lockDiagnostics";
import { createImmediateSqliteDialect } from "../src/server/authDialect";
import {
  acquireWriteGate,
  WriteGateError,
  writeGateQueueLength,
} from "../src/server/writeGate";
import { createLockRecorder } from "./helpers/lockRecorder";

/**
 * Build 015: Better Auth's transaction begin uses ONE deadline for the gate
 * wait plus the SQLite lock wait. Time spent in the gate queue is taken from
 * the SQLite budget; the budgets are not raised and the old per-wait budget is
 * gone. Written, not executed by the author (no shell in that session).
 *
 * Margins: the budget is 600 ms and the gate is held 350 ms. With one shared
 * deadline the refusal arrives near 600 ms; with two independent budgets it
 * would arrive near 350 + 600 = 950 ms. The assertions sit between the two
 * (under 850 ms total, under 500 ms of SQLite time), far from either.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "app.db");

// "Another process" that owns the SQLite write lock.
const holder = new DatabaseSync(file, { timeout: 1 });
holder.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT);",
);
const authDb = new DatabaseSync(file, { timeout: 1 });

after(() => {
  if (holder.isOpen) {
    if (holder.isTransaction) holder.exec("ROLLBACK");
    holder.close();
  }
  if (authDb.isOpen) {
    if (authDb.isTransaction) authDb.exec("ROLLBACK");
    authDb.close();
  }
});

async function gateIsFree(): Promise<boolean> {
  return Promise.race([
    acquireWriteGate().then((release) => (release(), true)),
    sleep(500).then(() => false),
  ]);
}

const q = (sql: string, ...parameters: unknown[]) =>
  ({ sql, parameters, query: {} }) as never;

test("time spent waiting for the gate is deducted from the SQLite budget, and the failed begin releases the gate", async () => {
  const BUDGET = 600;
  const GATE_HELD = 350;
  const driver = createImmediateSqliteDialect(authDb, {
    acquireTimeoutMs: BUDGET,
    baseDelayMs: 10,
  }).createDriver();
  await driver.init();
  const recorder = createLockRecorder();

  holder.exec("BEGIN IMMEDIATE"); // the SQLite lock is unavailable throughout
  const release = await acquireWriteGate(); // so is the process gate, for a while
  const timer = setTimeout(release, GATE_HELD);
  let failure: unknown;
  let began = false;
  let elapsed = 0;
  try {
    await runWithLockObserver(recorder.observer, async () => {
      const conn = await driver.acquireConnection();
      const started = performance.now();
      try {
        await driver.beginTransaction(conn, {});
        began = true;
      } catch (error) {
        failure = error;
        elapsed = performance.now() - started;
      } finally {
        await driver.releaseConnection(conn);
      }
    });
  } finally {
    clearTimeout(timer);
    release(); // idempotent
    holder.exec("ROLLBACK");
  }

  assert.equal(began, false, "the begin must be refused while the lock is held");
  const code = (failure as { errcode?: number }).errcode ?? 0;
  assert.equal(code & 0xff, 5, "the original SQLITE_BUSY error surfaces");

  // One shared deadline: gate wait plus SQLite wait stays near the budget.
  assert.ok(
    elapsed < BUDGET + 250,
    `one deadline, not two (${Math.round(elapsed)} ms; two independent budgets would take about ${GATE_HELD + BUDGET} ms)`,
  );
  assert.ok(elapsed >= BUDGET - 60, `the whole budget was still used (${Math.round(elapsed)} ms)`);

  assert.equal(recorder.acquires.length, 1);
  const [event] = recorder.acquires;
  assert.equal(event.path, "auth");
  assert.equal(event.ok, false);
  assert.equal(event.outcome, "busy");
  assert.equal(event.budgetMs, BUDGET, "the budget is unchanged, only shared");
  assert.ok(event.gateMs >= GATE_HELD - 40, `the gate wait was measured (${event.gateMs} ms)`);
  assert.ok(
    event.sqliteMs < 500,
    `the SQLite wait got only what the gate left (${event.sqliteMs} ms; a full budget would be ${BUDGET}+)`,
  );
  assert.ok(event.attempts >= 1, "at least one BEGIN was attempted");
  assert.ok(
    event.gateMs + event.sqliteMs < BUDGET + 250,
    `gate + SQLite stay within the shared budget (${event.gateMs} + ${event.sqliteMs} ms)`,
  );

  // Old observer contracts: the attached detail is numbers only, and the two
  // original wall-clock fields keep their names.
  const detail = (failure as { acquire?: Record<string, unknown> }).acquire;
  assert.ok(detail, "the refusal carries its acquisition detail");
  for (const [key, value] of Object.entries(detail))
    assert.equal(typeof value, "number", `${key} is a number`);
  for (const key of ["budgetMs", "gateMs", "sqliteMs", "totalMs", "attempts", "queueDepth", "initializationMs"])
    assert.ok(key in detail, `${key} is still reported`);

  // The failure released everything.
  assert.equal(authDb.isTransaction, false);
  assert.equal(writeGateQueueLength(), 0);
  assert.equal(await gateIsFree(), true, "the gate was released by the failed begin");

  // And the next begin works once the foreign lock is gone.
  const conn = await driver.acquireConnection();
  await driver.beginTransaction(conn, {});
  await conn.executeQuery(q("insert into t(v) values (?)", "after-refusal"));
  await driver.commitTransaction(conn);
  await driver.releaseConnection(conn);
  assert.equal(
    (authDb.prepare("SELECT COUNT(*) AS n FROM t WHERE v='after-refusal'").get() as { n: number }).n,
    1,
  );
  assert.equal(await gateIsFree(), true);
});

test("a gate wait that is shorter than the budget still leaves the rest for the SQLite lock, which is then acquired", async () => {
  const driver = createImmediateSqliteDialect(authDb, {
    acquireTimeoutMs: 3000,
    baseDelayMs: 10,
  }).createDriver();
  await driver.init();
  const recorder = createLockRecorder();

  holder.exec("BEGIN IMMEDIATE");
  const release = await acquireWriteGate();
  const gateTimer = setTimeout(release, 200);
  const lockTimer = setTimeout(() => {
    try {
      holder.exec("COMMIT");
    } catch {
      // The test's finally rolls back if this did not run.
    }
  }, 450);
  try {
    await runWithLockObserver(recorder.observer, async () => {
      const conn = await driver.acquireConnection();
      await driver.beginTransaction(conn, {});
      try {
        await conn.executeQuery(q("insert into t(v) values (?)", "after-wait"));
        await driver.commitTransaction(conn);
      } finally {
        await driver.releaseConnection(conn);
      }
    });
  } finally {
    clearTimeout(gateTimer);
    clearTimeout(lockTimer);
    release();
    if (holder.isTransaction) holder.exec("ROLLBACK");
  }
  const [event] = recorder.acquires;
  assert.ok(event.ok, "acquired within the shared budget");
  assert.equal(event.outcome, "acquired");
  assert.ok(event.gateMs >= 160, `gate wait ${event.gateMs} ms`);
  assert.ok(event.attempts > 1, `BEGIN was retried while the lock was held (${event.attempts})`);
  assert.equal(recorder.holds.length, 1);
  assert.equal(recorder.holds[0].outcome, "commit");
  assert.equal(authDb.isTransaction, false);
  assert.equal(await gateIsFree(), true);
});

test("a gate wait that uses the whole budget fails as a gate timeout: no BEGIN is attempted and nothing is left held", async () => {
  const driver = createImmediateSqliteDialect(authDb, {
    acquireTimeoutMs: 150,
    baseDelayMs: 10,
  }).createDriver();
  await driver.init();
  const recorder = createLockRecorder();
  const release = await acquireWriteGate();
  try {
    await runWithLockObserver(recorder.observer, async () => {
      const conn = await driver.acquireConnection();
      try {
        await assert.rejects(
          driver.beginTransaction(conn, {}),
          (error: unknown) => error instanceof WriteGateError,
        );
      } finally {
        await driver.releaseConnection(conn);
      }
    });
  } finally {
    release();
  }
  const [event] = recorder.acquires;
  assert.equal(event.outcome, "gate-timeout");
  assert.equal(event.attempts, 0);
  assert.equal(event.sqliteMs, 0);
  assert.equal(authDb.isTransaction, false);
  assert.equal(writeGateQueueLength(), 0);
  assert.equal(await gateIsFree(), true);
});

test("STATIC: begin() derives the SQLite timeout from one deadline and the shared retry accepts an explicit remaining budget", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/server/authDialect.ts", "utf8");
  const begin = source.slice(
    source.indexOf("async begin()"),
    source.indexOf("async executeQuery"),
  );
  assert.match(begin, /const deadline = t0 \+ this\.acquireTimeoutMs/);
  assert.match(begin, /Math\.max\(0, deadline - Date\.now\(\)\)/);
  assert.match(begin, /acquireWriteGate\(this\.acquireTimeoutMs\)/, "the gate keeps the full budget");
  assert.doesNotMatch(begin, /acquireTimeoutMs \* 2|10_000\s*\*\s*2/);
});
