import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Build 007 queue behaviour: admission/ETA/deadlines, quota refunds and the
 * abuse counter, owner-only discovery and retained results, and prompt
 * aborts of running model work. A mock Ollama server stands in for the model.
 */

process.env.STYLE_DATA_DIR = path.join(
  process.cwd(),
  ".data",
  "tests",
  randomUUID(),
);
process.env.APP_URL = "http://127.0.0.1:3000";
mkdirSync(process.env.STYLE_DATA_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await sleep(10);
  }
}

type Mode = "ok" | "hold" | "error" | "garbage";
let mode: Mode = "ok";
let release: (() => void) | undefined;
let requests = 0;
let aborted = 0;
const answer = JSON.stringify({
  message: {
    content: JSON.stringify({
      items: [
        {
          name: "White shirt",
          category: "Tops",
          color: "white",
          pattern: "solid",
          formality: "casual",
          brand: "",
          size: "",
          confidence: 0.75,
          evidence: "Short sleeves visible",
          box: [0, 0, 1000, 1000],
        },
      ],
      warning: "",
    }),
  },
  done: true, // the strict stream reader requires Ollama's terminal marker
});
const server = createServer((req, res) => {
  requests++;
  res.on("close", () => {
    if (!res.writableEnded) aborted++;
  });
  req.resume();
  req.on("end", async () => {
    if (mode === "hold")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    res.setHeader("content-type", "application/json");
    if (mode === "error") {
      res.statusCode = 500;
      res.end("{}");
    } else if (mode === "garbage")
      res.end(JSON.stringify({ message: { content: "not json at all" }, done: true }));
    else res.end(answer);
  });
});

type Q = typeof import("../src/server/analysisJobs");
let q: Q;
let db: import("node:sqlite").DatabaseSync;
let image: Buffer;
let signUp: (label: string) => Promise<string>;
const OWNER = "w";
const tick = (signal?: AbortSignal) =>
  q.runWorkerTick(OWNER, () => {}, () => {}, signal, { watchIntervalMs: 25 });
// node:sqlite rows have a null prototype; return plain objects so deepEqual
// compares values rather than prototypes.
const usage = (userId: string) => {
  const r = db
    .prepare(
      "SELECT count, attempts FROM usage_daily WHERE user_id=? AND day=?",
    )
    .get(userId, new Date().toISOString().slice(0, 10)) as
    | { count: number; attempts: number }
    | undefined;
  return r ? { count: r.count, attempts: r.attempts } : undefined;
};
const row = (id: string) =>
  db.prepare("SELECT * FROM analysis_jobs WHERE id=?").get(id) as
    | Record<string, unknown>
    | undefined;
function reset() {
  release?.();
  release = undefined;
  mode = "ok";
  db.exec(
    "DELETE FROM analysis_jobs; DELETE FROM usage_daily; DELETE FROM analysis_timings;",
  );
  for (const name of [
    "STYLE_ANALYSIS_ESTIMATE_MS",
    "STYLE_QUEUE_MAX_ACTIVE",
    "STYLE_DAILY_ATTEMPTS",
    "STYLE_REVIEW_BUDGET_MS",
  ])
    delete process.env[name];
}
function failure(work: () => unknown) {
  try {
    work();
  } catch (e) {
    return e as {
      status: number;
      message: string;
      extra?: Record<string, unknown>;
    };
  }
  throw new Error("expected a RequestError");
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { getReadyAuth } = await import("../src/server/auth");
  const auth = await getReadyAuth();
  db = (await import("../src/server/database")).getDatabase();
  q = await import("../src/server/analysisJobs");
  const { normalizePhoto } = await import("../src/server/vision");
  image = await normalizePhoto(readFileSync("tests/fixtures/public-shirt.jpg"));
  let n = 0;
  signUp = async (label) =>
    (
      await auth.api.signUpEmail({
        body: {
          email: `${label}-${n++}@example.test`,
          name: label,
          password: "Test queue passphrase 41!",
        },
      })
    ).user.id;
  assert.equal(q.acquireWorkerLock(OWNER), true);
});

