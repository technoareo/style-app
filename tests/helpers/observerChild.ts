/**
 * Child process for tests/lockDiagnostics.test.ts. Not for manual use.
 *
 * Runs REAL write transactions and REAL auth-dialect transactions against a
 * real SQLite file with hostile lock observers installed (throwing property
 * getters, a throwing Proxy, async observers that reject, thenables that throw
 * or return rejecting promises, observers that mutate the event), and checks
 * that every result, thrown error, committed or rolled-back row and the write
 * gate are exactly what they would be without an observer.
 *
 * It is a separate process so that an unhandled rejection is a real, observable
 * failure here: any `unhandledRejection` or `uncaughtException` is counted, and
 * Node's own default for an unhandled rejection (exit with an error) also
 * applies. Prints one JSON line: { failures, unhandled, observers }.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDatabase } from "../../src/server/database";
import {
  runWithLockObserver,
  type LockObserver,
} from "../../src/server/lockDiagnostics";
import {
  runWriteTransaction,
  WriteContentionError,
} from "../../src/server/writeTransaction";
import { acquireWriteGate, WriteGateError } from "../../src/server/writeGate";
import { createImmediateSqliteDialect } from "../../src/server/authDialect";

let unhandled = 0;
process.on("unhandledRejection", () => {
  unhandled++;
});
process.on("uncaughtException", () => {
  unhandled++;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const q = (sql: string, ...parameters: unknown[]) =>
  ({ sql, parameters, query: {} }) as never;

const dir = process.env.STYLE_DATA_DIR!;
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "app.db");
const holder = new DatabaseSync(file, { timeout: 1 });
holder.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT);",
);

const failures: string[] = [];
function expect(condition: boolean, label: string): void {
  if (!condition) failures.push(label);
}

const count = (v: string) =>
  (getDatabase().prepare("SELECT COUNT(*) AS n FROM t WHERE v=?").get(v) as { n: number }).n;

async function gateIsFree(): Promise<boolean> {
  return Promise.race([
    acquireWriteGate().then((release) => (release(), true)),
    sleep(500).then(() => false),
  ]);
}

const observers: Record<string, LockObserver> = {
  "throwing getters": {
    get acquire(): never {
      throw new Error("getter acquire");
    },
    get hold(): never {
      throw new Error("getter hold");
    },
  },
  "throwing proxy": new Proxy(
    {},
    {
      get() {
        throw new Error("proxy get");
      },
    },
  ) as LockObserver,
  "async rejecting": {
    acquire: async () => {
      throw new Error("async acquire");
    },
    hold: () => Promise.reject(new Error("async hold")),
  },
  "hostile thenables": {
    acquire: () =>
      ({
        then() {
          throw new Error("then throws");
        },
      }) as unknown as void,
    hold: () =>
      ({
        get then(): never {
          throw new Error("then getter throws");
        },
      }) as unknown as void,
  },
  "thenable returning a rejection": {
    acquire: () =>
      ({
        then() {
          return Promise.reject(new Error("derived rejection"));
        },
      }) as unknown as void,
    hold: () =>
      ({
        then(_resolve: unknown, reject: (e: Error) => void) {
          reject(new Error("rejecting thenable"));
        },
      }) as unknown as void,
  },
  "event mutation": {
    acquire(event) {
      const e = event as unknown as Record<string, unknown>;
      e.budgetMs = 1;
      e.attempts = -5;
      e.gateMs = 99999;
      e.ok = !e.ok;
    },
    hold(event) {
      (event as unknown as Record<string, unknown>).holdMs = -1;
    },
  },
};

async function exercise(name: string, observer: LockObserver): Promise<void> {
  const label = (what: string) => `${name}: ${what}`;
  const run = <T>(fn: (db: DatabaseSync) => T, budget?: number) =>
    runWithLockObserver(observer, () =>
      runWriteTransaction(fn, budget === undefined ? {} : { acquireTimeoutMs: budget }),
    );

  // 1. success: value returned, row committed.
  try {
    const value = await run((db) => {
      db.prepare("INSERT INTO t(v) VALUES (?)").run(`${name}-ok`);
      return "value";
    });
    expect(value === "value", label("success value"));
  } catch {
    expect(false, label("success did not throw"));
  }
  expect(count(`${name}-ok`) === 1, label("success row committed"));

  // 2. body failure: the body's error surfaces, the row is rolled back.
  try {
    await run((db) => {
      db.prepare("INSERT INTO t(v) VALUES (?)").run(`${name}-rb`);
      throw new Error("real failure");
    });
    expect(false, label("body error surfaced"));
  } catch (error) {
    expect(
      error instanceof Error && error.message === "real failure",
      label("the thrown error is the real one"),
    );
  }
  expect(count(`${name}-rb`) === 0, label("body failure rolled back"));
  expect(getDatabase().isTransaction === false, label("no open transaction after body failure"));
  expect(await gateIsFree(), label("gate free after body failure"));

  // 3. refused lock: the contention error with its untouched numbers; body never runs.
  let bodyRuns = 0;
  holder.exec("BEGIN IMMEDIATE");
  try {
    await run(() => {
      bodyRuns++;
    }, 150);
    expect(false, label("refusal surfaced"));
  } catch (error) {
    expect(error instanceof WriteContentionError, label("refusal is WriteContentionError"));
    const detail = (error as WriteContentionError).acquire;
    expect(
      !!detail &&
        detail.budgetMs === 150 &&
        detail.attempts >= 1 &&
        detail.gateMs >= 0 &&
        detail.gateMs < 150,
      label("diagnostic detail not altered by the observer"),
    );
  } finally {
    holder.exec("ROLLBACK");
  }
  expect(bodyRuns === 0, label("refused body never ran"));
  expect(await gateIsFree(), label("gate free after refusal"));

  // 4. refused gate: WriteGateError surfaces.
  const release = await acquireWriteGate();
  try {
    await run(() => {
      bodyRuns++;
    }, 60);
    expect(false, label("gate refusal surfaced"));
  } catch (error) {
    expect(error instanceof WriteGateError, label("gate refusal is WriteGateError"));
  } finally {
    release();
  }
  expect(bodyRuns === 0, label("gate-refused body never ran"));
  expect(await gateIsFree(), label("gate free after gate refusal"));

  // 5. auth dialect: begin, commit, rollback and a refused begin.
  const authDb = new DatabaseSync(file, { timeout: 1 });
  try {
    const driver = createImmediateSqliteDialect(authDb, {
      acquireTimeoutMs: 1000,
      baseDelayMs: 10,
    }).createDriver();
    await driver.init();
    await runWithLockObserver(observer, async () => {
      let conn = await driver.acquireConnection();
      await driver.beginTransaction(conn, {});
      await conn.executeQuery(q("insert into t(v) values (?)", `${name}-auth`));
      await driver.commitTransaction(conn);
      await driver.releaseConnection(conn);
      conn = await driver.acquireConnection();
      await driver.beginTransaction(conn, {});
      await conn.executeQuery(q("insert into t(v) values (?)", `${name}-auth-rb`));
      await driver.rollbackTransaction(conn);
      await driver.releaseConnection(conn);
    });
    expect(count(`${name}-auth`) === 1, label("auth commit kept"));
    expect(count(`${name}-auth-rb`) === 0, label("auth rollback discarded"));
    expect(authDb.isTransaction === false, label("auth connection not in a transaction"));
    expect(await gateIsFree(), label("gate free after auth transactions"));

    holder.exec("BEGIN IMMEDIATE");
    try {
      const fast = createImmediateSqliteDialect(authDb, {
        acquireTimeoutMs: 120,
        baseDelayMs: 10,
      }).createDriver();
      await fast.init();
      await runWithLockObserver(observer, async () => {
        const conn = await fast.acquireConnection();
        try {
          await fast.beginTransaction(conn, {});
          expect(false, label("auth refusal surfaced"));
        } catch (error) {
          const e = error as { errcode?: number; acquire?: { gateMs?: number; sqliteMs?: number } };
          expect(((e.errcode ?? 0) & 0xff) === 5, label("auth refusal is SQLITE_BUSY"));
          expect(
            typeof e.acquire?.gateMs === "number" && typeof e.acquire?.sqliteMs === "number",
            label("auth refusal keeps its original gateMs and sqliteMs fields"),
          );
        }
        await fast.releaseConnection(conn);
      });
    } finally {
      holder.exec("ROLLBACK");
    }
    expect(authDb.isTransaction === false, label("no half-open auth transaction"));
    expect(await gateIsFree(), label("gate free after auth refusal"));
  } finally {
    authDb.close();
  }
}

(async () => {
  for (const [name, observer] of Object.entries(observers))
    await exercise(name, observer);
  // Give any stray rejection every chance to surface before judging.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  await sleep(200);
  console.log(
    JSON.stringify({ failures, unhandled, observers: Object.keys(observers).length }),
  );
  holder.close();
  process.exit(0);
})().catch((error) => {
  console.log(
    JSON.stringify({
      failures: [...failures, `harness error: ${error instanceof Error ? error.message : "unknown"}`],
      unhandled,
      observers: 0,
    }),
  );
  process.exit(0);
});
