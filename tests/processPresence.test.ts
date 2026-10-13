import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { forkHelper, sleep } from "./helpers/processes";

/**
 * Build 010, F1: cooperative process coordination (src/server/processPresence.ts).
 * The holder is a REAL child process that opens the live database through the
 * application's getDatabase() and then idles; the claimant is this process
 * (the same call the restore command makes). Local file system only: these
 * tests say nothing about NFS/SMB or container volumes.
 */

const base = path.join(process.cwd(), ".data", "tests");
const fresh = () => {
  const dir = path.join(base, randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("an exclusive claim is refused while a real idle process has the database open, and granted the moment that process is killed", async () => {
  const { claimExclusiveAccess, PresenceBusyError } = await import(
    "../src/server/processPresence"
  );
  const dir = fresh();
  const holder = forkHelper("tests/helpers/presenceChild.ts", { STYLE_DATA_DIR: dir });
  try {
    await holder.next((m) => m.ready === true);
    // The holder runs no statement and no transaction: only its presence.
    assert.throws(() => claimExclusiveAccess(dir), PresenceBusyError);
    // Still refused a while later (not a race with start-up).
    await sleep(500);
    assert.throws(() => claimExclusiveAccess(dir), PresenceBusyError);
  } finally {
    holder.proc.kill("SIGKILL");
    await holder.exited;
  }
  // No lease, no timestamp: the operating system released a dead process's
  // lock. Allow a few seconds only for the OS to finish tearing it down.
  const end = Date.now() + 10_000;
  for (;;) {
    try {
      claimExclusiveAccess(dir).release();
      break;
    } catch (error) {
      if (!(error instanceof PresenceBusyError) || Date.now() > end) throw error;
      await sleep(100);
    }
  }
});

test("while a restore holds the exclusive claim a starting process cannot take its hold: it fails within the bound instead of waiting for ever", async () => {
  const { claimExclusiveAccess, holdPresence, PresenceBusyError } = await import(
    "../src/server/processPresence"
  );
  const dir = fresh();
  const claim = claimExclusiveAccess(dir);
  const began = Date.now();
  try {
    assert.throws(() => holdPresence(dir, 400), PresenceBusyError);
    assert.ok(Date.now() - began < 5_000, "bounded wait");
  } finally {
    claim.release();
  }
  const hold = holdPresence(dir, 400);
  hold.release();
});

test("many holders coexist, and the claim needs every one of them gone", async () => {
  const { claimExclusiveAccess, holdPresence, PresenceBusyError } = await import(
    "../src/server/processPresence"
  );
  const dir = fresh();
  const a = holdPresence(dir);
  const b = holdPresence(dir);
  assert.throws(() => claimExclusiveAccess(dir), PresenceBusyError);
  a.release();
  assert.throws(() => claimExclusiveAccess(dir), PresenceBusyError);
  b.release();
  b.release(); // idempotent
  claimExclusiveAccess(dir).release();
});

test("getDatabase() takes the hold and closeDatabases() releases it (in-process wiring)", async () => {
  const dir = fresh();
  const previous = process.env.STYLE_DATA_DIR;
  process.env.STYLE_DATA_DIR = dir;
  try {
    const database = await import("../src/server/database");
    const { claimExclusiveAccess, PresenceBusyError } = await import(
      "../src/server/processPresence"
    );
    database.getDatabase();
    assert.throws(() => claimExclusiveAccess(dir), PresenceBusyError);
    // The auth connection alone keeps it too.
    database.getAuthDatabase();
    database.closeAuthDatabase();
    assert.throws(() => claimExclusiveAccess(dir), PresenceBusyError);
    database.closeDatabases();
    claimExclusiveAccess(dir).release();
  } finally {
    if (previous === undefined) delete process.env.STYLE_DATA_DIR;
    else process.env.STYLE_DATA_DIR = previous;
  }
});
