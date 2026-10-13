import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
test("consistent backup excludes temporary photos and restore preserves account deletions", async () => {
  const directory = path.join(process.cwd(), ".data", "tests", randomUUID());
  process.env.STYLE_DATA_DIR = directory;
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase, closeDatabases } = await import(
    "../src/server/database"
  );
  const auth = await getReadyAuth(),
    db = getDatabase();
  const gone = (
    await auth.api.signUpEmail({
      body: {
        name: "Deleted wearer",
        email: "restore-gone@example.test",
        password: "Restore test passphrase 52!",
      },
    })
  ).user.id;
  const keep = (
    await auth.api.signUpEmail({
      body: {
        name: "Kept wearer",
        email: "restore-kept@example.test",
        password: "Restore test passphrase 52!",
      },
    })
  ).user.id;
  db.prepare(
    "INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)",
  ).run(
    "kept-photo",
    keep,
    Buffer.from("private-photo-fixture"),
    "photo-sha",
    Date.now(),
  );
  db.prepare(
    "INSERT INTO analysis_jobs(id,user_id,status,input_image,created_at,expires_at) VALUES(?,?,'queued',?,?,?)",
  ).run(
    "temporary-photo",
    keep,
    Buffer.from("temporary-must-not-backup"),
    Date.now(),
    Date.now() + 3600000,
  );
  // Queued account mail (an address and a one-time link). Scheduled an hour
  // out so nothing sends or captures it before the backup runs.
  db.prepare(
    "INSERT INTO mail_outbox(id,user_id,kind,recipient_key,to_address,subject,text_body,html_body,status,attempts,created_at,expires_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,'queued',0,?,?,?)",
  ).run(
    "queued-reset-mail",
    keep,
    "reset-password",
    "key",
    "restore-kept@example.test",
    "Reset your Style Studio password",
    "Reset your password: https://example.test/reset/backup-canary-token",
    "<p>backup-canary-token</p>",
    Date.now(),
    Date.now() + 3_600_000,
    Date.now() + 3_600_000,
  );
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM mail_outbox WHERE id='queued-reset-mail'").get() as { n: number }).n,
    1,
  );
  const run = promisify(execFile);
  const environment = {
    ...process.env,
    STYLE_DATA_DIR: directory,
    STYLE_PUBLIC_DEPLOYMENT: "false",
  };
  await run(
    process.execPath,
    ["--import", "tsx", "scripts/backup-database.ts"],
    { env: environment, windowsHide: true },
  );
  // A backup is a file the production pattern accepts. The backups directory
  // also holds the (empty) lock coordinator database, which is not a backup.
  const { FINAL_BACKUP } = await import("../src/server/backupDatabase");
  const filename = readdirSync(path.join(directory, "backups")).find((f) =>
    FINAL_BACKUP.test(f),
  )!;
  assert.ok(filename, "the backup command published one backup");
  const copy = new DatabaseSync(path.join(directory, "backups", filename), {
    readOnly: true,
  });
  assert.equal(
    (
      copy.prepare("SELECT count(*) AS count FROM analysis_jobs").get() as {
        count: number;
      }
    ).count,
    0,
  );
  assert.equal(
    (
      copy.prepare("SELECT count(*) AS count FROM photo_assets").get() as {
        count: number;
      }
    ).count,
    1,
  );
  assert.equal(
    (
      copy.prepare("SELECT count(*) AS count FROM mail_outbox").get() as {
        count: number;
      }
    ).count,
    0,
    "queued mail (addresses, one-time links) is not backed up",
  );
  copy.close();
  // The bytes are gone from the backup file itself, not just unreferenced.
  assert.ok(
    !readFileSync(path.join(directory, "backups", filename)).includes(
      "backup-canary-token",
    ),
    "no queued link survives in the backup file",
  );
  // Simulate a deletion after this backup was made. The user_deletion_ledger
  // trigger writes the durable ledger row in the same statement; the restore
  // command must reapply it.
  db.prepare("DELETE FROM user WHERE id=?").run(gone);
  assert.ok(
    db.prepare("SELECT user_id FROM account_deletions WHERE user_id=?").get(gone),
    "deleting a user records the tombstone atomically",
  );
  // Both connections (main + auth) must be closed before the stopped-process
  // restore drill replaces app.db.
  closeDatabases();
  await run(
    process.execPath,
    ["--import", "tsx", "scripts/restore-database.ts", filename],
    {
      env: { ...environment, STYLE_RESTORE_CONFIRMED: "true" },
      windowsHide: true,
    },
  );
  const restored = new DatabaseSync(path.join(directory, "app.db"), {
    readOnly: true,
  });
  assert.equal(
    restored.prepare("SELECT id FROM user WHERE id=?").get(gone),
    undefined,
  );
  assert.ok(restored.prepare("SELECT id FROM user WHERE id=?").get(keep));
  assert.equal(
    (
      restored.prepare("SELECT count(*) AS n FROM mail_outbox").get() as {
        n: number;
      }
    ).n,
    0,
    "restore never replays stale mail",
  );
  assert.ok(
    restored
      .prepare("SELECT id FROM photo_assets WHERE id=?")
      .get("kept-photo"),
  );
  assert.equal(
    (
      restored.prepare("SELECT count(*) AS count FROM session").get() as {
        count: number;
      }
    ).count,
    0,
  );
  assert.equal(
    (
      restored.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      }
    ).integrity_check,
    "ok",
  );
  restored.close();
});
