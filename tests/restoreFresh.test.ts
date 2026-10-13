import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { forkHelper, runScript, sleep } from "./helpers/processes";

/**
 * Build 010, batch D1: restore onto a CLEAN data directory with a separately
 * exported latest deletion ledger, the ledger policy (missing, malformed,
 * stale), refusal while a real idle process has the database open, and staged
 * failure cleanup. Every step that matters runs the real script as a real child
 * process against real files.
 *
 * Story: users A, B, C exist; a backup is taken (T0). Afterwards A resets a
 * password (T1) and C is deleted; the latest ledger is exported; the volume
 * is lost. A new server restores T0 with that ledger.
 */

const root = path.join(process.cwd(), ".data", "tests", randomUUID());
const sourceDir = path.join(root, "source");
const incoming = path.join(root, "incoming");
mkdirSync(sourceDir, { recursive: true });
mkdirSync(incoming, { recursive: true });
process.env.STYLE_DATA_DIR = sourceDir;
process.env.APP_URL = "http://127.0.0.1:3000";
delete process.env.STYLE_PUBLIC_DEPLOYMENT;
delete process.env.SMTP_URL;

const pw = {
  a1: "Fresh restore A one 11!",
  a2: "Fresh restore A two 22!",
  b: "Fresh restore B one 33!",
  c: "Fresh restore C one 44!",
};
const emails = {
  a: "fresh-a@example.test",
  b: "fresh-b@example.test",
  c: "fresh-c@example.test",
};
const ids: Record<string, string> = {};
let backupName = "";
let ledgerCopy = "";
const RATE_MARKER = "203.0.113.77|/sign-in/email";

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const pending = (dir: string) => readdirSync(dir).filter((n) => /\.restore-.*\.pending/.test(n));

/** Inserts one rate-limit row into the REAL table Better Auth created. */
function insertRateLimitRow(db: DatabaseSync, table: string, key: string): void {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
    notnull: number;
    dflt_value: unknown;
  }[];
  const values: Record<string, unknown> = {};
  for (const c of columns) {
    if (c.name === "key") values[c.name] = key;
    else if (c.name === "count") values[c.name] = 1;
    else if (c.name === "lastRequest") values[c.name] = Date.now();
    else if (c.name === "id") values[c.name] = randomUUID();
    else if (c.notnull && c.dflt_value === null)
      throw new Error(`Unexpected required column ${c.name} in the rate-limit table.`);
  }
  const names = Object.keys(values);
  db.prepare(
    `INSERT INTO "${table}"(${names.map((n) => `"${n}"`).join(",")}) VALUES(${names.map(() => "?").join(",")})`,
  ).run(...(names.map((n) => values[n]) as (string | number)[]));
}

function freshDir(): string {
  const dir = path.join(root, randomUUID());
  mkdirSync(path.join(dir, "backups"), { recursive: true });
  copyFileSync(path.join(sourceDir, "backups", backupName), path.join(dir, "backups", backupName));
  return dir;
}
const restoreFile = (
  dir: string,
  filename: string,
  args: string[] = [],
  env: Record<string, string> = {},
) =>
  runScript("scripts/restore-database.ts", [filename, ...args], {
    STYLE_DATA_DIR: dir,
    STYLE_RESTORE_CONFIRMED: "true",
    ...env,
  });
const restore = (dir: string, args: string[] = [], env: Record<string, string> = {}) =>
  restoreFile(dir, backupName, args, env);

function assertNothingRestored(dir: string, result: { code: number; stderr: string }, code: string) {
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, new RegExp(code));
  assert.equal(existsSync(path.join(dir, "app.db")), false, "no database was created");
  assert.deepEqual(pending(dir), [], "no staging file is left");
  assert.ok(!result.stderr.includes(ids.c), "no user id in the diagnostic");
}

