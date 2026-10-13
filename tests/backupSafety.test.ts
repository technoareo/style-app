import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Build 009, C2: failure-safe, serialised backups. Failure injection uses the
 * createBackup() stage hook (a throw there is a failure at that point); the
 * kill and same-millisecond cases use real child processes
 * (tests/helpers/backupChild.ts). Markers are distinctive byte strings placed
 * in every table the backup must sanitise; "no marker" means no file under
 * backups/ contains the bytes at all.
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dataDir, { recursive: true });
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
delete process.env.STYLE_PUBLIC_DEPLOYMENT;
delete process.env.SMTP_URL;

const MARKERS = {
  photo: "PHOTO-MARKER-7f3a91c2",
  mail: "MAIL-MARKER-b81d44e0",
  session: "SESSION-MARKER-0c5e9a17",
  token: "TOKEN-MARKER-62d1f8ab",
};
const backupsDir = path.join(dataDir, "backups");

type Backup = typeof import("../src/server/backupDatabase");
let b: Backup;
let db: DatabaseSync;
let userId = "";

const FINAL = /^style-[0-9TZ.-]+\.db$/;
// The coordinator database (the OS lock's anchor, always empty) legitimately
// stays between backups; every listing below ignores it.
const COORDINATOR = ".backup-coordinator.db";
const rawListing = () => (existsSync(backupsDir) ? readdirSync(backupsDir).sort() : []);
const listing = () => rawListing().filter((n) => n !== COORDINATOR);
const finals = () => listing().filter((f) => FINAL.test(f));
const partials = () => listing().filter((f) => /\.partial/.test(f));
function filesWithMarkers(): string[] {
  const hits: string[] = [];
  for (const name of listing()) {
    const full = path.join(backupsDir, name);
    if (!lstatSync(full).isFile()) continue;
    const bytes = readFileSync(full);
    if (Object.values(MARKERS).some((m) => bytes.includes(m))) hits.push(name);
  }
  return hits;
}
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
function run(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script, ...args],
      { cwd: process.cwd(), env: { ...process.env, STYLE_DATA_DIR: dataDir, ...env }, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (error as { code?: unknown }).code : 0;
        if (typeof code !== "number") return reject(error);
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
const child = (env: Record<string, string>) =>
  run("tests/helpers/backupChild.ts", [], env);
const lines = (out: string) =>
  JSON.parse(out.trim().split("\n").filter(Boolean).at(-1)!) as {
    startedAt: number;
    rawCopiedAt: number;
    doneAt: number;
    file?: string;
    leftovers: string[];
    error?: string;
  };

before(async () => {
  const { getReadyAuth } = await import("../src/server/auth");
  const auth = await getReadyAuth();
  db = (await import("../src/server/database")).getDatabase();
  b = await import("../src/server/backupDatabase");
  userId = (
    await auth.api.signUpEmail({
      body: {
        email: "backup-safety@example.test",
        name: "Backup safety",
        password: "Backup safety passphrase 38!",
      },
    })
  ).user.id;
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const later = new Date(now + 3_600_000).toISOString();
  db.exec("DELETE FROM mail_outbox");
  db.prepare(
    "INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)",
  ).run("kept-photo", userId, Buffer.from("kept-photo-bytes"), "sha", now);
  db.prepare(
    "INSERT INTO analysis_jobs(id,user_id,status,input_image,created_at,expires_at) VALUES(?,?,'queued',?,?,?)",
  ).run("job-1", userId, Buffer.from(MARKERS.photo), now, now + 3_600_000);
  db.prepare(
    "INSERT INTO mail_outbox(id,user_id,kind,recipient_key,to_address,subject,text_body,html_body,status,attempts,created_at,expires_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,'queued',0,?,?,?)",
  ).run(
    "mail-1",
    userId,
    "reset-password",
    "key",
    "backup-safety@example.test",
    "Reset",
    `Reset: https://example.test/${MARKERS.mail}`,
    `<p>${MARKERS.mail}</p>`,
    now,
    now + 3_600_000,
    now + 3_600_000,
  );
  db.prepare(
    "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)",
  ).run("session-1", later, MARKERS.session, iso, iso, userId);
  db.prepare(
    "INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
  ).run("verification-1", `reset-password:${MARKERS.token}`, userId, later, iso, iso);
});

after(async () => {
  (await import("../src/server/database")).closeDatabases();
});

function resetBackups() {
  for (const name of rawListing()) {
    const full = path.join(backupsDir, name);
    const info = lstatSync(full);
    if (info.isDirectory() && !info.isSymbolicLink()) rmdirSync(full);
    else unlinkSync(full);
  }
}

test("a completed backup is sanitised, verified and published under a final name only", async () => {
  resetBackups();
  const result = await b.createBackup(db, { dataDir });
  assert.match(result.file, FINAL);
  assert.deepEqual(result.leftovers, []);
  assert.deepEqual(listing(), [result.file], "no partial, sidecar or lock left behind");
  assert.deepEqual(filesWithMarkers(), [], "no marker bytes in any file");
  const copy = new DatabaseSync(path.join(backupsDir, result.file), { readOnly: true });
  try {
    for (const table of ["analysis_jobs", "mail_outbox", "verification", "session"])
      assert.equal(
        (copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        0,
        `${table} emptied in the backup`,
      );
    assert.ok(copy.prepare("SELECT id FROM photo_assets WHERE id='kept-photo'").get());
    assert.equal(
      (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
  } finally {
    copy.close();
  }
  assert.equal(count("analysis_jobs"), 1, "the live database was not touched");
  assert.equal(count("session"), 1);
});

test("a failure at any stage leaves no final file, no partial and no marker bytes, and keeps the earlier backup and the live data", async () => {
  resetBackups();
  const prior = await b.createBackup(db, {
    dataDir,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    retentionMs: 10 * 365 * 86_400_000,
  });
  const priorBytes = readFileSync(path.join(backupsDir, prior.file));
  for (const stage of ["raw-copied", "sanitized", "vacuumed", "verified"] as const) {
    await assert.rejects(
      b.createBackup(db, {
        dataDir,
        retentionMs: 10 * 365 * 86_400_000,
        onStage: (s) => {
          if (s === stage) throw new Error(`injected failure after ${stage}`);
        },
      }),
      (error: unknown) =>
        error instanceof b.BackupFailure && error.leftovers.length === 0,
      stage,
    );
    assert.deepEqual(listing(), [prior.file], `only the earlier backup remains after ${stage}`);
    assert.deepEqual(filesWithMarkers(), [], `no marker bytes after ${stage}`);
    assert.ok(
      readFileSync(path.join(backupsDir, prior.file)).equals(priorBytes),
      "the earlier backup is byte-identical",
    );
  }
  assert.equal(count("analysis_jobs"), 1);
  assert.equal(count("mail_outbox"), 1);
  assert.equal(
    (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
    "ok",
  );
});

test("pruning happens only after a backup completed", async () => {
  resetBackups();
  const old = path.join(backupsDir, "style-2020-01-01T00-00-00-000Z.db");
  writeFileSync(old, "old backup stand-in");
  const long = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(old, long, long);
  await assert.rejects(
    b.createBackup(db, {
      dataDir,
      onStage: (s) => {
        if (s === "vacuumed") throw new Error("injected");
      },
    }),
  );
  assert.ok(existsSync(old), "a failed backup prunes nothing");
  const done = await b.createBackup(db, { dataDir });
  assert.ok(!existsSync(old), "a completed backup applies the 7-day retention");
  assert.deepEqual(finals(), [done.file]);
});

test("a cleanup that cannot remove the partial says so instead of claiming it is gone", async () => {
  resetBackups();
  let blocked = "";
  await assert.rejects(
    b.createBackup(db, {
      dataDir,
      onStage: (s) => {
        if (s !== "raw-copied") return;
        // Replace the partial with a directory of the same name: the cleanup
        // refuses to remove directories, as it must.
        blocked = partials()[0];
        unlinkSync(path.join(backupsDir, blocked));
        mkdirSync(path.join(backupsDir, blocked));
        throw new Error("injected");
      },
    }),
    (error: unknown) =>
      error instanceof b.BackupFailure &&
      error.leftovers.includes(blocked) &&
      /could not be removed/.test(error.message),
  );
  assert.ok(blocked.endsWith(".partial"));
  // The next backup reports it too, rather than silently succeeding.
  const result = await b.createBackup(db, { dataDir });
  assert.deepEqual(result.leftovers, [blocked]);
  assert.match(result.file, FINAL);
  rmdirSync(path.join(backupsDir, blocked));
  resetBackups();
});

// Ownership is an OS file lock held by the backup process: there is no lease,
// no timestamp and no "stale" judgement, so nothing here is shortened or
// time-compressed. The waits below are only for processes to reach a point.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A backup child with an IPC channel; `raw` resolves when it reaches the raw-copied stage. */
function forkBackup(env: Record<string, string>) {
  const proc = fork(path.join(process.cwd(), "tests", "helpers", "backupChild.ts"), [], {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    env: { ...process.env, STYLE_DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let stdout = "";
  let reached = false;
  proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  const raw = new Promise<void>((resolve, reject) => {
    proc.on("message", () => {
      reached = true;
      resolve();
    });
    proc.on("exit", () => reject(new Error("the child exited before the raw-copied stage")));
  });
  raw.catch(() => {});
  // "close", not "exit": it fires after the child's stdout has been read.
  const exited = new Promise<number | null>((resolve) => proc.on("close", resolve));
  const result = () =>
    JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      startedAt: number;
      rawCopiedAt: number;
      doneAt: number;
      file?: string;
      leftovers: string[];
    };
  return { proc, raw, exited, stdout: () => stdout, reached: () => reached, result };
}

test("a killed owner leaves only a partial that restore refuses; its lock dies with it, the next backup takes over at once and removes the dead partial", async () => {
  resetBackups();
  const prior = await b.createBackup(db, {
    dataDir,
    now: () => new Date("2026-02-02T00:00:00.000Z"),
    retentionMs: 10 * 365 * 86_400_000,
  });
  // The child reports the raw-copied stage over IPC and then waits; the PARENT
  // kills it with SIGKILL (TerminateProcess on Windows): no exit hooks, no
  // signal handlers, no cleanup of any kind runs in the child.
  const owner = forkBackup({ TEST_BACKUP_BLOCK_MS: "120000" });
  await owner.raw;
  const leftover = partials().find((n) => n.endsWith(".partial"))!;
  assert.ok(leftover, "the owner's partial exists");
  // While the owner lives, nobody else can have the lock.
  await assert.rejects(
    b.createBackup(db, { dataDir, lockWaitMs: 0 }),
    /Another backup is running/,
  );
  assert.ok(existsSync(path.join(backupsDir, leftover)), "a live owner's partial is not touched");
  owner.proc.kill("SIGKILL");
  await owner.exited;
  assert.deepEqual(finals(), [prior.file], "no final file from the killed run");
  assert.doesNotMatch(leftover, FINAL, "not a restore or retention candidate");
  assert.ok(existsSync(path.join(backupsDir, leftover)), "the killed run left its partial");

  // The restore command refuses it by name.
  const restore = await run("scripts/restore-database.ts", [leftover], {
    STYLE_RESTORE_CONFIRMED: "true",
  });
  assert.equal(restore.code, 1);
  assert.equal(count("user"), 1, "the live database is untouched");

  // The kernel released the dead process's lock: no lease to wait out. (A few
  // seconds of waiting are allowed only for the operating system to finish
  // tearing the killed process down.)
  const began = Date.now();
  const next = await b.createBackup(db, { dataDir, lockWaitMs: 5_000 });
  assert.ok(Date.now() - began < 5_000, "taken over without waiting for any lease");
  assert.deepEqual(next.leftovers, []);
  assert.ok(!existsSync(path.join(backupsDir, leftover)), "the dead partial was removed");
  assert.deepEqual(finals().sort(), [prior.file, next.file].sort());
  assert.deepEqual(filesWithMarkers(), [], "no marker bytes remain anywhere");
});

test("two contenders waiting on a live owner cannot take its lock; when it is killed they proceed one at a time and both succeed", async () => {
  resetBackups();
  const owner = forkBackup({ TEST_BACKUP_BLOCK_MS: "120000" });
  await owner.raw;
  const ownersPartial = partials().find((n) => n.endsWith(".partial"))!;
  // Two other backups start while the owner is alive and wait for the lock.
  const env = { TEST_BACKUP_HOLD_MS: "1500", TEST_BACKUP_WAIT_MS: "90000" };
  const b1 = forkBackup(env);
  const b2 = forkBackup(env);
  await sleep(4_000); // long enough for both to have started and be waiting
  assert.equal(b1.reached(), false, "contender 1 cannot start while the owner lives");
  assert.equal(b2.reached(), false, "contender 2 cannot start while the owner lives");
  assert.ok(existsSync(path.join(backupsDir, ownersPartial)), "the owner's partial is intact");

  const killedAt = Date.now();
  owner.proc.kill("SIGKILL");
  assert.equal(await b1.exited, 0, b1.stdout());
  assert.equal(await b2.exited, 0, b2.stdout());
  await owner.exited;
  const [first, second] = [b1.result(), b2.result()].sort(
    (p, q) => p.rawCopiedAt - q.rawCopiedAt,
  );
  assert.ok(first.rawCopiedAt >= killedAt, "neither started before the owner died");
  // One at a time: the second copies only after the first has finished, and
  // both were waiting (started) well before that.
  assert.ok(second.rawCopiedAt >= first.doneAt - 50, "the contenders did not overlap");
  assert.ok(second.startedAt < first.rawCopiedAt, "both were contenders for the same release");
  assert.ok(!existsSync(path.join(backupsDir, ownersPartial)), "the dead owner's partial was removed");
  assert.equal(finals().length, 2, "each contender produced its own backup");
  assert.ok(finals().includes(first.file!) && finals().includes(second.file!));
  assert.deepEqual(partials(), []);
  assert.deepEqual(filesWithMarkers(), []);
});

test("the lock module: a second holder is refused while the first lives (same process too), granted after release, and the coordinator file is guarded", async () => {
  resetBackups();
  const { acquireProcessLock, LockBusyError } = await import("../src/server/directoryLock");
  const file = path.join(backupsDir, ".backup-coordinator.db");
  const first = await acquireProcessLock(file, { waitMs: 0 });
  first.assertHeld();
  await assert.rejects(acquireProcessLock(file, { waitMs: 0 }), LockBusyError);
  // A waiter is released when the holder lets go, not before.
  let granted = false;
  const waiter = acquireProcessLock(file, { waitMs: 5_000, pollMs: 20 }).then((l) => {
    granted = true;
    return l;
  });
  await sleep(300);
  assert.equal(granted, false);
  first.release();
  const second = await waiter;
  second.assertHeld();
  assert.throws(() => first.assertHeld(), /not held/);
  second.release();
  const third = await acquireProcessLock(file, { waitMs: 0 });
  third.release();

  // A coordinator "file" that is a link is refused, and its target untouched.
  unlinkSync(file);
  const outsideFile = path.join(process.cwd(), ".data", "tests", `${randomUUID()}.txt`);
  writeFileSync(outsideFile, "outside canary");
  try {
    symlinkSync(outsideFile, file);
  } catch {
    console.warn("Skipped coordinator link guard: this account may not create links.");
    return;
  }
  await assert.rejects(acquireProcessLock(file, { waitMs: 0 }), /not a plain file/);
  assert.equal(readFileSync(outsideFile, "utf8"), "outside canary");
  unlinkSync(file);
});

test("a LIVE owner whose main thread is blocked for a long time keeps its lock and its partial and completes (the first 009 failure)", async () => {
  resetBackups();
  const BLOCK_MS = 7_000;
  const owner = forkBackup({ TEST_BACKUP_BLOCK_MS: String(BLOCK_MS) });
  await owner.raw;
  const partial = partials().find((n) => n.endsWith(".partial"))!;
  assert.ok(partial);
  // The owner's main thread is now blocked in native code (Atomics.wait stands
  // in for VACUUM). However long that lasts, the OS lock is still its own.
  await sleep(4_000);
  assert.ok(existsSync(path.join(backupsDir, partial)), "the active partial is still there");
  await assert.rejects(
    b.createBackup(db, { dataDir, lockWaitMs: 0 }),
    /Another backup is running/,
    "a second backup is refused",
  );
  assert.ok(existsSync(path.join(backupsDir, partial)), "and it did not remove the owner's partial");

  // The owner wakes, still holds its lock, and finishes normally.
  assert.equal(await owner.exited, 0, owner.stdout());
  const done = owner.result();
  assert.ok(done.doneAt - done.rawCopiedAt >= BLOCK_MS - 200, "the block really lasted");
  assert.deepEqual(finals(), [done.file]);
  assert.deepEqual(partials(), []);
  assert.deepEqual(filesWithMarkers(), []);
  // And the lock is free again.
  const after = await b.createBackup(db, { dataDir, lockWaitMs: 0 });
  assert.equal(finals().length, 2);
  assert.ok(finals().includes(after.file));
});

test("publication never replaces an existing backup, even when the name is taken at the last moment", async () => {
  resetBackups();
  const stamp = "2026-05-05T05:05:05.005Z";
  const sameName = `style-${stamp.replace(/[:.]/g, "-")}.db`;
  const sentinel = Buffer.from("LATE-ARRIVING-BACKUP-SENTINEL");
  await b.createBackup(db, {
    dataDir,
    now: () => new Date(stamp),
    onStage: (s) => {
      // After the name was (conceptually) free, another writer takes it.
      if (s === "verified") writeFileSync(path.join(backupsDir, sameName), sentinel);
    },
  });
  assert.ok(readFileSync(path.join(backupsDir, sameName)).equals(sentinel), "the existing file is untouched");
  assert.deepEqual(
    finals().sort(),
    [sameName, sameName.replace(/\.db$/, "-1.db")].sort(),
  );
  assert.deepEqual(partials(), []);
});

test("two backups started in the same millisecond are serialised and never replace an earlier backup", async () => {
  resetBackups();
  const stamp = "2026-03-03T03:03:03.003Z";
  const sameName = `style-${stamp.replace(/[:.]/g, "-")}.db`;
  const sentinel = Buffer.from("EARLIER-COMPLETED-BACKUP-SENTINEL");
  writeFileSync(path.join(backupsDir, sameName), sentinel);
  const env = { TEST_BACKUP_STAMP: stamp, TEST_BACKUP_HOLD_MS: "3000" };
  const [x, y] = await Promise.all([child(env), child(env)]);
  assert.equal(x.code, 0, x.stderr);
  assert.equal(y.code, 0, y.stderr);
  const [first, second] = [lines(x.stdout), lines(y.stdout)].sort(
    (p, q) => p.rawCopiedAt - q.rawCopiedAt,
  );
  assert.ok(
    second.startedAt < first.doneAt,
    "the two processes really overlapped in time",
  );
  // 50 ms tolerance: doneAt is taken just after the first process returned
  // from the call that released the lock, and the second needs at least a
  // lock poll and a file copy after that release.
  assert.ok(
    second.rawCopiedAt >= first.doneAt - 50,
    "the second backup did not start copying until the first had finished",
  );
  assert.ok(
    second.rawCopiedAt - first.rawCopiedAt >= 2_500,
    "the first backup's 3 s hold was not overlapped by the second's copy",
  );
  assert.ok(
    readFileSync(path.join(backupsDir, sameName)).equals(sentinel),
    "the earlier completed backup is byte-identical",
  );
  const stampBase = sameName.replace(/\.db$/, "");
  assert.deepEqual(
    finals().sort(),
    [sameName, `${stampBase}-1.db`, `${stampBase}-2.db`].sort(),
    "each new backup got its own unused name inside the restore pattern",
  );
  assert.deepEqual(partials(), []);
  assert.deepEqual(filesWithMarkers(), []);
  for (const name of [`${stampBase}-1.db`, `${stampBase}-2.db`]) {
    const copy = new DatabaseSync(path.join(backupsDir, name), { readOnly: true });
    try {
      assert.equal(
        (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
        "ok",
      );
    } finally {
      copy.close();
    }
  }
});

test("physical path guards: a linked backups directory is refused and a linked partial name is unlinked without touching its target", async () => {
  // 1. backups/ itself is a link: refused, nothing written outside.
  const other = path.join(process.cwd(), ".data", "tests", randomUUID());
  const outside = path.join(other, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "canary.txt"), "outside canary");
  try {
    symlinkSync(outside, path.join(other, "backups"), "junction");
  } catch {
    console.warn("Skipped link guards: this account may not create links.");
    return;
  }
  await assert.rejects(
    b.createBackup(db, { dataDir: other }),
    /not a plain directory/,
  );
  assert.deepEqual(readdirSync(outside), ["canary.txt"]);

  // 2. a link that carries a partial's name is removed as a link.
  resetBackups();
  const target = path.join(outside, "target-dir");
  mkdirSync(target);
  writeFileSync(path.join(target, "canary2.txt"), "second canary");
  const linkName = "style-2026-04-04T00-00-00-000Z.abcdef012345.partial";
  symlinkSync(target, path.join(backupsDir, linkName), "junction");
  const result = await b.createBackup(db, { dataDir });
  assert.deepEqual(result.leftovers, []);
  assert.ok(!existsSync(path.join(backupsDir, linkName)), "the link was removed");
  assert.equal(readFileSync(path.join(target, "canary2.txt"), "utf8"), "second canary");
  assert.equal(readFileSync(path.join(outside, "canary.txt"), "utf8"), "outside canary");
  resetBackups();
});
