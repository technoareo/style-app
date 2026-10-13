import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { makeTempDir, removeTempDir } from "./helpers/tempDir";
import { waitForMail } from "./helpers/mailCapture";
import { createCallTimer, createLockRecorder } from "./helpers/lockRecorder";
import { runWithLockObserver } from "../src/server/lockDiagnostics";

const PREFIX = "style-conc-";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = (e: unknown) =>
  ((e as { errcode?: number }).errcode! & 0xff) === 5;
const open = (file: string, timeout: number) =>
  new DatabaseSync(file, { timeout });
// Only .sql/.parameters are read by the dialect's connection.
const q = (sql: string, ...parameters: unknown[]) =>
  ({ sql, parameters, query: {} }) as never;

test("deferred BEGIN fails read-to-write upgrade at once; BEGIN IMMEDIATE does not", () => {
  const dir = makeTempDir(PREFIX);
  try {
    const file = path.join(dir, "t.db");
    const setup = open(file, 5000);
    setup.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER); INSERT INTO t VALUES(1,0);",
    );
    // The stock adapter's behavior: deferred BEGIN, read, another connection
    // commits, then the first writes. A generous busy_timeout must not help,
    // and the failure must be immediate.
    const a = open(file, 5000);
    const b = open(file, 5000);
    a.exec("BEGIN");
    a.prepare("SELECT v FROM t").get();
    b.exec("UPDATE t SET v=v+1");
    const started = Date.now();
    assert.throws(() => a.exec("UPDATE t SET v=v+10"), busy);
    assert.ok(
      Date.now() - started < 1000,
      "snapshot upgrade fails immediately",
    );
    a.exec("ROLLBACK");
    a.exec("BEGIN IMMEDIATE");
    a.prepare("SELECT v FROM t").get();
    a.exec("UPDATE t SET v=v+10");
    a.exec("COMMIT");
    assert.equal((b.prepare("SELECT v FROM t").get() as { v: number }).v, 11);
    for (const db of [setup, a, b]) db.close();
  } finally {
    removeTempDir(dir, PREFIX);
  }
});

test("auth dialect: eager IMMEDIATE transaction, async bounded lock acquisition, gate released on every exit", async () => {
  const { createImmediateSqliteDialect } =
    await import("../src/server/authDialect");
  const { acquireWriteGate } = await import("../src/server/writeGate");
  const gateFree = async () =>
    Promise.race([
      acquireWriteGate().then((release) => (release(), true)),
      sleep(500).then(() => false),
    ]);
  const dir = makeTempDir(PREFIX);
  const file = path.join(dir, "t.db");
  const setup = open(file, 5000);
  setup.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER);");
  const authDb = open(file, 1);
  const holder = open(file, 1);
  const count = () =>
    (setup.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
  try {
    const driver = createImmediateSqliteDialect(authDb, {
      acquireTimeoutMs: 200,
      baseDelayMs: 10,
    }).createDriver();
    await driver.init();

    // Eager: the write lock and the gate are taken at beginTransaction,
    // before the body's first read, and held until commit.
    let conn = await driver.acquireConnection();
    await driver.beginTransaction(conn, {});
    assert.equal(authDb.isTransaction, true);
    assert.throws(() => holder.exec("BEGIN IMMEDIATE"), busy);
    assert.equal(await gateFree(), false, "gate held until commit");
    await conn.executeQuery(q("select count(*) as n from t"));
    await conn.executeQuery(q("insert into t(id) values (?)", 1));
    await conn.executeQuery(q("insert into t(id) values (?)", 2));
    await driver.commitTransaction(conn);
    await driver.releaseConnection(conn);
    assert.equal(count(), 2);
    assert.equal(authDb.isTransaction, false);
    assert.equal(await gateFree(), true);

    // Rollback discards every write and frees the gate.
    conn = await driver.acquireConnection();
    await driver.beginTransaction(conn, {});
    await conn.executeQuery(q("insert into t(id) values (?)", 3));
    await driver.rollbackTransaction(conn);
    await driver.releaseConnection(conn);
    assert.equal(count(), 2);
    assert.equal(await gateFree(), true);

    // Bounded: a lock that never clears fails after acquireTimeoutMs, with
    // no half-open transaction, and the gate is released.
    holder.exec("BEGIN IMMEDIATE");
    conn = await driver.acquireConnection();
    const started = Date.now();
    await assert.rejects(driver.beginTransaction(conn, {}), busy);
    assert.ok(Date.now() - started < 3000, "wait is bounded");
    assert.equal(authDb.isTransaction, false, "no half-open transaction");
    assert.equal(await gateFree(), true, "gate released after a failed begin");
    await driver.releaseConnection(conn);

    // Async retry: the lock clears while we wait and the event loop stays
    // free (timers keep firing) during the wait.
    const patient = createImmediateSqliteDialect(authDb, {
      acquireTimeoutMs: 3000,
      baseDelayMs: 10,
    }).createDriver();
    await patient.init();
    setTimeout(() => holder.exec("COMMIT"), 120);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    conn = await patient.acquireConnection();
    await patient.beginTransaction(conn, {});
    clearInterval(timer);
    await conn.executeQuery(q("insert into t(id) values (5)"));
    assert.ok(
      ticks >= 3,
      `event loop stayed free while waiting (${ticks} ticks)`,
    );
    await patient.commitTransaction(conn);
    await patient.releaseConnection(conn);
    assert.equal(count(), 3);
  } finally {
    for (const db of [setup, authDb, holder]) if (db.isOpen) db.close();
    removeTempDir(dir, PREFIX);
  }
});

