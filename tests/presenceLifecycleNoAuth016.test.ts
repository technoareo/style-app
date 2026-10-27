import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeDatabases,
  DatabaseQuarantineError,
  getDatabase,
  isQuarantined,
} from "../src/server/database";
import { claimExclusiveAccess } from "../src/server/processPresence";
import { runWriteTransaction } from "../src/server/writeTransaction";

/**
 * Build 016 revision 3, case B: the same double fault as case A in
 * presenceLifecycle016.test.ts (failing ROLLBACK and failing CLOSE on the main
 * connection) but with the auth connection never opened. Own process and
 * synthetic data directory, because the quarantine leaves the main connection
 * refused for the rest of the process. It pins behaviour that was already
 * correct: the main handle alone keeps the hold.
 */

const dir = path.join(process.cwd(), ".data", "tests", `presence016-noauth-${randomUUID()}`);
mkdirSync(dir, { recursive: true });
const previousDir = process.env.STYLE_DATA_DIR;
process.env.STYLE_DATA_DIR = dir;

after(() => {
  try {
    closeDatabases();
  } finally {
    if (previousDir === undefined) delete process.env.STYLE_DATA_DIR;
    else process.env.STYLE_DATA_DIR = previousDir;
  }
});

function claimRefused(): boolean {
  let claim: { release(): void } | undefined;
  try {
    claim = claimExclusiveAccess(dir);
    return false;
  } catch (error) {
    assert.equal((error as Error).name, "PresenceBusyError");
    return true;
  } finally {
    claim?.release();
  }
}

test("B: failing ROLLBACK and CLOSE on main, auth never opened: the claim stays refused until the handle really closes", async () => {
  const main = getDatabase();
  try {
    main.exec("CREATE TABLE probe(v INTEGER)");
    const original = main.exec.bind(main);
    (main as unknown as { exec: (sql: string) => void }).exec = (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("injected rollback failure");
      return original(sql);
    };
    (main as unknown as { close: () => void }).close = () => {
      throw new Error("injected close failure");
    };
    await assert.rejects(
      runWriteTransaction((db) => {
        db.exec("INSERT INTO probe VALUES(1)");
        throw new Error("injected body failure");
      }),
      /injected body failure/,
    );
    assert.equal(isQuarantined(main), true);
    assert.equal(main.isOpen, true);
    assert.equal(claimRefused(), true, "after quarantine");
    closeDatabases(); // close still failing: retried, not thrown
    assert.equal(main.isOpen, true);
    assert.equal(claimRefused(), true, "after a failing closeDatabases()");
    assert.throws(() => getDatabase(), DatabaseQuarantineError);
  } finally {
    const handle = main as unknown as { exec?: unknown; close?: unknown };
    delete handle.exec;
    delete handle.close;
    closeDatabases();
    assert.equal((main as DatabaseSync).isOpen, false);
  }
  assert.equal(claimRefused(), false, "granted once the handle really closed");
});
