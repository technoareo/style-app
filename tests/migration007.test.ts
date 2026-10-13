import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Build 006 -> 007 application migration. A database is created by the
 * current code, filled with a user, wardrobe, photo, queued job, completed job
 * and usage row, then rewound to the build 006 shape (the 007 columns and
 * tables removed). Fresh processes then run the real initializer (under the
 * shared migration lock, concurrently and repeatedly) and nothing may be lost.
 */

const directory = path.join(process.cwd(), ".data", "tests", randomUUID());
process.env.STYLE_DATA_DIR = directory;
process.env.APP_URL = "http://127.0.0.1:3000";
mkdirSync(directory, { recursive: true });

const init = () =>
  new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/init-auth.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STYLE_DATA_DIR: directory,
          STYLE_PUBLIC_DEPLOYMENT: "false",
          APP_URL: "http://127.0.0.1:3000",
        },
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
const tableExists = (db: DatabaseSync, name: string) =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );

test("build 006 databases migrate in place without losing users, wardrobes, photos, looks or queued jobs", async () => {
  const { getReadyAuth } = await import("../src/server/auth");
  const { closeDatabases, getDatabase } = await import("../src/server/database");
  const q = await import("../src/server/analysisJobs");
  const auth = await getReadyAuth();
  const make = async (label: string) =>
    (
      await auth.api.signUpEmail({
        body: {
          email: `${label}@example.test`,
          name: label,
          password: "Migration passphrase 55!",
        },
      })
    ).user.id;
  const alice = await make("mig-alice");
  const bob = await make("mig-bob");
  const db = getDatabase();
  const photo = Buffer.from("queued-photo-bytes");
  const queued = q.enqueueAnalysisJob(alice, photo);
  const wardrobe = JSON.stringify({
    version: 1,
    name: "Alice",
    wardrobe: [{ id: "tee" }],
    looks: [{ id: "look-1" }],
  });
  db.prepare(
    "INSERT INTO wardrobe_spaces(user_id,revision,data_json) VALUES(?,?,?)",
  ).run(alice, 3, wardrobe);
  db.prepare(
    "INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)",
  ).run("photo-1", alice, Buffer.from("saved-photo"), "abc", Date.now());
  db.prepare(
    "INSERT INTO analysis_jobs(id,user_id,status,result_json,created_at,expires_at,attempts) VALUES(?,?,'completed',?,?,?,1)",
  ).run(
    "completed-1",
    bob,
    '{"items":[],"warning":"","image":"data:image/jpeg;base64,AA=="}',
    Date.now(),
    Date.now() + 3_000_000,
  );
  db.prepare(
    "INSERT INTO usage_daily(user_id,day,count) VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET count=excluded.count",
  ).run(bob, new Date().toISOString().slice(0, 10), 4);
  closeDatabases();

  // Rewind to the build 006 shape.
  const old = new DatabaseSync(path.join(directory, "app.db"));
  old.exec(
    "DROP INDEX IF EXISTS analysis_jobs_user_status_idx;" +
      "ALTER TABLE analysis_jobs DROP COLUMN started_at;" +
      "ALTER TABLE analysis_jobs DROP COLUMN finished_at;" +
      "ALTER TABLE analysis_jobs DROP COLUMN refunded;" +
      "ALTER TABLE analysis_jobs DROP COLUMN failure_kind;" +
      "ALTER TABLE usage_daily DROP COLUMN attempts;" +
      "DROP TABLE analysis_timings;" +
      "DROP TABLE schema_migrations;",
  );
  assert.ok(!columns(old, "analysis_jobs").includes("refunded"));
  assert.ok(!columns(old, "usage_daily").includes("attempts"));
  assert.ok(!tableExists(old, "analysis_timings"));
  old.close();

  // Concurrent cold starts, then a repeat: idempotent under the lock.
  for (const batch of [[init(), init()], [init()]])
    for (const result of await Promise.all(batch))
      assert.equal(result.code, 0, result.output);

  const migrated = new DatabaseSync(path.join(directory, "app.db"));
  try {
    for (const column of ["started_at", "finished_at", "refunded", "failure_kind"])
      assert.ok(columns(migrated, "analysis_jobs").includes(column), column);
    assert.ok(columns(migrated, "usage_daily").includes("attempts"));
    assert.ok(tableExists(migrated, "analysis_timings"));
    assert.equal(
      (
        migrated
          .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id=?")
          .get("007-queue-metadata") as { n: number }
      ).n,
      1,
      "recorded exactly once",
    );
    assert.equal(
      (
        migrated
          .prepare("SELECT COUNT(*) AS n FROM user WHERE id IN (?,?)")
          .get(alice, bob) as { n: number }
      ).n,
      2,
    );
    const wardrobeRow = migrated
      .prepare("SELECT revision,data_json FROM wardrobe_spaces WHERE user_id=?")
      .get(alice) as { revision: number; data_json: string };
    assert.equal(wardrobeRow.revision, 3);
    assert.equal(wardrobeRow.data_json, wardrobe, "wardrobe and saved looks intact");
    assert.equal(
      Buffer.from(
        (
          migrated.prepare("SELECT data FROM photo_assets WHERE id='photo-1'").get() as {
            data: Uint8Array;
          }
        ).data,
      ).toString(),
      "saved-photo",
    );
    const queuedRow = migrated
      .prepare("SELECT status,input_image,refunded,started_at FROM analysis_jobs WHERE id=?")
      .get(queued.id) as {
      status: string;
      input_image: Uint8Array;
      refunded: number;
      started_at: number | null;
    };
    assert.equal(queuedRow.status, "queued");
    assert.equal(Buffer.from(queuedRow.input_image).toString(), "queued-photo-bytes");
    assert.equal(queuedRow.refunded, 0);
    assert.equal(queuedRow.started_at, null);
    assert.equal(
      (
        migrated
          .prepare("SELECT status FROM analysis_jobs WHERE id='completed-1'")
          .get() as { status: string }
      ).status,
      "completed",
    );
    const usage = migrated
      .prepare("SELECT count,attempts FROM usage_daily WHERE user_id=?")
      .get(bob) as { count: number; attempts: number };
    assert.deepEqual(
      { count: usage.count, attempts: usage.attempts },
      { count: 4, attempts: 4 },
      "already-spent allowance carries into the abuse counter",
    );
    assert.equal(
      (migrated.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
      "ok",
    );
  } finally {
    migrated.close();
  }

  // The new code reads the migrated queue: the old queued job resumes with a
  // position, and the old completed job is still readable by its owner only.
  const list = q.listJobsForOwner(alice);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "queued");
  assert.equal(list[0].position, 1);
  assert.equal(q.getAnalysisJobForOwner(bob, "completed-1").status, "completed");
  assert.throws(() => q.getAnalysisJobForOwner(alice, "completed-1"));
  closeDatabases();
});
