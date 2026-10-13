import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDatabases, getDatabase } from "../src/server/database";
import {
  runWithLockObserver,
  setProcessLockObserver,
  type LockObserver,
} from "../src/server/lockDiagnostics";
import {
  runWriteTransaction,
  WriteContentionError,
} from "../src/server/writeTransaction";
import {
  acquireWriteGate,
  WriteGateError,
  writeGateQueueLength,
} from "../src/server/writeGate";
import { createImmediateSqliteDialect } from "../src/server/authDialect";
import { createLockRecorder, stats } from "./helpers/lockRecorder";
import { runScript } from "./helpers/processes";

/**
 * Build 011: the lock diagnostics (src/server/lockDiagnostics.ts) measure what
 * they claim and change nothing. These tests use real SQLite connections and
 * real waiting; the tolerances are deliberately generous (they bound the
 * measurement from below by the wait the test itself created).
 *
 *  - the brackets cover the real gate wait, the real SQLite wait and the hold;
 *  - concurrent observer contexts stay isolated;
 *  - a refused lock never runs the body and releases the gate;
 *  - an observer that throws cannot change a result, mask a failure, keep a
 *    transaction open or hold the gate.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const q = (sql: string, ...parameters: unknown[]) =>
  ({ sql, parameters, query: {} }) as never;

const dir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dir, { recursive: true });
process.env.STYLE_DATA_DIR = dir;
const file = path.join(dir, "app.db");

// A second connection standing in for "another process" that holds the lock.
const holder = new DatabaseSync(file, { timeout: 1 });
holder.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT);",
);

after(() => {
  closeDatabases();
  if (holder.isOpen) holder.close();
});

const rows = () =>
  (getDatabase().prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number })
    .n;
const insert = (value: string) => (db: DatabaseSync) => {
  db.prepare("INSERT INTO t(v) VALUES (?)").run(value);
};

async function gateIsFree(): Promise<boolean> {
  return Promise.race([
    acquireWriteGate().then((release) => (release(), true)),
    sleep(500).then(() => false),
  ]);
}

test("the percentile helper is nearest-rank and keeps the exact maximum", () => {
  const s = stats([5, 1, 3, 2, 4, 100, 7, 6, 8, 9]);
  assert.equal(s.count, 10);
  assert.equal(s.p50, 5);
  assert.equal(s.p95, 100);
  assert.equal(s.p99, 100);
  assert.equal(s.max, 100);
  assert.deepEqual(stats([]), { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
});

// This must stay the first test that touches the application connection: the
// COLD call is what it measures.
test("connection initialization is reported on its own: not a gate wait, not a SQLite wait, and part of the total", async () => {
  const cold = createLockRecorder();
  await runWithLockObserver(cold.observer, () => runWriteTransaction(insert("cold")));
  const warm = createLockRecorder();
  await runWithLockObserver(warm.observer, () => runWriteTransaction(insert("warm")));
  assert.equal(cold.acquires.length, 1);
  assert.equal(warm.acquires.length, 1);
  const [c] = cold.acquires;
  const [w] = warm.acquires;
  assert.ok(c.ok && w.ok);
  assert.ok(c.initializationMs > 0, `the first call opened the connection (${c.initializationMs} ms)`);
  assert.ok(c.initializationMs < 10_000);
  assert.ok(w.initializationMs < 5, `a later call reuses it (${w.initializationMs} ms)`);
  for (const e of [c, w]) {
    assert.ok(e.gateMs < 50, `the gate was free, so opening the file is not gate time (${e.gateMs} ms)`);
    assert.ok(e.sqliteMs < 50, `nothing held the lock (${e.sqliteMs} ms)`);
    assert.ok(
      Math.abs(e.totalMs - (e.initializationMs + e.gateMs + e.sqliteMs)) <= 5,
      "total = initialization + gate + SQLite",
    );
  }
  assert.ok(c.totalMs >= c.initializationMs, "the total includes initialization");
});

test("the acquire measurement brackets the real SQLite wait, the gate wait and the queue depth", async () => {
  // Warm the connection FIRST. Starting the foreign lock and its release timer
  // before the application connection existed let lazy initialization consume
  // part of the held interval, so the SQLite wait came out shorter than the
  // wait the fixture created. The lower bound below is causal and unchanged.
  await runWriteTransaction(() => undefined);
  const recorder = createLockRecorder();
  holder.exec("BEGIN IMMEDIATE");
  const timer = setTimeout(() => {
    try {
      holder.exec("COMMIT");
    } catch {
      // Already finished by the cleanup below.
    }
  }, 400);
  let elapsed = 0;
  try {
    const before = performance.now();
    await runWithLockObserver(recorder.observer, () =>
      runWriteTransaction(insert("sqlite-wait")),
    );
    elapsed = performance.now() - before;
  } finally {
    clearTimeout(timer);
    if (holder.isTransaction) holder.exec("ROLLBACK");
  }
  assert.equal(recorder.acquires.length, 1);
  const e = recorder.acquires[0];
  assert.equal(e.path, "write");
  assert.equal(e.ok, true);
  assert.equal(e.outcome, "acquired");
  assert.ok(e.initializationMs < 5, `the connection was already open (${e.initializationMs} ms)`);
  assert.ok(e.sqliteMs >= 300, `SQLite wait covers the held lock (${e.sqliteMs} ms)`);
  assert.ok(e.sqliteMs < 5000);
  assert.ok(e.gateMs < 100, `the gate was free (${e.gateMs} ms)`);
  assert.ok(e.attempts >= 2, `BEGIN was retried (${e.attempts})`);
  assert.ok(
    Math.abs(e.totalMs - (e.initializationMs + e.gateMs + e.sqliteMs)) <= 5,
    "total equals initialization plus gate plus SQLite wait",
  );
  assert.ok(e.totalMs <= elapsed + 1, "the measurement lies inside the caller's wall time");
  assert.equal(e.budgetMs, 10_000);
  assert.equal(e.queueDepth, 0);

  // Gate wait and queue depth: the gate is held elsewhere for ~300 ms; two
  // callers arrive while it is held.
  const second = createLockRecorder();
  const release = await acquireWriteGate();
  const releaseTimer = setTimeout(release, 300);
  assert.equal(writeGateQueueLength(), 0);
  const one = runWithLockObserver(second.observer, () =>
    runWriteTransaction(insert("gate-1")),
  );
  const two = runWithLockObserver(second.observer, () =>
    runWriteTransaction(insert("gate-2")),
  );
  await Promise.all([one, two]);
  clearTimeout(releaseTimer);
  assert.equal(second.acquires.length, 2);
  assert.deepEqual(
    second.acquires.map((x) => x.queueDepth).sort(),
    [0, 1],
    "the second caller saw the first one queued",
  );
  for (const x of second.acquires) {
    assert.ok(x.ok);
    assert.ok(x.gateMs >= 250, `gate wait covers the held gate (${x.gateMs} ms)`);
    assert.equal(x.attempts, 1, "no SQLite contention, one BEGIN");
  }
  assert.equal(second.holds.length, 2);
});

test("the hold measurement runs from a successful BEGIN to COMMIT or ROLLBACK, on the auth path and on the write path", async () => {
  const authDb = new DatabaseSync(file, { timeout: 1 });
  try {
    const recorder = createLockRecorder();
    const driver = createImmediateSqliteDialect(authDb, {
      acquireTimeoutMs: 2000,
      baseDelayMs: 10,
    }).createDriver();
    await driver.init();

    await runWithLockObserver(recorder.observer, async () => {
      let conn = await driver.acquireConnection();
      await driver.beginTransaction(conn, {});
      await sleep(250); // the lock is held across real macrotasks
      await conn.executeQuery(q("insert into t(v) values (?)", "auth-commit"));
      await driver.commitTransaction(conn);
      await driver.releaseConnection(conn);

      conn = await driver.acquireConnection();
      await driver.beginTransaction(conn, {});
      await sleep(120);
      await conn.executeQuery(q("insert into t(v) values (?)", "auth-rollback"));
      await driver.rollbackTransaction(conn);
      await driver.releaseConnection(conn);
    });

    assert.equal(recorder.acquires.length, 2);
    assert.ok(recorder.acquires.every((e) => e.path === "auth" && e.ok && e.attempts === 1));
    assert.equal(recorder.holds.length, 2);
    const [commit, rollback] = recorder.holds;
    assert.equal(commit.path, "auth");
    assert.equal(commit.outcome, "commit");
    assert.ok(commit.holdMs >= 230 && commit.holdMs < 5000, `commit hold ${commit.holdMs}`);
    assert.equal(rollback.outcome, "rollback");
    assert.ok(rollback.holdMs >= 100 && rollback.holdMs < 5000, `rollback hold ${rollback.holdMs}`);
    assert.equal(
      (getDatabase().prepare("SELECT COUNT(*) AS n FROM t WHERE v='auth-rollback'").get() as { n: number }).n,
      0,
      "the rolled-back row is absent",
    );
  } finally {
    authDb.close();
  }

  // Write path: a body that throws rolls back and reports a rollback hold.
  const recorder = createLockRecorder();
  const before = rows();
  await assert.rejects(
    runWithLockObserver(recorder.observer, () =>
      runWriteTransaction((db) => {
        insert("write-rollback")(db);
        throw new Error("body failed");
      }),
    ),
    /body failed/,
  );
  assert.equal(rows(), before);
  assert.equal(recorder.holds.length, 1);
  assert.equal(recorder.holds[0].path, "write");
  assert.equal(recorder.holds[0].outcome, "rollback");
  await runWithLockObserver(recorder.observer, () =>
    runWriteTransaction(insert("write-commit")),
  );
  assert.equal(recorder.holds[1].outcome, "commit");
});

/**
 * Queues `count` microtasks that each block the thread for `eachMs`. Called
 * synchronously right after starting a transaction call, they run AFTER the
 * call's first continuation (which executes BEGIN) and BEFORE the continuation
 * that follows `await`ing it: exactly the gap between "the lock was taken" and
 * "the caller resumed" that a timestamp read after the await would wrongly
 * leave out of the hold.
 */