test("a gated synchronous writer waits for an async auth transaction instead of blocking the event loop", async () => {
  const { createImmediateSqliteDialect } =
    await import("../src/server/authDialect");
  const { withWriteGate } = await import("../src/server/writeGate");
  const dir = makeTempDir(PREFIX);
  const file = path.join(dir, "t.db");
  const setup = open(file, 5000);
  setup.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER);");
  const authDb = open(file, 100);
  // A 5 s native busy wait: without the gate, the synchronous BEGIN below
  // would park the event loop here while the auth transaction (which needs
  // the loop to finish) holds the lock, and then fail.
  const main = open(file, 5000);
  try {
    const driver = createImmediateSqliteDialect(authDb).createDriver();
    await driver.init();
    const conn = await driver.acquireConnection();
    await driver.beginTransaction(conn, {});
    await conn.executeQuery(q("insert into t(id) values (1)"));
    // Delayed async transaction: hold the lock across real macrotasks.
    let ran = false;
    const writer = withWriteGate(() => {
      main.exec("BEGIN IMMEDIATE");
      main.exec("INSERT INTO t VALUES (2)");
      main.exec("COMMIT");
      ran = true;
    });
    await sleep(150); // auth transaction stays open across real macrotasks
    assert.equal(ran, false, "writer is queued behind the auth transaction");
    const t0 = Date.now();
    await driver.commitTransaction(conn);
    await driver.releaseConnection(conn);
    await writer;
    assert.equal(ran, true);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(
      (setup.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n,
      2,
    );
  } finally {
    for (const db of [setup, authDb, main]) if (db.isOpen) db.close();
    removeTempDir(dir, PREFIX);
  }
});

test("read-then-write atomicity: two delayed async consumers of one token cannot both succeed", async () => {
  const { createImmediateSqliteDialect } =
    await import("../src/server/authDialect");
  const dir = makeTempDir(PREFIX);
  const file = path.join(dir, "t.db");
  const setup = open(file, 5000);
  setup.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE token(id TEXT PRIMARY KEY); CREATE TABLE consumed(by TEXT); INSERT INTO token VALUES('tok');",
  );
  // Two connections, as if two requests/processes validated the same
  // reset or verification token at once.
  const dbs = [open(file, 20), open(file, 20)];
  try {
    const consume = async (db: DatabaseSync, name: string) => {
      const driver = createImmediateSqliteDialect(db).createDriver();
      await driver.init();
      const conn = await driver.acquireConnection();
      try {
        await driver.beginTransaction(conn, {});
        const found = await conn.executeQuery<{ id: string }>(
          q("select id from token where id=?", "tok"),
        );
        await sleep(60); // the window where a deferred BEGIN would let both read it
        if (!found.rows.length) {
          await driver.commitTransaction(conn);
          return false;
        }
        await conn.executeQuery(q("delete from token where id=?", "tok"));
        await conn.executeQuery(q("insert into consumed(by) values (?)", name));
        await driver.commitTransaction(conn);
        return true;
      } catch (error) {
        await driver.rollbackTransaction(conn);
        throw error;
      } finally {
        await driver.releaseConnection(conn);
      }
    };
    const results = await Promise.all([
      consume(dbs[0], "first"),
      consume(dbs[1], "second"),
    ]);
    assert.equal(
      results.filter(Boolean).length,
      1,
      "exactly one consumer wins",
    );
    assert.equal(
      (
        setup.prepare("SELECT COUNT(*) AS n FROM consumed").get() as {
          n: number;
        }
      ).n,
      1,
    );
  } finally {
    for (const db of [setup, ...dbs]) if (db.isOpen) db.close();
    removeTempDir(dir, PREFIX);
  }
});

