import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { forkHelper, runScript, sleep } from "./helpers/processes";

/**
 * Build 021: the encrypted backup command core (in process, with failure
 * injection) and both commands as REAL child processes against real files,
 * ending in a restore onto a genuinely fresh data directory.
 *
 * Story: users A (kept), B (kept, with a photo and a wardrobe) and C exist.
 * Encrypted package P1 is made. C is deleted afterwards and a newer ledger is
 * exported. Package P2 is made after the deletion. Both are restored onto
 * empty data directories.
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
delete process.env.STYLE_BACKUP_PASSPHRASE;
delete process.env.STYLE_BACKUP_PASSPHRASE_FILE;

const PASSPHRASE = "unit test passphrase 7f3a9c1e5b2d8046";
const WRONG = "some other long passphrase 0a1b2c3d4e5f";
const passFile = path.join(incoming, "passphrase.txt");
const wrongFile = path.join(incoming, "wrong.txt");
writeFileSync(passFile, PASSPHRASE + "\n", { mode: 0o600 });
writeFileSync(wrongFile, WRONG + "\n", { mode: 0o600 });
if (process.platform !== "win32") {
  chmodSync(passFile, 0o600);
  chmodSync(wrongFile, 0o600);
}

const pw = { a: "Encrypted pkg A one 11!", b: "Encrypted pkg B one 22!", c: "Encrypted pkg C one 33!" };
const emails = { a: "pkg-a@example.test", b: "pkg-b@example.test", c: "pkg-c@example.test" };
const ids: Record<string, string> = {};
const RATE_MARKER = "203.0.113.99|/sign-in/email";
const outputs: string[] = [];
const record = <T extends { stdout: string; stderr: string }>(r: T): T => {
  outputs.push(r.stdout, r.stderr);
  return r;
};

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const packages = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".stylepkg"));
const partials = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".partial"));
const pending = (dir: string) => readdirSync(dir).filter((n) => /\.pending/.test(n));

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
    else if (c.notnull && c.dflt_value === null) throw new Error(`Unexpected column ${c.name}.`);
  }
  const names = Object.keys(values);
  db.prepare(
    `INSERT INTO "${table}"(${names.map((n) => `"${n}"`).join(",")}) VALUES(${names.map(() => "?").join(",")})`,
  ).run(...(names.map((n) => values[n]) as (string | number)[]));
}

const backupEncrypted = (args: string[] = [], env: Record<string, string> = {}) =>
  runScript("scripts/backup-encrypted.ts", args, {
    STYLE_DATA_DIR: sourceDir,
    STYLE_BACKUP_PASSPHRASE_FILE: passFile,
    STYLE_BACKUP_PASSPHRASE: "",
    ...env,
  }).then(record);

const restoreEncrypted = (
  dir: string,
  name: string,
  args: string[] = [],
  env: Record<string, string> = {},
) =>
  runScript("scripts/restore-encrypted.ts", [name, ...args], {
    STYLE_DATA_DIR: dir,
    STYLE_RESTORE_CONFIRMED: "true",
    STYLE_BACKUP_PASSPHRASE_FILE: passFile,
    STYLE_BACKUP_PASSPHRASE: "",
    ...env,
  }).then(record);

/** A new, genuinely empty data directory with the package copied into its exports directory. */
function freshDir(packageName: string, from = path.join(sourceDir, "exports")): string {
  const dir = path.join(root, randomUUID());
  mkdirSync(path.join(dir, "exports"), { recursive: true });
  copyFileSync(path.join(from, packageName), path.join(dir, "exports", packageName));
  return dir;
}

function assertNothingRestored(dir: string, result: { code: number; stderr: string }, code: string) {
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, new RegExp(code));
  assert.equal(existsSync(path.join(dir, "app.db")), false, "no database was created");
  assert.equal(existsSync(path.join(dir, "ledger")), false, "no ledger was installed");
  assert.deepEqual(pending(dir), [], "no staging file is left");
  const staging = path.join(dir, "restore-staging");
  if (existsSync(staging)) assert.deepEqual(readdirSync(staging), [], "no decrypted staging is left");
}

let p1 = "";
let p2 = "";
let ledgerLater = "";
const cleanOpts = { kdf: { logN: 15, r: 8, p: 1 } };

/** An encrypted export of the source data directory at the bounded test cost. */
async function exportPackage() {
  const { createEncryptedBackup } = await import("../src/server/encryptedBackup");
  const { getDatabase } = await import("../src/server/database");
  return createEncryptedBackup(getDatabase(), {
    dataDir: sourceDir,
    passphrase: Buffer.from(PASSPHRASE),
    ...cleanOpts,
  });
}

