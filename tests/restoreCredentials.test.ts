import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Build 009, C3: restoring a backup must not bring back a password that was
 * revoked after the backup. Sequence: A, B, C exist and are verified; backup
 * (T0); A resets their password (T1); C is deleted; the T0 backup is restored.
 * Afterwards the old AND the new password of A are refused, B (never changed)
 * is refused too (nobody can tell from the backup who changed), C is gone,
 * B's wardrobe and photo survive, and the existing email reset flow gives each
 * user a working password again.
 *
 * Fresh-server restore (no live database, deletion ledger file) is NOT covered
 * and still unsupported.
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dataDir, { recursive: true });
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
delete process.env.STYLE_PUBLIC_DEPLOYMENT;
delete process.env.SMTP_URL;

function run(script: string, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", script, ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env, STYLE_DATA_DIR: dataDir, ...env },
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code = error ? (error as { code?: unknown }).code : 0;
          if (typeof code !== "number") return reject(error);
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    },
  );
}

test("restoring an older backup invalidates every password; the email reset flow recovers each user; deleted users stay deleted; data is kept", async () => {
  const { getReadyAuth } = await import("../src/server/auth");
  const database = await import("../src/server/database");
  const auth = await getReadyAuth();
  const db = database.getDatabase();

  const pw = {
    a1: "Restore credentials A one 11!",
    a2: "Restore credentials A two 22!",
    b: "Restore credentials B one 33!",
    c: "Restore credentials C one 44!",
  };
  const users = {
    a: "restore-a@example.test",
    b: "restore-b@example.test",
    c: "restore-c@example.test",
  };
  const ids: Record<string, string> = {};
  for (const [key, email] of Object.entries(users)) {
    const password = key === "a" ? pw.a1 : key === "b" ? pw.b : pw.c;
    ids[key] = (await auth.api.signUpEmail({ body: { email, name: key, password } })).user.id;
  }
  db.exec("UPDATE user SET emailVerified=1");
  db.prepare(
    "INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)",
  ).run("b-photo", ids.b, Buffer.from("b-photo-bytes"), "sha", Date.now());
  db.prepare(
    "INSERT INTO wardrobe_spaces(user_id,revision,data_json) VALUES(?,?,?)",
  ).run(ids.b, 3, '{"items":["b-keeps-this"]}');
  await auth.api.signInEmail({ body: { email: users.a, password: pw.a1 } });

  // T0
  const backup = await run("scripts/backup-database.ts", [], {});
  assert.equal(backup.code, 0, backup.stderr);
  const filename = readdirSync(path.join(dataDir, "backups")).find((f) => /^style-.*\.db$/.test(f))!;
  assert.ok(filename);

  // T1: A resets their password (the old one is now revoked), C is deleted.
  await auth.api.requestPasswordReset({ body: { email: users.a } });
  const token = (
    db
      .prepare(
        "SELECT identifier FROM verification WHERE identifier LIKE 'reset-password:%' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { identifier: string }
  ).identifier.slice("reset-password:".length);
  await auth.api.resetPassword({ body: { newPassword: pw.a2, token } });
  await assert.rejects(auth.api.signInEmail({ body: { email: users.a, password: pw.a1 } }));
  await auth.api.signInEmail({ body: { email: users.a, password: pw.a2 } });
  db.prepare("DELETE FROM user WHERE id=?").run(ids.c);

  // Restore T0 with every connection of this process closed.
  database.closeDatabases();
  const restore = await run("scripts/restore-database.ts", [filename], {
    STYLE_RESTORE_CONFIRMED: "true",
  });
  assert.equal(restore.code, 0, restore.stderr);
  assert.match(restore.stdout, /ALL sign-in passwords were invalidated/);
  assert.match(restore.stdout, /SMTP/);
  for (const secret of Object.values(pw))
    assert.ok(!restore.stdout.includes(secret) && !restore.stderr.includes(secret), "no password in output");

  const restored = new DatabaseSync(path.join(dataDir, "app.db"), { readOnly: true });
  try {
    assert.equal(
      (restored.prepare("SELECT COUNT(*) AS n FROM account WHERE providerId='credential' AND password IS NOT NULL").get() as { n: number }).n,
      0,
      "no credential hash survives",
    );
    assert.equal(
      (restored.prepare("SELECT COUNT(*) AS n FROM account WHERE providerId='credential'").get() as { n: number }).n,
      2,
      "the accounts themselves remain (A and B)",
    );
    assert.equal(restored.prepare("SELECT id FROM user WHERE id=?").get(ids.c), undefined, "deleted user stays deleted");
    assert.ok(restored.prepare("SELECT id FROM user WHERE id=?").get(ids.a));
    assert.ok(restored.prepare("SELECT id FROM photo_assets WHERE id='b-photo'").get(), "photo kept");
    assert.equal(
      (restored.prepare("SELECT data_json FROM wardrobe_spaces WHERE user_id=?").get(ids.b) as { data_json: string }).data_json,
      '{"items":["b-keeps-this"]}',
      "wardrobe kept",
    );
    for (const table of ["session", "verification", "mail_outbox", "analysis_jobs"])
      assert.equal(
        (restored.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        0,
        `${table} cleared as before`,
      );
    assert.equal(
      (restored.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
  } finally {
    restored.close();
  }

  // A fresh Better Auth instance on the restored database.
  const probe = await run("tests/helpers/authProbeChild.ts", [], {
    PROBE: JSON.stringify({
      logins: [
        { label: "A-old-password", email: users.a, password: pw.a1 },
        { label: "A-new-password", email: users.a, password: pw.a2 },
        { label: "B-unchanged-password", email: users.b, password: pw.b },
        { label: "C-deleted", email: users.c, password: pw.c },
      ],
      resets: [
        { label: "A-after-reset", email: users.a, newPassword: "Restore credentials A three 55!" },
        { label: "B-after-reset", email: users.b, newPassword: "Restore credentials B two 66!" },
      ],
    }),
  });
  assert.equal(probe.code, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout.trim().split("\n").at(-1)!), {
    "A-old-password": "refused",
    "A-new-password": "refused",
    "B-unchanged-password": "refused",
    "C-deleted": "refused",
    "A-after-reset": "ok",
    "B-after-reset": "ok",
  });
});