after(async () => {
  release?.();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  q?.releaseWorkerLock(OWNER);
  (await import("../src/server/database")).closeDatabases();
});

test("admission returns position, conservative wait and the server deadline, and refuses work that cannot be reviewed before expiry", async () => {
  reset();
  process.env.STYLE_ANALYSIS_ESTIMATE_MS = "300000"; // 5 min per photo
  process.env.STYLE_REVIEW_BUDGET_MS = "600000"; // 10 min review
  // (n+1)*5 + 10 <= 60  =>  at most 9 jobs ahead of a new one.
  const users = await Promise.all(
    Array.from({ length: 11 }, (_, i) => signUp(`adm${i}`)),
  );
  const views = users.slice(0, 10).map((u) => q.enqueueAnalysisJob(u, image));
  assert.equal(views[0].position, 1);
  assert.equal(views[0].estimatedStartMs, 0);
  assert.equal(views[0].estimatedReadyMs, 300_000);
  const third = q.getAnalysisJobForOwner(users[2], views[2].id);
  assert.equal(third.position, 3);
  assert.equal(third.estimatedStartMs, 600_000);
  assert.equal(third.estimatedReadyMs, 900_000);
  assert.equal(third.expiresAt, third.createdAt! + 3_600_000);
  assert.ok(third.serverNow! >= third.createdAt!);

  const refused = failure(() => q.enqueueAnalysisJob(users[10], image));
  assert.equal(refused.status, 503);
  assert.equal(refused.extra?.code, "busy");
  assert.ok((refused.extra?.retryAfterSeconds as number) >= 30);
  const capacity = q.analysisCapacity(users[10]);
  assert.equal(capacity.accepting, false);
  assert.ok((capacity.retryAfterSeconds ?? 0) >= 30);
  assert.equal(usage(users[10]), undefined, "a refused photo is not charged");
  reset();
});

test("admission assumes the worst case (full inference timeout), not the 120 s estimate", async () => {
  reset();
  // Defaults: estimate 120 s but timeout 240 s (+10 s overhead) => 250 s per
  // job ahead, review budget 10 min. (n+1)*250 s + 600 s <= 3600 s => n <= 11.
  const users = await Promise.all(
    Array.from({ length: 13 }, (_, i) => signUp(`worst${i}`)),
  );
  for (const u of users.slice(0, 12)) q.enqueueAnalysisJob(u, image);
  const last = q.getAnalysisJobForOwner(users[11], (
    db.prepare("SELECT id FROM analysis_jobs WHERE user_id=?").get(users[11]) as { id: string }
  ).id);
  // Even if all 11 jobs ahead take the full timeout, review time remains.
  const worstReady = 12 * 250_000;
  assert.ok(worstReady + 600_000 <= 3_600_000);
  assert.equal(last.position, 12);
  const refused = failure(() => q.enqueueAnalysisJob(users[12], image));
  assert.equal(refused.status, 503);
  assert.equal(refused.extra?.code, "busy");
  assert.ok((refused.extra?.retryAfterSeconds as number) >= 30);
  reset();
});

test("the global cap stays and carries a retry hint; measured speed can raise but never lower the estimate", async () => {
  reset();
  process.env.STYLE_QUEUE_MAX_ACTIVE = "2";
  const [a, b, c] = await Promise.all([signUp("cap"), signUp("cap"), signUp("cap")]);
  q.enqueueAnalysisJob(a, image);
  q.enqueueAnalysisJob(b, image);
  const full = failure(() => q.enqueueAnalysisJob(c, image));
  assert.equal(full.status, 503);
  assert.ok((full.extra?.retryAfterSeconds as number) >= 15);
  reset();

  const d = await signUp("est");
  const now = Date.now();
  const fast = db.prepare(
    "INSERT INTO analysis_timings(finished_at,duration_ms) VALUES(?,?)",
  );
  for (let i = 0; i < 5; i++) fast.run(now - i, 1_000);
  assert.equal(
    q.enqueueAnalysisJob(d, image).estimatedReadyMs,
    120_000,
    "quick photos cannot push the estimate below the configured floor",
  );
  reset();
  const e = await signUp("est");
  const slow = db.prepare(
    "INSERT INTO analysis_timings(finished_at,duration_ms) VALUES(?,?)",
  );
  for (let i = 0; i < 5; i++) slow.run(now - i, 400_000);
  assert.equal(
    q.enqueueAnalysisJob(e, image).estimatedReadyMs,
    240_000,
    "slow history raises the estimate, capped at the inference timeout",
  );
  reset();
});