test("write gate waits are bounded: timed-out waiters are removed and the queue is capped", async () => {
  const gate = await import("../src/server/writeGate");
  const free = async () =>
    Promise.race([
      gate.acquireWriteGate().then((release) => (release(), true)),
      sleep(500).then(() => false),
    ]);
  const hold = await gate.acquireWriteGate();
  await assert.rejects(
    gate.acquireWriteGate(50),
    (e) => e instanceof gate.WriteGateError,
  );
  assert.equal(gate.writeGateQueueLength(), 0, "timed-out waiter was removed");

  const waiting = Array.from({ length: gate.WRITE_GATE_MAX_QUEUE }, () =>
    gate.acquireWriteGate(30_000).then((release) => release()),
  );
  assert.equal(gate.writeGateQueueLength(), gate.WRITE_GATE_MAX_QUEUE);
  await assert.rejects(
    gate.acquireWriteGate(30_000),
    (e) => e instanceof gate.WriteGateError,
    "queue length is capped",
  );
  hold();
  await Promise.all(waiting);
  assert.equal(gate.writeGateQueueLength(), 0);
  assert.equal(await free(), true, "no stale grant left behind");
});

type ChildReport = {
  role: string;
  ok: number;
  failures: string[];
  code: number | null;
  /** Build 011 evidence: phases, call timings, lock diagnostics (see the child). */
  timing?: unknown;
};

function runChild(
  role: "register" | "write" | "worker" | "crash-delete",
  arg: string | number,
  dataDir: string,
  startAt: number,
): Promise<ChildReport> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/concurrency-child.ts", role, String(arg)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STYLE_DATA_DIR: dataDir,
          CONCURRENCY_START_AT: String(startAt),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      let parsed: Partial<ChildReport> = {};
      try {
        parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
      } catch {
        parsed = { failures: [`unparseable output: ${out} ${err}`] };
      }
      resolve({
        role,
        ok: parsed.ok ?? 0,
        failures: parsed.failures ?? [],
        code,
        timing: parsed.timing,
      });
    });
  });
}

// One private integration database for every scenario in this file that uses
// the app's server singletons (cached auth instance + database connections).
// STYLE_DATA_DIR is set exactly once, before the first import of those
// modules, and never switched while their connections are live. The
// connections are closed only in the `after` hook below.
let sharedDataDir: string | undefined;
function newDataDir(): string {
  if (sharedDataDir) return sharedDataDir;
  sharedDataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
  process.env.STYLE_DATA_DIR = sharedDataDir;
  process.env.APP_URL = "http://127.0.0.1:3000";
  mkdirSync(sharedDataDir, { recursive: true });
  return sharedDataDir;
}

after(async () => {
  if (!sharedDataDir) return;
  const { closeDatabases } = await import("../src/server/database");
  closeDatabases();
});