before(async () => {
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const { rateLimitTables } = await import("../src/server/sensitiveTables");
  const auth = await getReadyAuth();
  const db = getDatabase();
  for (const [key, email] of Object.entries(emails))
    ids[key] = (
      await auth.api.signUpEmail({ body: { email, name: key, password: pw[key as "a"] } })
    ).user.id;
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
  // Material that must NEVER reach a package: a live session, a reset token,
  // queued mail, a temporary analysis photo and a client address.
  await auth.api.signInEmail({ body: { email: emails.a, password: pw.a } });
  await auth.api.requestPasswordReset({ body: { email: emails.b } });
  db.prepare(
    "INSERT INTO analysis_jobs(id,user_id,status,input_image,created_at,expires_at) VALUES(?,?,'queued',?,?,?)",
  ).run("temp-job", ids.b, Buffer.from("TEMP-ANALYSIS-PHOTO-BYTES"), Date.now(), Date.now() + 3_600_000);
  insertRateLimitRow(db, rateLimitTables(db)[0], RATE_MARKER);
  for (const table of ["session", "verification", "analysis_jobs"])
    assert.ok(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n > 0,
      `${table} has rows before the backup`,
    );
});

test("in process: success publishes one verified package, removes the plain backup it made, and the package holds neither plaintext nor secrets", async () => {
  const { createEncryptedBackup, exportsDirectory } = await import("../src/server/encryptedBackup");
  const { getDatabase } = await import("../src/server/database");
  const { verifyPackage } = await import("../src/server/encryptedPackage");
  const dataDir = path.join(root, "ok");
  mkdirSync(dataDir, { recursive: true });
  const passphrase = Buffer.from(PASSPHRASE);
  const result = await createEncryptedBackup(getDatabase(), { dataDir, passphrase, ...cleanOpts });
  assert.match(result.file, /^style-package-\d{4}-.*\.stylepkg$/);
  assert.equal(result.plainRemoved, true);
  assert.deepEqual(result.leftovers, []);
  const exportsDir = exportsDirectory(dataDir);
  assert.deepEqual(packages(exportsDir), [result.file]);
  assert.deepEqual(partials(exportsDir), []);
  assert.deepEqual(
    readdirSync(path.join(dataDir, "backups")).filter((n) => /^style-.*\.db$/.test(n)),
    [],
    "the plain backup is gone after publication",
  );
  const bytes = readFileSync(path.join(exportsDir, result.file));
  for (const secret of [
    "SQLite format 3",
    "style-deletion-ledger",
    emails.a,
    emails.b,
    ids.a,
    "b-photo-bytes",
    "b-keeps-this",
    "TEMP-ANALYSIS-PHOTO-BYTES",
    RATE_MARKER,
    PASSPHRASE,
  ])
    assert.ok(!bytes.includes(secret), `package does not contain "${secret.slice(0, 12)}"`);
  const info = verifyPackage(path.join(exportsDir, result.file), passphrase);
  assert.ok(info.databaseBytes > 0 && info.ledgerBytes > 0);
  if (process.platform !== "win32") {
    assert.equal(statSync(exportsDir).mode & 0o077, 0, "exports directory is owner-only");
    assert.equal(statSync(path.join(exportsDir, result.file)).mode & 0o077, 0, "package is owner-only");
  }
});

test("in process: --keep-local keeps the ordinary backup", async () => {
  const { createEncryptedBackup } = await import("../src/server/encryptedBackup");
  const { getDatabase } = await import("../src/server/database");
  const dataDir = path.join(root, "keep");
  mkdirSync(dataDir, { recursive: true });
  const result = await createEncryptedBackup(getDatabase(), {
    dataDir,
    passphrase: Buffer.from(PASSPHRASE),
    keepLocal: true,
    ...cleanOpts,
  });
  assert.equal(result.plainRemoved, false);
  assert.ok(existsSync(path.join(dataDir, "backups", result.plainBackup)));
});

