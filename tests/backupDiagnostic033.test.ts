import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  BackupCopyResetError,
  BackupFailure,
  COPY_MAX_ATTEMPTS,
  COPY_RETRY_DELAYS_MS,
  createBackup,
  isUpstreamBackupBusyBug,
  type BackupIo,
  type BackupStage,
} from "../src/server/backupDatabase";

/**
 * Build 033. Upstream Node.js bug nodejs/node#66760 (fixed on main by #66769, commit d630b5d; NOT in v24.22.2, the
 * version that failed our Linux CI): when sqlite3_backup_step() first returns SQLITE_BUSY or SQLITE_LOCKED because
 * the source connection overlaps a write transaction, backup() fails with `code === "ERR_SQLITE_ERROR"`, numeric
 * `errcode === 0` and the message "not an error". createBackup works around it by retrying ONLY the raw copy, a
 * bounded number of times, and ONLY for that exact code + errcode signature. These tests inject that error at the
 * raw-copy seam (`io.copyRaw`) and prove the retry contract, the cleanup of every attempt, the bound, that nothing
 * else is retried, and the hardened failure diagnostic. The upstream bug itself is not reproduced here (it needs an
 * affected Node and a real overlap); that was reproduced separately by root.
 */

const MARKER = "SECRET-ROW-MARKER-4c1d";
const GARBAGE = "GARBAGE-LEFTOVER-OF-A-FAILED-ATTEMPT";
const BUG = () => Object.assign(new Error("not an error"), { code: "ERR_SQLITE_ERROR", errcode: 0 });
const realCopy: BackupIo["copyRaw"] = (source, target) => backup(source, target, { rate: 1_000_000 });

function setup() {
  const dir = path.join(process.cwd(), ".data", "tests", `diag033-${randomUUID()}`);
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
  db.prepare("INSERT INTO session VALUES('s', ?)").run(MARKER);
  const backups = path.join(dir, "backups");
  return {
    db,
    dir,
    backups,
    listing: () => (existsSync(backups) ? readdirSync(backups).filter((n) => !n.startsWith(".backup-coordinator")) : []),
  };
}

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const POSIX_MODES = process.platform !== "win32"; // mode bits are meaningful only off Windows

type Seen = { calls: number; targetSizes: number[]; sidecars: string[][]; modes: Array<number | null>; sleeps: number[] };

/**
 * A copyRaw that follows `script` (one entry per call: an error to throw, or "real"). Each call first records what
 * the attempt was handed (target size, which sidecars exist, the target's permission bits off Windows). A failing
 * attempt leaves garbage in the partial AND in all three sidecars, as a half-finished SQLite copy could.
 */
function scripted(script: Array<"real" | unknown>, seen: Seen): Partial<BackupIo> {
  return {
    copyRaw: async (source, target) => {
      seen.targetSizes.push(statSync(target).size);
      seen.sidecars.push(SIDECAR_SUFFIXES.filter((suffix) => existsSync(target + suffix)));
      seen.modes.push(POSIX_MODES ? statSync(target).mode & 0o777 : null);
      const step = script[Math.min(seen.calls, script.length - 1)];
      seen.calls++;
      if (step === "real") return realCopy(source, target);
      writeFileSync(target, GARBAGE);
      for (const suffix of SIDECAR_SUFFIXES) writeFileSync(target + suffix, GARBAGE);
      throw step;
    },
    sleep: async (ms) => void seen.sleeps.push(ms),
  };
}
const newSeen = (): Seen => ({ calls: 0, targetSizes: [], sidecars: [], modes: [], sleeps: [] });

/** Removes a partial and its sidecars the way production does, for a seam that fakes a failure only on chosen calls. */
const removeForReal = (dir: string, name: string): string[] => {
  const left: string[] = [];
  for (const entry of readdirSync(dir))
    if (entry === name || SIDECAR_SUFFIXES.some((suffix) => entry === name + suffix)) {
      try {
        rmSync(path.join(dir, entry), { force: true });
      } catch {
        left.push(entry);
      }
    }
  return left;
};