function blockAfterBegin(count: number, eachMs: number): void {
  for (let i = 0; i < count; i++)
    queueMicrotask(() => {
      const until = performance.now() + eachMs;
      while (performance.now() < until) {
        // Busy wait: this stands in for a delayed resumption.
      }
    });
}

test("the hold starts when BEGIN returned, not when the caller resumed (write path)", async () => {
  await runWriteTransaction(() => undefined); // warm
  const recorder = createLockRecorder();
  const call = runWithLockObserver(recorder.observer, () =>
    runWriteTransaction(insert("begin-instant")),
  );
  blockAfterBegin(20, 5); // ~100 ms between BEGIN returning and the resumption
  await call;
  assert.equal(recorder.acquires.length, 1);
  assert.equal(recorder.holds.length, 1);
  const [a] = recorder.acquires;
  const [h] = recorder.holds;
  assert.ok(a.sqliteMs < 50, `acquisition itself was quick (${a.sqliteMs} ms)`);
  assert.ok(
    h.holdMs >= 90,
    `the hold includes the delay after BEGIN returned (${h.holdMs} ms)`,
  );
  assert.equal(h.outcome, "commit");
});

test("the hold starts when BEGIN returned, not when the caller resumed (auth path)", async () => {
  const authDb = new DatabaseSync(file, { timeout: 1 });
  try {
    const recorder = createLockRecorder();
    const driver = createImmediateSqliteDialect(authDb, {
      acquireTimeoutMs: 2000,
      baseDelayMs: 10,
    }).createDriver();
    await driver.init();
    await runWithLockObserver(recorder.observer, async () => {
      const conn = await driver.acquireConnection();
      const begun = driver.beginTransaction(conn, {});
      blockAfterBegin(20, 5);
      await begun;
      await driver.commitTransaction(conn);
      await driver.releaseConnection(conn);
    });
    assert.equal(recorder.acquires.length, 1);
    assert.equal(recorder.holds.length, 1);
    assert.ok(recorder.acquires[0].sqliteMs < 50, `${recorder.acquires[0].sqliteMs} ms`);
    assert.equal(recorder.acquires[0].initializationMs, 0, "the auth path has no initialization step");
    assert.ok(
      recorder.holds[0].holdMs >= 90,
      `the hold includes the delay after BEGIN returned (${recorder.holds[0].holdMs} ms)`,
    );
  } finally {
    authDb.close();
  }
});