test("in process: a failure or interrupt at EVERY stage publishes nothing, leaves no partial, keeps the ordinary backup and leaves the live database alone", async () => {
  const { createEncryptedBackup, exportsDirectory } = await import("../src/server/encryptedBackup");
  const { getDatabase } = await import("../src/server/database");
  const db = getDatabase();
  const users = () => (db.prepare("SELECT COUNT(*) AS n FROM user").get() as { n: number }).n;
  const stages = ["backup-created", "ledger-exported", "header-written", "encrypted", "synced", "verified"] as const;
  const before = users();
  for (const failAt of stages) {
    const dataDir = path.join(root, `fail-${failAt}`);
    mkdirSync(dataDir, { recursive: true });
    const passphrase = Buffer.from(PASSPHRASE);
    await assert.rejects(
      createEncryptedBackup(db, {
        dataDir,
        passphrase,
        ...cleanOpts,
        onStage: (stage) => {
          if (stage === failAt) throw new Error(`injected at ${stage}`);
        },
      }),
      new RegExp(`injected at ${failAt}`),
    );
    const exportsDir = exportsDirectory(dataDir);
    assert.deepEqual(packages(exportsDir), [], `${failAt}: no package`);
    assert.deepEqual(partials(exportsDir), [], `${failAt}: no partial`);
    assert.equal(
      readdirSync(path.join(dataDir, "backups")).filter((n) => /^style-.*\.db$/.test(n)).length,
      1,
      `${failAt}: the ordinary backup is kept`,
    );
    // The lock is released: the very next run in the same directory succeeds.
    const ok = await createEncryptedBackup(db, { dataDir, passphrase: Buffer.from(PASSPHRASE), ...cleanOpts });
    assert.deepEqual(packages(exportsDir), [ok.file], `${failAt}: a retry publishes exactly one`);
  }
  assert.equal(users(), before, "the live database was not touched");
});

test("in process: a package damaged or truncated while it is being written fails verification before publication", async () => {
  const { createEncryptedBackup, exportsDirectory } = await import("../src/server/encryptedBackup");
  const { getDatabase } = await import("../src/server/database");
  const damage: Record<string, (file: string) => void> = {
    "flipped byte": (file) => {
      const fd = openSync(file, "r+");
      try {
        writeSync(fd, Buffer.from([0xff]), 0, 1, 200);
      } finally {
        closeSync(fd);
      }
    },
    truncated: (file) => truncateSync(file, statSync(file).size - 7),
  };
  for (const [label, apply] of Object.entries(damage)) {
    const dataDir = path.join(root, `damage-${label.replace(" ", "-")}`);
    mkdirSync(dataDir, { recursive: true });
    await assert.rejects(
      createEncryptedBackup(getDatabase(), {
        dataDir,
        passphrase: Buffer.from(PASSPHRASE),
        ...cleanOpts,
        onStage: (stage, context) => {
          if (stage === "synced") apply(context.partial);
        },
      }),
      (error: Error) => /authenticated|shorter|truncated/i.test(error.message),
      label,
    );
    const exportsDir = exportsDirectory(dataDir);
    assert.deepEqual(packages(exportsDir), [], `${label}: nothing published`);
    assert.deepEqual(partials(exportsDir), [], `${label}: partial removed`);
  }
});

test("in process: an existing final name, even a link, is never replaced; the next free name is used", async () => {
  const { createEncryptedBackup, exportsDirectory } = await import("../src/server/encryptedBackup");
  const { getDatabase } = await import("../src/server/database");
  const dataDir = path.join(root, "duplicate");
  mkdirSync(dataDir, { recursive: true });
  const exportsDir = exportsDirectory(dataDir);
  const now = () => new Date("2026-01-15T12:00:00.000Z");
  const base = "style-package-2026-01-15T12-00-00-000Z";
  writeFileSync(path.join(exportsDir, `${base}.stylepkg`), "SENTINEL-ONE");
  const decoy = path.join(root, "decoy-target.txt");
  writeFileSync(decoy, "SENTINEL-TARGET");
  let linked = true;
  try {
    symlinkSync(decoy, path.join(exportsDir, `${base}-1.stylepkg`));
  } catch {
    linked = false;
  }
  const result = await createEncryptedBackup(getDatabase(), {
    dataDir,
    passphrase: Buffer.from(PASSPHRASE),
    now,
    ...cleanOpts,
  });
  assert.equal(result.file, linked ? `${base}-2.stylepkg` : `${base}-1.stylepkg`);
  assert.equal(readFileSync(path.join(exportsDir, `${base}.stylepkg`), "utf8"), "SENTINEL-ONE");
  assert.equal(readFileSync(decoy, "utf8"), "SENTINEL-TARGET", "the link's target was not written");
  // Running twice at the same instant keeps adding, never replacing.
  const again = await createEncryptedBackup(getDatabase(), {
    dataDir,
    passphrase: Buffer.from(PASSPHRASE),
    now,
    ...cleanOpts,
  });
  assert.notEqual(again.file, result.file);
  assert.ok(existsSync(path.join(exportsDir, result.file)));
});