// ------------------------------------------------------------------ the classifier

test("only the exact upstream signature is recognised: code ERR_SQLITE_ERROR and numeric errcode 0, never the message", () => {
  assert.equal(isUpstreamBackupBusyBug(BUG()), true);
  assert.equal(isUpstreamBackupBusyBug({ code: "ERR_SQLITE_ERROR", errcode: 0 }), true, "no message needed");
  const no: unknown[] = [
    new Error("not an error"), // the message alone is NOT the signature
    Object.assign(new Error("not an error"), { code: "ERR_SQLITE_ERROR" }), // no errcode
    Object.assign(new Error("not an error"), { code: "ERR_SQLITE_ERROR", errcode: 1 }),
    Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
    Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode: "0" }),
    Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode: NaN }),
    Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode: Infinity }),
    Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode: -1 }),
    Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode: 0.5 }),
    Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode: null }),
    Object.assign(new Error("not an error"), { code: "ERR_INVALID_STATE", errcode: 0 }),
    Object.assign(new Error("not an error"), { code: "EIO", errcode: 0 }),
    Object.assign(new Error("not an error"), { code: "err_sqlite_error", errcode: 0 }),
    "not an error",
    null,
    undefined,
    0,
    {},
    [],
  ];
  for (const v of no) assert.equal(isUpstreamBackupBusyBug(v), false, String(v));
  // hostile objects never throw and are never the bug
  const throwing = new Proxy({}, { get: () => { throw new Error("trap"); } });
  assert.equal(isUpstreamBackupBusyBug(throwing), false);
  assert.equal(isUpstreamBackupBusyBug({ get code(): string { throw new Error("getter"); }, errcode: 0 }), false);
  assert.equal(isUpstreamBackupBusyBug({ code: "ERR_SQLITE_ERROR", get errcode(): number { throw new Error("getter"); } }), false);
});

// ------------------------------------------------------------------ the bounded workaround

test("transient exact-signature failures are retried: each attempt starts from an empty owner-only partial, and the backup then succeeds and is published once", async () => {
  const s = setup();
  try {
    const seen = newSeen();
    const result = await createBackup(s.db, { dataDir: s.dir, io: scripted([BUG(), BUG(), "real"], seen) });
    assert.equal(seen.calls, 3, "two failures, then the real copy");
    assert.deepEqual(seen.targetSizes, [0, 0, 0], "every attempt started from an empty partial: the garbage of the failed attempt was removed");
    assert.deepEqual(seen.sidecars, [[], [], []], "no stale -wal/-shm/-journal of a failed attempt reached the next attempt");
    assert.deepEqual(seen.modes, POSIX_MODES ? [0o600, 0o600, 0o600] : [null, null, null], "every attempt's partial is owner-only (checked where mode bits mean something)");
    assert.deepEqual(seen.sleeps, [100, 200], "bounded waits between attempts");
    assert.deepEqual(result.leftovers, []);
    assert.deepEqual(s.listing(), [result.file], "exactly one published file, no partial or sidecar");
    const bytes = readFileSync(path.join(s.backups, result.file));
    assert.ok(!bytes.includes(GARBAGE) && !bytes.includes(MARKER), "no data of a failed attempt, and the sanitised rows are gone");
    const copy = new DatabaseSync(path.join(s.backups, result.file), { readOnly: true });
    try {
      assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n, 0);
      assert.equal((copy.prepare("SELECT v FROM kept").get() as { v: string }).v, "kept-row");
      assert.equal((copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    } finally {
      copy.close();
    }
    // a second backup never overwrites the first
    const again = await createBackup(s.db, { dataDir: s.dir, now: () => new Date(Date.now() + 5), io: scripted(["real"], newSeen()) });
    assert.notEqual(again.file, result.file);
    assert.ok(existsSync(path.join(s.backups, result.file)));
  } finally {
    s.db.close();
  }
});

test("the retry stops at the bound and then fails closed with the fixed message, nothing published, nothing left", async () => {
  assert.equal(COPY_MAX_ATTEMPTS, 6);
  assert.deepEqual([...COPY_RETRY_DELAYS_MS], [100, 200, 400, 800, 1600]);
  assert.equal(COPY_RETRY_DELAYS_MS.length, COPY_MAX_ATTEMPTS - 1);
  assert.ok(COPY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) <= 5000, "a few seconds at most, far below the 30 s lock wait");
  const s = setup();
  try {
    const seen = newSeen();
    await assert.rejects(createBackup(s.db, { dataDir: s.dir, io: scripted([BUG()], seen) }), (error: unknown) => {
      assert.ok(error instanceof BackupFailure);
      assert.equal(error.message, "Backup failed.");
      assert.deepEqual(error.leftovers, []);
      assert.equal(error.diagnostic?.copyAttempts, COPY_MAX_ATTEMPTS);
      assert.equal(error.diagnostic?.stage, "copy-started");
      assert.equal(error.diagnostic?.errorCode, "ERR_SQLITE_ERROR");
      assert.equal(error.diagnostic?.sqliteErrcode, 0);
      return true;
    });
    assert.equal(seen.calls, COPY_MAX_ATTEMPTS, "exactly the bound, no more");
    assert.deepEqual(seen.sleeps, [100, 200, 400, 800, 1600]);
    assert.deepEqual(s.listing(), [], "no final file, no partial, no sidecar");
  } finally {
    s.db.close();
  }
});

