import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeAuthDatabase,
  closeDatabases,
  DatabaseQuarantineError,
  getAuthDatabase,
  getDatabase,
  isQuarantined,
} from "../src/server/database";
import { claimExclusiveAccess } from "../src/server/processPresence";
import { runWriteTransaction } from "../src/server/writeTransaction";

/**
 * Build 016 revision 3: the restore presence hold must outlive every handle
 * this process cannot prove closed (docs/reviews/build-016-corrected-claude.md,
 * section 2; root's probe docs/verification/quarantine-presence-probe-016.mjs).
 *
 * Cases A and C-F follow the review (B, the same as A without an auth handle,
 * is in presenceLifecycleNoAuth016.test.ts: it also leaves the main connection
 * refused, so it needs its own process). Case G (the healthy wiring test) stays
 * in processPresence.test.ts, unchanged. Each case uses its own synthetic data
 * directory under .data/tests, and the claim goes through
 * `claimExclusiveAccess` exactly as the restore command does.
 *
 * This file has its own process. Case A deliberately leaves the main connection
 * refused for the rest of the process (there is no reset function), so it is the
 * LAST test. Every case restores its injected overrides in `finally` and ends
 * with every handle closed.
 */

const base = path.join(process.cwd(), ".data", "tests");
const previousDir = process.env.STYLE_DATA_DIR;
const freshDir = () => {
  const dir = path.join(base, `presence016-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

after(() => {
  try {
    closeDatabases();
  } finally {
    if (previousDir === undefined) delete process.env.STYLE_DATA_DIR;
    else process.env.STYLE_DATA_DIR = previousDir;
  }
});

type Overridable = { exec?: unknown; close?: unknown };
const asOverridable = (db: DatabaseSync) => db as unknown as Overridable;
const restore = (db: DatabaseSync) => {
  delete asOverridable(db).exec;
  delete asOverridable(db).close;
};

/** True when the restore claim is refused. A granted claim is released at once. */
function claimRefused(dir: string): boolean {
  let claim: { release(): void } | undefined;
  try {
    claim = claimExclusiveAccess(dir);
    return false;
  } catch (error) {
    assert.equal((error as Error).name, "PresenceBusyError", "refused for the right reason");
    return true;
  } finally {
    claim?.release();
  }
}

function breakRollback(db: DatabaseSync): void {
  const original = db.exec.bind(db);
  (db as unknown as { exec: (sql: string) => void }).exec = (sql: string) => {
    if (sql === "ROLLBACK") throw new Error("injected rollback failure");
    return original(sql);
  };
}

function breakClose(db: DatabaseSync, error: Error): void {
  (db as unknown as { close: () => void }).close = () => {
    throw error;
  };
}

async function failedWrite(): Promise<void> {
  await assert.rejects(
    runWriteTransaction((db) => {
      db.exec("INSERT INTO probe VALUES(1)");
      throw new Error("injected body failure");
    }),
    /injected body failure/,
  );
}

test("C: closeAuthDatabase() whose close throws: the error surfaces, the claim stays refused, a later closeDatabases() closes it and releases", () => {
  const dir = freshDir();
  process.env.STYLE_DATA_DIR = dir;
  const auth = getAuthDatabase();
  const failure = new Error("injected auth close failure");
  try {
    breakClose(auth, failure);
    assert.throws(
      () => closeAuthDatabase(),
      (error: unknown) => error === failure,
    );
    assert.equal(auth.isOpen, true, "the close really failed");
    assert.equal(claimRefused(dir), true, "an untracked-before handle now keeps the hold");
    // Retrying while it still fails keeps the hold and does not throw from the retry.
    closeDatabases();
    assert.equal(claimRefused(dir), true);
    restore(auth);
    closeDatabases();
    assert.equal(auth.isOpen, false);
    assert.equal(claimRefused(dir), false, "released once the handle is really closed");
  } finally {
    restore(auth);
    closeDatabases();
    assert.equal(auth.isOpen, false);
  }
});

test("D: closeDatabases() whose main close throws: the error surfaces, the claim stays refused, the next closeDatabases() closes it and releases", () => {
  const dir = freshDir();
  process.env.STYLE_DATA_DIR = dir;
  const main = getDatabase();
  const failure = new Error("injected main close failure");
  try {
    breakClose(main, failure);
    assert.throws(
      () => closeDatabases(),
      (error: unknown) => error === failure,
    );
    assert.equal(main.isOpen, true);
    assert.equal(claimRefused(dir), true);
    restore(main);
    closeDatabases();
    assert.equal(main.isOpen, false);
    assert.equal(claimRefused(dir), false);
  } finally {
    restore(main);
    closeDatabases();
    assert.equal(main.isOpen, false);
  }
});

test("D2: a close that throws AFTER the handle closed still surfaces, and the hold is released because closure is proven", () => {
  const dir = freshDir();
  process.env.STYLE_DATA_DIR = dir;
  const main = getDatabase();
  const failure = new Error("injected late close failure");
  try {
    const original = main.close.bind(main);
    (main as unknown as { close: () => void }).close = () => {
      original();
      throw failure;
    };
    assert.throws(
      () => closeDatabases(),
      (error: unknown) => error === failure,
    );
    assert.equal(main.isOpen, false);
    assert.equal(claimRefused(dir), false);
  } finally {
    restore(main);
    closeDatabases();
    assert.equal(main.isOpen, false, "the handle is closed on every path");
    assert.equal(claimRefused(dir), false, "nothing is left held on every path");
  }
});

test("E: a successful quarantine close and reopen keeps the hold throughout; it is released only by closeDatabases()", async () => {
  const dir = freshDir();
  process.env.STYLE_DATA_DIR = dir;
  const old = getDatabase();
  let fresh: DatabaseSync | undefined;
  try {
    old.exec("CREATE TABLE probe(v INTEGER)");
    breakRollback(old);
    await failedWrite();
    assert.equal(isQuarantined(old), true);
    assert.equal(old.isOpen, false, "the quarantine close succeeded");
    assert.equal(claimRefused(dir), true, "held between the close and the reopen");
    fresh = getDatabase();
    assert.notStrictEqual(fresh, old);
    assert.equal(fresh.isOpen, true);
    assert.equal(
      (fresh.prepare("SELECT COUNT(*) AS n FROM probe").get() as { n: number }).n,
      0,
      "the uncommitted row is gone; the fresh connection works",
    );
    assert.equal(claimRefused(dir), true, "held after the reopen");
  } finally {
    restore(old);
    closeDatabases();
    assert.equal(old.isOpen, false, "the quarantined handle is closed on every path");
    if (fresh) assert.equal(fresh.isOpen, false, "the replacement is closed on every path");
  }
  assert.equal(claimRefused(dir), false, "released by shutdown");
});

test("F: reopen failure with no other handle open releases the hold and the real error surfaces; a later getDatabase() retries. With auth open the hold is kept", () => {
  const goodDir = freshDir();
  const badDir = freshDir();
  // An app.db that is a directory cannot be opened as a database.
  mkdirSync(path.join(badDir, "app.db"));
  let retried: DatabaseSync | undefined;
  let auth: DatabaseSync | undefined;
  try {
    // Alone: nothing is open, so a failed open must not keep the hold.
    process.env.STYLE_DATA_DIR = badDir;
    let thrown: unknown;
    try {
      getDatabase();
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, "the real open error surfaces");
    assert.notEqual((thrown as Error).name, "PresenceBusyError");
    assert.notEqual((thrown as Error).name, "DatabaseQuarantineError");
    assert.equal(claimRefused(badDir), false, "released: no handle exists");
    rmdirSync(path.join(badDir, "app.db"));
    retried = getDatabase();
    assert.equal(retried.isOpen, true, "a later call retries and succeeds");
    assert.equal(claimRefused(badDir), true);
    closeDatabases();
    assert.equal(claimRefused(badDir), false);

    // Twin: the auth handle is open, so the failed main open must keep the hold.
    process.env.STYLE_DATA_DIR = goodDir;
    auth = getAuthDatabase();
    // A separate synthetic directory: badDir now holds a real app.db.
    const twinBadDir = freshDir();
    mkdirSync(path.join(twinBadDir, "app.db"));
    process.env.STYLE_DATA_DIR = twinBadDir;
    assert.throws(() => getDatabase(), (error: unknown) => error instanceof Error);
    process.env.STYLE_DATA_DIR = goodDir;
    assert.equal(auth.isOpen, true);
    assert.equal(claimRefused(goodDir), true, "kept while the auth handle is open");
    closeDatabases();
    assert.equal(auth.isOpen, false);
    assert.equal(claimRefused(goodDir), false);
  } finally {
    process.env.STYLE_DATA_DIR = goodDir;
    closeDatabases();
    if (retried) assert.equal(retried.isOpen, false, "the retried handle is closed on every path");
    if (auth) assert.equal(auth.isOpen, false, "the auth handle is closed on every path");
    // Put the environment back as this file found it (after() also does).
    if (previousDir === undefined) delete process.env.STYLE_DATA_DIR;
    else process.env.STYLE_DATA_DIR = previousDir;
  }
});

// Keep this LAST: it leaves the main connection refused for the rest of the
// process (there is deliberately no reset function).
test("A: quarantine with a failing ROLLBACK and CLOSE on main, auth open: the claim is refused after quarantine, after closeAuthDatabase() and after a failing closeDatabases(); granted only after the handle really closes", async () => {
  const dir = freshDir();
  process.env.STYLE_DATA_DIR = dir;
  const main = getDatabase();
  const auth = getAuthDatabase();
  try {
    main.exec("CREATE TABLE probe(v INTEGER)");
    breakRollback(main);
    breakClose(main, new Error("injected close failure"));
    await failedWrite();
    assert.equal(isQuarantined(main), true);
    assert.equal(main.isOpen, true, "the close really failed");
    assert.equal(main.isTransaction, true, "still inside the transaction");
    assert.equal(claimRefused(dir), true, "(a) after quarantine");

    closeAuthDatabase();
    assert.equal(auth.isOpen, false);
    assert.equal(claimRefused(dir), true, "(b) after closeAuthDatabase()");

    closeDatabases(); // main close still failing: retried, swallowed
    assert.equal(main.isOpen, true);
    assert.equal(claimRefused(dir), true, "(c) after a failing closeDatabases()");
    assert.throws(() => getDatabase(), DatabaseQuarantineError);

    restore(main);
    closeDatabases();
    assert.equal(main.isOpen, false);
    claimExclusiveAccess(dir).release(); // granted and releasable
    assert.throws(() => getDatabase(), DatabaseQuarantineError, "still refused: only a restart clears it");
  } finally {
    restore(main);
    closeDatabases();
    assert.equal(main.isOpen, false);
    assert.equal(auth.isOpen, false);
  }
});