test("a refusal's detail carries initialization, gate and SQLite time that add up to its total", async () => {
  await runWriteTransaction(() => undefined); // warm
  holder.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(
      runWriteTransaction(insert("detail"), { acquireTimeoutMs: 250 }),
      (error: unknown) => {
        assert.ok(error instanceof WriteContentionError);
        const d = error.acquire;
        assert.ok(d);
        assert.ok(d.initializationMs < 5);
        assert.ok(d.sqliteMs >= 150, `${d.sqliteMs} ms`);
        assert.ok(Math.abs(d.totalMs - (d.initializationMs + d.gateMs + d.sqliteMs)) <= 5);
        return true;
      },
    );
  } finally {
    if (holder.isTransaction) holder.exec("ROLLBACK");
  }
});

test("concurrent observer contexts stay isolated; the process observer sees only what no context claims", async () => {
  const a = createLockRecorder();
  const b = createLockRecorder();
  const processWide = createLockRecorder();
  setProcessLockObserver(processWide.observer);
  try {
    const run = (n: number, tag: string) => async () => {
      for (let i = 0; i < n; i++) {
        await runWriteTransaction(insert(`${tag}-${i}`));
        await sleep(1);
      }
    };
    await Promise.all([
      runWithLockObserver(a.observer, run(3, "ctx-a")),
      runWithLockObserver(b.observer, run(2, "ctx-b")),
    ]);
    assert.equal(a.acquires.length, 3);
    assert.equal(a.holds.length, 3);
    assert.equal(b.acquires.length, 2);
    assert.equal(b.holds.length, 2);
    assert.equal(processWide.acquires.length, 0, "a context observer replaces the process one");

    await runWriteTransaction(insert("no-context"));
    assert.equal(processWide.acquires.length, 1);
    assert.equal(a.acquires.length, 3);
    assert.equal(b.acquires.length, 2);
  } finally {
    setProcessLockObserver(null);
  }
  const before = processWide.acquires.length;
  await runWriteTransaction(insert("no-observer"));
  assert.equal(processWide.acquires.length, before, "nothing is recorded without an observer");
});

