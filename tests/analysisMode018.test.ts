import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

/**
 * Build 018 upgrade safety: a photo queued under an earlier build keeps the
 * multi-item behaviour it was accepted under; a job accepted now runs the
 * single-item path. Real queue, real database, mock Ollama (no model).
 */

process.env.STYLE_DATA_DIR = path.join(process.cwd(), ".data", "tests", randomUUID());
process.env.APP_URL = "http://127.0.0.1:3000";
mkdirSync(process.env.STYLE_DATA_DIR, { recursive: true });

const item = (name: string, box: number[]) => ({
  name,
  category: "Tops",
  color: "white",
  pattern: "solid",
  formality: "casual",
  brand: "",
  size: "",
  confidence: 0.75,
  evidence: "visible",
  box,
});
const answer = JSON.stringify({
  message: {
    content: JSON.stringify({
      items: [item("Small top", [0, 0, 300, 300]), item("Big top", [100, 100, 900, 900])],
      warning: "",
    }),
  },
  done: true,
});
const formats: Array<{ maxItems: number }> = [];
let nextBody = answer;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const sent = JSON.parse(body);
    formats.push({ maxItems: sent.format.properties.items.maxItems });
    res.setHeader("content-type", "application/json");
    res.end(nextBody);
  });
});

type Q = typeof import("../src/server/analysisJobs");
let q: Q;
let db: import("node:sqlite").DatabaseSync;
let image: Buffer;
let signUp: (label: string) => Promise<string>;
const OWNER = "w";
const tick = () => q.runWorkerTick(OWNER, () => {}, () => {}, undefined, { watchIntervalMs: 25 });
const stored = (id: string) =>
  JSON.parse(
    (db.prepare("SELECT result_json FROM analysis_jobs WHERE id=?").get(id) as { result_json: string })
      .result_json,
  ) as { items: Array<{ name: string }>; warning: string };

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { getReadyAuth } = await import("../src/server/auth");
  const auth = await getReadyAuth();
  db = (await import("../src/server/database")).getDatabase();
  q = await import("../src/server/analysisJobs");
  const { normalizePhoto } = await import("../src/server/vision");
  // A synthetic photo: nothing copyrighted is involved.
  image = await normalizePhoto(
    await sharp({ create: { width: 200, height: 200, channels: 3, background: "#6688aa" } })
      .jpeg()
      .toBuffer(),
  );
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
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  q?.releaseWorkerLock(OWNER);
  (await import("../src/server/database")).closeDatabases();
});

test("a job accepted now records 'single' and runs the single-item path", async () => {
  formats.length = 0;
  const user = await signUp("new");
  const job = q.enqueueAnalysisJob(user, image);
  const mode = (db.prepare("SELECT analysis_mode FROM analysis_jobs WHERE id=?").get(job.id) as { analysis_mode: string | null }).analysis_mode;
  assert.equal(mode, "single");
  assert.equal(await tick(), true);
  assert.deepEqual(formats, [{ maxItems: 3 }], "the single-item request");
  const result = stored(job.id);
  assert.deepEqual(result.items.map((i) => i.name), ["Big top"], "one item, the most prominent");
  assert.match(result.warning, /More than one item may be visible/);
});

test("a job queued by an earlier build (no recorded mode) keeps the multi-item behaviour after the upgrade", async () => {
  formats.length = 0;
  const user = await signUp("legacy");
  const job = q.enqueueAnalysisJob(user, image);
  // What a pre-018 row looks like: the column exists after migration but holds NULL.
  db.prepare("UPDATE analysis_jobs SET analysis_mode=NULL WHERE id=?").run(job.id);
  assert.equal(await tick(), true);
  assert.deepEqual(formats, [{ maxItems: 6 }], "the multi-item request");
  const result = stored(job.id);
  assert.deepEqual(result.items.map((i) => i.name), ["Small top", "Big top"], "both items, as it was accepted");
  assert.doesNotMatch(result.warning, /More than one item may be visible/);
});

test("rollback switch: STYLE_ANALYSIS_MODE=multi makes NEW jobs multi; queued jobs keep the mode stored with them in both directions", async () => {
  formats.length = 0;
  const [a, b, c] = [await signUp("sw-a"), await signUp("sw-b"), await signUp("sw-c")];
  const mode = (id: string) => (db.prepare("SELECT analysis_mode FROM analysis_jobs WHERE id=?").get(id) as { analysis_mode: string | null }).analysis_mode;
  try {
    delete process.env.STYLE_ANALYSIS_MODE;
    const queuedSingle = q.enqueueAnalysisJob(a, image); // default: single
    process.env.STYLE_ANALYSIS_MODE = " MULTI ";
    const queuedMulti = q.enqueueAnalysisJob(b, image);
    assert.equal(mode(queuedSingle.id), "single");
    assert.equal(mode(queuedMulti.id), "multi");
    // Flip the switch both ways AFTER queueing: stored modes do not change.
    process.env.STYLE_ANALYSIS_MODE = "single";
    assert.equal(await tick(), true);
    process.env.STYLE_ANALYSIS_MODE = "multi";
    assert.equal(await tick(), true);
    assert.deepEqual(formats, [{ maxItems: 3 }, { maxItems: 6 }], "oldest first: the single job ran single, the multi job ran multi");
    assert.equal(stored(queuedSingle.id).items.length, 1);
    assert.equal(stored(queuedMulti.id).items.length, 2);
    // Back to the default after the rollback is lifted.
    delete process.env.STYLE_ANALYSIS_MODE;
    assert.equal(mode(q.enqueueAnalysisJob(c, image).id), "single");
  } finally {
    delete process.env.STYLE_ANALYSIS_MODE;
  }
});