test("in process: a link or junction in place of the exports directory is refused before anything is created", async () => {
  const { createEncryptedBackup } = await import("../src/server/encryptedBackup");
  const { getDatabase } = await import("../src/server/database");
  const dataDir = path.join(root, "linked-exports");
  const outside = path.join(root, "outside-exports");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    symlinkSync(outside, path.join(dataDir, "exports"), "junction");
  } catch {
    return; // links cannot be created here
  }
  await assert.rejects(
    createEncryptedBackup(getDatabase(), { dataDir, passphrase: Buffer.from(PASSPHRASE), ...cleanOpts }),
  );
  assert.deepEqual(readdirSync(outside), [], "nothing was written through the link");
  assert.equal(existsSync(path.join(dataDir, "backups")), false, "no backup was started");
});

test("in process: only owned partials are swept; decoys, finals and a directory with a partial's name are left alone and reported", async () => {
  const { createEncryptedBackup, exportsDirectory } = await import("../src/server/encryptedBackup");
  const { getDatabase } = await import("../src/server/database");
  const dataDir = path.join(root, "sweep");
  mkdirSync(dataDir, { recursive: true });
  const exportsDir = exportsDirectory(dataDir);
  const owned = "style-package-2026-01-01T00-00-00-000Z.0123456789ab.partial";
  const stuck = "style-package-2026-01-02T00-00-00-000Z.ba9876543210.partial";
  const decoys = [
    "style-package-2026-01-01T00-00-00-000Z.stylepkg",
    "style-package-2026-01-01T00-00-00-000Z.notahexvalue.partial",
    "notes.partial",
    "style-2026-01-01T00-00-00-000Z.0123456789ab.partial",
    "style-package-2026-01-01T00-00-00-000Z.0123456789ab.partial.keep",
  ];
  writeFileSync(path.join(exportsDir, owned), "crash leftover");
  for (const name of decoys) writeFileSync(path.join(exportsDir, name), "keep me");
  mkdirSync(path.join(exportsDir, stuck));
  const result = await createEncryptedBackup(getDatabase(), {
    dataDir,
    passphrase: Buffer.from(PASSPHRASE),
    ...cleanOpts,
  });
  assert.equal(existsSync(path.join(exportsDir, owned)), false, "the owned partial was swept");
  for (const name of decoys) assert.equal(readFileSync(path.join(exportsDir, name), "utf8"), "keep me");
  assert.ok(statSync(path.join(exportsDir, stuck)).isDirectory(), "a directory is never removed");
  assert.deepEqual(result.leftovers, [stuck], "and it is reported by its fixed-pattern name");
});

