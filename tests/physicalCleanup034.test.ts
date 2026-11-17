import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { waitForMail } from "./helpers/mailCapture";

/**
 * Build 034: physical deletion cleanup. Markers are distinctive byte strings
 * placed in every kind of row an account deletion must remove; "absent" means
 * the bytes appear in neither app.db nor app.db-wal. The control step proves the
 * markers REALLY were in those files after the deletion committed and before
 * the cleanup (secure_delete alone is not enough in WAL mode), so the absence
 * afterwards is not a vacuous pass.
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dataDir, { recursive: true });
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
delete process.env.STYLE_PUBLIC_DEPLOYMENT;
delete process.env.SMTP_URL;
const origin = process.env.APP_URL;
const dbFile = path.join(dataDir, "app.db");
const walFile = dbFile + "-wal";

const PHOTO_FILLER_BYTES = 30_000;
const filler = () => randomBytes(PHOTO_FILLER_BYTES); // random: no accidental marker; spans overflow pages
type Markers = Record<
  "savedPhoto" | "queuedPhoto" | "queuedMail" | "token" | "session" | "account",
  string
>;
const markersFor = (tag: string): Markers => ({
  savedPhoto: `SAVED-PHOTO-${tag}-7f3a91c2`,
  queuedPhoto: `QUEUED-PHOTO-${tag}-5d02e8b4`,
  queuedMail: `QUEUED-MAIL-${tag}-b81d44e0`,
  token: `VERIFY-TOKEN-${tag}-62d1f8ab`,
  session: `SESSION-${tag}-0c5e9a17`,
  account: `ACCOUNT-${tag}-9e47c3d1`,
});

/**
 * Manual clock for the cleanup scheduler (setCleanupTestHooks): no test waits for
 * real time. A timer fires only when the test says so, and fireNext() resolves
 * when the run that timer started has finished.
 */
class ManualClock {
  t = 1_000_000;
  private next = 1;
  private timers = new Map<number, { fn: () => unknown; at: number }>();
  now = () => this.t;
  setTimeout = (fn: () => unknown, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { fn, at: this.t + ms });
    return id;
  };
  clearTimeout = (handle: unknown): void => void this.timers.delete(handle as number);
  get pending(): number {
    return this.timers.size;
  }
  async fireNext(): Promise<boolean> {
    const first = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!first) return false;
    this.timers.delete(first[0]);
    this.t = Math.max(this.t, first[1].at);
    await first[1].fn();
    return true;
  }
}
const clock = new ManualClock();

type Db = typeof import("../src/server/database");
type Cleanup = typeof import("../src/server/physicalCleanup");
let database: Db;
let cleanup: Cleanup;
let main: DatabaseSync;
// An extra connection that keeps the WAL file alive across our own close/reopen.
let keeper: DatabaseSync;

const bytes = (file: string): Buffer => (existsSync(file) ? readFileSync(file) : Buffer.alloc(0));
function where(marker: string): string[] {
  const hits: string[] = [];
  if (bytes(dbFile).includes(marker)) hits.push("app.db");
  if (bytes(walFile).includes(marker)) hits.push("app.db-wal");
  return hits;
}
const walSize = () => (existsSync(walFile) ? statSync(walFile).size : 0);

