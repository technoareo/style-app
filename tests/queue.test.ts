import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
test("durable queue isolates users, enforces individual quotas, recovers leases and suppresses cancelled results", async () => {
  process.env.STYLE_DATA_DIR = path.join(
    process.cwd(),
    ".data",
    "tests",
    randomUUID(),
  );
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const auth = await getReadyAuth();
  const db = getDatabase();
  const q = await import("../src/server/analysisJobs");
  const { normalizePhoto } = await import("../src/server/vision");
  const alice = (
    await auth.api.signUpEmail({
      body: {
        email: "queue-alice@example.test",
        name: "Alice",
        password: "Test queue passphrase 41!",
      },
    })
  ).user.id;
  const bob = (
    await auth.api.signUpEmail({
      body: {
        email: "queue-bob@example.test",
        name: "Bob",
        password: "Test queue passphrase 41!",
      },
    })
  ).user.id;
  const image = await normalizePhoto(
    readFileSync("tests/fixtures/public-shirt.jpg"),
  );
  let releaseResponse: (() => void) | undefined;
  // A function call, so TypeScript does not narrow releaseResponse to
  // `undefined` across the polling loop that waits for the mock server.
  const clearRelease = () => {
    releaseResponse = undefined;
  };
  let delayed = false;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {
      void chunk;
    }
    if (delayed)
      await new Promise<void>((resolve) => {
        releaseResponse = resolve;
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const first = q.enqueueAnalysisJob(alice, image);
    assert.equal(q.getAnalysisJobForOwner(alice, first.id).status, "queued");
    assert.throws(() => q.getAnalysisJobForOwner(bob, first.id));
    assert.throws(() => q.cancelAnalysisJobForOwner(bob, first.id));
    assert.throws(() => q.enqueueAnalysisJob(alice, image));
    assert.equal(q.acquireWorkerLock("worker-a"), true);
    assert.equal(q.acquireWorkerLock("worker-b"), false);
    assert.equal(
      await q.runWorkerTick(
        "worker-b",
        () => {},
        () => {},
      ),
      false,
      "unowned workers must never claim work",
    );
    await q.runWorkerTick(
      "worker-a",
      () => {},
      () => {},
    );
    const result = q.getAnalysisJobForOwner(alice, first.id);
    assert.equal(result.status, "completed");
    assert.equal((result.result as { items: unknown[] }).items.length, 1);
    assert.equal(
      (
        db
          .prepare("SELECT input_image FROM analysis_jobs WHERE id=?")
          .get(first.id) as { input_image: unknown }
      ).input_image,
      null,
    );
    q.cancelAnalysisJobForOwner(alice, first.id);
    assert.equal(
      (
        db
          .prepare("SELECT result_json FROM analysis_jobs WHERE id=?")
          .get(first.id) as { result_json: unknown }
      ).result_json,
      null,
      "discarding a completed result clears its temporary photo",
    );
    const second = q.enqueueAnalysisJob(alice, image);
    delayed = true;
    const tick = q.runWorkerTick(
      "worker-a",
      () => {},
      () => {},
    );
    while (!releaseResponse)
      await new Promise((resolve) => setTimeout(resolve, 10));
    q.cancelAnalysisJobForOwner(alice, second.id);
    releaseResponse();
    await tick;
    delayed = false;
    assert.equal(
      q.getAnalysisJobForOwner(alice, second.id).status,
      "cancelled",
    );
    const recovered = q.enqueueAnalysisJob(bob, image);
    db.prepare(
      "UPDATE analysis_jobs SET status='running',attempts=1,lease_until=? WHERE id=?",
    ).run(Date.now() - 1, recovered.id);
    q.cleanupOnStartup();
    assert.equal(q.getAnalysisJobForOwner(bob, recovered.id).status, "queued");
    await q.runWorkerTick(
      "worker-a",
      () => {},
      () => {},
    );
    assert.equal(
      q.getAnalysisJobForOwner(bob, recovered.id).status,
      "completed",
    );
    const day = new Date().toISOString().slice(0, 10);
    db.prepare("UPDATE usage_daily SET count=20 WHERE user_id=? AND day=?").run(
      alice,
      day,
    );
    assert.throws(() => q.enqueueAnalysisJob(alice, image));
    const independent = q.enqueueAnalysisJob(bob, image);
    assert.equal(independent.status, "queued");
    q.cancelAnalysisJobForOwner(bob, independent.id);
    const expired = q.enqueueAnalysisJob(bob, image);
    db.prepare(
      "UPDATE analysis_jobs SET status='running',lease_until=?,created_at=? WHERE id=?",
    ).run(Date.now() + 600_000, Date.now() - 3_600_001, expired.id);
    const expiredView = q.getAnalysisJobForOwner(bob, expired.id);
    assert.equal(expiredView.status, "failed");
    assert.match(expiredView.error || "", /expired/);
    assert.equal(
      (
        db
          .prepare("SELECT input_image FROM analysis_jobs WHERE id=?")
          .get(expired.id) as { input_image: unknown }
      ).input_image,
      null,
    );
    // Regression: inference that completes after the photo's absolute
    // one-hour deadline must not persist a result, even with no GET or sweep
    // between the deadline passing and finishJob running.
    const carol = (
      await auth.api.signUpEmail({
        body: {
          email: "queue-carol@example.test",
          name: "Carol",
          password: "Test queue passphrase 41!",
        },
      })
    ).user.id;
    const late = q.enqueueAnalysisJob(carol, image);
    clearRelease();
    delayed = true;
    const lateTick = q.runWorkerTick(
      "worker-a",
      () => {},
      () => {},
    );
    while (!releaseResponse)
      await new Promise((resolve) => setTimeout(resolve, 10));
    // Simulate the upload having happened just over an hour ago, while the
    // job is mid-inference. Direct DB write only: no GET/sweep touches it.
    db.prepare("UPDATE analysis_jobs SET created_at=? WHERE id=?").run(
      Date.now() - 3_600_001,
      late.id,
    );
    releaseResponse();
    await lateTick;
    delayed = false;
    const lateRow = db
      .prepare(
        "SELECT status, result_json, input_image, error FROM analysis_jobs WHERE id=?",
      )
      .get(late.id) as {
      status: string;
      result_json: string | null;
      input_image: unknown;
      error: string | null;
    };
    assert.equal(lateRow.status, "failed");
    assert.equal(lateRow.result_json, null, "expired result must not persist");
    assert.equal(lateRow.input_image, null);
    assert.match(lateRow.error || "", /expired/);
    const lateView = q.getAnalysisJobForOwner(carol, late.id);
    assert.equal(lateView.status, "failed");
    assert.match(lateView.error || "", /expired/);
    assert.equal(lateView.result, undefined);
    q.releaseWorkerLock("worker-a");
    assert.equal(q.acquireWorkerLock("worker-b"), true);
    q.releaseWorkerLock("worker-b");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