test("CLI end to end: encrypted export, then restore onto a fresh data directory (kept data returns, deleted account stays deleted, secrets absent, passwords require reset)", async () => {
  const { getDatabase } = await import("../src/server/database");
  const db = getDatabase();

  // P1: made while C still exists. In process at a bounded, accepted test cost
  // (scrypt log2N 15, 32 MiB); the production-default CLI path has its own test below.
  const first = await exportPackage();
  [p1] = packages(path.join(sourceDir, "exports"));
  assert.ok(p1 && first.file.endsWith(p1));
  assert.deepEqual(
    readdirSync(path.join(sourceDir, "backups")).filter((n) => /^style-.*\.db$/.test(n)),
    [],
    "the ordinary backup made by the command was removed",
  );

  // C is deleted AFTER P1; a newer ledger is exported and copied off the server.
  db.prepare("DELETE FROM user WHERE id=?").run(ids.c);
  const exported = record(
    await runScript("scripts/export-deletion-ledger.ts", [], { STYLE_DATA_DIR: sourceDir }),
  );
  assert.equal(exported.code, 0, exported.stderr);
  ledgerLater = path.join(incoming, "deletion-ledger-later.json");
  copyFileSync(path.join(sourceDir, "ledger", "deletion-ledger.json"), ledgerLater);
  await sleep(20);

  // P2: made after the deletion.
  await exportPackage();
  p2 = packages(path.join(sourceDir, "exports")).find((n) => n !== p1)!;
  assert.ok(p2);

  // --- fresh restore of P2 alone -------------------------------------------
  const dir = freshDir(p2);
  assert.equal(readdirSync(dir).join(), "exports", "the target directory is genuinely fresh");
  const restored = await restoreEncrypted(dir, p2);
  assert.equal(restored.code, 0, restored.stderr + restored.stdout);
  assert.match(restored.stdout, /ALL sign-in passwords were invalidated/);
  assert.ok(!restored.stdout.includes(PASSPHRASE) && !restored.stderr.includes(PASSPHRASE));

  const { rateLimitTables } = await import("../src/server/sensitiveTables");
  const live = new DatabaseSync(path.join(dir, "app.db"), { readOnly: true });
  try {
    assert.ok(live.prepare("SELECT id FROM user WHERE id=?").get(ids.a), "A returns");
    assert.ok(live.prepare("SELECT id FROM user WHERE id=?").get(ids.b), "B returns");
    assert.equal(live.prepare("SELECT id FROM user WHERE id=?").get(ids.c), undefined, "C stays deleted");
    assert.ok(live.prepare("SELECT user_id FROM account_deletions WHERE user_id=?").get(ids.c));
    assert.ok(live.prepare("SELECT id FROM photo_assets WHERE id='b-photo'").get(), "photo returns");
    assert.equal(
      (live.prepare("SELECT data_json FROM wardrobe_spaces WHERE user_id=?").get(ids.b) as { data_json: string }).data_json,
      '{"items":["b-keeps-this"]}',
      "wardrobe returns",
    );
    assert.equal(
      (live.prepare("SELECT COUNT(*) AS n FROM account WHERE providerId='credential' AND password IS NOT NULL").get() as { n: number }).n,
      0,
      "every password was invalidated",
    );
    for (const table of ["session", "verification", "mail_outbox", "analysis_jobs", ...rateLimitTables(live)])
      assert.equal(
        (live.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        0,
        `${table} is empty`,
      );
    assert.equal((live.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  } finally {
    live.close();
  }
  assert.deepEqual(readdirSync(path.join(dir, "restore-staging")), [], "decrypted staging removed");
  assert.deepEqual(pending(dir), []);
  const dbBytes = readFileSync(path.join(dir, "app.db"));
  assert.ok(!dbBytes.includes("TEMP-ANALYSIS-PHOTO-BYTES") && !dbBytes.includes(RATE_MARKER));

  // Sign-in is refused for everyone (old passwords), the reset flow works.
  const probe = await runScript("tests/helpers/authProbeChild.ts", [], {
    STYLE_DATA_DIR: dir,
    PROBE: JSON.stringify({
      logins: [
        { label: "A-old", email: emails.a, password: pw.a },
        { label: "B-old", email: emails.b, password: pw.b },
        { label: "C-deleted", email: emails.c, password: pw.c },
      ],
      resets: [{ label: "A-reset", email: emails.a, newPassword: "Encrypted pkg A two 44!" }],
    }),
  });
  assert.equal(probe.code, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout.trim().split("\n").at(-1)!), {
    "A-old": "refused",
    "B-old": "refused",
    "C-deleted": "refused",
    "A-reset": "ok",
  });
});

test("CLI at the production default cost: backup:encrypted then restore:encrypted (the one default-cost scrypt test)", async () => {
  const { DEFAULT_KDF } = await import("../src/server/encryptedPackage");
  const before = packages(path.join(sourceDir, "exports"));
  const made = await backupEncrypted();
  assert.equal(made.code, 0, made.stderr + made.stdout);
  assert.match(made.stdout, /Encrypted backup package published/);
  assert.match(made.stdout, /Without the passphrase the data cannot be recovered/);
  for (const text of [made.stdout, made.stderr]) {
    assert.ok(!text.includes(PASSPHRASE), "the passphrase is never printed");
    assert.ok(!text.includes(emails.a) && !text.includes(ids.a), "no user data printed");
  }
  const name = packages(path.join(sourceDir, "exports")).find((n) => !before.includes(n))!;
  assert.ok(name);
  const header = readFileSync(path.join(sourceDir, "exports", name)).subarray(0, 64);
  assert.equal(header[12], DEFAULT_KDF.logN, "written with the production default cost");
  assert.equal(header[12], 17);

  const dir = freshDir(name);
  const restored = await restoreEncrypted(dir, name);
  assert.equal(restored.code, 0, restored.stderr + restored.stdout);
  const live = new DatabaseSync(path.join(dir, "app.db"), { readOnly: true });
  try {
    assert.ok(live.prepare("SELECT id FROM user WHERE id=?").get(ids.b), "B returns");
    assert.equal(live.prepare("SELECT id FROM user WHERE id=?").get(ids.c), undefined, "C stays deleted");
  } finally {
    live.close();
  }
  assert.deepEqual(readdirSync(path.join(dir, "restore-staging")), []);
});

test("CLI: P1 predates C's deletion, so alone it cannot know; with the newer ledger C stays deleted; on a live database the live record wins", async () => {
  const alone = freshDir(p1);
  const resultAlone = await restoreEncrypted(alone, p1);
  assert.equal(resultAlone.code, 0, resultAlone.stderr);
  assert.match(resultAlone.stdout, /not known to this restore/);
  const a = new DatabaseSync(path.join(alone, "app.db"), { readOnly: true });
  try {
    assert.ok(a.prepare("SELECT id FROM user WHERE id=?").get(ids.c), "documented limit: the package's own ledger predates the deletion");
  } finally {
    a.close();
  }

  const supplemented = freshDir(p1);
  const result = await restoreEncrypted(supplemented, p1, ["--ledger", ledgerLater]);
  assert.equal(result.code, 0, result.stderr);
  const b = new DatabaseSync(path.join(supplemented, "app.db"), { readOnly: true });
  try {
    assert.equal(b.prepare("SELECT id FROM user WHERE id=?").get(ids.c), undefined, "C stays deleted");
    assert.ok(b.prepare("SELECT id FROM user WHERE id=?").get(ids.b));
  } finally {
    b.close();
  }

  // LIVE mode: the database already here knows C is deleted; the older package must not bring C back.
  copyFileSync(path.join(sourceDir, "exports", p1), path.join(supplemented, "exports", p1));
  const live = await restoreEncrypted(supplemented, p1);
  assert.equal(live.code, 0, live.stderr);
  const c = new DatabaseSync(path.join(supplemented, "app.db"), { readOnly: true });
  try {
    assert.equal(c.prepare("SELECT id FROM user WHERE id=?").get(ids.c), undefined, "still deleted after a live restore");
  } finally {
    c.close();
  }
  assert.deepEqual(readdirSync(path.join(supplemented, "restore-staging")), []);
});

test("CLI: wrong key, tampering and truncation change nothing, on a fresh directory and on a live one", async () => {
  const bytes = readFileSync(path.join(sourceDir, "exports", p2));
  const variants: Record<string, { name: string; code: string; write: (file: string) => void }> = {
    tampered: {
      name: "style-package-2026-02-01T00-00-00-000Z.stylepkg",
      code: "RESTORE_E_PKG_AUTH",
      write: (f) => {
        const copy = Buffer.from(bytes);
        copy[Math.floor(copy.length / 2)] ^= 0x01;
        writeFileSync(f, copy);
      },
    },
    truncated: {
      name: "style-package-2026-02-02T00-00-00-000Z.stylepkg",
      code: "RESTORE_E_PKG_TRUNCATED",
      write: (f) => writeFileSync(f, bytes.subarray(0, bytes.length - 40)),
    },
    "header changed": {
      name: "style-package-2026-02-03T00-00-00-000Z.stylepkg",
      code: "RESTORE_E_PKG_VERSION",
      write: (f) => {
        const copy = Buffer.from(bytes);
        copy.writeUInt16BE(9, 8);
        writeFileSync(f, copy);
      },
    },
    "not a package": {
      name: "style-package-2026-02-04T00-00-00-000Z.stylepkg",
      code: "RESTORE_E_PKG_FORMAT",
      write: (f) => writeFileSync(f, Buffer.alloc(bytes.length, 0x41)),
    },
  };
  for (const [label, v] of Object.entries(variants)) {
    const dir = freshDir(p2);
    v.write(path.join(dir, "exports", v.name));
    assertNothingRestored(dir, await restoreEncrypted(dir, v.name), v.code);
    assert.ok(label);
  }
  // Wrong passphrase, same genuine package.
  const dir = freshDir(p2);
  const wrong = await restoreEncrypted(dir, p2, [], { STYLE_BACKUP_PASSPHRASE_FILE: wrongFile });
  assertNothingRestored(dir, wrong, "RESTORE_E_PKG_AUTH");
  assert.ok(!wrong.stderr.includes(WRONG) && !wrong.stderr.includes(PASSPHRASE));

  // Live directory: the database and ledger are byte-identical after every refusal.
  const liveDir = freshDir(p2);
  assert.equal((await restoreEncrypted(liveDir, p2)).code, 0);
  const dbFile = path.join(liveDir, "app.db");
  const ledgerFile = path.join(liveDir, "ledger", "deletion-ledger.json");
  const before = { db: sha(dbFile), ledger: sha(ledgerFile) };
  const tamperedName = variants.tampered.name;
  variants.tampered.write(path.join(liveDir, "exports", tamperedName));
  for (const result of [
    await restoreEncrypted(liveDir, tamperedName),
    await restoreEncrypted(liveDir, p2, [], { STYLE_BACKUP_PASSPHRASE_FILE: wrongFile }),
  ]) {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /RESTORE_E_PKG_AUTH/);
  }
  assert.equal(sha(dbFile), before.db, "live database unchanged");
  assert.equal(sha(ledgerFile), before.ledger, "ledger unchanged");
  assert.deepEqual(readdirSync(path.join(liveDir, "restore-staging")), []);
});

test("CLI: passphrase handling fails closed and an argument can never carry it", async () => {
  const dir = freshDir(p2);
  const none = await restoreEncrypted(dir, p2, [], { STYLE_BACKUP_PASSPHRASE_FILE: "" });
  assertNothingRestored(dir, none, "RESTORE_E_PKG_PASSPHRASE_MISSING");
  const weak = await restoreEncrypted(dir, p2, [], { STYLE_BACKUP_PASSPHRASE_FILE: "", STYLE_BACKUP_PASSPHRASE: "too short" });
  assertNothingRestored(dir, weak, "RESTORE_E_PKG_PASSPHRASE_WEAK");
  assert.ok(!weak.stderr.includes("too short"));
  const both = await restoreEncrypted(dir, p2, [], { STYLE_BACKUP_PASSPHRASE: PASSPHRASE });
  assertNothingRestored(dir, both, "RESTORE_E_PKG_PASSPHRASE_AMBIGUOUS");
  assert.ok(!both.stderr.includes(PASSPHRASE));
  const viaEnv = await restoreEncrypted(dir, p2, [], { STYLE_BACKUP_PASSPHRASE_FILE: "" , STYLE_BACKUP_PASSPHRASE: PASSPHRASE });
  assert.equal(viaEnv.code, 0, viaEnv.stderr);

  // Passing the passphrase as an argument is an argument error that does not echo it.
  const secretArg = "--passphrase=" + PASSPHRASE;
  const dir2 = freshDir(p2);
  const arg = await restoreEncrypted(dir2, p2, [secretArg]);
  assertNothingRestored(dir2, arg, "RESTORE_E_ARGS");
  assert.ok(!arg.stderr.includes(PASSPHRASE) && !arg.stdout.includes(PASSPHRASE));
  const backupArg = await backupEncrypted([secretArg]);
  assert.equal(backupArg.code, 1);
  assert.ok(!backupArg.stderr.includes(PASSPHRASE) && !backupArg.stdout.includes(PASSPHRASE));
  const noPass = await backupEncrypted([], { STYLE_BACKUP_PASSPHRASE_FILE: "" });
  assert.equal(noPass.code, 1);
  assert.match(noPass.stderr, /BACKUP_E_PKG_PASSPHRASE_MISSING/);
  const packagesNow = packages(path.join(sourceDir, "exports")).length;
  const weakBackup = await backupEncrypted([], { STYLE_BACKUP_PASSPHRASE_FILE: "", STYLE_BACKUP_PASSPHRASE: "weak" });
  assert.equal(weakBackup.code, 1);
  assert.match(weakBackup.stderr, /BACKUP_E_PKG_PASSPHRASE_WEAK/);
  assert.equal(packages(path.join(sourceDir, "exports")).length, packagesNow, "a weak passphrase publishes nothing");

  // Path tricks in the file name never reach the file system.
  for (const bad of ["../escape.stylepkg", "style-package-2026-01-01T00-00-00-000Z.stylepkg/../x", path.join(incoming, p2), "style-2026-01-01T00-00-00-000Z.db"]) {
    const d = freshDir(p2);
    assertNothingRestored(d, await restoreEncrypted(d, bad), "RESTORE_E_FILENAME");
  }
});

test("CLI: a link, a directory or a missing file in place of the package is refused", async () => {
  const name = "style-package-2026-03-01T00-00-00-000Z.stylepkg";
  const dirMissing = freshDir(p2);
  assertNothingRestored(dirMissing, await restoreEncrypted(dirMissing, name), "RESTORE_E_BACKUP_INVALID");

  const asDirectory = freshDir(p2);
  mkdirSync(path.join(asDirectory, "exports", name));
  assertNothingRestored(asDirectory, await restoreEncrypted(asDirectory, name), "RESTORE_E_BACKUP_INVALID");

  const asLink = freshDir(p2);
  try {
    symlinkSync(path.join(asLink, "exports", p2), path.join(asLink, "exports", name));
  } catch {
    return;
  }
  assertNothingRestored(asLink, await restoreEncrypted(asLink, name), "RESTORE_E_BACKUP_INVALID");
});

test("CLI: decrypted staging is removed when the shared restore refuses later (foreign database, stale ledger); a crashed staging leftover is swept", async () => {
  const { writePackage } = await import("../src/server/encryptedPackage");
  const { serializeLedger } = await import("../src/server/deletionLedger");
  const foreignDb = path.join(root, "foreign.db");
  const other = new DatabaseSync(foreignDb);
  other.exec("CREATE TABLE unrelated(x); INSERT INTO unrelated VALUES('FOREIGN-ROW-MARKER');");
  other.close();
  const madeAt = Date.parse("2026-04-01T00:00:00.000Z");
  const build = async (name: string, databaseFile: string, exportedAt: number) => {
    const dir = path.join(root, randomUUID());
    mkdirSync(path.join(dir, "exports"), { recursive: true });
    await writePackage({
      databaseFile,
      ledgerText: serializeLedger({ generation: 1, exportedAt, entries: [] }),
      backupCreatedAt: madeAt,
      passphrase: Buffer.from(PASSPHRASE),
      destination: path.join(dir, "exports", name),
      ...cleanOpts,
    });
    return dir;
  };

  // A genuine package of a database that is not this application's.
  const foreign = await build("style-package-2026-04-01T00-00-00-000Z.stylepkg", foreignDb, madeAt + 1000);
  const staleSetting = { STYLE_RESTORE_ACCEPT_STALE_LEDGER: "true" };
  assertNothingRestored(
    foreign,
    await restoreEncrypted(foreign, "style-package-2026-04-01T00-00-00-000Z.stylepkg", [], staleSetting),
    "RESTORE_E_BACKUP_INVALID",
  );

  // A genuine package whose ledger is older than the allowed age.
  const realDb = path.join(root, "real-copy.db");
  {
    // The encrypted command removes its ordinary backups, so take one directly.
    const { createBackup } = await import("../src/server/backupDatabase");
    const { getDatabase } = await import("../src/server/database");
    const staleSource = path.join(root, "stale-src");
    mkdirSync(staleSource, { recursive: true });
    const made = await createBackup(getDatabase(), { dataDir: staleSource });
    copyFileSync(path.join(staleSource, "backups", made.file), realDb);
  }
  const stale = await build("style-package-2026-04-01T00-00-00-000Z.stylepkg", realDb, madeAt + 1000);
  assertNothingRestored(
    stale,
    await restoreEncrypted(stale, "style-package-2026-04-01T00-00-00-000Z.stylepkg"),
    "RESTORE_E_LEDGER_STALE",
  );

  // A ledger older than its own backup is not a package this software makes.
  const inconsistent = await build("style-package-2026-04-01T00-00-00-000Z.stylepkg", realDb, madeAt - 1000);
  assertNothingRestored(
    inconsistent,
    await restoreEncrypted(inconsistent, "style-package-2026-04-01T00-00-00-000Z.stylepkg", [], staleSetting),
    "RESTORE_E_PACKAGE_INVALID",
  );

  // Leftover staging from a crashed restore: only the fixed pattern is swept.
  const crashed = freshDir(p2);
  const stagingDir = path.join(crashed, "restore-staging");
  mkdirSync(stagingDir);
  const owned = path.join(stagingDir, "package-0123456789abcdef.pending");
  const decoy = path.join(stagingDir, "package-notahexvalue.pending");
  writeFileSync(owned, "decrypted leftover");
  writeFileSync(decoy, "not ours");
  const ok = await restoreEncrypted(crashed, p2);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(existsSync(owned), false, "the owned leftover was swept");
  assert.equal(readFileSync(decoy, "utf8"), "not ours", "a non-matching name is untouched");
});

test("CLI: a process that still has the live database open makes the restore refuse before anything is decrypted or changed", async () => {
  const dir = freshDir(p2);
  assert.equal((await restoreEncrypted(dir, p2)).code, 0);
  const dbFile = path.join(dir, "app.db");
  const holder = forkHelper("tests/helpers/presenceChild.ts", { STYLE_DATA_DIR: dir });
  try {
    await holder.next((m) => m.ready === true);
    const unchanged = sha(dbFile);
    const refused = await restoreEncrypted(dir, p2);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /RESTORE_E_ACTIVE/);
    assert.equal(sha(dbFile), unchanged);
    assert.deepEqual(readdirSync(path.join(dir, "restore-staging")), [], "nothing was decrypted");
  } finally {
    holder.proc.kill("SIGKILL");
    await holder.exited;
  }
});

test("CLI: the restore needs explicit confirmation, like the plain restore", async () => {
  const dir = freshDir(p2);
  const result = await restoreEncrypted(dir, p2, [], { STYLE_RESTORE_CONFIRMED: "" });
  assertNothingRestored(dir, result, "RESTORE_E_CONFIRM");
});

test("no command output anywhere contained the passphrase, an email address or a user id", () => {
  assert.ok(outputs.length > 10, "the check saw real output");
  const joined = outputs.join("\n");
  for (const secret of [PASSPHRASE, WRONG, ...Object.values(emails), ...Object.values(ids), ...Object.values(pw)])
    assert.ok(!joined.includes(secret), `output leaked ${secret.slice(0, 6)}…`);
});