test("a sleep that rejects during the retry stops the backup: no later copy, fail closed, nothing published or left, honest diagnostic", async () => {
  const s = setup();
  try {
    const seen = newSeen();
    const sleepError = Object.assign(new Error(`sleep aborted ${MARKER}`), { code: "ERR_TEST_SLEEP" });
    const io: Partial<BackupIo> = {
      ...scripted([BUG()], seen),
      sleep: async (ms) => {
        seen.sleeps.push(ms);
        throw sleepError;
      },
    };
    await assert.rejects(createBackup(s.db, { dataDir: s.dir, io }), (error: unknown) => {
      assert.ok(error instanceof BackupFailure);
      assert.equal(error.message, "Backup failed.");
      assert.deepEqual(error.leftovers, []);
      assert.equal(error.reason, sleepError, "the sleep failure is the reason, not the earlier SQLite error");
      const d = error.diagnostic;
      assert.ok(d);
      assert.equal(d.stage, "copy-started");
      assert.equal(d.copyAttempts, 1, "one copy was made; the retry never started");
      assert.equal(d.errorName, "Error");
      assert.equal(d.errorCode, "ERR_TEST_SLEEP", "describes what actually failed (the wait), not a SQLite error");
      assert.equal(d.sqliteErrcode, null);
      assert.ok(!JSON.stringify(d).includes(MARKER), "the message text is not copied");
      return true;
    });
    assert.equal(seen.calls, 1, "no later copy after the failed wait");
    assert.deepEqual(seen.sleeps, [100]);
    assert.deepEqual(s.listing(), [], "nothing published, and the fresh partial made for the retry was removed");
  } finally {
    s.db.close();
  }
});

