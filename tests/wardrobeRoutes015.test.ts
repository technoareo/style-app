// FIRST import: sets STYLE_DATA_DIR and APP_URL (and clears SMTP_URL) before
// any src/ module is evaluated; see tests/helpers/wardrobeEnv.ts.
import "./helpers/wardrobeEnv";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { GET, PUT } from "../src/app/api/wardrobe/route";
import { closeDatabases, getDatabase } from "../src/server/database";
import { RECLAIM_ACQUIRE_MS } from "../src/server/wardrobes";
import {
  acquireWriteGate,
  writeGateQueueLength,
} from "../src/server/writeGate";
import {
  DAY,
  addPhoto,
  dataDir,
  origin,
  oversizeDocument,
  photoExists,
  putRawRow,
  space,
  storedRow,
  verifiedSession,
  wardrobeRows,
  type Session,
} from "./helpers/wardrobeFixtures";

/**
 * Build 015 revision 2: the REAL GET and PUT handlers, called as direct handler
 * functions (not a network test: Node's HTTP server is not involved), under a
 * held process write gate and a foreign SQLite write lock. Written, not run.
 *
 * Admission versus validation (read this before changing a test). PUT's first
 * step is account(req, true): origin, session and account-binding checks, which
 * need no database write, and then the change quota, which IS a write
 * (INSERT ... mutation_limits) and therefore takes the process write gate. That
 * is deliberate and is not weakened here. So with the gate held:
 *   - an unauthenticated, wrong-origin or wrong-account PUT is refused at once;
 *   - an authenticated PUT waits in ADMISSION, before its body is even read,
 *     whatever the body is.
 * Whether wardrobe VALIDATION precedes the wardrobe transaction is therefore
 * observed after admission has finished: the request body is a stream the test
 * releases only once the quota row shows admission is done and the test holds
 * the gate. The ordering is fixed by the test, not by timers.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let holder: DatabaseSync | undefined;
after(() => {
  if (holder?.isOpen) {
    if (holder.isTransaction) holder.exec("ROLLBACK");
    holder.close();
  }
  closeDatabases();
});

const headers = (s: Session, extra: Record<string, string> = {}) => ({
  origin,
  cookie: s.cookie,
  "content-type": "application/json",
  "x-style-account": s.id,
  ...extra,
});
const getRequest = (s: Session) =>
  new NextRequest(origin + "/api/wardrobe", { method: "GET", headers: headers(s) });
const putRequest = (s: Session, body: string, extra: Record<string, string> = {}) =>
  new NextRequest(origin + "/api/wardrobe", {
    method: "PUT",
    headers: headers(s, extra),
    body,
  });
const quota = (s: Session) =>
  (
    getDatabase()
      .prepare("SELECT count FROM mutation_limits WHERE user_id=?")
      .get(s.id) as { count: number } | undefined
  )?.count ?? 0;

type Settled<T> = { done: true; value: T } | { done: false };
/** Resolves with the value, or `done: false` if it is still pending after `ms`. */
async function settled<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  return Promise.race([
    promise.then((value): Settled<T> => ({ done: true, value })),
    sleep(ms).then((): Settled<T> => ({ done: false })),
  ]);
}
async function until(condition: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await sleep(10);
  }
}

/** A request body the test completes by hand. */
function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    send(text: string) {
      controller.enqueue(Buffer.from(text));
      controller.close();
    },
  };
}

/**
 * PUT whose body is withheld until ADMISSION is finished (the quota row moved)
 * and the test holds the write gate; then the body is delivered. Reports
 * whether the handler answered while the gate was still held and how many
 * waiters the gate then had, then releases the gate and returns the response.
 */
async function putAfterAdmission(s: Session, text: string, holdMs: number) {
  const before = quota(s);
  const body = controlledBody();
  const pending = PUT(
    new NextRequest(origin + "/api/wardrobe", {
      method: "PUT",
      headers: headers(s),
      body: body.stream,
      duplex: "half",
    } as never),
  );
  await until(() => quota(s) === before + 1, 5000);
  const release = await acquireWriteGate();
  let early: Settled<Response>;
  let queued: number;
  try {
    body.send(text);
    early = await settled(pending, holdMs);
    queued = writeGateQueueLength();
  } finally {
    release();
  }
  const response = early.done ? early.value : await pending;
  return { answeredWhileHeld: early.done, queued, response };
}

