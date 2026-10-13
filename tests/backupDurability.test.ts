import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BackupFailure,
  createBackup,
  FINAL_BACKUP,
  type BackupIo,
} from "../src/server/backupDatabase";
import { isUnsupportedSyncError } from "../src/server/durableFs";

/**
 * Build 010: backup durability, publication reporting, permissions and
 * rate-limit sanitising. The source is a plain SQLite file with the tables the
 * backup sanitises (the real application database is covered end to end in
 * restoreFresh.test.ts).
 *
 * I/O failures are INJECTED through BackupOptions.io because a real EIO cannot
 * be produced on demand. These tests prove how the backup REACTS to such an
 * error. They are not evidence about any file system.
 */

const MARKERS = [
  "PHOTO-MARKER-d1a2",
  "MAIL-MARKER-d1a2",
  "SESSION-MARKER-d1a2",
  "TOKEN-MARKER-d1a2",
  "203.0.113.9|/sign-in/email",
];
const COORDINATOR = ".backup-coordinator.db";

function setup() {
  const dir = path.join(process.cwd(), ".data", "tests", randomUUID());
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "app.db"));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE analysis_jobs(id TEXT, input_image BLOB);
    CREATE TABLE mail_outbox(id TEXT, body TEXT);
    CREATE TABLE verification(id TEXT, value TEXT);
    CREATE TABLE session(id TEXT, token TEXT);
    CREATE TABLE "rateLimit"(id TEXT, key TEXT, count INTEGER, lastRequest INTEGER);
    CREATE TABLE kept(v TEXT);
    INSERT INTO kept VALUES('kept-row');
  `);
  db.prepare("INSERT INTO analysis_jobs VALUES('j', ?)").run(Buffer.from(MARKERS[0]));
  db.prepare("INSERT INTO mail_outbox VALUES('m', ?)").run(MARKERS[1]);
  db.prepare("INSERT INTO session VALUES('s', ?)").run(MARKERS[2]);
  db.prepare("INSERT INTO verification VALUES('v', ?)").run(MARKERS[3]);
  db.prepare('INSERT INTO "rateLimit" VALUES(?,?,?,?)').run("r", MARKERS[4], 1, Date.now());
  const backups = path.join(dir, "backups");
  const listing = () =>
    existsSync(backups) ? readdirSync(backups).filter((n) => n !== COORDINATOR).sort() : [];
  const finals = () => listing().filter((n) => FINAL_BACKUP.test(n));
  const markersIn = () =>
    listing().filter((n) => {
      const bytes = readFileSync(path.join(backups, n));
      return MARKERS.some((m) => bytes.includes(m));
    });
  return { dir, db, backups, listing, finals, markersIn };
}
const failingWith = (code: string) => () => {
  throw Object.assign(new Error("injected"), { code });
};
function integrity(file: string): string {
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    return (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
      .integrity_check;
  } finally {
    copy.close();
  }
}

test("only 'this file system cannot fsync' is tolerated; I/O failures are not", () => {
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])
    assert.equal(isUnsupportedSyncError(Object.assign(new Error("x"), { code })), true, code);
  for (const code of ["EIO", "ENOSPC", "EDQUOT", "EROFS", "EACCES", "EBADF"])
    assert.equal(isUnsupportedSyncError(Object.assign(new Error("x"), { code })), false, code);
  assert.equal(isUnsupportedSyncError(new Error("no code")), false);
  assert.equal(isUnsupportedSyncError(null), false);
  assert.equal(isUnsupportedSyncError("EIO"), false);
});

test("a real I/O error while flushing the backup file fails the backup: nothing published, no partial, no sensitive bytes", async () => {
  const s = setup();
  try {
    await assert.rejects(
      createBackup(s.db, { dataDir: s.dir, io: { syncFile: failingWith("EIO") } }),
      (error: unknown) => error instanceof BackupFailure && error.leftovers.length === 0,
    );
    assert.deepEqual(s.listing(), []);
    assert.deepEqual(s.markersIn(), []);
  } finally {
    s.db.close();
  }
});

test("a file system that cannot fsync is tolerated and reported as a platform limit, not as a failure", async () => {
  const s = setup();
  try {
    const result = await createBackup(s.db, {
      dataDir: s.dir,
      io: { syncFile: () => "unsupported" },
    });
    assert.equal(result.durable, true);
    assert.ok(result.warnings.includes("BACKUP_W_FILE_SYNC_UNSUPPORTED"));
    assert.deepEqual(s.finals(), [result.file]);
    assert.equal(integrity(path.join(s.backups, result.file)), "ok");
  } finally {
    s.db.close();
  }
});

test("a real I/O error flushing the directory after publication keeps the verified backup but reports it as not durable, and old backups are not pruned", async () => {
  const s = setup();
  try {
    mkdirSync(s.backups, { recursive: true });
    const old = path.join(s.backups, "style-2020-01-01T00-00-00-000Z.db");
    writeFileSync(old, "old backup stand-in");
    const long = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(old, long, long);

    const result = await createBackup(s.db, {
      dataDir: s.dir,
      io: { syncDirectory: failingWith("EIO") },
    });
    assert.equal(result.durable, false);
    assert.ok(result.warnings.includes("BACKUP_W_DIR_SYNC_FAILED"));
    assert.deepEqual(result.leftovers, []);
    assert.equal(integrity(path.join(s.backups, result.file)), "ok", "the published file is complete");
    assert.ok(!s.listing().some((n) => n.endsWith(".partial")), "no partial remains");
    assert.deepEqual(s.markersIn(), []);
    assert.ok(existsSync(old), "retention waits until a backup is known to be durable");

    const next = await createBackup(s.db, { dataDir: s.dir });
    assert.equal(next.durable, true);
    assert.ok(!existsSync(old), "the next durable backup applies retention");
  } finally {
    s.db.close();
  }
});

test("a platform that cannot flush a directory is reported as a limit and does not block retention", async () => {
  const s = setup();
  try {
    mkdirSync(s.backups, { recursive: true });
    const old = path.join(s.backups, "style-2020-01-01T00-00-00-000Z.db");
    writeFileSync(old, "old backup stand-in");
    const long = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(old, long, long);
    const result = await createBackup(s.db, {
      dataDir: s.dir,
      io: { syncDirectory: () => "unsupported" },
    });
    assert.equal(result.durable, true);
    assert.ok(result.warnings.includes("BACKUP_W_DIR_SYNC_UNSUPPORTED"));
    assert.ok(!existsSync(old));
  } finally {
    s.db.close();
  }
});

test("the real flushes: a platform that can flush a directory does so; Windows reports the documented limit", async () => {
  const s = setup();
  try {
    const result = await createBackup(s.db, { dataDir: s.dir });
    assert.equal(result.durable, true);
    if (process.platform === "win32")
      assert.deepEqual(result.warnings, ["BACKUP_W_DIR_SYNC_UNSUPPORTED"]);
    else assert.deepEqual(result.warnings, []);
  } finally {
    s.db.close();
  }
});

/**
 * Capability probe: can THIS environment create a hard link in the test area?
 * (Root's environment answers EPERM, so production correctly takes its
 * check-then-rename fallback there and the native branch cannot run.) The
 * native-branch test below is skipped, with this reason, where links are
 * refused; the fallback is then tested for real, and the link-success /
 * unlink-failure reaction is tested with an injected stand-in.
 */
const hardLinkProbe = (() => {
  const dir = path.join(process.cwd(), ".data", "tests", randomUUID());
  mkdirSync(dir, { recursive: true });
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  writeFileSync(a, "x");
  try {
    linkSync(a, b);
    return { ok: true as const, reason: "" };
  } catch (error) {
    return { ok: false as const, reason: String((error as NodeJS.ErrnoException).code) };
  }
})();

test(
  "NATIVE hard-link publication: when the partial's name cannot be removed after the final name exists, the backup is reported as published with the leftover named, not as failed; the next backup sweeps it",
  {
    skip: hardLinkProbe.ok
      ? false
      : `hard links are refused here (${hardLinkProbe.reason}); the native branch cannot run. See the fallback test and the injected reaction test`,
  },
  async () => {
  const s = setup();
  try {
    const failUnlink: Partial<BackupIo> = { unlinkPartial: failingWith("EIO") };
    const result = await createBackup(s.db, { dataDir: s.dir, io: failUnlink });
    assert.equal(result.durable, true);
    assert.deepEqual(s.finals(), [result.file], "the final file exists");
    assert.equal(integrity(path.join(s.backups, result.file)), "ok");
    assert.equal(result.leftovers.length, 1);
    const [leftover] = result.leftovers;
    assert.ok(leftover.endsWith(".partial"));
    assert.ok(existsSync(path.join(s.backups, leftover)), "the leftover really is there");
    assert.deepEqual(s.markersIn(), [], "it holds the sanitised copy only");

    const next = await createBackup(s.db, { dataDir: s.dir });
    assert.deepEqual(next.leftovers, []);
    assert.ok(!existsSync(path.join(s.backups, leftover)), "swept by the next backup");
    assert.equal(s.finals().length, 2);
  } finally {
    s.db.close();
  }
  },
);

test(
  "REAL fallback: where this environment refuses hard links, publication uses rename, the partial name is gone, nothing is left over, and the unlink step never runs",
  {
    skip: hardLinkProbe.ok
      ? "hard links work here, so the native branch is what runs (see the native test)"
      : false,
  },
  async () => {
    const s = setup();
    try {
      let unlinkCalls = 0;
      const result = await createBackup(s.db, {
        dataDir: s.dir,
        io: {
          unlinkPartial: () => {
            unlinkCalls++;
            throw Object.assign(new Error("injected"), { code: "EIO" });
          },
        },
      });
      assert.equal(unlinkCalls, 0, "link failed for real, so the post-link unlink was never reached");
      assert.deepEqual(result.leftovers, []);
      assert.equal(result.durable, true);
      assert.deepEqual(s.finals(), [result.file]);
      assert.ok(!s.listing().some((n) => n.includes(".partial")), "the rename moved the partial");
      assert.equal(integrity(path.join(s.backups, result.file)), "ok");
    } finally {
      s.db.close();
    }
  },
);

test("REACTION (injected link refusal, any platform): a refused hard link falls back to rename and the backup is complete with no leftover", async () => {
  const s = setup();
  try {
    let linkCalls = 0;
    let unlinkCalls = 0;
    const result = await createBackup(s.db, {
      dataDir: s.dir,
      io: {
        linkFile: () => {
          linkCalls++;
          throw Object.assign(new Error("injected"), { code: "EPERM" });
        },
        unlinkPartial: () => {
          unlinkCalls++;
        },
      },
    });
    assert.equal(linkCalls, 1);
    assert.equal(unlinkCalls, 0);
    assert.deepEqual(result.leftovers, []);
    assert.deepEqual(s.finals(), [result.file]);
    assert.ok(!s.listing().some((n) => n.includes(".partial")));
    assert.equal(integrity(path.join(s.backups, result.file)), "ok");
  } finally {
    s.db.close();
  }
});

test("REACTION (injected; a copy stands in for the link, so this is NOT hard-link or file-system proof): link succeeds, removing the partial name fails -> published with the leftover named, durable, next backup sweeps it; a taken name moves on to -1", async () => {
  const s = setup();
  try {
    let taken = true;
    const result = await createBackup(s.db, {
      dataDir: s.dir,
      io: {
        linkFile: (existing, target) => {
          if (taken) {
            taken = false;
            throw Object.assign(new Error("injected"), { code: "EEXIST" });
          }
          copyFileSync(existing, target);
        },
        unlinkPartial: failingWith("EIO"),
      },
    });
    assert.match(result.file, /-1\.db$/, "the first name was reported taken");
    assert.equal(result.durable, true);
    assert.deepEqual(s.finals(), [result.file]);
    assert.equal(integrity(path.join(s.backups, result.file)), "ok");
    assert.equal(result.leftovers.length, 1);
    const [leftover] = result.leftovers;
    assert.ok(leftover.endsWith(".partial"));
    assert.ok(existsSync(path.join(s.backups, leftover)), "the leftover really is there");
    assert.deepEqual(s.markersIn(), [], "it holds the sanitised copy only");

    const next = await createBackup(s.db, { dataDir: s.dir });
    assert.deepEqual(next.leftovers, []);
    assert.ok(!existsSync(path.join(s.backups, leftover)), "swept by the next backup");
    assert.equal(s.finals().length, 2);
  } finally {
    s.db.close();
  }
});

test("rate-limit rows (client addresses) never reach a completed backup; the table is kept, empty", async () => {
  const s = setup();
  try {
    const result = await createBackup(s.db, { dataDir: s.dir });
    assert.deepEqual(s.markersIn(), []);
    const copy = new DatabaseSync(path.join(s.backups, result.file), { readOnly: true });
    try {
      assert.equal(
        (copy.prepare('SELECT COUNT(*) AS n FROM "rateLimit"').get() as { n: number }).n,
        0,
      );
      assert.equal(
        (copy.prepare("SELECT COUNT(*) AS n FROM kept").get() as { n: number }).n,
        1,
        "ordinary data is kept",
      );
    } finally {
      copy.close();
    }
    assert.equal(
      (s.db.prepare('SELECT COUNT(*) AS n FROM "rateLimit"').get() as { n: number }).n,
      1,
      "the live table is untouched",
    );
  } finally {
    s.db.close();
  }
});

test(
  "POSIX: a pre-existing wide backups directory is narrowed to 0700 (that directory only) and the backup files are owner-only",
  { skip: process.platform === "win32" ? "POSIX mode bits do not exist on Windows" : false },
  async () => {
    const s = setup();
    try {
      mkdirSync(s.backups, { recursive: true });
      chmodSync(s.backups, 0o755);
      const stranger = path.join(s.backups, "style-2020-02-02T00-00-00-000Z.db");
      writeFileSync(stranger, "an existing file");
      chmodSync(stranger, 0o644);
      const result = await createBackup(s.db, { dataDir: s.dir });
      assert.equal(lstatSync(s.backups).mode & 0o077, 0, "the directory is owner-only");
      assert.equal(
        lstatSync(path.join(s.backups, result.file)).mode & 0o077,
        0,
        "the new backup is owner-only",
      );
      assert.equal(
        lstatSync(stranger).mode & 0o777,
        0o644,
        "files that were already there are not touched",
      );
    } finally {
      s.db.close();
    }
  },
);