let restoredDir = "";
let primary: Promise<void> | null = null;
/** The main scenario's restore, run once and shared by the tests that follow. */
function primaryRestore(): Promise<void> {
  primary ??= (async () => {
    restoredDir = freshDir();
    const result = await restore(restoredDir, ["--ledger", ledgerCopy]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /ALL sign-in passwords were invalidated/);
    assert.match(result.stdout, /SMTP/);
    assert.match(result.stdout, /ledger's export time/);
    for (const secret of Object.values(pw))
      assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  })();
  return primary;
}

before(async () => {
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const { rateLimitTables } = await import("../src/server/sensitiveTables");
  const { FINAL_BACKUP } = await import("../src/server/backupDatabase");
  const auth = await getReadyAuth();
  const db = getDatabase();
  for (const [key, email] of Object.entries(emails)) {
    const password = key === "a" ? pw.a1 : key === "b" ? pw.b : pw.c;
    ids[key] = (await auth.api.signUpEmail({ body: { email, name: key, password } })).user.id;
  }
  db.exec("UPDATE user SET emailVerified=1");
  db.prepare("INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)").run(
    "b-photo",
    ids.b,
    Buffer.from("b-photo-bytes"),
    "sha",
    Date.now(),
  );
  db.prepare("INSERT INTO wardrobe_spaces(user_id,revision,data_json) VALUES(?,?,?)").run(
    ids.b,
    3,
    '{"items":["b-keeps-this"]}',
  );

  // The ACTUAL rate-limit table Better Auth created (inspected, not assumed).
  const tables = rateLimitTables(db);
  assert.equal(tables.length, 1, `exactly one rate-limit table exists (${tables.join(",")})`);
  insertRateLimitRow(db, tables[0], RATE_MARKER);

  // T0
  const backup = await runScript("scripts/backup-database.ts", [], { STYLE_DATA_DIR: sourceDir });
  assert.equal(backup.code, 0, backup.stderr);
  backupName = readdirSync(path.join(sourceDir, "backups")).find((f) => FINAL_BACKUP.test(f))!;
  assert.ok(backupName);
  const copy = new DatabaseSync(path.join(sourceDir, "backups", backupName), { readOnly: true });
  try {
    assert.equal(
      (copy.prepare(`SELECT COUNT(*) AS n FROM "${tables[0]}"`).get() as { n: number }).n,
      0,
      "the backup holds no rate-limit rows",
    );
  } finally {
    copy.close();
  }
  assert.ok(
    !readFileSync(path.join(sourceDir, "backups", backupName)).includes(RATE_MARKER),
    "no client address bytes in the backup file",
  );

  // T1: A resets a password; C is deleted AFTER the backup.
  await auth.api.requestPasswordReset({ body: { email: emails.a } });
  const token = (
    db
      .prepare(
        "SELECT identifier FROM verification WHERE identifier LIKE 'reset-password:%' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { identifier: string }
  ).identifier.slice("reset-password:".length);
  await auth.api.resetPassword({ body: { newPassword: pw.a2, token } });
  db.prepare("DELETE FROM user WHERE id=?").run(ids.c);

  // The latest ledger is exported separately from the backup, then copied to
  // where the new server can reach it (the operator's off-server copy).
  const exported = await runScript("scripts/export-deletion-ledger.ts", [], {
    STYLE_DATA_DIR: sourceDir,
  });
  assert.equal(exported.code, 0, exported.stderr);
  ledgerCopy = path.join(incoming, "deletion-ledger.json");
  copyFileSync(path.join(sourceDir, "ledger", "deletion-ledger.json"), ledgerCopy);
});

test("a fresh server restores the backup with the latest exported ledger: post-backup deletion honoured, every password invalidated, data intact, self-service reset works", async () => {
  await primaryRestore();
  const { readLedgerFile } = await import("../src/server/deletionLedger");
  const { rateLimitTables } = await import("../src/server/sensitiveTables");
  const incomingLedger = readLedgerFile(ledgerCopy);
  assert.ok(incomingLedger.entries.some((e) => e.userId === ids.c), "the ledger knows the post-backup deletion");

  const restored = new DatabaseSync(path.join(restoredDir, "app.db"), { readOnly: true });
  try {
    assert.equal(restored.prepare("SELECT id FROM user WHERE id=?").get(ids.c), undefined, "C stays deleted");
    assert.ok(restored.prepare("SELECT id FROM user WHERE id=?").get(ids.a));
    assert.ok(restored.prepare("SELECT id FROM user WHERE id=?").get(ids.b));
    assert.ok(restored.prepare("SELECT user_id FROM account_deletions WHERE user_id=?").get(ids.c));
    assert.equal(
      (restored.prepare("SELECT COUNT(*) AS n FROM account WHERE providerId='credential' AND password IS NOT NULL").get() as { n: number }).n,
      0,
      "no credential hash survives",
    );
    assert.equal(
      (restored.prepare("SELECT COUNT(*) AS n FROM account WHERE providerId='credential'").get() as { n: number }).n,
      2,
    );
    assert.ok(restored.prepare("SELECT id FROM photo_assets WHERE id='b-photo'").get(), "photo kept");
    assert.equal(
      (restored.prepare("SELECT data_json FROM wardrobe_spaces WHERE user_id=?").get(ids.b) as { data_json: string }).data_json,
      '{"items":["b-keeps-this"]}',
      "wardrobe kept",
    );
    for (const table of ["session", "verification", "mail_outbox", "analysis_jobs", ...rateLimitTables(restored)])
      assert.equal(
        (restored.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        0,
        `${table} empty`,
      );
    assert.equal(
      (restored.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
  } finally {
    restored.close();
  }
  assert.deepEqual(pending(restoredDir), [], "no staging file left");

  // The restored server immediately has a current ledger of its own.
  const installed = readLedgerFile(path.join(restoredDir, "ledger", "deletion-ledger.json"));
  assert.ok(installed.entries.some((e) => e.userId === ids.c));
  assert.ok(installed.generation > incomingLedger.generation, "generation continues");

  // A fresh Better Auth process on the restored directory.
  const probe = await runScript("tests/helpers/authProbeChild.ts", [], {
    STYLE_DATA_DIR: restoredDir,
    PROBE: JSON.stringify({
      logins: [
        { label: "A-old-password", email: emails.a, password: pw.a1 },
        { label: "A-new-password", email: emails.a, password: pw.a2 },
        { label: "B-unchanged-password", email: emails.b, password: pw.b },
        { label: "C-deleted", email: emails.c, password: pw.c },
      ],
      resets: [
        { label: "A-after-reset", email: emails.a, newPassword: "Fresh restore A three 55!" },
        { label: "B-after-reset", email: emails.b, newPassword: "Fresh restore B two 66!" },
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

test("ledger policy on a fresh server: missing, absent file, damaged, tampered and stale ledgers are all refused, nothing is created, and the diagnostic carries no user data", async () => {
  // No ledger at all.
  let dir = freshDir();
  assertNothingRestored(dir, await restore(dir), "RESTORE_E_LEDGER_REQUIRED");

  // A path that does not exist.
  dir = freshDir();
  assertNothingRestored(
    dir,
    await restore(dir, ["--ledger", path.join(incoming, "nope.json")]),
    "RESTORE_E_LEDGER_MISSING",
  );

  // Truncated (a half-copied file).
  const text = readFileSync(ledgerCopy, "utf8");
  const truncated = path.join(incoming, "truncated.json");
  writeFileSync(truncated, text.slice(0, Math.floor(text.length / 2)));
  dir = freshDir();
  assertNothingRestored(dir, await restore(dir, ["--ledger", truncated]), "RESTORE_E_LEDGER_INVALID");

  // Tampered: an entry edited, checksum untouched.
  const edited = JSON.parse(text) as { entries: { userId: string; deletedAt: number }[] };
  edited.entries[0].deletedAt += 1;
  const tampered = path.join(incoming, "tampered.json");
  writeFileSync(tampered, JSON.stringify(edited));
  dir = freshDir();
  assertNothingRestored(dir, await restore(dir, ["--ledger", tampered]), "RESTORE_E_LEDGER_INVALID");

  // Empty file and a directory in place of a file.
  const empty = path.join(incoming, "empty.json");
  writeFileSync(empty, "");
  dir = freshDir();
  assertNothingRestored(dir, await restore(dir, ["--ledger", empty]), "RESTORE_E_LEDGER_INVALID");
  dir = freshDir();
  assertNothingRestored(dir, await restore(dir, ["--ledger", incoming]), "RESTORE_E_LEDGER_INVALID");

  // A perfectly valid ledger exported BEFORE the backup says nothing about
  // later deletions: refused as stale.
  const { serializeLedger } = await import("../src/server/deletionLedger");
  const early = path.join(incoming, "early.json");
  writeFileSync(early, serializeLedger({ generation: 1, exportedAt: 1_000_000, entries: [] }));
  dir = freshDir();
  assertNothingRestored(dir, await restore(dir, ["--ledger", early]), "RESTORE_E_LEDGER_STALE");

  // A ledger after the backup but older than the allowed age.
  dir = freshDir();
  assertNothingRestored(
    dir,
    await restore(dir, ["--ledger", ledgerCopy], { STYLE_RESTORE_LEDGER_MAX_AGE_HOURS: "0.00001" }),
    "RESTORE_E_LEDGER_STALE",
  );
  // ... unless the operator knowingly accepts the loss.
  dir = freshDir();
  const accepted = await restore(dir, ["--ledger", ledgerCopy], {
    STYLE_RESTORE_LEDGER_MAX_AGE_HOURS: "0.00001",
    STYLE_RESTORE_ACCEPT_STALE_LEDGER: "true",
  });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.ok(existsSync(path.join(dir, "app.db")));
  assert.match(accepted.stdout, /not known to this restore/);

  // Arguments and confirmation.
  dir = freshDir();
  const unconfirmed = await runScript("scripts/restore-database.ts", [backupName, "--ledger", ledgerCopy], {
    STYLE_DATA_DIR: dir,
    STYLE_RESTORE_CONFIRMED: "",
  });
  assertNothingRestored(dir, unconfirmed, "RESTORE_E_CONFIRM");
  dir = freshDir();
  assertNothingRestored(dir, await restore(dir, ["--bogus"]), "RESTORE_E_ARGS");
  dir = freshDir();
  assertNothingRestored(
    dir,
    await restoreFile(dir, "style-2026-01-01T00-00-00-000Z.db", ["--ledger", ledgerCopy]),
    "RESTORE_E_BACKUP_INVALID",
  );
});

test("restore is refused while a real idle process has the live database open; the original database is unchanged; once that process is killed the restore proceeds", async () => {
  await primaryRestore();
  copyFileSync(
    path.join(sourceDir, "backups", backupName),
    path.join(restoredDir, "backups", backupName),
  );
  const dbFile = path.join(restoredDir, "app.db");
  const ledgerFile = path.join(restoredDir, "ledger", "deletion-ledger.json");
  const holder = forkHelper("tests/helpers/presenceChild.ts", { STYLE_DATA_DIR: restoredDir });
  try {
    await holder.next((m) => m.ready === true);
    const before = { db: sha(dbFile), ledger: sha(ledgerFile) };
    const refused = await restore(restoredDir);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /RESTORE_E_ACTIVE/);
    assert.equal(sha(dbFile), before.db, "the original database is byte-identical");
    assert.equal(sha(ledgerFile), before.ledger, "and so is the ledger");
    assert.deepEqual(pending(restoredDir), []);
    // Idle for a while longer: still refused.
    await sleep(500);
    assert.equal((await restore(restoredDir)).code, 1);
  } finally {
    holder.proc.kill("SIGKILL");
    await holder.exited;
  }
  // The kernel released the dead holder's lock; allow a few seconds only for
  // operating-system teardown.
  const end = Date.now() + 15_000;
  let result = await restore(restoredDir);
  while (result.code === 1 && /RESTORE_E_ACTIVE/.test(result.stderr) && Date.now() < end) {
    await sleep(200);
    result = await restore(restoredDir);
  }
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const after = new DatabaseSync(dbFile, { readOnly: true });
  try {
    assert.equal(after.prepare("SELECT id FROM user WHERE id=?").get(ids.c), undefined);
    assert.equal(
      (after.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
  } finally {
    after.close();
  }
});

test("a restore that fails after staging begins leaves the original database untouched and no staging file; earlier crash leftovers are swept", async () => {
  await primaryRestore();
  copyFileSync(
    path.join(sourceDir, "backups", backupName),
    path.join(restoredDir, "backups", backupName),
  );
  const dbFile = path.join(restoredDir, "app.db");
  const unchanged = sha(dbFile);

  // 1. Not a database at all.
  const garbage = "style-2026-01-01T00-00-00-000Z.db";
  writeFileSync(path.join(restoredDir, "backups", garbage), Buffer.alloc(6000, 0x41));
  let result = await restoreFile(restoredDir, garbage);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RESTORE_E_BACKUP_INVALID/);
  assert.equal(sha(dbFile), unchanged);
  assert.deepEqual(pending(restoredDir), []);

  // 2. A real SQLite file that is not this application's database.
  const foreign = "style-2026-01-02T00-00-00-000Z.db";
  const other = new DatabaseSync(path.join(restoredDir, "backups", foreign));
  other.exec("CREATE TABLE unrelated(x)");
  other.close();
  result = await restoreFile(restoredDir, foreign);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RESTORE_E_BACKUP_INVALID/);
  assert.equal(sha(dbFile), unchanged);
  assert.deepEqual(pending(restoredDir), []);

  // 3. A directory carrying a backup's name.
  const dirName = "style-2026-01-03T00-00-00-000Z.db";
  mkdirSync(path.join(restoredDir, "backups", dirName));
  result = await restoreFile(restoredDir, dirName);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RESTORE_E_BACKUP_INVALID/);
  assert.equal(sha(dbFile), unchanged);

  // 4. A damaged implicit ledger (live mode): refused, nothing changed.
  const implicit = path.join(restoredDir, "ledger", "deletion-ledger.json");
  const good = readFileSync(implicit);
  writeFileSync(implicit, good.subarray(0, 30));
  result = await restore(restoredDir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RESTORE_E_LEDGER_INVALID/);
  assert.equal(sha(dbFile), unchanged);
  assert.deepEqual(pending(restoredDir), []);

  // 5. Crash leftovers from earlier restores are removed by the next one; a
  //    file that merely resembles them is not.
  const stale = [
    "app.db.restore-0123456789abcdef.pending",
    "app.db.restore-0123456789abcdef.pending-wal",
  ].map((n) => path.join(restoredDir, n));
  const decoy = path.join(restoredDir, "app.db.restore-notahex.pending");
  for (const f of [...stale, decoy]) writeFileSync(f, "leftover");
  // An explicit valid ledger takes the place of the damaged implicit one.
  result = await restore(restoredDir, ["--ledger", ledgerCopy]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  for (const f of stale) assert.equal(existsSync(f), false, "swept");
  assert.equal(existsSync(decoy), true, "a non-matching name is left alone");
  assert.deepEqual(pending(restoredDir).filter((n) => !n.includes("notahex")), []);
});

test("staging leftovers that cannot be removed are reported with a fixed warning code, by name only, and change the exit code instead of passing silently", async () => {
  await primaryRestore();
  copyFileSync(
    path.join(sourceDir, "backups", backupName),
    path.join(restoredDir, "backups", backupName),
  );
  // A DIRECTORY carrying the staging pattern is something the sweep must not
  // remove (it only ever deletes files and links), so its removal genuinely
  // fails without any mock.
  const stuckName = "app.db.restore-fedcba9876543210.pending";
  const stuck = path.join(restoredDir, stuckName);
  mkdirSync(stuck);
  try {
    // A restore that succeeds: exit 2, the database IS replaced, the leftover is named.
    const ok = await restore(restoredDir, ["--ledger", ledgerCopy]);
    assert.equal(ok.code, 2, ok.stderr + ok.stdout);
    assert.match(ok.stderr, /RESTORE_W_STAGING_LEFT/);
    assert.ok(ok.stderr.includes(stuckName), "named by its fixed-pattern file name");
    assert.ok(!ok.stderr.includes(restoredDir), "no directory path is printed");
    assert.ok(!ok.stderr.includes(ids.c), "no user id is printed");
    assert.match(ok.stdout, /ALL sign-in passwords were invalidated/);
    const after = new DatabaseSync(path.join(restoredDir, "app.db"), { readOnly: true });
    try {
      assert.equal(after.prepare("SELECT id FROM user WHERE id=?").get(ids.c), undefined);
    } finally {
      after.close();
    }
    assert.ok(existsSync(stuck), "the directory was left alone");

    // A restore that fails: still exit 1 with its own code, and the leftover is still reported.
    const garbage = "style-2026-02-01T00-00-00-000Z.db";
    writeFileSync(path.join(restoredDir, "backups", garbage), Buffer.alloc(6000, 0x41));
    const dbBefore = sha(path.join(restoredDir, "app.db"));
    const failed = await restoreFile(restoredDir, garbage);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /RESTORE_E_BACKUP_INVALID/);
    assert.match(failed.stderr, /RESTORE_W_STAGING_LEFT/);
    assert.ok(failed.stderr.includes(stuckName));
    assert.equal(sha(path.join(restoredDir, "app.db")), dbBefore);
  } finally {
    rmSync(stuck, { recursive: true, force: true }); // this test's own fixture directory
  }
  const clean = await restore(restoredDir, ["--ledger", ledgerCopy]);
  assert.equal(clean.code, 0, clean.stderr);
});