test("quota refunds are one-time, fair, and bounded by a separate attempts counter", async () => {
  reset();
  const u = await signUp("refund");

  // Cancelled while still queued: refunded once, abuse counter keeps counting.
  const first = q.enqueueAnalysisJob(u, image);
  assert.deepEqual(usage(u), { count: 1, attempts: 1 });
  assert.equal(q.cancelAnalysisJobForOwner(u, first.id).refunded, true);
  assert.deepEqual(usage(u), { count: 0, attempts: 1 });
  q.cancelAnalysisJobForOwner(u, first.id);
  q.cleanupOnStartup();
  q.cleanupOnStartup();
  assert.deepEqual(usage(u), { count: 0, attempts: 1 }, "never refunded twice");

  // Cancelling *running* inference is intentional abandonment: no refund.
  mode = "hold";
  const running = q.enqueueAnalysisJob(u, image);
  const t = tick();
  await until(() => release !== undefined);
  const cancelled = q.cancelAnalysisJobForOwner(u, running.id);
  assert.equal(cancelled.refunded, undefined);
  assert.equal(await t, true);
  assert.deepEqual(usage(u), { count: 1, attempts: 2 });
  mode = "ok";

  // Server-side failure (model unreachable): refunded exactly once.
  const v = await signUp("refund");
  mode = "error";
  const serverFail = q.enqueueAnalysisJob(v, image);
  assert.equal(await tick(), true);
  const failed = q.getAnalysisJobForOwner(v, serverFail.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /not counted/);
  assert.equal(failed.refunded, true);
  assert.deepEqual(usage(v), { count: 0, attempts: 1 });
  q.cleanupOnStartup();
  q.cleanupOnStartup();
  assert.deepEqual(usage(v), { count: 0, attempts: 1 });

  // The model answered but its output could not be verified: charged.
  const w = await signUp("refund");
  mode = "garbage";
  const unverified = q.enqueueAnalysisJob(w, image);
  assert.equal(await tick(), true);
  assert.equal(q.getAnalysisJobForOwner(w, unverified.id).status, "failed");
  assert.equal(q.getAnalysisJobForOwner(w, unverified.id).refunded, undefined);
  assert.deepEqual(usage(w), { count: 1, attempts: 1 });

  // Completed and then discarded: charged.
  const x = await signUp("refund");
  mode = "ok";
  const done = q.enqueueAnalysisJob(x, image);
  assert.equal(await tick(), true);
  assert.equal(q.getAnalysisJobForOwner(x, done.id).status, "completed");
  q.cancelAnalysisJobForOwner(x, done.id);
  assert.deepEqual(usage(x), { count: 1, attempts: 1 });

  // Expired before it ever ran: refunded once by the sweep.
  const y = await signUp("refund");
  const stale = q.enqueueAnalysisJob(y, image);
  db.prepare("UPDATE analysis_jobs SET created_at=? WHERE id=?").run(
    Date.now() - 3_600_001,
    stale.id,
  );
  q.cleanupOnStartup();
  q.cleanupOnStartup();
  assert.equal(row(stale.id)?.status, "failed");
  assert.equal(row(stale.id)?.input_image, null);
  assert.deepEqual(usage(y), { count: 0, attempts: 1 });

  // Refunds cannot create unlimited work: attempts are capped separately.
  process.env.STYLE_DAILY_ATTEMPTS = "3";
  const z = await signUp("refund");
  for (let i = 0; i < 3; i++)
    q.cancelAnalysisJobForOwner(z, q.enqueueAnalysisJob(z, image).id);
  assert.deepEqual(usage(z), { count: 0, attempts: 3 });
  const blocked = failure(() => q.enqueueAnalysisJob(z, image));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.extra?.code, "attempt-limit");
  assert.ok((blocked.extra?.retryAfterSeconds as number) > 0);
  reset();
});