test("if the partial cannot be reset for a retry, the retry stops: no later copy, nothing published, the original error kept as the cause, the reset failure explicit", async () => {
  const s = setup();
  try {
    const seen = newSeen();
    let removals = 0;
    const io: Partial<BackupIo> = {
      ...scripted([BUG()], seen),
      // the reset (first call) reports a file it could not remove; the final cleanup then works
      removePartial: (dir, name) => {
        removals++;
        return removals === 1 ? [name] : removeForReal(dir, name);
      },
    };
    await assert.rejects(createBackup(s.db, { dataDir: s.dir, io }), (error: unknown) => {
      assert.ok(error instanceof BackupFailure);
      assert.equal(error.message, "Backup failed.");
      assert.deepEqual(error.leftovers, [], "the final cleanup removed everything");
      assert.ok(error.reason instanceof BackupCopyResetError, "the reset failure is explicit");
      assert.equal(error.reason.message, "The partial copy could not be reset for a retry.");
      assert.ok(isUpstreamBackupBusyBug(error.reason.original), "the exact-signature error that triggered the retry is kept as the cause");
      const d = error.diagnostic;
      assert.ok(d);
      assert.equal(d.errorName, "BackupCopyResetError");
      assert.equal(d.errorCode, null);
      assert.equal(d.copyAttempts, 1);
      assert.equal(d.stage, "copy-started");
      assert.ok(!/[\\/]|\.partial/.test(JSON.stringify(d)), "no path or file name in the diagnostic");
      return true;
    });
    assert.equal(seen.calls, 1, "no later copy");
    assert.deepEqual(seen.sleeps, [], "stopped before waiting");
    assert.equal(removals, 2);
    assert.deepEqual(s.listing(), [], "nothing published, nothing left");
  } finally {
    s.db.close();
  }
});

test("if the partial can be neither reset nor cleaned up, the failure says so and names the unsafe file, which is really still there", async () => {
  const s = setup();
  try {
    const seen = newSeen();
    let removals = 0;
    const io: Partial<BackupIo> = {
      ...scripted([BUG()], seen),
      removePartial: (_dir, name) => {
        removals++;
        return [name];
      },
    };
    const caught: BackupFailure[] = [];
    await assert.rejects(createBackup(s.db, { dataDir: s.dir, io }), (error: unknown) => {
      assert.ok(error instanceof BackupFailure);
      caught.push(error);
      return true;
    });
    const failure = caught[0];
    assert.ok(failure);
    try {
      assert.equal(failure.message, "Backup failed and an unsanitised file could not be removed.");
      assert.equal(failure.leftovers.length, 1);
      assert.match(failure.leftovers[0], /^style-[0-9TZ.-]+\.[0-9a-f]{12}\.partial$/);
      assert.ok(failure.reason instanceof BackupCopyResetError);
      assert.ok(isUpstreamBackupBusyBug(failure.reason.original));
      assert.equal(seen.calls, 1, "no later copy");
      assert.deepEqual(seen.sleeps, []);
      assert.equal(removals, 2, "the reset and the final cleanup were both attempted");
      assert.ok(s.listing().includes(failure.leftovers[0]), "the reported file is really there: it is not silently ignored");
      assert.deepEqual(s.listing().filter((name) => /^style-.*\.db$/.test(name)), [], "nothing was published");
    } finally {
      removeForReal(s.backups, failure.leftovers[0]); // the test removes what it faked
    }
  } finally {
    s.db.close();
  }
});

test("any other error is never retried: one attempt, no wait, fail closed, nothing left", async () => {
  const others: unknown[] = [
    Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
    Object.assign(new Error("not an error"), { code: "ERR_SQLITE_ERROR" }),
    Object.assign(new Error("not an error"), { code: "ERR_SQLITE_ERROR", errcode: "0" }),
    Object.assign(new Error("not an error"), { code: "ERR_INVALID_STATE", errcode: 0 }),
    Object.assign(new Error("disk"), { code: "EIO" }),
    Object.assign(new Error("full"), { code: "ENOSPC" }),
    new Error("not an error"), // the free-text message is never the classifier
    "not an error",
    null,
    undefined,
    42,
  ];
  for (const failure of others) {
    const s = setup();
    try {
      const seen = newSeen();
      await assert.rejects(createBackup(s.db, { dataDir: s.dir, io: scripted([failure], seen) }), (error: unknown) => error instanceof BackupFailure && error.message === "Backup failed." && error.leftovers.length === 0 && error.diagnostic?.copyAttempts === 1);
      assert.equal(seen.calls, 1, `not retried: ${String(failure)}`);
      assert.deepEqual(seen.sleeps, []);
      assert.deepEqual(s.listing(), []);
    } finally {
      s.db.close();
    }
  }
});