test("a refused lock never runs the body, reports where the budget went, and leaves no transaction or gate behind", async () => {
  const recorder = createLockRecorder();
  let bodyRuns = 0;
  const before = rows();
  holder.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(
      runWithLockObserver(recorder.observer, () =>
        runWriteTransaction(
          () => {
            bodyRuns++;
          },
          { acquireTimeoutMs: 300 },
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof WriteContentionError);
        assert.equal(error.message, "The database is busy. Try again shortly.");
        assert.ok(error.acquire, "the error carries its diagnostics");
        assert.equal(error.acquire.budgetMs, 300);
        assert.ok(error.acquire.attempts >= 2);
        assert.ok(error.acquire.sqliteMs >= 200);
        return true;
      },
    );
  } finally {
    holder.exec("ROLLBACK");
  }
  assert.equal(bodyRuns, 0, "the body never ran");
  assert.equal(rows(), before);
  assert.equal(getDatabase().isTransaction, false);
  assert.equal(recorder.acquires.length, 1);
  const e = recorder.acquires[0];
  assert.equal(e.ok, false);
  assert.equal(e.outcome, "busy");
  assert.ok(e.sqliteMs >= 200 && e.totalMs < 5000);
  assert.ok(e.gateMs < 100);
  assert.equal(recorder.holds.length, 0, "no transaction began, so there is no hold");
  assert.equal(await gateIsFree(), true, "the gate was released");
  // The same call succeeds once the lock is free.
  await runWriteTransaction(insert("after-refusal"));
  assert.equal(rows(), before + 1);
});