test("repeated refunded server-side failures, a real inference timeout among them, still spend the finite attempt quota", async () => {
  // A photo that is too slow is a 'server' failure: the chargeable allowance is
  // refunded. Resubmitting it must still be bounded by the separate, never
  // refunded attempt counter (build 016 review, refund loop).
  reset();
  process.env.STYLE_DAILY_ATTEMPTS = "3";
  process.env.STYLE_INFERENCE_TIMEOUT_MS = "10000"; // the smallest the limit allows
  try {
    const u = await signUp("refund-loop");

    mode = "hold"; // the model never answers: the explicit deadline ends it
    const slow = q.enqueueAnalysisJob(u, image);
    assert.equal(await tick(), true);
    const timedOut = q.getAnalysisJobForOwner(u, slow.id);
    assert.equal(timedOut.status, "failed");
    assert.match(timedOut.error ?? "", /took too long/);
    assert.equal(timedOut.refunded, true, "a timeout is refunded");
    assert.equal(row(slow.id)?.failure_kind, "server");
    assert.deepEqual(usage(u), { count: 0, attempts: 1 });
    release?.();
    release = undefined;

    mode = "error"; // two more refunded server-side failures
    for (let n = 2; n <= 3; n++) {
      const job = q.enqueueAnalysisJob(u, image);
      assert.equal(await tick(), true);
      assert.equal(q.getAnalysisJobForOwner(u, job.id).refunded, true);
      assert.deepEqual(usage(u), { count: 0, attempts: n });
    }

    // Every chargeable allowance was refunded, but the attempts are spent.
    const blocked = failure(() => q.enqueueAnalysisJob(u, image));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.extra?.code, "attempt-limit");
    assert.deepEqual(usage(u), { count: 0, attempts: 3 }, "a refused photo is not counted again");
    assert.equal(requests >= 3, true);
  } finally {
    delete process.env.STYLE_INFERENCE_TIMEOUT_MS;
    reset();
  }
});

test("owner-only discovery lists active and recent jobs, results are retained until discard, and other accounts see nothing", async () => {
  reset();
  const alice = await signUp("disc");
  const bob = await signUp("disc");
  const job = q.enqueueAnalysisJob(alice, image);

  const active = failure(() => q.enqueueAnalysisJob(alice, image));
  assert.equal(active.status, 409);
  assert.equal(active.extra?.code, "active-job");
  assert.equal(active.extra?.jobId, job.id, "the duplicate points at the job to resume");

  let list = q.listJobsForOwner(alice);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "queued");
  assert.equal(list[0].position, 1);
  assert.deepEqual(q.listJobsForOwner(bob), []);
  assert.equal(failure(() => q.getAnalysisJobForOwner(bob, job.id)).status, 404);
  assert.equal(failure(() => q.cancelAnalysisJobForOwner(bob, job.id)).status, 404);

  assert.equal(await tick(), true);
  list = q.listJobsForOwner(alice);
  assert.equal(list[0].status, "completed");
  assert.equal(list[0].result, undefined, "summaries carry no photo or result");
  const first = q.getAnalysisJobForOwner(alice, job.id);
  const second = q.getAnalysisJobForOwner(alice, job.id);
  assert.equal((first.result as { items: unknown[] }).items.length, 1);
  assert.deepEqual(second.result, first.result, "not deleted on fetch");
  assert.ok(
    (second.result as { image: string }).image.startsWith("data:image/jpeg"),
  );

  q.cancelAnalysisJobForOwner(alice, job.id); // explicit discard
  assert.deepEqual(q.listJobsForOwner(alice), []);
  const gone = q.getAnalysisJobForOwner(alice, job.id);
  assert.equal(gone.status, "cancelled");
  assert.equal(gone.result, undefined);
  assert.equal(row(job.id)?.result_json, null);
  reset();
});

