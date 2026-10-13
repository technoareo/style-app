import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Behavior of the production write path (runWriteTransaction, the worker
 * heartbeat and job completion) when another process holds the SQLite write
 * lock for longer than the documented bounds. The "other process" is a raw
 * second connection that holds BEGIN IMMEDIATE. One private database for the
 * whole file; connections are closed only in the `after` hook.
 *
 * Fixture hygiene: every foreign lock, mock-model response and timer created
 * by a test is released in that test's own `finally`, and `afterEach` repeats
 * the lock release as a backstop, so one failing assertion cannot cascade
 * into the next test.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
process.env.STYLE_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });

let holder: DatabaseSync | undefined;
let server: ReturnType<typeof createServer> | undefined;

/** Ends the foreign writer's transaction, if any. Safe to call repeatedly. */
function releaseForeignLock(commit = false): void {
  if (holder?.isOpen && holder.isTransaction)
    holder.exec(commit ? "COMMIT" : "ROLLBACK");
}

afterEach(() => releaseForeignLock());

after(async () => {
  releaseForeignLock();
  if (holder?.isOpen) holder.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  const { closeDatabases } = await import("../src/server/database");
  closeDatabases();
});

async function setup() {
  const { getReadyAuth } = await import("../src/server/auth");
  const auth = await getReadyAuth();
  // The "other process": a raw second connection to the same database file.
  holder ??= new DatabaseSync(path.join(dataDir, "app.db"), { timeout: 1 });
  return auth;
}

function holdForeignLock(): void {
  holder!.exec("BEGIN IMMEDIATE");
}

/**
 * Runs `work` and records when it settled, plus whether an unrelated timer
 * scheduled just before it fired *before* it settled. Causal rather than
 * count-based: if the event loop had been parked for the whole wait, the
 * timer could only fire after `work` returned. (Exact tick counts are
 * brittle under CPU load and 50 ms native busy steps.)
 */
async function observeResponsiveness<T>(work: () => Promise<T>): Promise<{
  value?: T;
  error?: unknown;
  ms: number;
  otherTaskRanWhileWaiting: boolean;
}> {
  let sideTaskAt = 0;
  const side = setTimeout(() => {
    sideTaskAt = performance.now();
  }, 0);
  const started = performance.now();
  let settledAt = 0;
  try {
    const value = await work();
    settledAt = performance.now();
    return {
      value,
      ms: settledAt - started,
      otherTaskRanWhileWaiting: sideTaskAt > 0 && sideTaskAt < settledAt,
    };
  } catch (error) {
    settledAt = performance.now();
    return {
      error,
      ms: settledAt - started,
      otherTaskRanWhileWaiting: sideTaskAt > 0 && sideTaskAt < settledAt,
    };
  } finally {
    clearTimeout(side);
  }
}

// Generous wall-clock ceiling for "bounded": far above the 100-300 ms
// budgets used here, far below an unbounded wait.
const BOUNDED_MS = 8000;

test("a write that cannot get the lock within its budget fails retryably before its body runs", async () => {
  await setup();
  const { runWriteTransaction, WriteContentionError } = await import(
    "../src/server/writeTransaction"
  );
  const { writeGateQueueLength } = await import("../src/server/writeGate");
  const { errorResponse } = await import("../src/server/access");
  try {
    holdForeignLock();
    let bodyRan = false;
    const result = await observeResponsiveness(() =>
      runWriteTransaction(
        () => {
          bodyRan = true;
        },
        { acquireTimeoutMs: 300 },
      ),
    );
    assert.ok(result.error instanceof WriteContentionError);
    assert.equal(bodyRan, false, "the body never ran, so nothing to replay");
    assert.ok(result.ms < BOUNDED_MS, `bounded wait (${result.ms} ms)`);
    assert.ok(
      result.otherTaskRanWhileWaiting,
      "another task ran before the lock wait settled (event loop not parked)",
    );
    assert.equal(writeGateQueueLength(), 0);
    assert.equal(
      errorResponse(result.error).status,
      503,
      "reported to clients as a retryable 503",
    );

    // Once the other writer is done the very same call succeeds, exactly once.
    releaseForeignLock();
    let runs = 0;
    await runWriteTransaction(() => {
      runs++;
    });
    assert.equal(runs, 1);
  } finally {
    releaseForeignLock();
  }
});

