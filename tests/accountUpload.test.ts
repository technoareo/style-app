import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { waitForMail } from "./helpers/mailCapture";
import { makeSource, sleep, streamInit } from "./helpers/bodySource";

/**
 * Build 013, G21: one in-flight image work (body read + decode) per signed-in
 * account, shared by /api/photos and /api/analyze, refused with a fixed
 * retryable 429 BEFORE it can take or queue for a global image slot.
 *
 * Route-level tests call the handlers directly (route.POST), with real
 * signed-in accounts, so they are not network tests: Node's HTTP server and a
 * real client disconnect are not involved. Bodies are controllable streams
 * (tests/helpers/bodySource.ts). The body deadline is the operator setting
 * STYLE_BODY_READ_TIMEOUT_MS at its smallest valid value (1000 ms); the 20 s
 * production default and every production limit are unchanged. Image
 * concurrency/queue/wait are set per test through the existing operator
 * variables, as tests/admission.test.ts does.
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.STYLE_BODY_READ_TIMEOUT_MS = "1000";
mkdirSync(dataDir, { recursive: true });
const origin = process.env.APP_URL;
const BUDGET_MS = 1000;

after(async () => {
  (await import("../src/server/database")).closeDatabases();
});

type Account = { id: string; email: string; cookie: string };

async function newAccount(label: string): Promise<Account> {
  const { getReadyAuth } = await import("../src/server/auth");
  const auth = await getReadyAuth();
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = "Correct upload passphrase 42!";
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
  return { id: created.user.id, email, cookie };
}

let accountsPromise: Promise<[Account, Account, Account]> | undefined;
const accounts = () =>
  (accountsPromise ??= (async () => {
    const a = await newAccount("alice");
    const b = await newAccount("bruno");
    const c = await newAccount("chen");
    return [a, b, c] as [Account, Account, Account];
  })());

const headers = (who: Account) => ({
  origin,
  cookie: who.cookie,
  "content-type": "application/json",
  "x-style-account": who.id,
});

const fixture = readFileSync("tests/fixtures/public-shirt.jpg");
const validBody = () =>
  JSON.stringify({ image: "data:image/jpeg;base64," + fixture.toString("base64"), consent: true });
const STALL_START = Buffer.from('{"image":"data:image/jpeg;base64,');

async function photo(who: Account, init: Record<string, unknown>) {
  const route = await import("../src/app/api/photos/route");
  return route.POST(
    new NextRequest(origin + "/api/photos", { method: "POST", headers: headers(who), ...init } as never),
  );
}
async function analyze(who: Account, init: Record<string, unknown>) {
  const route = await import("../src/app/api/analyze/route");
  return route.POST(
    new NextRequest(origin + "/api/analyze", { method: "POST", headers: headers(who), ...init } as never),
  );
}

const stalled = (sources: Array<{ stop: () => void }>) => {
  const source = makeSource({ first: STALL_START });
  sources.push(source);
  return { body: source.stream, duplex: "half" as const };
};

/** A promise plus a flag that says whether it has settled yet. */
function track<T>(promise: Promise<T>) {
  const t = { settled: false, promise };
  promise.then(
    () => (t.settled = true),
    () => (t.settled = true),
  );
  return t;
}