/** Holds the process write gate AND another connection's SQLite write lock. */
async function withGateAndForeignLock<T>(fn: () => Promise<T>): Promise<T> {
  getDatabase();
  const other = (holder ??= new DatabaseSync(path.join(dataDir, "app.db"), {
    timeout: 1,
  }));
  other.exec("BEGIN IMMEDIATE");
  const release = await acquireWriteGate();
  try {
    return await fn();
  } finally {
    release();
    other.exec("ROLLBACK");
  }
}

test("GET answers 200 inside a deadline while the write gate and a foreign SQLite write lock are held, queues nothing and creates no row", async () => {
  const s = await verifiedSession("route-get");
  // Warm outside the locks: session lookup and connection setup.
  assert.equal((await GET(getRequest(s))).status, 200);
  await withGateAndForeignLock(async () => {
    const outcome = await settled(GET(getRequest(s)), 3000);
    assert.ok(outcome.done, "the real GET handler did not wait for the gate or the lock");
    if (!outcome.done) return;
    assert.equal(outcome.value.status, 200);
    assert.equal(outcome.value.headers.get("cache-control"), "private, no-store");
    const body = await outcome.value.json();
    assert.equal(body.revision, 0);
    assert.deepEqual(body.wardrobe, []);
    assert.equal(writeGateQueueLength(), 0, "the read never queued");
  });
  assert.equal(wardrobeRows(s.id), 0, "reading did not create a wardrobe row");
});

test("GET with an expired unreferenced photo and a stalled cleanup still succeeds, after about the bounded cleanup wait, and deletes nothing; the next GET cleans up", async () => {
  const s = await verifiedSession("route-stalled");
  const expired = addPhoto(s.id, 2 * DAY);
  const release = await acquireWriteGate(); // the cleanup cannot start
  const started = Date.now();
  let outcome: Settled<Response>;
  try {
    outcome = await settled(GET(getRequest(s)), RECLAIM_ACQUIRE_MS + 3000);
  } finally {
    release();
  }
  const elapsed = Date.now() - started;
  assert.ok(outcome.done, "GET answered");
  if (!outcome.done) return;
  assert.equal(outcome.value.status, 200, "the response does not depend on the cleanup");
  // Honest latency: this GET awaited the bounded 2 s best-effort cleanup. The
  // bounds are timer based, so they are loose and prove "bounded", not "fast".
  assert.ok(elapsed >= RECLAIM_ACQUIRE_MS - 300, `waited for the cleanup budget (${elapsed} ms)`);
  assert.ok(elapsed < RECLAIM_ACQUIRE_MS + 2500, `and no longer (${elapsed} ms)`);
  assert.ok(photoExists(expired), "the stalled cleanup deleted nothing");
  assert.equal(writeGateQueueLength(), 0, "the timed-out cleanup left the queue");
  assert.equal((await GET(getRequest(s))).status, 200);
  assert.equal(photoExists(expired), false, "with the gate free the next GET cleans up");
});

test("PUT admission: origin, session and account binding are refused at once under a held gate and use no quota; an authenticated PUT waits in ADMISSION (the quota write), whatever its body", async () => {
  const s = await verifiedSession("route-admission");
  const valid = JSON.stringify(space(0));
  const release = await acquireWriteGate();
  try {
    for (const [label, extra, status] of [
      ["no session", { cookie: "" }, 401],
      ["wrong origin", { origin: "http://evil.example" }, 403],
      ["wrong account", { "x-style-account": "someone-else" }, 409],
    ] as const) {
      const outcome = await settled(PUT(putRequest(s, valid, extra)), 3000);
      assert.ok(outcome.done, `${label}: answered without the gate`);
      if (outcome.done) assert.equal(outcome.value.status, status, label);
    }
    assert.equal(quota(s), 0, "refused requests used no change quota");

    // An authenticated PUT, even with an INVALID body, cannot get past the
    // quota write while the gate is held: that is admission, not validation.
    const invalid = PUT(putRequest(s, JSON.stringify({ nonsense: true })));
    const stuck = await settled(invalid, 300);
    assert.equal(stuck.done, false, "admission waits for the write gate");
    assert.equal(writeGateQueueLength(), 1);
    assert.equal(quota(s), 0, "no slot is used until admission succeeds");
    release();
    const response = await invalid;
    assert.equal(response.status, 400, "after admission the invalid body is refused");
    assert.equal(quota(s), 1, "the refused request used exactly one slot");
  } finally {
    release(); // idempotent; see writeGate
  }
  assert.equal(wardrobeRows(s.id), 0);
});