test("a contended heartbeat is degraded, not fatal; it only turns critical after half a lease", async () => {
  await setup();
  const { acquireWorkerLockAsync, heartbeatWorker, releaseWorkerLockAsync } =
    await import("../src/server/analysisJobs");
  try {
    assert.equal(await acquireWorkerLockAsync("hb-owner"), true);
    const state = { lastRenewedAt: Date.now() };

    holdForeignLock();
    const degraded = await observeResponsiveness(() =>
      heartbeatWorker("hb-owner", state, { acquireTimeoutMs: 200 }),
    );
    assert.equal(degraded.value, "degraded");
    assert.ok(degraded.ms < BOUNDED_MS, `bounded wait (${degraded.ms} ms)`);
    assert.ok(
      degraded.otherTaskRanWhileWaiting,
      "waiting on another process left the event loop free",
    );

    state.lastRenewedAt = Date.now() - 200_000; // > half of the 5-minute lease
    assert.equal(
      await heartbeatWorker("hb-owner", state, { acquireTimeoutMs: 100 }),
      "critical",
    );

    releaseForeignLock();
    assert.equal(await heartbeatWorker("hb-owner", state), "ok");
    assert.ok(Date.now() - state.lastRenewedAt < 5000);
    assert.equal(
      await heartbeatWorker("someone-else", { lastRenewedAt: Date.now() }),
      "lost",
      "a lock owned by another worker is lost, not merely contended",
    );
  } finally {
    releaseForeignLock();
    await releaseWorkerLockAsync("hb-owner").catch(() => {});
  }
});

test("job completion survives write contention without repeating inference; beyond the bound the job is requeued, not lost", async () => {
  const auth = await setup();
  const q = await import("../src/server/analysisJobs");
  const { getDatabase } = await import("../src/server/database");
  const { normalizePhoto } = await import("../src/server/vision");
  const db = getDatabase();
  const image = await normalizePhoto(
    readFileSync("tests/fixtures/public-shirt.jpg"),
  );

  // Mock model: counts requests and can hold a response until released.
  const held: { release?: () => void } = {};
  let hold = false;
  let requests = 0;
  const pendingTimers: ReturnType<typeof setTimeout>[] = [];
  server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    if (hold)
      await new Promise<void>((resolve) => {
        held.release = resolve;
      });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            items: [
              {
                name: "White shirt",
                category: "Tops",
                color: "white",
                pattern: "graphic",
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
      }),
    );
  });
  const tickPromises: Promise<unknown>[] = [];
  try {
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const heldResponse = async (): Promise<() => void> => {
      while (!held.release) await sleep(10);
      const release = held.release;
      held.release = undefined;
      return release;
    };
    const row = (id: string) =>
      db
        .prepare(
          "SELECT status, attempts, input_image, result_json FROM analysis_jobs WHERE id=?",
        )
        .get(id) as {
        status: string;
        attempts: number;
        input_image: unknown;
        result_json: string | null;
      };
    const user = (
      await auth.api.signUpEmail({
        body: {
          email: "contention@example.test",
          name: "Contention",
          password: "Test contention passphrase 73!",
        },
      })
    ).user.id;

    assert.equal(await q.acquireWorkerLockAsync("w1"), true);

    // (a) Contention shorter than the retry budget: the finished result is
    // recorded once the other writer lets go, and the model is called once.
    const first = q.enqueueAnalysisJob(user, image);
    hold = true;
    const tickA = q.runWorkerTick("w1", () => {}, () => {}, undefined, {
      writeTimeoutMs: 100,
      finishRetryMs: 10_000,
    });
    tickPromises.push(tickA);
    const releaseA = await heldResponse(); // claimed; inference in flight
    holdForeignLock(); // another process takes the write lock
    releaseA();
    pendingTimers.push(setTimeout(() => releaseForeignLock(true), 800));
    assert.equal(await tickA, true);
    assert.equal(row(first.id).status, "completed");
    assert.equal(requests, 1, "no duplicate inference for transient contention");

    // (b) Contention beyond the budget: the worker gives up cleanly, keeps the
    // job and its photo, and the normal lease sweep requeues it.
    const second = q.enqueueAnalysisJob(user, image);
    const before = requests;
    const tickB = q.runWorkerTick("w1", () => {}, () => {}, undefined, {
      writeTimeoutMs: 100,
      finishRetryMs: 400,
    });
    tickPromises.push(tickB);
    const releaseB = await heldResponse();
    holdForeignLock();
    releaseB();
    assert.equal(await tickB, true, "tick ends without throwing");
    const stuck = row(second.id);
    assert.equal(stuck.status, "running", "result not recorded under contention");
    assert.ok(stuck.input_image, "photo retained: nothing lost");
    assert.equal(stuck.result_json, null);
    assert.equal(requests, before + 1);
    releaseForeignLock();

    // Lease lapses (the worker is healthy and alive; only the write failed).
    db.prepare("UPDATE analysis_jobs SET lease_until=? WHERE id=?").run(
      Date.now() - 1,
      second.id,
    );
    hold = false;
    assert.equal(await q.runWorkerTick("w1", () => {}, () => {}), true);
    const recovered = row(second.id);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.attempts, 2, "bounded by MAX_ATTEMPTS");
    assert.equal(requests, before + 2, "exactly one bounded re-run");
  } finally {
    // Release everything this test may still hold, assertion failure or not.
    for (const timer of pendingTimers) clearTimeout(timer);
    hold = false;
    held.release?.();
    held.release = undefined;
    releaseForeignLock();
    await Promise.allSettled(tickPromises);
    await q.releaseWorkerLockAsync("w1").catch(() => {});
  }
});