test("a failure after the copy succeeded (sanitise, verify) is never retried, even with the upstream signature", async () => {
  const s = setup();
  try {
    const seen = newSeen();
    await assert.rejects(
      createBackup(s.db, {
        dataDir: s.dir,
        io: scripted(["real"], seen),
        onStage: (stage) => {
          if (stage === "sanitized") throw BUG(); // the signature AFTER the copy is not the upstream bug and not retried
        },
      }),
      (error: unknown) => error instanceof BackupFailure && error.diagnostic?.stage === "sanitized" && error.diagnostic?.copyAttempts === 1,
    );
    assert.equal(seen.calls, 1);
    assert.deepEqual(s.listing(), []);
  } finally {
    s.db.close();
  }
});

// ------------------------------------------------------------------ guarantees at every stage, and the diagnostic

test("a failure thrown by the onStage hook for each stage is reported as that stage (a stage counts as reached before its hook runs), and the fail-closed guarantees are unchanged", async () => {
  for (const stage of ["copy-started", "raw-copied", "sanitized", "vacuumed", "verified"] as const satisfies readonly BackupStage[]) {
    const s = setup();
    try {
      await assert.rejects(
        createBackup(s.db, { dataDir: s.dir, onStage: (reached) => { if (reached === stage) throw new Error(`injected failure with ${MARKER} and a path ${s.dir}`); } }),
        (error: unknown) => {
          assert.ok(error instanceof BackupFailure);
          assert.equal(error.message, "Backup failed.");
          assert.deepEqual(error.leftovers, []);
          assert.equal(error.diagnostic?.stage, stage);
          assert.ok(error.reason instanceof Error, "the original error is still the reason");
          return true;
        },
      );
      assert.deepEqual(s.listing(), [], `${stage}: no partial, sidecar or final file remains`);
    } finally {
      s.db.close();
    }
  }
});

test("the diagnostic holds only fixed facts: no message text, path, row value or secret", async () => {
  const s = setup();
  try {
    await assert.rejects(
      createBackup(s.db, { dataDir: s.dir, onStage: (stage) => { if (stage === "sanitized") throw new Error(`injected ${MARKER} ${s.dir}`); } }),
      (error: unknown) => {
        assert.ok(error instanceof BackupFailure);
        const d = error.diagnostic;
        assert.ok(d);
        assert.deepEqual(Object.keys(d).sort(), ["copyAttempts", "errorCode", "errorName", "sourceInTransaction", "sourceOpen", "sqliteErrcode", "sqliteErrstr", "stage"]);
        const text = JSON.stringify(d);
        assert.ok(!text.includes(MARKER) && !/injected|\.data|[\\/]/.test(text), text);
        assert.equal(d.sqliteErrcode, null);
        assert.equal(d.sourceInTransaction, false);
        assert.equal(d.sourceOpen, true);
        assert.ok(!JSON.stringify({ ...error, reason: undefined }).includes(MARKER));
        return true;
      },
    );
  } finally {
    s.db.close();
  }
});