test("deleting a user writes the tombstone atomically: rollback and a crash before commit leave neither", async () => {
  const dataDir = newDataDir();
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const auth = await getReadyAuth();
  const mk = async (email: string) =>
    (
      await auth.api.signUpEmail({
        body: { email, name: "Ledger", password: "Test ledger passphrase 63!" },
      })
    ).user.id;
  const doomed = await mk("ledger-doomed@example.test");
  const bystander = await mk("ledger-bystander@example.test");
  const db = getDatabase();
  for (const id of [doomed, bystander])
    db.prepare(
      "INSERT INTO wardrobe_spaces(user_id,revision,data_json) VALUES(?,0,'{}')",
    ).run(id);
  const ledger = (id: string) =>
    db.prepare("SELECT user_id FROM account_deletions WHERE user_id=?").get(id);
  const user = (id: string) =>
    db.prepare("SELECT id FROM user WHERE id=?").get(id);
  try {
    // Rolled-back deletion: the trigger's ledger row rolls back with it.
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM user WHERE id=?").run(doomed);
    assert.ok(ledger(doomed), "ledger row is written by the delete itself");
    db.exec("ROLLBACK");
    assert.ok(user(doomed));
    assert.equal(ledger(doomed), undefined);

    // Crash boundary: another process deletes, then dies before COMMIT.
    const crashed = await runChild("crash-delete", doomed, dataDir, 0);
    assert.equal(crashed.code, 3);
    assert.ok(user(doomed), "uncommitted deletion did not survive the crash");
    assert.equal(ledger(doomed), undefined, "no tombstone without deletion");

    // Committed deletion: user, cascaded data and tombstone land together,
    // and the other account is untouched.
    db.prepare("DELETE FROM user WHERE id=?").run(doomed);
    assert.equal(user(doomed), undefined);
    assert.ok(ledger(doomed));
    assert.equal(
      db.prepare("SELECT 1 FROM wardrobe_spaces WHERE user_id=?").get(doomed),
      undefined,
    );
    assert.ok(user(bystander));
    assert.ok(
      db
        .prepare("SELECT 1 FROM wardrobe_spaces WHERE user_id=?")
        .get(bystander),
    );
    assert.equal(ledger(bystander), undefined);
  } finally {
    // Connections stay open for the next scenario; the `after` hook closes them.
  }
});