// WAL file format (https://sqlite.org/fileformat2.html#walformat): a 32-byte file
// header, then frames of a 24-byte frame header plus one database page.
const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
const walFrames = (): number => {
  const size = walSize();
  if (size <= WAL_HEADER_BYTES) return 0;
  const pageSize = (main.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  return Math.floor((size - WAL_HEADER_BYTES) / (pageSize + WAL_FRAME_HEADER_BYTES));
};
/**
 * INVARIANT: after a truncating checkpoint the WAL holds only the cleanup's own
 * bookkeeping UPDATE (one small row; in practice 1 to 2 frames), never page
 * images of deleted data and never unbounded growth. A single leaked planted
 * photo would need at least floor(PHOTO_FILLER_BYTES / pageSize) overflow frames
 * on its own, so "fewer frames than that" separates the two without depending
 * on an exact frame count or page size (the marker-absence checks are the real
 * residue proof; this is the growth check). It fails with the observed counts.
 */
function assertWalHoldsBookkeepingOnly(label: string): void {
  const pageSize = (main.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const limit = Math.floor(PHOTO_FILLER_BYTES / pageSize);
  assert.ok(
    walFrames() < limit,
    `${label}: expected only bookkeeping frames in the WAL (fewer than ${limit} frames, the size of one leaked photo), found ${walFrames()} frames in ${walSize()} bytes`,
  );
}

/**
 * Negative control, PER marker kind: after the deletion committed and before any
 * cleanup, every kind's bytes must still be physically in app.db. This is
 * deterministic here, not best effort: plant() checkpoints every marker into
 * app.db, wal_autocheckpoint is 0 on both live connections, and nothing in the
 * test checkpoints between the deletion and this check, so SQLite has no reason
 * to touch the old page images (secure_delete only zero-fills the NEW images it
 * writes to the WAL). A kind that is not here would make its later "absent"
 * assertion vacuous, so it fails the test by name.
 */
function assertEveryMarkerKindStillOnDisk(m: Markers, why: string): void {
  for (const [kind, marker] of Object.entries(m))
    assert.ok(
      where(marker).includes("app.db"),
      `control (${why}): the ${kind} marker must still be in app.db before the cleanup; it is only in [${where(marker).join(", ")}]`,
    );
}

type Account = { id: string; email: string; password: string; cookie: string };
async function newAccount(label: string): Promise<Account> {
  const { getReadyAuth } = await import("../src/server/auth");
  const auth = await getReadyAuth();
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = "Correct cleanup passphrase 42!";
  const created = await auth.api.signUpEmail({ body: { email, password, name: label } });
  const url = new URL(
    (await waitForMail(dataDir, email, "Verify")).text.split(": ").slice(1).join(": "),
  );
  await auth.api.verifyEmail({ query: { token: url.searchParams.get("token")! } });
  const signedIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { id: created.user.id, email, password, cookie };
}

/** Rows holding every marker, owned by `who`; committed and checkpointed into app.db. */
function plant(who: Account, m: Markers): void {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const later = new Date(now + 3_600_000).toISOString();
  main
    .prepare("INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)")
    .run(`photo-${m.savedPhoto}`, who.id, Buffer.concat([Buffer.from(m.savedPhoto), filler()]), "sha", now);
  main
    .prepare(
      "INSERT INTO analysis_jobs(id,user_id,status,input_image,created_at,expires_at) VALUES(?,?,'queued',?,?,?)",
    )
    .run(
      `job-${m.queuedPhoto}`,
      who.id,
      Buffer.concat([Buffer.from(m.queuedPhoto), filler()]),
      now,
      now + 3_600_000,
    );
  main
    .prepare(
      "INSERT INTO mail_outbox(id,user_id,kind,recipient_key,to_address,subject,text_body,html_body,status,attempts,created_at,expires_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,'queued',0,?,?,?)",
    )
    .run(
      `mail-${m.queuedMail}`,
      who.id,
      "reset-password",
      "key",
      `${m.queuedMail}@example.test`,
      "Reset",
      `Reset: https://example.test/${m.queuedMail}`,
      `<p>${m.queuedMail}</p>`,
      now,
      now + 3_600_000,
      now + 3_600_000,
    );
  main
    .prepare(
      "INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
    )
    .run(`ver-${m.token}`, `reset-password:${m.token}`, who.id, later, iso, iso);
  main
    .prepare("INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)")
    .run(`sess-${m.session}`, later, m.session, iso, iso, who.id);
  main
    .prepare(
      "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
    )
    .run(`acc-${m.account}`, m.account, "marker-provider", who.id, iso, iso);
  main.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // the markers now live in app.db
}

async function deleteAccount(who: Account, viaRoute: boolean): Promise<Response> {
  const body = JSON.stringify({ password: who.password });
  const headers = { origin, cookie: who.cookie, "content-type": "application/json" };
  if (viaRoute) {
    const route = await import("../src/app/api/auth/[...all]/route");
    return route.POST(
      new NextRequest(origin + "/api/auth/delete-user", { method: "POST", headers, body }),
    );
  }
  const auth = await (await import("../src/server/auth")).getReadyAuth();
  return auth.handler(new Request(origin + "/api/auth/delete-user", { method: "POST", headers, body }));
}
const userExists = (id: string) => Boolean(main.prepare("SELECT 1 FROM user WHERE id=?").get(id));
const countWhere = (table: string, column: string, value: string) =>
  (main.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get(value) as { n: number }).n;

before(async () => {
  database = await import("../src/server/database");
  cleanup = await import("../src/server/physicalCleanup");
  // Before getReadyAuth(): its start-up sweep timer lands on the manual clock too.
  // Scheduled runs get a short budget so a deliberately busy database costs
  // 400 ms, not the 5 s production default; the logic is otherwise unchanged.
  cleanup.setCleanupTestHooks({ clock, runOptions: { budgetMs: 400 } });
  const { getReadyAuth } = await import("../src/server/auth");
  await getReadyAuth();
  main = database.getDatabase();
  // Deterministic files: nothing may checkpoint behind the test's back.
  main.exec("PRAGMA wal_autocheckpoint=0");
  database.getAuthDatabase().exec("PRAGMA wal_autocheckpoint=0");
  keeper = new DatabaseSync(dbFile, { timeout: 5000 });
});
after(() => {
  cleanup.setCleanupTestHooks(null);
  try {
    keeper.close();
  } catch {
    // already closed
  }
  database.closeDatabases();
});

test("every live connection has secure_delete=ON verified, and readiness fails if it is ever off", async () => {
  assert.equal(database.secureDeleteActive(database.getDatabase()), true);
  assert.equal(database.secureDeleteActive(database.getAuthDatabase()), true);
  assert.equal(database.secureDeleteVerified(), true);
  const health = await import("../src/app/api/health/route");
  assert.equal((await health.GET()).status, 200);
  main.exec("PRAGMA secure_delete=OFF");
  try {
    assert.equal(database.secureDeleteVerified(), false);
    const response = await health.GET();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ready: false }, "the same fixed body as every readiness failure");
  } finally {
    main.exec("PRAGMA secure_delete=ON");
  }
  assert.equal(database.secureDeleteVerified(), true);
});