test("cancelling, deleting the account or expiry aborts running model work promptly and the next job starts", async () => {
  reset();
  // --- cancel ---
  const a = await signUp("abort");
  mode = "hold";
  const j1 = q.enqueueAnalysisJob(a, image);
  aborted = 0;
  const t1 = tick();
  await until(() => release !== undefined);
  const cancelledAt = Date.now();
  q.cancelAnalysisJobForOwner(a, j1.id);
  assert.equal(
    await Promise.race([t1, sleep(3000).then(() => "stuck")]),
    true,
    "the worker was not left waiting for the model",
  );
  assert.ok(Date.now() - cancelledAt < 3000);
  await until(() => aborted >= 1);
  assert.equal(row(j1.id)?.status, "cancelled");
  assert.equal(row(j1.id)?.result_json, null);

  // The next job starts straight away (the mock now answers at once).
  release = undefined;
  mode = "ok";
  const b = await signUp("abort");
  const j2 = q.enqueueAnalysisJob(b, image);
  const started = Date.now();
  assert.equal(await tick(), true);
  assert.ok(Date.now() - started < 3000);
  assert.equal(q.getAnalysisJobForOwner(b, j2.id).status, "completed");

  // --- account deletion ---
  const c = await signUp("abort");
  mode = "hold";
  release = undefined;
  const j3 = q.enqueueAnalysisJob(c, image);
  aborted = 0;
  const t3 = tick();
  await until(() => release !== undefined);
  db.prepare("DELETE FROM user WHERE id=?").run(c);
  assert.equal(
    await Promise.race([t3, sleep(3000).then(() => "stuck")]),
    true,
  );
  await until(() => aborted >= 1);
  assert.equal(row(j3.id), undefined, "the job went with the account");

  // --- expiry mid-inference ---
  const d = await signUp("abort");
  release = undefined;
  const j4 = q.enqueueAnalysisJob(d, image);
  aborted = 0;
  const t4 = tick();
  await until(() => release !== undefined);
  db.prepare("UPDATE analysis_jobs SET created_at=? WHERE id=?").run(
    Date.now() - 3_600_001,
    j4.id,
  );
  assert.equal(
    await Promise.race([t4, sleep(3000).then(() => "stuck")]),
    true,
  );
  await until(() => aborted >= 1);
  const expired = row(j4.id)!;
  assert.equal(expired.status, "failed");
  assert.match(String(expired.error), /expired/);
  assert.equal(expired.input_image, null);
  assert.equal(expired.result_json, null);
  assert.deepEqual(usage(d), { count: 0, attempts: 1 }, "expiry is refunded");
  reset();
});

test("a worker that is shutting down returns its job to the queue instead of failing it", async () => {
  reset();
  const u = await signUp("stop");
  mode = "hold";
  const job = q.enqueueAnalysisJob(u, image);
  const stop = new AbortController();
  const t = tick(stop.signal);
  await until(() => release !== undefined);
  stop.abort();
  assert.equal(await t, true);
  const r = row(job.id)!;
  assert.equal(r.status, "queued");
  assert.equal(r.attempts, 0, "the attempt is given back");
  assert.ok(r.input_image, "the photo is retained");
  assert.deepEqual(usage(u), { count: 1, attempts: 1 }, "no refund needed, no charge lost");
  release = undefined;
  mode = "ok";
  assert.equal(await tick(), true);
  assert.equal(q.getAnalysisJobForOwner(u, job.id).status, "completed");
  reset();
});