test("simultaneous HTTP auth, wardrobe routes, multi-process registrations, worker and direct writes never hit 'database is locked'", async () => {
  const testStartedAt = performance.now();
  const dataDir = newDataDir();
  const origin = process.env.APP_URL!;
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const { GET, PUT } = await import("../src/app/api/wardrobe/route");
  const auth = await getReadyAuth();
  const password = "Correct wardrobe passphrase 42!";

  // Capture is eventual since build 008: poll for the message.
  const mail = (email: string, subject = "Verify") =>
    waitForMail(dataDir, email, subject);
  async function verifiedUser(email: string) {
    const created = await auth.api.signUpEmail({
      body: { email, password, name: "Wearer " + email },
    });
    const url = new URL(
      (await mail(email)).text.split(": ").slice(1).join(": "),
    );
    await auth.api.verifyEmail({
      query: { token: url.searchParams.get("token")! },
    });
    const response = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { id: created.user.id, name: "Wearer " + email, cookie };
  }
  const users = [
    await verifiedUser("http-a@example.test"),
    await verifiedUser("http-b@example.test"),
    await verifiedUser("http-c@example.test"),
  ];
  // Accounts for the token-consumption and deletion races below.
  const resetter = await verifiedUser("http-reset@example.test");
  const deleter = await verifiedUser("http-delete@example.test");
  await auth.api.requestPasswordReset({
    body: { email: "http-reset@example.test", redirectTo: origin + "/reset" },
  });
  const resetUrl = new URL(
    (await mail("http-reset@example.test", "Reset")).text
      .split(": ")
      .slice(1)
      .join(": "),
  );
  const resetToken =
    resetUrl.searchParams.get("token") || resetUrl.pathname.split("/").at(-1)!;
  const outcomes = { reset: 0, deleted: 0 };
  const request = (u: (typeof users)[number], body?: unknown) =>
    new NextRequest(origin + "/api/wardrobe", {
      method: body ? "PUT" : "GET",
      headers: {
        origin,
        cookie: u.cookie,
        "content-type": "application/json",
        "x-style-account": u.id,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  const registrars = 3;
  const perRegistrar = 4;
  const writers = 3;
  const perWriter = 150;
  const startAt = Date.now() + 8000;
  // Phase 1 (setup) ends here: modules, verified users, the reset token.
  const setupEndedAt = performance.now();
  const recorder = createLockRecorder();
  const calls = {
    handlerSignUp: createCallTimer(),
    apiSignUp: createCallTimer(),
    wardrobeRequest: createCallTimer(),
  };
  const children = Promise.all([
    ...Array.from({ length: registrars }, () =>
      runChild("register", perRegistrar, dataDir, startAt),
    ),
    ...Array.from({ length: writers }, () =>
      runChild("write", perWriter, dataDir, startAt),
    ),
    runChild("worker", 60, dataDir, startAt),
  ]);

  // In-process traffic in this (the "app") process, released together with
  // the children: real HTTP-handler sign-ups (hashing inside Better Auth's
  // transaction), direct API sign-ups, and wardrobe GET/PUT routes whose
  // synchronous BEGIN IMMEDIATE transactions share the event loop with them.
  await sleep(Math.max(0, startAt - Date.now()));
  // Phase 2 (wait) ended at the release instant; phase 3 (stress) starts now.
  const stressStartedAt = performance.now();
  const statuses: number[] = [];
  const signUpViaHandler = async (i: number) => {
    const res = await calls.handlerSignUp.time(() =>
      auth.handler(
        new Request(origin + "/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            "x-forwarded-for": `10.0.0.${i + 1}`,
          },
          body: JSON.stringify({
            email: `inproc-h${i}@example.test`,
            name: "Handler " + i,
            password,
          }),
        }),
      ),
    );
    statuses.push(res.status);
  };
  const wardrobeChain = async (u: (typeof users)[number]) => {
    const timed = (run: () => Promise<Response>) =>
      calls.wardrobeRequest.time(run);
    statuses.push((await timed(() => GET(request(u)))).status);
    for (let revision = 0; revision < 3; revision++) {
      statuses.push(
        (
          await timed(() =>
            PUT(
              request(u, {
                version: 1,
                name: u.name,
                wardrobe: [],
                looks: [],
                revision,
              }),
            ),
          )
        ).status,
      );
      statuses.push((await timed(() => GET(request(u)))).status);
    }
  };
  // The observer sees only this process's lock calls made inside this async
  // chain (lockDiagnostics.ts); it records, it never alters.
  const inProcess = await runWithLockObserver(recorder.observer, () =>
    Promise.allSettled([
    ...Array.from({ length: 4 }, (_, i) => signUpViaHandler(i)),
    ...Array.from({ length: 4 }, (_, i) =>
      calls.apiSignUp.time(() =>
        auth.api.signUpEmail({
          body: {
            email: `inproc-a${i}@example.test`,
            name: "Api " + i,
            password,
          },
        }),
      ),
    ),
    ...users.map(wardrobeChain),
    // Concurrent consumers of one reset token: exactly one may succeed.
    (async () => {
      const r = await Promise.allSettled(
        [1, 2, 3].map(() =>
          auth.api.resetPassword({
            body: { token: resetToken, newPassword: "Another passphrase 77!!" },
          }),
        ),
      );
      outcomes.reset = r.filter((x) => x.status === "fulfilled").length;
    })(),
    // Concurrent self-service deletions of one account.
    (async () => {
      const r = await Promise.allSettled(
        [1, 2].map(() =>
          auth.api.deleteUser({
            headers: new Headers({ cookie: deleter.cookie }),
            body: { password },
          }),
        ),
      );
      outcomes.deleted = r.filter((x) => x.status === "fulfilled").length;
    })(),
  ]));
  const reports = await children;
  const stressEndedAt = performance.now();

  // Build 011 evidence collection: EVERY child report and EVERY invariant is
  // evaluated before anything is asserted, so one failing child cannot hide
  // the others or the data-integrity checks. Each check below is the same
  // assertion as before; nothing is relaxed, skipped or retried. The single
  // assertion at the end still fails the test if any check failed.
  const problems: string[] = [];
  const check = (label: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      problems.push(`${label}: ${text}`);
    }
  };

  inProcess.forEach((r, i) =>
    check(`in-process task ${i}`, () =>
      assert.equal(
        r.status,
        "fulfilled",
        String((r as PromiseRejectedResult).reason),
      ),
    ),
  );
  check("in-process statuses present", () => assert.ok(statuses.length > 0));
  check("in-process HTTP statuses", () =>
    assert.ok(
      statuses.every((s) => s === 200),
      `all HTTP responses succeeded: ${statuses.join(",")}`,
    ),
  );
  reports.forEach((r, i) => {
    check(`${r.role} child ${i} failures`, () =>
      assert.deepEqual(r.failures, [], `${r.role} child failures`),
    );
    check(`${r.role} child ${i} exit code`, () => assert.equal(r.code, 0));
  });

  check("data integrity", () => {
    const db = getDatabase();
    const count = (sql: string, ...p: string[]) =>
      (db.prepare(sql).get(...p) as { n: number }).n;
    const each: [string, () => void][] = [
      [
        "registrar accounts",
        () =>
          assert.equal(
            count("SELECT COUNT(*) AS n FROM user WHERE email LIKE 'conc-%'"),
            registrars * perRegistrar,
          ),
      ],
      [
        "in-process accounts",
        () =>
          assert.equal(
            count("SELECT COUNT(*) AS n FROM user WHERE email LIKE 'inproc-%'"),
            8,
          ),
      ],
      [
        "every user has a credential account",
        () =>
          assert.equal(
            count(
              "SELECT COUNT(*) AS n FROM user u WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.userId=u.id)",
            ),
            0,
            "every account creation committed user and credential together",
          ),
      ],
      [
        "no orphan accounts",
        () =>
          assert.equal(
            count(
              "SELECT COUNT(*) AS n FROM account a WHERE NOT EXISTS (SELECT 1 FROM user u WHERE u.id=a.userId)",
            ),
            0,
          ),
      ],
      [
        "all direct-writer rows present",
        () =>
          assert.equal(
            count(
              "SELECT COUNT(*) AS n FROM account_deletions WHERE user_id LIKE 'conc-writer-%'",
            ),
            writers * perWriter,
          ),
      ],
      [
        "reset token consumed exactly once",
        () =>
          assert.equal(
            outcomes.reset,
            1,
            "a reset token is consumed exactly once",
          ),
      ],
      [
        "self-service deletion succeeded",
        () =>
          assert.ok(outcomes.deleted >= 1, "self-service deletion succeeded"),
      ],
      [
        "deleted user is gone",
        () =>
          assert.equal(
            db.prepare("SELECT id FROM user WHERE id=?").get(deleter.id),
            undefined,
          ),
      ],
      [
        "deletion left exactly one tombstone",
        () =>
          assert.equal(
            count(
              "SELECT COUNT(*) AS n FROM account_deletions WHERE user_id=?",
              deleter.id,
            ),
            1,
            "deletion left exactly one tombstone",
          ),
      ],
      [
        "reset account still exists",
        () =>
          assert.ok(db.prepare("SELECT id FROM user WHERE id=?").get(resetter.id)),
      ],
      ...users.map((u, i): [string, () => void] => [
        `wardrobe revision and isolation, user ${i}`,
        () => {
          const row = db
            .prepare(
              "SELECT revision, data_json FROM wardrobe_spaces WHERE user_id=?",
            )
            .get(u.id) as { revision: number; data_json: string };
          assert.equal(row.revision, 3);
          assert.equal(
            JSON.parse(row.data_json).name,
            u.name,
            "account isolation",
          );
        },
      ]),
    ];
    // Evaluate all of them; report each failure by name.
    const failed: string[] = [];
    for (const [label, run] of each) {
      try {
        run();
      } catch (error) {
        failed.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    assert.deepEqual(failed, [], "data integrity invariants");
  });

  // Evidence: phases printed separately, then every report's timing.
  const report = {
    phasesMs: {
      setup: Math.round(setupEndedAt - testStartedAt),
      wait: Math.round(stressStartedAt - setupEndedAt),
      stress: Math.round(stressEndedAt - stressStartedAt),
    },
    parent: {
      calls: {
        handlerSignUp: calls.handlerSignUp.summary(),
        apiSignUp: calls.apiSignUp.summary(),
        wardrobeRequest: calls.wardrobeRequest.summary(),
      },
      locks: recorder.summary(),
    },
    children: reports.map((r) => ({
      role: r.role,
      ok: r.ok,
      failures: r.failures.length,
      code: r.code,
      timing: r.timing,
    })),
    problems: problems.length,
  };
  console.log("CONCURRENCY_TIMING " + JSON.stringify(report));
  const reportFile = process.env.CONCURRENCY_REPORT_FILE;
  if (reportFile) {
    try {
      writeFileSync(
        reportFile,
        JSON.stringify({
          ...report,
          problemList: problems.map((p) => p.slice(0, 1500)),
        }),
      );
    } catch {
      // Evidence is best effort; the assertion below is what decides.
    }
  }

  assert.deepEqual(problems, [], "concurrency stress: failed checks");
});