test("markers of a deleted account are physically absent from app.db and app.db-wal after cleanup, and WITHOUT cleanup they are still there", async () => {
  const who = await newAccount("marker");
  const m = markersFor("main");
  plant(who, m);
  for (const [kind, marker] of Object.entries(m))
    assert.deepEqual(where(marker), ["app.db"], `precondition: ${kind} marker is in app.db`);

  const response = await deleteAccount(who, false);
  assert.equal(response.status, 200);
  assert.equal(userExists(who.id), false, "the deletion committed");
  for (const table of ["photo_assets", "analysis_jobs", "mail_outbox"])
    assert.equal(countWhere(table, "user_id", who.id), 0, `${table} rows are gone`);
  for (const table of ["session", "account"])
    assert.equal(countWhere(table, "userId", who.id), 0, `${table} rows are gone`);
  assert.equal(
    countWhere("verification", "value", who.id),
    0,
    "verification tokens are deleted by the same statement as the user",
  );
  assert.equal(cleanup.readCleanupStatus(main).pending, true, "the cleanup is owed durably");

  // Control: logically deleted and zero-filled in the new page images, yet the
  // OLD images stay on disk until a checkpoint overwrites them.
  assertEveryMarkerKindStillOnDisk(m, "deleted but not cleaned");

  assert.equal(await cleanup.runPhysicalCleanup(), "clean");
  for (const [kind, marker] of Object.entries(m))
    assert.deepEqual(where(marker), [], `${kind} marker absent from app.db and app.db-wal`);
  assertWalHoldsBookkeepingOnly("after cleanup");
  const status = cleanup.readCleanupStatus(main);
  assert.equal(status.pending, false);
  assert.equal(status.completed, status.requested);
  assert.equal(status.lastFailureCode, null);
  assert.equal(
    (main.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
    "ok",
  );
});

test("a busy database leaves the cleanup owed (never undoes or reports failure of the deletion); the next run finishes it", async () => {
  const who = await newAccount("busy");
  const m = markersFor("busy");
  plant(who, m);
  const reader = new DatabaseSync(dbFile, { timeout: 5000 });
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM user").get(); // an older snapshot another process might hold
  try {
    const response = await deleteAccount(who, false);
    assert.equal(response.status, 200);
    assert.equal(await cleanup.runPhysicalCleanup({ budgetMs: 400 }), "busy");
    assert.equal(userExists(who.id), false, "still deleted");
    const status = cleanup.readCleanupStatus(main);
    assert.equal(status.pending, true);
    assert.equal(status.lastFailureCode, "busy");
    assert.ok(status.attempts >= 1);
    assertEveryMarkerKindStillOnDisk(m, "cleanup owed, database busy");
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
  assert.equal(await cleanup.runPhysicalCleanup(), "clean");
  for (const marker of Object.values(m)) assert.deepEqual(where(marker), []);
  assert.equal(cleanup.readCleanupStatus(main).attempts, 0, "attempts reset after success");
});

test("an unexpected checkpoint error is reported as failed, logged without user data, and does not touch the deletion", async () => {
  const who = await newAccount("failing");
  await deleteAccount(who, false);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const outcome = await cleanup.runPhysicalCleanup({
      budgetMs: 300,
      checkpoint: () => {
        throw new Error(`disk exploded for ${who.email}`);
      },
    });
    assert.equal(outcome, "failed");
  } finally {
    console.error = original;
  }
  assert.equal(userExists(who.id), false);
  const status = cleanup.readCleanupStatus(main);
  assert.equal(status.pending, true);
  assert.equal(status.lastFailureCode, "error");
  const line = logged.join("\n");
  assert.match(line, /\[cleanup\] deleted-data cleanup still owed: reason=error attempts=\d+ owed=\d+/);
  assert.ok(
    !line.includes(who.email) && !line.includes(who.id) && !line.includes("exploded"),
    "no user data or error text is logged",
  );
  assert.equal(await cleanup.runPhysicalCleanup(), "clean");
});

test("the delete-user route schedules the cleanup, and a cleanup stuck on a busy database never changes the deletion response", async () => {
  const who = await newAccount("route");
  const m = markersFor("route");
  plant(who, m);
  const reader = new DatabaseSync(dbFile, { timeout: 5000 });
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM user").get();
  try {
    const response = await deleteAccount(who, true);
    assert.equal(response.status, 200, "deletion reported as succeeded");
    assert.equal(userExists(who.id), false);
    assert.ok(cleanup.scheduledCleanupDueInMs()! <= 250, "the response scheduled the cleanup");
    assert.equal(cleanup.readCleanupStatus(main).pending, true, "nothing has run yet: the timer is ours to fire");
    await clock.fireNext(); // the scheduled run, against a database another connection holds busy
    assert.equal(cleanup.readCleanupStatus(main).lastFailureCode, "busy");
    assert.equal(userExists(who.id), false, "the failed cleanup did not resurrect anything");
    assert.equal(cleanup.scheduledCleanupDueInMs(), 2_000, "the first backoff retry is queued 2 s out");
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
  // The queued retry completes it with no operator action.
  assert.equal(await clock.fireNext(), true);
  assert.equal(cleanup.readCleanupStatus(main).pending, false);
  assert.equal(cleanup.scheduledCleanupDueInMs(), null, "a finished cleanup schedules nothing more");
  for (const marker of Object.values(m)) assert.deepEqual(where(marker), []);
});

/** A deletion with no data: inserts a user and deletes it (the trigger owes one more cleanup). */
let bareCounter = 0;
function bareDelete(db: DatabaseSync = main): void {
  const id = `bare-${++bareCounter}-${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,?,?)").run(
    id,
    "x",
    `${id}@example.test`,
    now,
    now,
  );
  db.prepare("DELETE FROM user WHERE id=?").run(id);
}
const realCheckpoint = (db: DatabaseSync) =>
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number };
/** Fires every pending scheduled run (by hand), then runs one more to be sure nothing is owed. */
async function drainTimer(): Promise<void> {
  for (let i = 0; i < 10 && (await clock.fireNext()); i++);
  assert.equal(clock.pending, 0, "no scheduled run left behind");
  await cleanup.runPhysicalCleanup();
}

test("a deletion that commits between the target read and the bookkeeping is never lost: the pass loops, and nothing reports clean while owed", async () => {
  await drainTimer();
  bareDelete();
  let calls = 0;
  let pendingAtSecondCall: boolean | undefined;
  const outcome = await cleanup.runPhysicalCleanup({
    checkpoint: (db) => {
      calls++;
      if (calls === 2) pendingAtSecondCall = cleanup.readCleanupStatus(db).pending;
      const result = realCheckpoint(db);
      if (calls === 1) bareDelete(db); // commits AFTER the target was read, BEFORE markDone
      return result;
    },
  });
  assert.equal(pendingAtSecondCall, true, "after the first bookkeeping the second deletion was still owed (target was stale)");
  assert.equal(calls, 2, "a prompt follow-up pass ran in the same call");
  assert.equal(outcome, "clean");
  const status = cleanup.readCleanupStatus(main);
  assert.equal(status.pending, false);
  assert.equal(status.completed, status.requested);
});

test("every caller, including one that joined an in-flight run, reruns when a deletion arrived after the run's last read", async () => {
  await drainTimer();
  bareDelete();
  let checkpoints = 0;
  let injected = false;
  let joined: Promise<string> | undefined;
  const first = cleanup.runPhysicalCleanup({
    checkpoint: (db) => {
      checkpoints++;
      return realCheckpoint(db);
    },
    beforeReportClean: () => {
      if (injected) return;
      injected = true;
      bareDelete(); // after the final read said "nothing owed"
      joined = cleanup.runPhysicalCleanup(); // joins the run that is about to report clean
    },
  });
  const outcomes = [await first, await joined!];
  assert.deepEqual(outcomes, ["clean", "clean"]);
  assert.ok(checkpoints >= 2, "the late deletion got its own checkpoint");
  const status = cleanup.readCleanupStatus(main);
  assert.equal(status.pending, false, "never clean while owed");
  assert.equal(status.completed, status.requested);
});

test("a checkpoint only counts when the log was reset too: busy = 0 with log > 0 is not proof", async () => {
  await drainTimer();
  bareDelete();
  const outcome = await cleanup.runPhysicalCleanup({
    budgetMs: 300,
    checkpoint: () => ({ busy: 0, log: 2 }),
  });
  assert.equal(outcome, "busy");
  assert.equal(cleanup.readCleanupStatus(main).pending, true);
  assert.equal(await cleanup.runPhysicalCleanup(), "clean");
});

test("a fresh deletion pulls a long pending retry timer forward; a later request never pushes it back", async () => {
  await drainTimer();
  cleanup.schedulePhysicalCleanup(600_000, 3);
  const far = cleanup.scheduledCleanupDueInMs()!;
  assert.ok(far > 500_000);
  cleanup.schedulePhysicalCleanup(900_000, 0);
  assert.ok(cleanup.scheduledCleanupDueInMs()! <= far, "a later request changes nothing");
  bareDelete();
  cleanup.schedulePhysicalCleanup(250, 0);
  assert.ok(cleanup.scheduledCleanupDueInMs()! <= 250, "pulled forward");
  assert.equal(clock.pending, 1, "still exactly one timer");
  assert.equal(await clock.fireNext(), true);
  assert.equal(cleanup.readCleanupStatus(main).pending, false);
  assert.equal(cleanup.scheduledCleanupDueInMs(), null);
});

test("bookkeeping takes the write gate: it can never join a transaction another writer holds open on the main connection", async () => {
  await drainTimer();
  bareDelete();
  const before = cleanup.readCleanupStatus(main);
  const { acquireWriteGate } = await import("../src/server/writeGate");
  const release = await acquireWriteGate(1_000);
  main.exec("BEGIN IMMEDIATE"); // exactly what a gated writer holds
  try {
    const outcome = await cleanup.runPhysicalCleanup({
      budgetMs: 300,
      checkpoint: () => assert.fail("the checkpoint must not run while the gate is held"),
    });
    assert.ok(["busy", "failed"].includes(outcome));
    assert.equal(main.isTransaction, true, "the other writer's transaction is untouched");
  } finally {
    main.exec("ROLLBACK");
    release();
  }
  const after = cleanup.readCleanupStatus(main);
  assert.equal(after.attempts, before.attempts, "no failure bookkeeping slipped in");
  assert.equal(after.completed, before.completed);
  assert.equal(await cleanup.runPhysicalCleanup(), "clean");
});

test("isDeleteUserPath matches /delete-user and /delete-user/callback with or without a trailing slash, from the PATH only", () => {
  for (const yes of [
    "/api/auth/delete-user",
    "/api/auth/delete-user/",
    "/api/auth/delete-user/callback",
    "/api/auth/delete-user/callback/",
  ])
    assert.equal(cleanup.isDeleteUserPath(yes), true, yes);
  for (const no of [
    "/api/auth/get-session",
    "/api/auth/delete-user/other",
    "/api/auth/delete-users",
    "/api/auth/xdelete-user/callbackz",
    "/api/auth/delete-user//",
    "/api/auth/",
  ])
    assert.equal(cleanup.isDeleteUserPath(no), false, no);
  // Query and fragment are not part of the pathname, so they can neither hide nor fake a match.
  const path = (u: string) => new URL(u, "http://x.test").pathname;
  assert.equal(cleanup.isDeleteUserPath(path("/api/auth/delete-user/?a=1#f")), true);
  assert.equal(cleanup.isDeleteUserPath(path("/api/auth/delete-user/callback?token=a/b")), true);
  assert.equal(cleanup.isDeleteUserPath(path("/api/auth/get-session?next=/delete-user")), false);
  assert.equal(cleanup.isDeleteUserPath(path("/api/auth/get-session?x=/delete-user/callback/")), false);
});

test("the route schedules the cleanup for EVERY delete-user and delete-user/callback response (with or without a trailing slash, any query), whatever its status", async () => {
  await drainTimer();
  const route = await import("../src/app/api/auth/[...all]/route");
  const post = (p: string) =>
    route.POST(
      new NextRequest(origin + p, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ password: "nothing" }),
      }),
    );
  const get = (p: string) => route.GET(new NextRequest(origin + p, { headers: { origin } }));

  const first = await post("/api/auth/delete-user");
  assert.ok(first.status >= 400, `signed-out delete is refused (got ${first.status})`);
  assert.notEqual(cleanup.scheduledCleanupDueInMs(), null, "scheduled although the response was an error");
  await drainTimer();
  for (const [label, call] of [
    ["POST /delete-user/", () => post("/api/auth/delete-user/")],
    ["POST /delete-user?x=1", () => post("/api/auth/delete-user?x=1")],
    ["GET /delete-user/callback", () => get("/api/auth/delete-user/callback?token=nope")],
    ["GET /delete-user/callback/", () => get("/api/auth/delete-user/callback/?token=nope")],
  ] as const) {
    await call();
    assert.notEqual(cleanup.scheduledCleanupDueInMs(), null, `${label} is covered`);
    await drainTimer();
  }
  for (const other of ["/api/auth/get-session", "/api/auth/get-session?next=/delete-user", "/api/auth/get-session?x=/delete-user/callback/"]) {
    await get(other);
    assert.equal(cleanup.scheduledCleanupDueInMs(), null, `${other} schedules nothing`);
  }
});

test("a checkpoint result is proof only with explicit documented values: log undefined, missing or non-numeric fields are never accepted", async () => {
  for (const ok of [{ busy: 0, log: 0 }, { busy: 0, log: -1 }]) assert.equal(cleanup.checkpointComplete(ok), true, JSON.stringify(ok));
  for (const bad of [
    { busy: 0 },
    { busy: 0, log: undefined },
    { busy: 0, log: 2 },
    { busy: 1, log: 0 },
    { busy: 1, log: -1 },
    { busy: 0, log: "0" as unknown as number },
    { busy: 0, log: null as unknown as number },
    { busy: undefined as unknown as number, log: 0 },
  ])
    assert.equal(cleanup.checkpointComplete(bad), false, JSON.stringify(bad));
  await drainTimer();
  bareDelete();
  const outcome = await cleanup.runPhysicalCleanup({
    budgetMs: 300,
    checkpoint: () => ({ busy: 0 }), // no log field: SQLite did not tell us the log was reset
  });
  assert.equal(outcome, "busy", "not accepted as a clean checkpoint");
  assert.equal(cleanup.readCleanupStatus(main).pending, true, "still owed");
  assert.equal(await cleanup.runPhysicalCleanup(), "clean");
});

test("restart recovery: a deletion committed but never cleaned is still owed after the connections are reopened, and is then finished", async () => {
  const who = await newAccount("restart");
  const m = markersFor("restart");
  plant(who, m);
  await deleteAccount(who, false);
  assert.equal(cleanup.readCleanupStatus(main).pending, true);
  // "Crash" (the last test of this file: the auth instance keeps its handle): every connection of this process goes away without any cleanup.
  // `keeper` stays open (as another process would), so the WAL file survives.
  database.closeDatabases();
  assert.equal(
    await cleanup.runPhysicalCleanup(),
    "unavailable",
    "never reopens a connection just to clean",
  );
  main = database.getDatabase();
  main.exec("PRAGMA wal_autocheckpoint=0");
  assert.equal(database.secureDeleteActive(main), true, "the reopened connection is verified again");
  assert.equal(cleanup.readCleanupStatus(main).pending, true, "the owed mark is durable");
  assert.equal(await cleanup.runPhysicalCleanup(), "clean");
  for (const marker of Object.values(m)) assert.deepEqual(where(marker), []);
  assertWalHoldsBookkeepingOnly("after restart recovery");
});