test("a malformed STYLE_ANALYSIS_MODE refuses new jobs (503, no row, no quota) and readiness says not ready; it is never guessed", async () => {
  const { parseAnalysisMode } = await import("../src/domain/analysis");
  assert.equal(parseAnalysisMode(undefined), "single");
  assert.equal(parseAnalysisMode(""), "single");
  assert.equal(parseAnalysisMode("  "), "single");
  assert.equal(parseAnalysisMode("Multi"), "multi");
  for (const bad of ["both", "singel", "1", "multi,single", "true"]) assert.equal(parseAnalysisMode(bad), null, bad);
  const user = await signUp("bad-mode");
  const before = (db.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE user_id=?").get(user) as { n: number }).n;
  process.env.STYLE_ANALYSIS_MODE = "singel";
  try {
    assert.throws(() => q.enqueueAnalysisJob(user, image), (e: unknown) => (e as { status?: number }).status === 503);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE user_id=?").get(user) as { n: number }).n, before);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE user_id=?").get(user) as { n: number }).n, 0);
    const { isModelAvailable } = await import("../src/server/vision");
    assert.equal(await isModelAvailable(), false);
  } finally {
    delete process.env.STYLE_ANALYSIS_MODE;
  }
});

const asAnswer = (items: unknown[]) =>
  JSON.stringify({ message: { content: JSON.stringify({ items, warning: "" }) }, done: true });
// node:sqlite rows have a null prototype; copy to a plain object for deepEqual.
const usageOf = (user: string) => {
  const r = db.prepare("SELECT count, attempts FROM usage_daily WHERE user_id=?").get(user) as { count: number; attempts: number } | undefined;
  return r ? { count: r.count, attempts: r.attempts } : undefined;
};

test("charge semantics for single-item results: a repairable item completes and is charged once; an entry that is not an item fails as a model result and is charged, not refunded", async () => {
  // Earlier tests leave queued jobs behind; run them off first so the next tick is this test's job.
  while (await tick()) { /* drain */ }
  try {
    // Repairable: unnamed, junk category, over-long brand, junk confidence.
    nextBody = asAnswer([{ ...item("", [100, 100, 900, 900]), category: "Hats", brand: "B".repeat(400), confidence: "high" }]);
    const a = await signUp("repairable");
    const done = q.enqueueAnalysisJob(a, image);
    assert.equal(await tick(), true);
    const row = db.prepare("SELECT status, failure_kind, refunded FROM analysis_jobs WHERE id=?").get(done.id) as { status: string; failure_kind: string | null; refunded: number };
    assert.equal(row.status, "completed");
    const result = stored(done.id).items[0] as unknown as Record<string, unknown>;
    assert.equal(result.name, "");
    assert.equal(result.category, "Unsorted");
    assert.equal(result.brand, "");
    assert.equal(result.confidence, 0.25);
    assert.deepEqual(usageOf(a), { count: 1, attempts: 1 });

    // Not an item at all: verification fails. It is a model result (inference ran), so it is charged.
    nextBody = asAnswer([null]);
    const b = await signUp("garbage");
    const bad = q.enqueueAnalysisJob(b, image);
    assert.equal(await tick(), true);
    const failed = db.prepare("SELECT status, failure_kind, refunded, error FROM analysis_jobs WHERE id=?").get(bad.id) as { status: string; failure_kind: string; refunded: number; error: string };
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure_kind, "model");
    assert.equal(failed.refunded, 0, "not refunded: refunds are for server-side failures");
    assert.deepEqual(usageOf(b), { count: 1, attempts: 1 });
  } finally {
    nextBody = answer;
  }
});

test("an unrecognised stored mode is treated as multi, never as single", async () => {
  const { jobAnalysisMode } = await import("../src/domain/analysis");
  assert.equal(jobAnalysisMode("single"), "single");
  for (const value of [null, undefined, "", "multi", "SINGLE", "single ", "other"])
    assert.equal(jobAnalysisMode(value as string | null | undefined), "multi", String(value));
});

test("the migration adds the column to a database that lacks it, is idempotent, and leaves existing rows NULL", async () => {
  const { migrateApplicationSchema, ANALYSIS_MODE_MIGRATION } = await import("../src/server/database");
  const user = await signUp("migrate");
  const job = q.enqueueAnalysisJob(user, image);
  db.prepare("UPDATE analysis_jobs SET analysis_mode=NULL WHERE id=?").run(job.id);
  // Rewind to the pre-018 shape.
  db.exec("ALTER TABLE analysis_jobs DROP COLUMN analysis_mode");
  db.prepare("DELETE FROM schema_migrations WHERE id=?").run(ANALYSIS_MODE_MIGRATION);
  const has = () =>
    (db.prepare("PRAGMA table_info(analysis_jobs)").all() as { name: string }[]).some((c) => c.name === "analysis_mode");
  assert.equal(has(), false);
  migrateApplicationSchema(db);
  migrateApplicationSchema(db);
  assert.equal(has(), true);
  assert.equal(
    (db.prepare("SELECT analysis_mode FROM analysis_jobs WHERE id=?").get(job.id) as { analysis_mode: string | null }).analysis_mode,
    null,
    "a row that existed before keeps no mode and so stays multi",
  );
  assert.ok(db.prepare("SELECT 1 AS ok FROM schema_migrations WHERE id=?").get(ANALYSIS_MODE_MIGRATION));
});
