import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { forkHelper } from "./helpers/processes";

/**
 * Build 034: concurrent processes and the mechanism itself.
 *
 * 1. Three REAL processes (their own connections) create, delete and clean up
 *    accounts against one app.db at the same time. Every deletion must bump the
 *    cleanup counter exactly once (the trigger runs in the deleting statement),
 *    no run may report an unexpected failure, and after one final cleanup no
 *    marker is left in app.db or app.db-wal.
 * 2. Negative control: with secure_delete OFF the same checkpoint-and-truncate
 *    leaves the deleted bytes in the freed pages of app.db. This is why the
 *    pragma is verified on every connection and not just assumed.
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dataDir, { recursive: true });
const CHILDREN = 3;
const ROUNDS = 4;

test("three concurrent processes: counters are exact, nothing fails unexpectedly, no marker survives the final cleanup", async () => {
  const env = {
    STYLE_DATA_DIR: dataDir,
    APP_URL: "http://127.0.0.1:3000",
    STYLE_PUBLIC_DEPLOYMENT: "",
    SMTP_URL: "",
    CHILD_ROUNDS: String(ROUNDS),
  };
  const children = Array.from({ length: CHILDREN }, (_, i) =>
    forkHelper("tests/helpers/cleanupChild034.ts", { ...env, CHILD_TAG: `c${i}` }),
  );
  const codes = await Promise.all(children.map((c) => c.exited));
  assert.deepEqual(codes, [0, 0, 0], children.map((c) => c.stderr()).join("\n"));
  for (const child of children) {
    const result = JSON.parse(child.stdout().trim().split("\n").at(-1)!) as { outcomes: string[] };
    assert.equal(result.outcomes.length, ROUNDS);
    for (const outcome of result.outcomes)
      assert.ok(["clean", "busy"].includes(outcome), `bounded outcome, got ${outcome}`);
  }

  // The parent plays the supervising worker: one more bounded cleanup.
  process.env.STYLE_DATA_DIR = dataDir;
  process.env.APP_URL = "http://127.0.0.1:3000";
  delete process.env.STYLE_PUBLIC_DEPLOYMENT;
  const { getReadyAuth } = await import("../src/server/auth");
  await getReadyAuth();
  const database = await import("../src/server/database");
  const cleanup = await import("../src/server/physicalCleanup");
  try {
    assert.equal(await cleanup.runPhysicalCleanup({ budgetMs: 10_000 }), "clean");
    const status = cleanup.readCleanupStatus(database.getDatabase());
    assert.equal(status.requested, CHILDREN * ROUNDS, "exactly one bump per committed deletion");
    assert.equal(status.completed, status.requested);
    assert.equal(status.pending, false);
    assert.equal(
      (database.getDatabase().prepare("SELECT COUNT(*) AS n FROM account_deletions").get() as { n: number }).n,
      CHILDREN * ROUNDS,
      "every deletion is also in the ledger",
    );
    assert.equal(
      (database.getDatabase().prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
    const db = readFileSync(path.join(dataDir, "app.db"));
    const walFile = path.join(dataDir, "app.db-wal");
    const wal = existsSync(walFile) ? readFileSync(walFile) : Buffer.alloc(0);
    for (let c = 0; c < CHILDREN; c++)
      for (let r = 0; r < ROUNDS; r++) {
        const marker = `MARK-c${c}-${r}-`;
        assert.equal(db.includes(marker), false, `${marker} absent from app.db`);
        assert.equal(wal.includes(marker), false, `${marker} absent from app.db-wal`);
      }
  } finally {
    database.closeDatabases();
  }
});

test("negative control: without secure_delete a truncating checkpoint still leaves the deleted bytes in app.db; with it they are gone", () => {
  const outcome = (secure: boolean): boolean => {
    const dir = path.join(dataDir, `control-${secure}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "app.db");
    const marker = `CONTROL-${secure}-${randomUUID()}`;
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      db.exec(`PRAGMA secure_delete=${secure ? "ON" : "OFF"}`);
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, data BLOB)");
      db.prepare("INSERT INTO t(data) VALUES(?)").run(Buffer.concat([Buffer.from(marker), randomBytes(30_000)]));
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("DELETE FROM t");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const walFile = file + "-wal";
      const wal = existsSync(walFile) ? readFileSync(walFile) : Buffer.alloc(0);
      return readFileSync(file).includes(marker) || wal.includes(marker);
    } finally {
      db.close();
    }
  };
  assert.equal(outcome(false), true, "control: the residue is real when secure_delete is off");
  assert.equal(outcome(true), false, "secure_delete plus the truncating checkpoint removes it");
});

test("the operator command: strict arguments, no mail or launch configuration needed, explicit refusals, exit codes 0/3, and --run finishes what is owed without printing user data", async () => {
  const { runScript } = await import("./helpers/processes");
  const { parseArgs } = await import("../scripts/cleanup-deleted-data");
  const script = "scripts/cleanup-deleted-data.ts";
  const base = { APP_URL: "http://127.0.0.1:3000", STYLE_PUBLIC_DEPLOYMENT: "", SMTP_URL: "" };

  // Argument parsing (pure).
  assert.deepEqual(parseArgs([]), { run: false, force: false, budgetMs: 30_000 });
  assert.deepEqual(parseArgs(["--run", "--force", "--budget-ms=250"]), { run: true, force: true, budgetMs: 250 });
  for (const bad of [
    ["--force"],
    ["--budget-ms=500"],
    ["--run", "--budget-ms=abc"],
    ["--run", "--budget-ms=1e3"],
    ["--run", "--budget-ms=-5"],
    ["--run", "--budget-ms="],
    ["--run", "--budget-ms=99"],
    ["--run", "--budget-ms=300001"],
    ["--run", "--budget-ms=100", "--budget-ms=200"],
    ["--bogus"],
    ["run"],
  ])
    assert.ok("error" in parseArgs(bad), `refused: ${bad.join(" ")}`);

  // Refused before any database work: exit 2, fixed text, nothing created.
  const refusedDir = path.join(dataDir, "cli-refused");
  mkdirSync(refusedDir, { recursive: true });
  for (const args of [["--force"], ["--run", "--budget-ms=abc"], ["--run", "--budget-ms=50"], ["--nope"]]) {
    const r = await runScript(script, args, { ...base, STYLE_DATA_DIR: refusedDir });
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, /^CLEANUP_BAD_ARGS: /);
    assert.equal(r.stdout, "");
  }
  assert.equal(existsSync(path.join(refusedDir, "app.db")), false, "a refused command never creates a database");

  // No database / not migrated: explicit, exit 1, and nothing is created or migrated.
  const none = await runScript(script, [], { ...base, STYLE_DATA_DIR: refusedDir });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /^CLEANUP_NO_DATABASE:/);
  assert.equal(existsSync(path.join(refusedDir, "app.db")), false);
  const bare = path.join(dataDir, "cli-bare");
  mkdirSync(bare, { recursive: true });
  new DatabaseSync(path.join(bare, "app.db")).close();
  const unmigrated = await runScript(script, [], { ...base, STYLE_DATA_DIR: bare });
  assert.equal(unmigrated.code, 1);
  assert.match(unmigrated.stderr, /^CLEANUP_NOT_MIGRATED:/);

  // A migrated database (the app/worker applies the schema; init-auth stands in for it).
  const dir = path.join(dataDir, "cli");
  mkdirSync(dir, { recursive: true });
  const env = { ...base, STYLE_DATA_DIR: dir };
  const init = await runScript("scripts/init-auth.ts", [], env);
  assert.equal(init.code, 0, init.stderr);

  // Status mode must not need mail or launch information: run it as a PUBLIC deployment with neither configured.
  const publicEnv = { STYLE_DATA_DIR: dir, STYLE_PUBLIC_DEPLOYMENT: "true", APP_URL: "https://example.test", SMTP_URL: "" };
  const first = await runScript(script, [], publicEnv);
  assert.equal(first.code, 0, first.stderr);
  const clean = JSON.parse(first.stdout.trim().split("\n").at(-1)!);
  assert.equal(clean.secureDelete, true);
  assert.equal(clean.owed, 0);
  assert.equal(clean.legacyDeletions, 0);

  const db = new DatabaseSync(path.join(dir, "app.db"), { timeout: 5000 });
  const secret = "cli-secret-person@example.test";
  const now = new Date().toISOString();
  db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('cli-user','x',?,0,?,?)").run(secret, now, now);
  db.prepare("DELETE FROM user WHERE id='cli-user'").run();
  db.close();

  const owed = await runScript(script, [], publicEnv);
  assert.equal(owed.code, 3, "still owed is a non-zero exit code");
  assert.equal(JSON.parse(owed.stdout.trim().split("\n").at(-1)!).owed, 1);

  const ran = await runScript(script, ["--run", "--budget-ms=20000"], publicEnv);
  assert.equal(ran.code, 0, ran.stderr);
  const done = JSON.parse(ran.stdout.trim().split("\n").at(-1)!);
  assert.equal(done.outcome, "clean");
  assert.equal(done.owed, 0);
  const forced = await runScript(script, ["--run", "--force", "--budget-ms=20000"], publicEnv);
  assert.equal(forced.code, 0, forced.stderr);
  assert.ok(
    !(ran.stdout + ran.stderr + owed.stdout + owed.stderr + forced.stdout).includes(secret),
    "no user data printed",
  );
});