test("a gate that times out is reported, the body never runs, and the original error type is unchanged", async () => {
  const recorder = createLockRecorder();
  let bodyRuns = 0;
  const release = await acquireWriteGate();
  try {
    await assert.rejects(
      runWithLockObserver(recorder.observer, () =>
        runWriteTransaction(
          () => {
            bodyRuns++;
          },
          { acquireTimeoutMs: 120 },
        ),
      ),
      (error: unknown) =>
        error instanceof WriteGateError &&
        error.message === "Timed out waiting for the write queue.",
    );
  } finally {
    release();
  }
  assert.equal(bodyRuns, 0);
  assert.equal(recorder.acquires.length, 1);
  const e = recorder.acquires[0];
  assert.equal(e.ok, false);
  assert.equal(e.outcome, "gate-timeout");
  assert.ok(e.gateMs >= 90, `gate wait covers the timeout (${e.gateMs} ms)`);
  assert.equal(e.sqliteMs, 0);
  assert.equal(e.attempts, 0);
  assert.equal(writeGateQueueLength(), 0, "the timed-out waiter was removed");
  assert.equal(await gateIsFree(), true);
});

test("an observer that throws cannot change a result, mask a failure, keep a transaction open or hold the gate", async () => {
  const hostile: LockObserver = {
    acquire() {
      throw new Error("observer acquire failure");
    },
    hold() {
      throw new Error("observer hold failure");
    },
  };

  // Success: the value is returned and the row committed.
  const before = rows();
  const value = await runWithLockObserver(hostile, () =>
    runWriteTransaction((db) => {
      insert("hostile-ok")(db);
      return "result";
    }),
  );
  assert.equal(value, "result");
  assert.equal(rows(), before + 1);
  assert.equal(getDatabase().isTransaction, false);
  assert.equal(await gateIsFree(), true);

  // Body failure: the body's own error comes out, the work is rolled back.
  await assert.rejects(
    runWithLockObserver(hostile, () =>
      runWriteTransaction((db) => {
        insert("hostile-rollback")(db);
        throw new Error("the real failure");
      }),
    ),
    /the real failure/,
  );
  assert.equal(rows(), before + 1);
  assert.equal(getDatabase().isTransaction, false);
  assert.equal(await gateIsFree(), true);

  // Refusal: the contention error comes out, not the observer's.
  holder.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(
      runWithLockObserver(hostile, () =>
        runWriteTransaction(insert("hostile-busy"), { acquireTimeoutMs: 200 }),
      ),
      (error: unknown) => error instanceof WriteContentionError,
    );
  } finally {
    holder.exec("ROLLBACK");
  }
  assert.equal(await gateIsFree(), true);

  // Gate refusal: the gate error comes out, not the observer's.
  const release = await acquireWriteGate();
  try {
    await assert.rejects(
      runWithLockObserver(hostile, () =>
        runWriteTransaction(insert("hostile-gate"), { acquireTimeoutMs: 80 }),
      ),
      (error: unknown) => error instanceof WriteGateError,
    );
  } finally {
    release();
  }
  assert.equal(await gateIsFree(), true);

  // Auth dialect: begin, commit and rollback behave, and the gate is freed.
  const authDb = new DatabaseSync(file, { timeout: 1 });
  try {
    const driver = createImmediateSqliteDialect(authDb, {
      acquireTimeoutMs: 1000,
      baseDelayMs: 10,
    }).createDriver();
    await driver.init();
    await runWithLockObserver(hostile, async () => {
      let conn = await driver.acquireConnection();
      await driver.beginTransaction(conn, {});
      assert.equal(authDb.isTransaction, true);
      await conn.executeQuery(q("insert into t(v) values (?)", "hostile-auth"));
      await driver.commitTransaction(conn);
      await driver.releaseConnection(conn);
      assert.equal(authDb.isTransaction, false);
      assert.equal(await gateIsFree(), true);

      conn = await driver.acquireConnection();
      await driver.beginTransaction(conn, {});
      await conn.executeQuery(q("insert into t(v) values (?)", "hostile-auth-rb"));
      await driver.rollbackTransaction(conn);
      await driver.releaseConnection(conn);
      assert.equal(authDb.isTransaction, false);
      assert.equal(await gateIsFree(), true);
    });
    const count = (v: string) =>
      (getDatabase().prepare("SELECT COUNT(*) AS n FROM t WHERE v=?").get(v) as { n: number }).n;
    assert.equal(count("hostile-auth"), 1);
    assert.equal(count("hostile-auth-rb"), 0);

    // A refused auth BEGIN still surfaces the SQLite error, not the observer's.
    holder.exec("BEGIN IMMEDIATE");
    try {
      const fast = createImmediateSqliteDialect(authDb, {
        acquireTimeoutMs: 150,
        baseDelayMs: 10,
      }).createDriver();
      await fast.init();
      await runWithLockObserver(hostile, async () => {
        const conn = await fast.acquireConnection();
        await assert.rejects(fast.beginTransaction(conn, {}), (error: unknown) => {
          const code = (error as { errcode?: number }).errcode ?? 0;
          assert.equal(code & 0xff, 5, "SQLITE_BUSY");
          return true;
        });
        await fast.releaseConnection(conn);
      });
    } finally {
      holder.exec("ROLLBACK");
    }
    assert.equal(authDb.isTransaction, false);
    assert.equal(await gateIsFree(), true);
  } finally {
    authDb.close();
  }
});

