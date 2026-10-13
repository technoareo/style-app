import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Build 007 -> 008 migration (the account-mail outbox). A database is created
 * by the current code and filled with users, a wardrobe, a saved photo, a
 * queued analysis job, a real password-reset token and a session-less
 * account, then rewound to the build 007 shape (no mail tables, no 008
 * record). Fresh processes run the real initializer concurrently and
 * repeatedly; nothing may be lost and the new tables must appear exactly once.
 */

const directory = path.join(process.cwd(), ".data", "tests", randomUUID());
process.env.STYLE_DATA_DIR = directory;
process.env.APP_URL = "http://127.0.0.1:3000";
// A configured (but unreachable, never contacted) relay keeps the web-process
// local-capture drain off, so nothing touches the database while it is rewound.
process.env.SMTP_URL = "smtp://127.0.0.1:1";
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

const tableExists = (db: DatabaseSync, name: string) =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
const count = (db: DatabaseSync, sql: string, ...args: string[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

test("build 007 databases gain the mail outbox in place without losing users, tokens, wardrobes, photos or queued jobs", async () => {
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
          password: "Migration passphrase 88!",
        },
      })
    ).user.id;
  const alice = await make("mig8-alice");
  const bob = await make("mig8-bob");
  const db = getDatabase();
  // A real reset token (a row in Better Auth's own verification table).
  await auth.api.requestPasswordReset({
    body: { email: "mig8-alice@example.test", redirectTo: "http://127.0.0.1:3000/reset" },
  });
  const tokensBefore = count(db, "SELECT COUNT(*) AS n FROM verification");
  assert.ok(tokensBefore >= 1, "a reset token exists before migrating");
  const wardrobe = JSON.stringify({ version: 1, name: "Alice", wardrobe: [{ id: "tee" }], looks: [] });
  db.prepare("INSERT INTO wardrobe_spaces(user_id,revision,data_json) VALUES(?,?,?)").run(alice, 5, wardrobe);
  db.prepare("INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)").run(
    "mig8-photo",
    alice,
    Buffer.from("saved-photo-008"),
    "abc",
    Date.now(),
  );
  const queued = q.enqueueAnalysisJob(bob, Buffer.from("queued-photo-008"));
  closeDatabases();

  // Rewind to the build 007 shape.
  const old = new DatabaseSync(path.join(directory, "app.db"));
  old.exec(
    "DROP TABLE mail_outbox; DROP TABLE mail_worker_state; DELETE FROM schema_migrations WHERE id='008-mail-outbox';",
  );
  assert.ok(!tableExists(old, "mail_outbox"));
  old.close();

  // Concurrent cold starts, then a repeat: idempotent under the shared lock.
  for (const batch of [[init(), init(), init()], [init()]])
    for (const result of await Promise.all(batch))
      assert.equal(result.code, 0, result.output);

  const migrated = new DatabaseSync(path.join(directory, "app.db"));
  try {
    assert.ok(tableExists(migrated, "mail_outbox"));
    assert.ok(tableExists(migrated, "mail_worker_state"));
    assert.equal(
      count(migrated, "SELECT COUNT(*) AS n FROM schema_migrations WHERE id='008-mail-outbox'"),
      1,
      "recorded exactly once",
    );
    assert.equal(
      count(migrated, "SELECT COUNT(*) AS n FROM schema_migrations WHERE id='007-queue-metadata'"),
      1,
      "the earlier migration record is untouched",
    );
    assert.equal(count(migrated, "SELECT COUNT(*) AS n FROM mail_outbox"), 0);
    assert.equal(
      count(migrated, "SELECT COUNT(*) AS n FROM user WHERE id IN ('" + alice + "','" + bob + "')"),
      2,
    );
    assert.equal(
      count(migrated, "SELECT COUNT(*) AS n FROM verification"),
      tokensBefore,
      "reset tokens survive the migration",
    );
    const w = migrated
      .prepare("SELECT revision,data_json FROM wardrobe_spaces WHERE user_id=?")
      .get(alice) as { revision: number; data_json: string };
    assert.equal(w.revision, 5);
    assert.equal(w.data_json, wardrobe);
    assert.equal(
      Buffer.from(
        (migrated.prepare("SELECT data FROM photo_assets WHERE id='mig8-photo'").get() as { data: Uint8Array }).data,
      ).toString(),
      "saved-photo-008",
    );
    const job = migrated
      .prepare("SELECT status,input_image FROM analysis_jobs WHERE id=?")
      .get(queued.id) as { status: string; input_image: Uint8Array };
    assert.equal(job.status, "queued");
    assert.equal(Buffer.from(job.input_image).toString(), "queued-photo-008");

    // The new table enforces its own rules and cascades with the account.
    const insert = migrated.prepare(
      "INSERT INTO mail_outbox(id,user_id,kind,recipient_key,status,created_at,expires_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?)",
    );
    assert.throws(() => insert.run("m1", alice, "newsletter", "k", "queued", 1, 2, 1), "kind is restricted");
    assert.throws(() => insert.run("m2", alice, "verify-email", "k", "bogus", 1, 2, 1), "status is restricted");
    insert.run("m3", bob, "verify-email", "k", "queued", 1, 2, 1);
    migrated.prepare("DELETE FROM user WHERE id=?").run(bob);
    assert.equal(count(migrated, "SELECT COUNT(*) AS n FROM mail_outbox"), 0, "cascade");
    assert.equal(
      (migrated.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
  } finally {
    migrated.close();
  }
});