test("hostile thrown objects cannot make the diagnostic throw or hide the failure: each property read is contained, numbers are range-checked", async () => {
  const hostile: unknown[] = [
    new Proxy({}, { get: () => { throw new Error("trap"); }, has: () => { throw new Error("trap"); }, ownKeys: () => { throw new Error("trap"); } }),
    { get name(): string { throw new Error("getter"); }, get code(): string { throw new Error("getter"); }, get errcode(): number { throw new Error("getter"); }, get errstr(): string { throw new Error("getter"); } },
    { name: { toString() { throw new Error("coerce"); } }, code: Symbol("x"), errcode: BigInt(10), errstr: ["a"] },
    { name: "E".repeat(5000), code: `ERR ${MARKER} /etc/passwd`, errcode: Infinity, errstr: "x\ny" },
    Object.assign(new Error("e"), { errcode: NaN }),
  ];
  for (const thrown of hostile) {
    const s = setup();
    try {
      let copies = 0;
      let waits = 0;
      const io: Partial<BackupIo> = {
        copyRaw: async () => {
          copies++;
          throw thrown;
        },
        sleep: async () => void waits++,
      };
      await assert.rejects(createBackup(s.db, { dataDir: s.dir, io }), (error: unknown) => {
        assert.ok(error instanceof BackupFailure, "the backup's own BackupFailure, not an error from reading the hostile object");
        assert.equal(error.message, "Backup failed.");
        assert.ok(error.diagnostic, "a diagnostic exists");
        const text = JSON.stringify(error.diagnostic);
        assert.ok(!text.includes(MARKER) && !text.includes("passwd") && !text.includes("EEEEE"), "nothing from a hostile value leaks");
        assert.equal(error.diagnostic.sqliteErrcode, null, "non-finite and non-integer numbers are dropped");
        assert.equal(error.reason, thrown, "the original thrown value is preserved untouched");
        return true;
      });
      assert.equal(copies, 1, "a hostile value is never the upstream signature, so it is not retried");
      assert.equal(waits, 0);
      assert.deepEqual(s.listing(), []);
    } finally {
      s.db.close();
    }
  }
});

test("SQLite's own code fields are recorded when present, including the bare errcode-0 shape", async () => {
  const s = setup();
  try {
    await assert.rejects(
      createBackup(s.db, { dataDir: s.dir, onStage: (stage) => { if (stage === "copy-started") throw Object.assign(new Error("not an error"), { code: "ERR_SQLITE_ERROR", errcode: 0, errstr: "not an error" }); } }),
      (error: unknown) => {
        assert.ok(error instanceof BackupFailure);
        assert.deepEqual(error.diagnostic, { stage: "copy-started", errorName: "Error", errorCode: "ERR_SQLITE_ERROR", sqliteErrcode: 0, sqliteErrstr: "not an error", sourceInTransaction: false, sourceOpen: true, copyAttempts: 0 });
        return true;
      },
    );
  } finally {
    s.db.close();
  }
});

test("a closed source and a source with an open write transaction are visible in the diagnostic", async () => {
  const closed = setup();
  closed.db.close();
  await assert.rejects(createBackup(closed.db, { dataDir: closed.dir }), (error: unknown) => {
    assert.ok(error instanceof BackupFailure);
    assert.equal(error.diagnostic?.sourceOpen, false);
    return true;
  });
  assert.deepEqual(closed.listing(), []);

  const writing = setup();
  try {
    writing.db.exec("BEGIN IMMEDIATE");
    writing.db.exec("INSERT INTO kept VALUES('uncommitted')");
    await assert.rejects(
      createBackup(writing.db, { dataDir: writing.dir, onStage: (stage) => { if (stage === "copy-started") throw new Error("stop"); } }),
      (error: unknown) => error instanceof BackupFailure && error.diagnostic?.sourceInTransaction === true,
    );
    writing.db.exec("ROLLBACK");
    assert.deepEqual(writing.listing(), []);
  } finally {
    if (writing.db.isTransaction) writing.db.exec("ROLLBACK");
    writing.db.close();
  }
});

test("a normal successful backup is unchanged: real copy, one attempt, one verified final file, no diagnostic on the result", async () => {
  const s = setup();
  try {
    const seen = newSeen();
    const result = await createBackup(s.db, { dataDir: s.dir, io: scripted(["real"], seen) });
    assert.equal(seen.calls, 1);
    assert.deepEqual(seen.sleeps, []);
    assert.match(result.file, /^style-.*\.db$/);
    assert.deepEqual(result.leftovers, []);
    assert.deepEqual(s.listing(), [result.file]);
    assert.ok(!("diagnostic" in result));
    // and without any injection at all (the real copy seam)
    const plain = await createBackup(s.db, { dataDir: s.dir, now: () => new Date(Date.now() + 5) });
    assert.notEqual(plain.file, result.file);
    assert.deepEqual(plain.leftovers, []);
  } finally {
    s.db.close();
  }
});