test("observers whose property lookup throws (getter, Proxy) cannot change an outcome, leave a transaction begun, or hold the gate", async () => {
  const getters: LockObserver = {
    get acquire(): never {
      throw new Error("getter acquire");
    },
    get hold(): never {
      throw new Error("getter hold");
    },
  };
  const proxy = new Proxy({}, {
    get() {
      throw new Error("proxy get");
    },
  }) as LockObserver;
  for (const observer of [getters, proxy]) {
    const before = rows();
    const value = await runWithLockObserver(observer, () =>
      runWriteTransaction((db) => {
        insert("lookup-ok")(db);
        return "kept";
      }),
    );
    assert.equal(value, "kept");
    assert.equal(rows(), before + 1, "the row was committed");
    assert.equal(getDatabase().isTransaction, false);
    assert.equal(await gateIsFree(), true, "the gate was released");

    await assert.rejects(
      runWithLockObserver(observer, () =>
        runWriteTransaction((db) => {
          insert("lookup-rb")(db);
          throw new Error("the real failure");
        }),
      ),
      /the real failure/,
    );
    assert.equal(rows(), before + 1, "the failing body was rolled back");
    assert.equal(getDatabase().isTransaction, false);
    assert.equal(await gateIsFree(), true);
  }
});

test("a mutating observer cannot alter the metrics attached to a refusal", async () => {
  const mutating: LockObserver = {
    acquire(event) {
      try {
        const e = event as unknown as Record<string, unknown>;
        e.budgetMs = 1;
        e.attempts = -5;
      } catch {
        // A frozen copy refuses the write; either way the original is safe.
      }
    },
  };
  holder.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(
      runWithLockObserver(mutating, () =>
        runWriteTransaction(insert("mutating"), { acquireTimeoutMs: 200 }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof WriteContentionError);
        assert.equal(error.acquire?.budgetMs, 200);
        assert.ok((error.acquire?.attempts ?? 0) >= 1);
        return true;
      },
    );
  } finally {
    holder.exec("ROLLBACK");
  }
});

test("REAL child, strict about unhandled rejections: throwing getters, a throwing Proxy, rejecting async observers and hostile thenables change no outcome, row or gate, and raise no unhandled rejection", async () => {
  const childDir = path.join(process.cwd(), ".data", "tests", randomUUID());
  mkdirSync(childDir, { recursive: true });
  const result = await runScript("tests/helpers/observerChild.ts", [], {
    STYLE_DATA_DIR: childDir,
  });
  assert.equal(result.code, 0, result.stderr.slice(0, 2000));
  assert.ok(
    !/UnhandledPromiseRejection|unhandled/i.test(result.stderr),
    "no unhandled rejection was reported on stderr",
  );
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
    failures: string[];
    unhandled: number;
    observers: number;
  };
  assert.deepEqual(report.failures, []);
  assert.equal(report.unhandled, 0, "no unhandledRejection / uncaughtException event");
  assert.equal(report.observers, 6);
});

test("the diagnostics add no cost without an observer: no events are produced and the result is unchanged", async () => {
  const before = rows();
  const value = await runWriteTransaction((db) => {
    insert("plain")(db);
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(rows(), before + 1);
});
