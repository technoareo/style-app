import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { waitForMail } from "./helpers/mailCapture";
import { makeSource, streamInit } from "./helpers/bodySource";

/**
 * Route-level tests of the body deadline, called as DIRECT HANDLER FUNCTIONS
 * (route.POST / route.PUT). This is not a network test: Node's HTTP server is
 * not involved, so socket-level behaviour (a connection that goes quiet, a
 * client that disconnects) is covered only by the abort-signal path here. The
 * real loopback HTTP check against the compiled build is a separate step.
 *
 * The budget is the operator setting STYLE_BODY_READ_TIMEOUT_MS at its
 * smallest valid value (1000 ms); the 20 s production default is not changed.
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.STYLE_BODY_READ_TIMEOUT_MS = "1000";
mkdirSync(dataDir, { recursive: true });
const origin = process.env.APP_URL;
const BUDGET_MS = 1000;
// Generous upper bound: the budget, the cancel grace period and scheduling slack.
const WITHIN_MS = BUDGET_MS + 2500;

after(async () => {
  (await import("../src/server/database")).closeDatabases();
});

const authRequest = (init: RequestInit & Record<string, unknown>, route = "/api/auth/sign-up/email") =>
  new NextRequest(origin + route, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    ...init,
  } as never);

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await work();
  return { value, ms: Date.now() - started };
}

test("auth: a stalled, trickling, aborted or oversized body is answered before any auth, contention or database work (runs first)", async () => {
  const route = await import("../src/app/api/auth/[...all]/route");
  const listing = () => readdirSync(dataDir).sort();
  const untouched = listing(); // importing the route must not have opened the database
  const sources: Array<{ stop: () => void }> = [];
  try {
    // --- stalled: some bytes, then silence ---
    const stalled = makeSource({ first: Buffer.from('{"email":"a@') });
    sources.push(stalled);
    const stalledRun = await timed(() =>
      route.POST(authRequest(streamInit(stalled.stream) as never)),
    );
    assert.equal(stalledRun.value.status, 408);
    assert.equal(stalledRun.value.headers.get("cache-control"), "private, no-store");
    assert.match(stalledRun.value.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await stalledRun.value.json(), {
      error: "The request took too long. Please try again.",
    });
    assert.ok(stalledRun.ms >= BUDGET_MS - 100 && stalledRun.ms < WITHIN_MS, `${stalledRun.ms} ms`);
    assert.equal(stalled.state.cancelled, 1);

    // --- steady trickle: progress does not reset the deadline ---
    const trickle = makeSource({ trickle: { everyMs: 50, chunk: Buffer.from(" ") } });
    sources.push(trickle);
    const trickleRun = await timed(() =>
      route.POST(authRequest(streamInit(trickle.stream) as never)),
    );
    assert.equal(trickleRun.value.status, 408, "a trickle is cut off at the total budget");
    assert.ok(trickleRun.ms >= BUDGET_MS - 100 && trickleRun.ms < WITHIN_MS, `${trickleRun.ms} ms`);
    assert.equal(trickle.state.cancelled, 1);

    // --- source whose cancel never settles: still a prompt 408 ---
    const hang = makeSource({ first: Buffer.from("{"), cancel: "hang" });
    sources.push(hang);
    const hangRun = await timed(() =>
      route.POST(authRequest(streamInit(hang.stream) as never)),
    );
    assert.equal(hangRun.value.status, 408);
    assert.ok(hangRun.ms < WITHIN_MS, `${hangRun.ms} ms`);

    // --- client abort mid-body: ends well before the budget ---
    const controller = new AbortController();
    const aborting = makeSource({ first: Buffer.from("{") });
    sources.push(aborting);
    setTimeout(() => controller.abort(), 100);
    const abortRun = await timed(() =>
      route.POST(authRequest(streamInit(aborting.stream, { signal: controller.signal }) as never)),
    );
    assert.equal(abortRun.value.status, 400);
    assert.equal(abortRun.value.headers.get("cache-control"), "private, no-store");
    assert.ok(abortRun.ms < BUDGET_MS - 200, `abort did not wait for the budget (${abortRun.ms} ms)`);
    assert.equal(aborting.state.cancelled, 1);

    // --- already aborted before the first read ---
    const pre = new AbortController();
    pre.abort();
    const preSource = makeSource({ first: Buffer.from("{") });
    sources.push(preSource);
    const preRun = await timed(() =>
      route.POST(authRequest(streamInit(preSource.stream, { signal: pre.signal }) as never)),
    );
    assert.equal(preRun.value.status, 400);
    assert.ok(preRun.ms < BUDGET_MS - 200);

    // --- oversize: the 32,768-byte cap is unchanged ---
    const big = makeSource({ first: new Uint8Array(32_769).fill(32) });
    sources.push(big);
    const bigResponse = await route.POST(authRequest(streamInit(big.stream) as never));
    assert.equal(bigResponse.status, 413);
    assert.equal(bigResponse.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await bigResponse.json(), { error: "Account request is too large." });
    assert.equal(big.state.cancelled, 1);

    // Proof that no refusal above reached getReadyAuth(), the contention
    // wrapper or any database function: those create the database file and
    // the auth secret in the data directory, and it is exactly as it was
    // before the first request. This test runs first in the file, before
    // anything opens the database. (Evidence by side effect, not by spying on
    // the delegate; getReadyAuth() is the only path that creates them.)
    assert.deepEqual(listing(), untouched);
  } finally {
    for (const s of sources) s.stop();
  }
});

test("auth: ordinary valid sign-up, invalid request and read-only request still behave as before", async () => {
  const route = await import("../src/app/api/auth/[...all]/route");
  const ok = await route.POST(
    authRequest({
      body: JSON.stringify({
        email: "deadline-a@example.test",
        name: "Deadline A",
        password: "Deadline passphrase 123!",
      }),
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");

  // Exactly 32,768 bytes is still within the cap (not refused with 413).
  const atCap = makeSource({ first: new Uint8Array(32_768).fill(32), end: true });
  try {
    const atCapResponse = await route.POST(authRequest(streamInit(atCap.stream) as never));
    assert.notEqual(atCapResponse.status, 413);
  } finally {
    atCap.stop();
  }

  const invalid = await route.POST(authRequest({ body: JSON.stringify({ email: "not-an-email" }) }));
  assert.ok(invalid.status >= 400 && invalid.status < 500, `invalid -> ${invalid.status}`);
  const malformed = await route.POST(authRequest({ body: "{ not json" }));
  assert.ok(malformed.status >= 400 && malformed.status < 500, `malformed -> ${malformed.status}`);

  const read = await route.GET(
    new NextRequest(origin + "/api/auth/get-session", { headers: { origin } }),
  );
  assert.ok(read.status < 500);
  assert.equal(read.headers.get("cache-control"), "private, no-store");
});

test("wardrobe and photo uploads: auth and quota run before the read, a timeout answers 408 before any write, and ordinary requests are unchanged", async () => {
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const { GET, PUT } = await import("../src/app/api/wardrobe/route");
  const { POST: upload } = await import("../src/app/api/photos/route");
  const auth = await getReadyAuth();
  const password = "Correct wardrobe passphrase 42!";
  const email = "deadline-w@example.test";
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Wearer" } });
  const url = new URL(
    (await waitForMail(dataDir, email, "Verify")).text.split(": ").slice(1).join(": "),
  );
  await auth.api.verifyEmail({ query: { token: url.searchParams.get("token")! } });
  const signedIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const id = created.user.id;
  const db = getDatabase();
  const quota = () =>
    (
      db.prepare("SELECT count FROM mutation_limits WHERE user_id=?").get(id) as
        | { count: number }
        | undefined
    )?.count ?? 0;
  const headers = (extra: Record<string, string> = {}) => ({
    origin,
    cookie,
    "content-type": "application/json",
    "x-style-account": id,
    ...extra,
  });
  const put = (init: Record<string, unknown>) =>
    PUT(new NextRequest(origin + "/api/wardrobe", { method: "PUT", ...init } as never));
  const space = { version: 1, name: "Deadline wardrobe", wardrobe: [], looks: [], revision: 0 };
  const sources: Array<{ stop: () => void }> = [];
  try {
    // --- auth, origin and account binding are decided BEFORE the body is read:
    // a stalled body costs nothing here because it is never waited on. ---
    for (const [label, extra, status] of [
      ["no session", { cookie: "" }, 401],
      ["wrong origin", { origin: "http://evil.example" }, 403],
      ["wrong account", { "x-style-account": "someone-else" }, 409],
    ] as const) {
      const source = makeSource({ first: Buffer.from("{") });
      sources.push(source);
      const run = await timed(() =>
        put({ headers: headers(extra), body: source.stream, duplex: "half" }),
      );
      assert.equal(run.value.status, status, label);
      assert.ok(run.ms < BUDGET_MS - 200, `${label} answered without waiting (${run.ms} ms)`);
    }
    assert.equal(quota(), 0, "refused-before-read requests used no change quota");

    // --- a stalled authenticated PUT: 408 at the budget, no wardrobe write ---
    const stalled = makeSource({ first: Buffer.from('{"version":1') });
    sources.push(stalled);
    const stalledRun = await timed(() =>
      put({ headers: headers(), body: stalled.stream, duplex: "half" }),
    );
    assert.equal(stalledRun.value.status, 408);
    assert.equal(stalledRun.value.headers.get("cache-control"), "private, no-store");
    assert.ok(stalledRun.ms >= BUDGET_MS - 100 && stalledRun.ms < WITHIN_MS, `${stalledRun.ms} ms`);
    assert.equal(stalled.state.cancelled, 1);
    // Documented quota implication: account(req, true) ran first, so the
    // timed-out request consumed one change slot (not refunded).
    assert.equal(quota(), 1, "the timed-out PUT used exactly one change slot");
    const afterTimeout = await (
      await GET(new NextRequest(origin + "/api/wardrobe", { headers: headers() }))
    ).json();
    assert.equal(afterTimeout.revision, 0, "nothing was saved");
    assert.deepEqual(afterTimeout.wardrobe, []);

    // --- a trickling PUT is cut off at the total budget too ---
    const trickle = makeSource({ trickle: { everyMs: 50, chunk: Buffer.from(" ") } });
    sources.push(trickle);
    const trickleRun = await timed(() =>
      put({ headers: headers(), body: trickle.stream, duplex: "half" }),
    );
    assert.equal(trickleRun.value.status, 408);
    assert.ok(trickleRun.ms < WITHIN_MS);

    // --- client abort during the wardrobe read ---
    const controller = new AbortController();
    const aborting = makeSource({ first: Buffer.from("{") });
    sources.push(aborting);
    setTimeout(() => controller.abort(), 100);
    const abortRun = await timed(() =>
      put({ headers: headers(), body: aborting.stream, duplex: "half", signal: controller.signal }),
    );
    assert.equal(abortRun.value.status, 400);
    assert.ok(abortRun.ms < BUDGET_MS - 200);

    // --- oversize (3,000,000-byte ceiling unchanged) ---
    const big = makeSource({ first: new Uint8Array(3_000_001).fill(32) });
    sources.push(big);
    assert.equal(
      (await put({ headers: headers(), body: big.stream, duplex: "half" })).status,
      413,
    );

    // --- ordinary valid and invalid requests ---
    assert.equal(
      (await put({ headers: headers(), body: JSON.stringify(space) })).status,
      200,
    );
    assert.equal((await put({ headers: headers(), body: "{ not json" })).status, 400);
    assert.equal(
      (await put({ headers: headers({ "content-type": "text/plain" }), body: "x" })).status,
      415,
    );

    // --- photos keep their own cap and timeout behaviour ---
    const photoRequest = (init: Record<string, unknown>) =>
      upload(new NextRequest(origin + "/api/photos", { method: "POST", ...init } as never));
    const stalledPhoto = makeSource({ first: Buffer.from('{"image":"data:image/jpeg;base64,') });
    sources.push(stalledPhoto);
    const photoRun = await timed(() =>
      photoRequest({ headers: headers(), body: stalledPhoto.stream, duplex: "half" }),
    );
    assert.equal(photoRun.value.status, 408);
    assert.ok(photoRun.ms >= BUDGET_MS - 100 && photoRun.ms < WITHIN_MS, `${photoRun.ms} ms`);
    const fixture = readFileSync("tests/fixtures/public-shirt.jpg");
    const photoOk = await photoRequest({
      headers: headers(),
      body: JSON.stringify({ image: "data:image/jpeg;base64," + fixture.toString("base64") }),
    });
    assert.equal(photoOk.status, 200);
    const photoBad = await photoRequest({
      headers: headers(),
      body: JSON.stringify({ image: "not an image" }),
    });
    assert.equal(photoBad.status, 400);
  } finally {
    for (const s of sources) s.stop();
  }
});