async function until(condition: () => boolean, label: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${label}`);
    await sleep(5);
  }
}

const admission = () => import("../src/server/admission");
const metrics = () => import("../src/server/uploadMetrics");

function setImageLimits(concurrency: number, queue: number, waitMs: number) {
  process.env.STYLE_IMAGE_CONCURRENCY = String(concurrency);
  process.env.STYLE_IMAGE_QUEUE = String(queue);
  process.env.STYLE_IMAGE_WAIT_MS = String(waitMs);
}

test("same account: a second photo is refused with a retryable 429 and takes no global slot; another account uploads while the first stalls; everything is released", async () => {
  setImageLimits(2, 2, 2000);
  // Slack for the other requests to finish while alice's body is still open.
  process.env.STYLE_BODY_READ_TIMEOUT_MS = "2500";
  const [alice, bruno] = await accounts();
  const { imageWorkStats, accountImageWorkActive } = await admission();
  const { resetUploadMetrics, uploadMetrics } = await metrics();
  resetUploadMetrics();
  const sources: Array<{ stop: () => void }> = [];
  try {
    // Alice's first upload: some bytes, then silence. It holds one global slot
    // and Alice's single account token until the 1 s body deadline.
    const first = track(photo(alice, stalled(sources)));
    await until(() => imageWorkStats().active === 1, "alice's first upload holds a slot");
    assert.equal(accountImageWorkActive(), 1);
    const before = imageWorkStats();
    assert.deepEqual(before, { active: 1, queued: 0, refused: 0 });

    // Second photo from the same account: refused at once, before any slot.
    const second = await photo(alice, { body: validBody() });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "3");
    assert.equal(second.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await second.json(), {
      error: "Another photo from your account is still being processed. Try again in a moment.",
      retryAfterSeconds: 3,
      code: "upload-in-progress",
    });
    assert.deepEqual(
      imageWorkStats(),
      before,
      "the refusal reserved no second global slot, joined no queue and did not count as a global refusal",
    );
    assert.equal(accountImageWorkActive(), 1);

    // Cross-route: analyze from the same account is refused by the same rule.
    const crossed = await analyze(alice, { body: validBody() });
    assert.equal(crossed.status, 429);
    assert.equal(crossed.headers.get("retry-after"), "3");
    assert.equal((await crossed.json()).code, "upload-in-progress");
    assert.deepEqual(imageWorkStats(), before);

    // Another account uploads normally while Alice's read is still stalled.
    const other = await photo(bruno, { body: validBody() });
    assert.equal(other.status, 200);
    assert.equal(first.settled, false, "alice's stalled upload is still in flight");
    assert.equal(imageWorkStats().active, 1, "bruno's slot was released");
    assert.equal(accountImageWorkActive(), 1, "bruno's token was released");

    // Alice's stall ends at the deadline; nothing is left behind and she can retry.
    assert.equal((await first.promise).status, 408);
    assert.deepEqual(imageWorkStats(), { active: 0, queued: 0, refused: 0 });
    assert.equal(accountImageWorkActive(), 0);
    const retry = await photo(alice, { body: validBody() });
    assert.equal(retry.status, 200, "the refused upload can simply be repeated");

    const m = uploadMetrics();
    assert.deepEqual(m.accounts.photos, { admitted: 3, refused: 1, released: 3 });
    assert.deepEqual(m.accounts.analyze, { admitted: 0, refused: 1, released: 0 });
    assert.equal(m.bodies.photos.timeout, 1);
    assert.equal(m.bodies.photos.ok, 2);
    assert.equal(m.cancels.photos.settled, 1, "the stalled body was cancelled and settled");
    assert.equal(m.bodies.analyze.ok + m.bodies.analyze.timeout, 0, "a refused upload's body is never read");
  } finally {
    process.env.STYLE_BODY_READ_TIMEOUT_MS = "1000";
    for (const s of sources) s.stop();
  }
});

test("the rule is shared in both directions: a stalled analyze holds the account's token against a photo, and is released at its deadline", async () => {
  setImageLimits(2, 2, 2000);
  process.env.STYLE_BODY_READ_TIMEOUT_MS = "2500";
  const [alice, bruno] = await accounts();
  const { imageWorkStats, accountImageWorkActive } = await admission();
  const sources: Array<{ stop: () => void }> = [];
  try {
    const first = track(analyze(alice, stalled(sources)));
    await until(() => imageWorkStats().active === 1, "alice's analyze upload holds a slot");
    const crossed = await photo(alice, { body: validBody() });
    assert.equal(crossed.status, 429);
    assert.equal((await crossed.json()).code, "upload-in-progress");
    assert.equal(imageWorkStats().active, 1);
    // Bruno's photo is unaffected.
    assert.equal((await photo(bruno, { body: validBody() })).status, 200);
    assert.equal((await first.promise).status, 408);
    assert.equal(accountImageWorkActive(), 0);
    assert.equal(imageWorkStats().active, 0);
    assert.equal((await photo(alice, { body: validBody() })).status, 200);
  } finally {
    process.env.STYLE_BODY_READ_TIMEOUT_MS = "1000";
    for (const s of sources) s.stop();
  }
});

test("queued and refused paths do not leak tokens or slots: wait timeout, full queue, then retries succeed", async () => {
  setImageLimits(1, 1, 300);
  const [alice, bruno, chen] = await accounts();
  const { imageWorkStats, accountImageWorkActive } = await admission();
  const { resetUploadMetrics, uploadMetrics } = await metrics();
  resetUploadMetrics();
  const sources: Array<{ stop: () => void }> = [];
  try {
    const holder = track(photo(alice, stalled(sources)));
    await until(() => imageWorkStats().active === 1, "alice holds the only slot");

    // Bruno queues for a slot (his body is valid but never read while queued).
    const queued = track(photo(bruno, { body: validBody() }));
    await until(() => imageWorkStats().queued === 1, "bruno is queued");
    assert.equal(accountImageWorkActive(), 2);

    // Chen finds the queue full: refused at once with the existing global 503,
    // and his token is already gone.
    const full = await photo(chen, { body: validBody() });
    assert.equal(full.status, 503);
    assert.equal((await full.json()).code, "busy");
    assert.equal(imageWorkStats().refused, 1);
    assert.equal(accountImageWorkActive(), 2, "chen's token was released on refusal");

    // Bruno's wait runs out (300 ms): 503 busy, token and queue entry released.
    const waited = await queued.promise;
    assert.equal(waited.status, 503);
    assert.equal((await waited.json()).code, "busy");
    assert.equal(imageWorkStats().queued, 0);
    assert.equal(accountImageWorkActive(), 1, "only alice still holds a token");

    assert.equal((await holder.promise).status, 408);
    assert.deepEqual(imageWorkStats(), { active: 0, queued: 0, refused: 2 });
    assert.equal(accountImageWorkActive(), 0);

    // Both refused accounts can simply try again.
    assert.equal((await photo(bruno, { body: validBody() })).status, 200);
    assert.equal((await photo(chen, { body: validBody() })).status, 200);
    const m = uploadMetrics().accounts.photos;
    assert.equal(m.admitted, m.released, "every admitted token was released");
    assert.equal(m.refused, 0, "none of these were same-account refusals");
  } finally {
    for (const s of sources) s.stop();
  }
});

test("failing paths release the token at once: bad image, oversize body, client abort, header-valid but undecodable image, then success", async () => {
  setImageLimits(2, 2, 2000);
  const [alice] = await accounts();
  const { imageWorkStats, accountImageWorkActive } = await admission();
  const { limits } = await import("../src/server/limits");
  const sources: Array<{ stop: () => void }> = [];
  const clean = () => {
    assert.equal(accountImageWorkActive(), 0, "no token left");
    assert.deepEqual(
      { active: imageWorkStats().active, queued: imageWorkStats().queued },
      { active: 0, queued: 0 },
      "no slot left",
    );
  };
  try {
    // Not an image at all (decode-stage failure inside the guarded work).
    assert.equal((await photo(alice, { body: JSON.stringify({ image: "not an image" }) })).status, 400);
    clean();
    // A data URL whose bytes are not an image: fails in header inspection.
    const junk = "data:image/jpeg;base64," + Buffer.alloc(64, 7).toString("base64");
    assert.equal((await photo(alice, { body: JSON.stringify({ image: junk }) })).status, 400);
    clean();
    // Over the body cap while streaming.
    const big = makeSource({ first: new Uint8Array(limits().maxBodyBytes + 1).fill(32) });
    sources.push(big);
    assert.equal((await photo(alice, { body: big.stream, duplex: "half" })).status, 413);
    assert.equal(big.state.cancelled, 1);
    clean();
    // The client goes away mid-body.
    const controller = new AbortController();
    const aborting = makeSource({ first: STALL_START });
    sources.push(aborting);
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const aborted = await photo(alice, {
      body: aborting.stream,
      duplex: "half",
      signal: controller.signal,
    });
    assert.equal(aborted.status, 400);
    assert.ok(Date.now() - started < BUDGET_MS - 200, "released well before the deadline");
    clean();
    // After all of that the same account is admitted at once and succeeds.
    assert.equal((await photo(alice, { body: validBody() })).status, 200);
    clean();
  } finally {
    for (const s of sources) s.stop();
  }
});

test("direct admission: same-id refusal is a RequestError 429 with a retry hint, a throwing job releases, ids are independent", async () => {
  setImageLimits(2, 2, 2000);
  const { withAccountImageWork, accountImageWorkActive, imageWorkStats } = await admission();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const first = withAccountImageWork("acct-one", "photos", () => hold);
  await sleep(10);
  const before = imageWorkStats();
  for (const route of ["photos", "analyze"] as const) {
    await assert.rejects(
      withAccountImageWork("acct-one", route, async () => "never runs"),
      (error: { status?: number; extra?: { code?: string; retryAfterSeconds?: number } }) =>
        error.status === 429 &&
        error.extra?.code === "upload-in-progress" &&
        error.extra?.retryAfterSeconds === 3,
    );
  }
  assert.deepEqual(imageWorkStats(), before, "refusals touched no global state");
  // A different id runs at the same time.
  assert.equal(await withAccountImageWork("acct-two", "analyze", async () => "two"), "two");
  assert.equal(accountImageWorkActive(), 1);
  release();
  await first;
  assert.equal(accountImageWorkActive(), 0);
  // A job that throws releases the id.
  await assert.rejects(
    withAccountImageWork("acct-one", "photos", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(accountImageWorkActive(), 0);
  assert.equal(await withAccountImageWork("acct-one", "photos", async () => "again"), "again");
  assert.deepEqual(imageWorkStats(), { active: 0, queued: 0, refused: before.refused });
});

test("the set of holding accounts never exceeds the existing image active + queue limits, and drains completely", async () => {
  setImageLimits(1, 2, 2000);
  const { withAccountImageWork, accountImageWorkActive, imageWorkStats } = await admission();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const baseRefused = imageWorkStats().refused; // process-wide, includes earlier tests
  const { resetUploadMetrics, uploadMetrics } = await metrics();
  resetUploadMetrics();
  const LIMIT = 1 + 2; // imageConcurrency + imageQueue
  let peak = 0;
  const outcomes: Array<Promise<string>> = [];
  // Launch in ONE synchronous run (no await between calls) and look at the
  // holder count after EVERY launch: the bound must hold at each step, not
  // only after the rejections have propagated.
  for (let i = 0; i < 100; i++) {
    outcomes.push(
      withAccountImageWork(`bounded-${i}`, i % 2 ? "photos" : "analyze", async () => {
        await hold;
        return "done";
      }).then(
        (value) => value,
        (error: { status?: number }) => `refused ${error.status}`,
      ),
    );
    const now = accountImageWorkActive();
    peak = Math.max(peak, now);
    assert.ok(now <= LIMIT, `launch ${i}: ${now} owners > ${LIMIT}`);
  }
  // Same-account duplicates inside the same synchronous run are still 429,
  // and take nothing.
  const duplicate = withAccountImageWork("bounded-0", "photos", async () => "never").then(
    () => "ran",
    (error: { status?: number }) => `refused ${error.status}`,
  );
  assert.ok(accountImageWorkActive() <= LIMIT);
  assert.equal(await duplicate, "refused 429");
  await sleep(30);
  assert.equal(peak, LIMIT);
  assert.equal(accountImageWorkActive(), LIMIT, "1 active + 2 queued; the rest never entered");
  assert.deepEqual(imageWorkStats(), { active: 1, queued: 2, refused: baseRefused + 97 });
  release();
  const results = await Promise.all(outcomes);
  assert.equal(results.filter((r) => r === "done").length, LIMIT);
  assert.equal(results.filter((r) => r === "refused 503").length, 97);
  assert.equal(accountImageWorkActive(), 0);
  assert.deepEqual(imageWorkStats(), { active: 0, queued: 0, refused: baseRefused + 97 });
  // Metrics stay consistent: capacity refusals were never "admitted".
  const a = uploadMetrics().accounts;
  assert.equal(a.photos.admitted + a.analyze.admitted, LIMIT);
  assert.equal(a.photos.released + a.analyze.released, LIMIT);
  assert.equal(a.photos.refused + a.analyze.refused, 1, "only the same-account duplicate");
});

test("a client abort while queued removes the waiter at once: no wait, no busy count, token released", async () => {
  setImageLimits(1, 2, 5000);
  const { withAccountImageWork, accountImageWorkActive, imageWorkStats } = await admission();
  const baseRefused = imageWorkStats().refused;
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const first = withAccountImageWork("abort-holder", "photos", () => hold);
  const controller = new AbortController();
  const started = Date.now();
  const queued = withAccountImageWork("abort-queued", "analyze", async () => "ran", controller.signal).then(
    () => "ran",
    (error: { status?: number; message?: string }) => `${error.status} ${error.message}`,
  );
  await sleep(20);
  assert.deepEqual(imageWorkStats(), { active: 1, queued: 1, refused: baseRefused });
  assert.equal(accountImageWorkActive(), 2);
  controller.abort();
  assert.equal(await queued, "400 The request was cancelled.");
  assert.ok(Date.now() - started < 1000, "did not wait for the 5 s queue limit");
  assert.deepEqual(imageWorkStats(), { active: 1, queued: 0, refused: baseRefused });
  assert.equal(accountImageWorkActive(), 1, "only the holder remains");
  // An already-aborted caller that would have to queue does not join the queue.
  const done = new AbortController();
  done.abort();
  await assert.rejects(
    withAccountImageWork("abort-late", "photos", async () => "x", done.signal),
    { status: 400 },
  );
  assert.equal(imageWorkStats().queued, 0);
  release();
  await first;
  assert.equal(accountImageWorkActive(), 0);
  assert.deepEqual(imageWorkStats(), { active: 0, queued: 0, refused: baseRefused });
});

test("the guard ends before the database write in both routes (static source order)", () => {
  for (const file of ["src/app/api/photos/route.ts", "src/app/api/analyze/route.ts"]) {
    const source = readFileSync(file, "utf8");
    const guard = source.indexOf("await withAccountImageWork(");
    const write = source.indexOf("await runWriteTransaction(");
    assert.ok(guard > 0 && write > 0, file);
    assert.ok(guard < write, `${file}: the guarded work is awaited to completion before the write`);
    assert.doesNotMatch(
      source.slice(guard, write),
      /runWriteTransaction|getDatabase\(/,
      `${file}: no database work inside the guarded section`,
    );
    assert.doesNotMatch(source, /\bwithImageWork\(/, `${file}: no unguarded global-only path remains`);
  }
});

test("/api/health/uploads exposes only fixed-shape integers and no identifiers", async () => {
  setImageLimits(2, 2, 2000);
  const [alice] = await accounts();
  const { resetUploadMetrics, UPLOAD_ROUTES, BODY_OUTCOMES, CANCEL_OUTCOMES, ACCOUNT_EVENTS } =
    await metrics();
  resetUploadMetrics();
  // One real, instant, pre-aborted upload so the counters are not all zero.
  const pre = new AbortController();
  pre.abort();
  const source = makeSource({ first: STALL_START });
  try {
    assert.equal(
      (await photo(alice, streamInit(source.stream, { signal: pre.signal, headers: headers(alice) }) as never)).status,
      400,
    );
  } finally {
    source.stop();
  }
  const { GET } = await import("../src/app/api/health/uploads/route");
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const json = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(json).sort(), [
    "accounts",
    "accountsHoldingUpload",
    "bodies",
    "cancels",
    "images",
  ]);
  const walk = (value: unknown, where: string) => {
    if (typeof value === "number") return assert.ok(Number.isInteger(value) && value >= 0, where);
    assert.equal(typeof value, "object", where);
    for (const [k, v] of Object.entries(value as object)) walk(v, `${where}.${k}`);
  };
  walk(json, "health");
  const shape = json as {
    bodies: Record<string, Record<string, number>>;
    cancels: Record<string, Record<string, number>>;
    accounts: Record<string, Record<string, number>>;
  };
  for (const [table, names] of [
    [shape.bodies, BODY_OUTCOMES],
    [shape.cancels, CANCEL_OUTCOMES],
    [shape.accounts, ACCOUNT_EVENTS],
  ] as const) {
    assert.deepEqual(Object.keys(table), [...UPLOAD_ROUTES]);
    for (const row of Object.values(table)) assert.deepEqual(Object.keys(row), [...names]);
  }
  assert.equal(shape.bodies.photos.aborted, 1);
  assert.equal(shape.cancels.photos.settled, 1);
  const text = JSON.stringify(json);
  assert.ok(!text.includes(alice.id) && !text.includes(alice.email), "no account identifier");
});