test("PUT validation precedes the wardrobe transaction: after admission, invalid documents are refused while the gate is held; a valid one queues for the gate and then commits", async () => {
  const s = await verifiedSession("route-validation");
  const bad: [string, string][] = [
    ["schema violation", JSON.stringify({ ...space(0), wardrobe: "nope" })],
    ["missing revision", JSON.stringify({ version: 1, name: "x", wardrobe: [], looks: [] })],
    ["negative revision", JSON.stringify({ ...space(0), revision: -1 })],
    ["inline data URL", JSON.stringify({
      ...space(0, "aaa"),
      wardrobe: [{ ...space(0, "aaa").wardrobe[0], image: "data:image/png;base64,AAAA" }],
    })],
    ["not JSON", "not json at all"],
  ];
  for (const [label, text] of bad) {
    const run = await putAfterAdmission(s, text, 3000);
    assert.equal(run.answeredWhileHeld, true, `${label}: answered while the gate was held`);
    assert.equal(run.queued, 0, `${label}: never queued for the wardrobe transaction`);
    assert.equal(run.response.status, 400, label);
  }
  assert.equal(wardrobeRows(s.id), 0);

  const ok = await putAfterAdmission(s, JSON.stringify(space(0)), 300);
  assert.equal(ok.answeredWhileHeld, false, "a valid document waits for the gate");
  assert.equal(ok.queued, 1, "exactly one waiter: the wardrobe transaction");
  assert.equal(ok.response.status, 200);
  assert.deepEqual(await ok.response.json(), { revision: 1 });
  assert.equal(wardrobeRows(s.id), 1);
});

test("PUT: a body over 3 MB is a 413 even when it references an unavailable photo, and writes nothing", async () => {
  const s = await verifiedSession("route-413");
  const text = JSON.stringify(oversizeDocument("no-such-photo-anywhere"));
  assert.ok(Buffer.byteLength(text) > 3_000_000, "precondition");
  const response = await PUT(putRequest(s, text));
  assert.equal(response.status, 413);
  assert.equal(wardrobeRows(s.id), 0);
});

test("F6 routes: an unreadable stored document answers GET with one fixed 500 and no repair; PUT with the right revision replaces it, and a wrong revision is a 409", async () => {
  const s = await verifiedSession("route-corrupt");
  const broken = [
    "not json",
    "{}",
    "null",
    "[]",
    '{"wardrobe":"x","looks":[]}',
    '{"wardrobe":[],"looks":[{}]}',
  ];
  for (const text of broken) {
    putRawRow(s.id, 7, text);
    const expired = addPhoto(s.id, 2 * DAY);

    const read = await GET(getRequest(s));
    assert.equal(read.status, 500, text);
    const raw = await read.text();
    const body = JSON.parse(raw);
    assert.match(body.error, /could not be read/);
    assert.ok(!(text.length > 3 && raw.includes(text)), "the stored text is never echoed");
    assert.equal(storedRow(s.id)!.data_json, text, "GET did not repair or replace it");
    assert.ok(photoExists(expired), "GET reclaimed nothing");

    const stale = await PUT(putRequest(s, JSON.stringify(space(6))));
    assert.equal(stale.status, 409, "revision check still applies");
    assert.equal(storedRow(s.id)!.data_json, text);

    const saved = await PUT(putRequest(s, JSON.stringify(space(7))));
    assert.equal(saved.status, 200, text);
    assert.deepEqual(await saved.json(), { revision: 8 });
    const again = await GET(getRequest(s));
    assert.equal(again.status, 200, "readable again once the user saves");
    assert.equal(photoExists(expired), false, "the 24 h grace sweep ran with the save");
  }
});
