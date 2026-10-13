// FIRST import: sets STYLE_DATA_DIR and APP_URL (and clears SMTP_URL) before
// any src/ module is evaluated; see tests/helpers/wardrobeEnv.ts.
import "./helpers/wardrobeEnv";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closeDatabases, getDatabase } from "../src/server/database";
import {
  queueVerificationEmail,
  settleLocalCapture,
} from "../src/server/mailOutbox";
import { acquireWriteGate, writeGateQueueLength } from "../src/server/writeGate";
import {
  dataDir,
  newRepositoryUser,
  origin,
} from "./helpers/wardrobeFixtures";
import { waitForMail } from "./helpers/mailCapture";

/**
 * Build 015 revision 3: semantics of the test-only settleLocalCapture() seam.
 * It only observes the two real flags (pending kick timer, drain running). These
 * tests show that it waits for a real drain, that it times out instead of
 * masking a writer that is blocked on the gate, and that it clears nothing.
 * Written, not executed.
 */

after(() => closeDatabases());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await sleep(5);
  }
}
const statuses = (userId: string) =>
  (
    getDatabase()
      .prepare("SELECT status FROM mail_outbox WHERE user_id=?")
      .all(userId) as { status: string }[]
  ).map((r) => r.status);

/** A direct-row account plus one real queued verification mail for it. */
async function accountWithQueuedMail(label: string) {
  const id = await newRepositoryUser(label);
  const { email } = getDatabase()
    .prepare('SELECT email FROM "user" WHERE id=?')
    .get(id) as { email: string };
  const result = await queueVerificationEmail(
    { id, email },
    `${origin}/api/auth/verify-email?token=settle-${label}`,
  );
  assert.equal(result.status, "queued");
  return { id, email };
}

test("idle: with nothing scheduled, settle resolves at once and changes nothing", async () => {
  const id = await newRepositoryUser("settle-idle");
  const started = Date.now();
  await settleLocalCapture();
  await settleLocalCapture({ timeoutMs: 50, pollMs: 5 });
  assert.ok(Date.now() - started < 1000, "an idle capture does not wait");
  assert.equal(writeGateQueueLength(), 0);
  assert.deepEqual(statuses(id), []);
});

test("a scheduled kick and a real drain are waited for: afterwards nothing is queued or sending and the mail was captured", async () => {
  const { id, email } = await accountWithQueuedMail("settle-wait");
  // No gate is held, so the drain can finish; settle waits for the timer and the drain.
  await settleLocalCapture({ timeoutMs: 10_000 });
  assert.equal(writeGateQueueLength(), 0);
  assert.deepEqual(statuses(id), ["sent"]);
  await waitForMail(dataDir, email, "Verify");
  await settleLocalCapture(); // and it stays settled
});

test("timeout: a drain blocked on the held gate is NOT masked; settle rejects at its cap, the writer stays queued, and settling works once the gate is free", async () => {
  const { id } = await accountWithQueuedMail("settle-timeout");
  // The kick was scheduled synchronously inside queueVerificationEmail; the
  // gate is taken in the same turn, before the 15 ms timer can fire.
  const release = await acquireWriteGate();
  try {
    await until(() => writeGateQueueLength() === 1, 2000); // the drain's claim waits
    const started = Date.now();
    await assert.rejects(
      settleLocalCapture({ timeoutMs: 150, pollMs: 5 }),
      /did not settle/,
    );
    const waited = Date.now() - started;
    assert.ok(waited >= 100, `settle waited for its cap (${waited} ms), not less`);
    assert.ok(waited < 2000, `settle stayed bounded (${waited} ms)`);
    assert.equal(writeGateQueueLength(), 1, "settle did not clear or hide the queued writer");
    assert.deepEqual(statuses(id), ["queued"], "nothing was claimed or sent while the gate was held");
  } finally {
    release();
  }
  await settleLocalCapture({ timeoutMs: 10_000 });
  assert.equal(writeGateQueueLength(), 0);
  assert.deepEqual(statuses(id), ["sent"]);
});

const BAD_OPTION_VALUES: [string, unknown][] = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["a numeric string", "100"],
  ["null", null],
  ["an object", {}],
  ["a boolean", true],
];
const badOptions = () =>
  BAD_OPTION_VALUES.flatMap(([label, value]) => [
    [`timeoutMs ${label}`, { timeoutMs: value }],
    [`pollMs ${label}`, { pollMs: value }],
  ]) as [string, never][];
const isRangeError = (error: unknown) =>
  error instanceof RangeError && /finite number/.test(error.message);

test("non-finite or wrongly typed options are rejected promptly with a fixed RangeError, on an idle capture", async () => {
  for (const [label, options] of badOptions()) {
    const started = Date.now();
    await assert.rejects(settleLocalCapture(options), isRangeError, label);
    assert.ok(Date.now() - started < 500, `${label}: rejected promptly`);
  }
  await settleLocalCapture({ timeoutMs: 50, pollMs: 5 }); // finite values still fine
});

test("non-finite or wrongly typed options are rejected promptly while a drain is blocked on the gate, and the pending writer is not cleared", async () => {
  const { id } = await accountWithQueuedMail("settle-badopts");
  const release = await acquireWriteGate();
  try {
    await until(() => writeGateQueueLength() === 1, 2000);
    for (const [label, options] of badOptions()) {
      const started = Date.now();
      await assert.rejects(settleLocalCapture(options), isRangeError, label);
      assert.ok(Date.now() - started < 500, `${label}: no wait for the blocked drain`);
    }
    assert.equal(writeGateQueueLength(), 1, "validation cleared nothing");
    assert.deepEqual(statuses(id), ["queued"]);
  } finally {
    release();
  }
  await settleLocalCapture({ timeoutMs: 10_000 });
  assert.deepEqual(statuses(id), ["sent"]);
});

test("the cap is clamped to a hard bound and a non-positive cap still rejects rather than hanging", async () => {
  await accountWithQueuedMail("settle-clamp");
  const release = await acquireWriteGate();
  try {
    await until(() => writeGateQueueLength() === 1, 2000);
    const started = Date.now();
    await assert.rejects(
      settleLocalCapture({ timeoutMs: -5, pollMs: 0 }),
      /did not settle/,
    );
    assert.ok(Date.now() - started < 1000, "a non-positive cap is raised to the 1 ms minimum");
  } finally {
    release();
  }
  await settleLocalCapture({ timeoutMs: 10_000 });
});
