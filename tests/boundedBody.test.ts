import test from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import {
  BodyCollector,
  SLAB_BYTES,
  effectiveBodyTimeoutMs,
  readBoundedBody,
} from "../src/server/boundedBody";
import {
  countBody,
  resetUploadMetrics,
  uploadMetrics,
} from "../src/server/uploadMetrics";
import {
  activeTimers,
  makeSource,
  sleep,
  streamInit,
} from "./helpers/bodySource";

/**
 * Unit tests of the shared bounded body reader with short INTERNAL budgets
 * (the `timeoutMs` argument). Production callers always pass
 * limits().bodyReadTimeoutMs (20 s default); nothing here changes that.
 */

const url = "http://127.0.0.1:3000/x";
const bytes = (n: number) => new Uint8Array(n).fill(97);
const request = (source: { stream: ReadableStream<Uint8Array> }, signal?: AbortSignal) =>
  new Request(url, streamInit(source.stream, signal ? { signal } : {}));

/** A request-like object whose signal counts listener add/remove calls. */
function spiedRequest(source: { stream: ReadableStream<Uint8Array> }, controller: AbortController) {
  const counts = { added: 0, removed: 0 };
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => {
    if (args[0] === "abort") counts.added++;
    return add(...args);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    if (args[0] === "abort") counts.removed++;
    return remove(...args);
  }) as typeof signal.removeEventListener;
  return { req: { body: source.stream, signal } as unknown as Request, counts };
}

test("a normal body is returned whole, the reader is released and no timer is left", async () => {
  const before = activeTimers();
  const source = makeSource({ first: Buffer.from('{"a":1}'), end: true });
  const result = await readBoundedBody(request(source), { maxBytes: 100, timeoutMs: 5000 });
  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" && result.bytes.toString(), '{"a":1}');
  assert.equal(source.stream.locked, false);
  assert.ok(activeTimers() <= before, "no timer outlives the read");
  assert.equal(source.state.cancelled, 0);
});

test("no body is reported as empty", async () => {
  const result = await readBoundedBody(new Request(url), { maxBytes: 10, timeoutMs: 1000 });
  assert.equal(result.status, "empty");
});

test("a stalled body times out, cancels the source, releases the reader and leaves no timer", async () => {
  const before = activeTimers();
  const source = makeSource({ first: bytes(3) });
  const started = Date.now();
  const result = await readBoundedBody(request(source), { maxBytes: 100, timeoutMs: 120 });
  assert.equal(result.status, "timeout");
  assert.ok(Date.now() - started < 1500, "returned promptly");
  assert.equal(source.state.cancelled, 1);
  assert.equal(source.stream.locked, false);
  assert.ok(activeTimers() <= before);
  source.stop();
});

test("a steady trickle that keeps making progress cannot extend the total deadline", async () => {
  const source = makeSource({ trickle: { everyMs: 15, chunk: bytes(1) } });
  const started = Date.now();
  const result = await readBoundedBody(request(source), { maxBytes: 1_000_000, timeoutMs: 200 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, "timeout");
  assert.ok(elapsed >= 150 && elapsed < 1500, `ended near the budget, not later (${elapsed} ms)`);
  assert.equal(source.state.cancelled, 1);
  assert.equal(source.stream.locked, false);
  source.stop();
});

test("a client abort during the read ends it at once, cancels, and removes the abort listener", async () => {
  const before = activeTimers();
  const source = makeSource({ first: bytes(2) });
  const controller = new AbortController();
  const { req, counts } = spiedRequest(source, controller);
  setTimeout(() => controller.abort(), 60);
  const started = Date.now();
  const result = await readBoundedBody(req, { maxBytes: 100, timeoutMs: 10_000 });
  assert.equal(result.status, "aborted");
  assert.ok(Date.now() - started < 1500, "did not wait for the 10 s budget");
  assert.equal(source.state.cancelled, 1);
  assert.equal(source.stream.locked, false);
  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1, "listener removed in finally");
  assert.ok(activeTimers() <= before);
  source.stop();
});

test("an already-aborted request is refused without reading and the source is cancelled", async () => {
  const source = makeSource({ first: bytes(2) });
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await readBoundedBody(request(source, controller.signal), {
    maxBytes: 100,
    timeoutMs: 10_000,
  });
  assert.equal(result.status, "aborted");
  assert.ok(Date.now() - started < 1500);
  assert.equal(source.state.cancelled, 1);
  assert.equal(source.stream.locked, false);
  source.stop();
});

test("an over-limit body is refused, the source is cancelled, and the reader is released", async () => {
  const before = activeTimers();
  const source = makeSource({ first: bytes(11), trickle: { everyMs: 10, chunk: bytes(5) } });
  const result = await readBoundedBody(request(source), { maxBytes: 10, timeoutMs: 5000 });
  assert.equal(result.status, "too_large");
  assert.equal(source.state.cancelled, 1);
  assert.equal(source.stream.locked, false);
  assert.ok(activeTimers() <= before);
  source.stop();
});

test("a body exactly at the cap is accepted", async () => {
  const source = makeSource({ first: bytes(10), end: true });
  const result = await readBoundedBody(request(source), { maxBytes: 10, timeoutMs: 5000 });
  assert.equal(result.status, "ok");
});

test("a source whose cancel never settles does not hold the reader past the grace period", async () => {
  const source = makeSource({ first: bytes(1), cancel: "hang" });
  const started = Date.now();
  const result = await readBoundedBody(request(source), {
    maxBytes: 100,
    timeoutMs: 80,
    cancelGraceMs: 80,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, "timeout");
  assert.ok(elapsed < 1500, `bounded by timeout + grace (${elapsed} ms)`);
  assert.equal(source.state.cancelled, 1);
  source.stop();
});

test("a source whose cancel rejects causes no unhandled rejection, on timeout, over-limit and abort", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const timeout = makeSource({ first: bytes(1), cancel: "reject" });
    assert.equal(
      (await readBoundedBody(request(timeout), { maxBytes: 100, timeoutMs: 60 })).status,
      "timeout",
    );
    const big = makeSource({ first: bytes(20), cancel: "reject" });
    assert.equal(
      (await readBoundedBody(request(big), { maxBytes: 10, timeoutMs: 5000 })).status,
      "too_large",
    );
    const controller = new AbortController();
    const aborted = makeSource({ first: bytes(1), cancel: "reject" });
    setTimeout(() => controller.abort(), 30);
    assert.equal(
      (
        await readBoundedBody(request(aborted, controller.signal), {
          maxBytes: 100,
          timeoutMs: 5000,
        })
      ).status,
      "aborted",
    );
    await sleep(100); // give any stray rejection a turn to surface
    assert.deepEqual(unhandled, []);
    for (const s of [timeout, big, aborted]) {
      assert.equal(s.state.cancelled, 1);
      s.stop();
    }
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a stream that errors mid-read is rethrown after cleanup", async () => {
  const before = activeTimers();
  const source = makeSource({ first: bytes(1), errorAfterMs: 30 });
  await assert.rejects(
    readBoundedBody(request(source), { maxBytes: 100, timeoutMs: 5000 }),
    /source failed/,
  );
  assert.equal(source.stream.locked, false);
  assert.ok(activeTimers() <= before);
  source.stop();
});

/**
 * Delayed continuation: a blocking microtask is queued BEFORE the read starts,
 * so it runs first and holds the thread past the deadline. The overdue timer
 * callback (a macrotask) cannot run until microtasks drain, so the already
 * available bytes / EOF are delivered to the reader with the timer unfired.
 * The monotonic clock check must still turn that into a timeout.
 */
function blockMicrotask(ms: number, first?: () => void) {
  queueMicrotask(() => {
    first?.();
    const end = performance.now() + ms;
    while (performance.now() < end) {
      // hold the thread: no timer callback can run in here
    }
  });
}

for (const [label, make] of [
  ["data then EOF", () => makeSource({ first: Buffer.from("{}"), end: true })],
  ["zero-byte progress then EOF", () => makeSource({ first: new Uint8Array(0), end: true })],
  ["EOF only", () => makeSource({ end: true })],
] as const) {
  test(`a result already queued behind a blocked thread is a timeout, not ok (${label}), with the timer unfired`, async () => {
    const before = activeTimers();
    const source = make();
    blockMicrotask(150);
    const started = performance.now();
    const result = await readBoundedBody(request(source), { maxBytes: 100, timeoutMs: 50 });
    assert.ok(performance.now() - started >= 150, "the continuation really was delayed past the budget");
    assert.equal(result.status, "timeout");
    assert.equal(source.stream.locked, false);
    assert.ok(activeTimers() <= before);
    source.stop();
  });
}

test("a delayed continuation after an earlier client abort keeps the first reason (aborted, not timeout)", async () => {
  const source = makeSource({ first: Buffer.from("{}"), end: true });
  const controller = new AbortController();
  blockMicrotask(150, () => controller.abort());
  const result = await readBoundedBody(request(source, controller.signal), {
    maxBytes: 100,
    timeoutMs: 50,
  });
  assert.equal(result.status, "aborted");
  source.stop();
});

test("a body that finishes inside the budget is still ok when the thread is not blocked", async () => {
  const source = makeSource({ first: Buffer.from("{}"), end: true });
  const result = await readBoundedBody(request(source), { maxBytes: 100, timeoutMs: 5000 });
  assert.equal(result.status, "ok");
  source.stop();
});

test("the budget can never be switched off: missing, zero, negative and non-finite values use the configured default", () => {
  const saved = process.env.STYLE_BODY_READ_TIMEOUT_MS;
  try {
    delete process.env.STYLE_BODY_READ_TIMEOUT_MS;
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      assert.equal(effectiveBodyTimeoutMs(bad), 20_000, String(bad));
    assert.equal(effectiveBodyTimeoutMs(150), 150);
    process.env.STYLE_BODY_READ_TIMEOUT_MS = "1000";
    assert.equal(effectiveBodyTimeoutMs(0), 1000);
    process.env.STYLE_BODY_READ_TIMEOUT_MS = "999999999"; // out of range: ignored
    assert.equal(effectiveBodyTimeoutMs(undefined), 20_000);
  } finally {
    if (saved === undefined) delete process.env.STYLE_BODY_READ_TIMEOUT_MS;
    else process.env.STYLE_BODY_READ_TIMEOUT_MS = saved;
  }
});

/**
 * Build 013, G25: memory must follow the BYTES, not the number of chunks.
 *
 * `gc` is obtained at run time (no command-line flag, `npm test` unchanged);
 * when it is unavailable the live-heap assertions are skipped and said so.
 * Live heap is sampled with a forced collection every SAMPLE_EVERY chunks, so
 * garbage cannot be mistaken for retention: only what the reader still holds
 * is measured. The build 012 shape (one Uint8Array per chunk plus one reaction
 * on a shared promise per chunk) was expected to hold tens of megabytes at
 * these counts; that figure is an estimate, not a measurement taken here.
 */
function getGc(): (() => void) | undefined {
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as unknown;
    return typeof gc === "function" ? (gc as () => void) : undefined;
  } catch {
    return undefined;
  }
}
const gc = getGc();
const MIB = 1024 * 1024;
const CHUNKS = 300_000;
const SAMPLE_EVERY = 25_000;

/** Pull-driven source of `total` chunks; `make(i)` builds each one fresh. */
function pulledSource(
  total: number,
  make: (i: number) => Uint8Array,
  onPull?: (i: number) => void,
) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= total) return controller.close();
      onPull?.(i);
      controller.enqueue(make(i++));
    },
  });
}

/** Runs a read and returns the largest live-heap growth seen while it ran. */
async function readMeasured(make: (i: number) => Uint8Array, total: number, maxBytes: number) {
  gc?.();
  const baseline = process.memoryUsage().heapUsed;
  let peak = 0;
  const stream = pulledSource(total, make, (i) => {
    if (gc && i > 0 && i % SAMPLE_EVERY === 0) {
      gc();
      peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
    }
  });
  const result = await readBoundedBody(new Request(url, streamInit(stream)), {
    maxBytes,
    timeoutMs: 120_000,
  });
  return { result, peak };
}

test("many one-byte chunks: bytes are exact and live memory does not grow with the chunk count", async (t) => {
  const { result, peak } = await readMeasured((i) => Uint8Array.of(i % 251), CHUNKS, 3_000_000);
  assert.equal(result.status, "ok");
  const bytes = result.status === "ok" ? result.bytes : Buffer.alloc(0);
  assert.equal(bytes.length, CHUNKS);
  for (let i = 0; i < CHUNKS; i += 997) assert.equal(bytes[i], i % 251, `byte ${i}`);
  assert.equal(bytes[CHUNKS - 1], (CHUNKS - 1) % 251);
  t.diagnostic(`${CHUNKS} one-byte chunks: peak live-heap growth ${(peak / MIB).toFixed(2)} MiB`);
  if (!gc) return t.diagnostic("gc unavailable: live-heap assertion skipped");
  assert.ok(peak < 8 * MIB, `retained ${(peak / MIB).toFixed(1)} MiB for ${CHUNKS} bytes`);
});

test("a flood of zero-byte chunks retains nothing and still ends ok", async (t) => {
  const { result, peak } = await readMeasured(
    (i) => (i === CHUNKS - 1 ? Uint8Array.of(7) : new Uint8Array(0)),
    CHUNKS,
    3_000_000,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? [...result.bytes] : null, [7]);
  t.diagnostic(`${CHUNKS} zero-byte chunks: peak live-heap growth ${(peak / MIB).toFixed(2)} MiB`);
  if (!gc) return t.diagnostic("gc unavailable: live-heap assertion skipped");
  assert.ok(peak < 8 * MIB, `retained ${(peak / MIB).toFixed(1)} MiB for 1 byte`);
});

test("tiny chunks respect the byte cap exactly: at the cap is ok, one over is too_large", async () => {
  const at = await readBoundedBody(
    new Request(url, streamInit(pulledSource(1000, () => Uint8Array.of(1)))),
    { maxBytes: 1000, timeoutMs: 30_000 },
  );
  assert.equal(at.status, "ok");
  assert.equal(at.status === "ok" && at.bytes.length, 1000);
  const tooBig = await readBoundedBody(
    new Request(url, streamInit(pulledSource(1000, () => Uint8Array.of(1)))),
    { maxBytes: 999, timeoutMs: 30_000 },
  );
  assert.equal(tooBig.status, "too_large");
});

test("a source that never waits (microtask-only flow) cannot outrun the deadline", async () => {
  let cancelled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(Uint8Array.of(1));
    },
    cancel() {
      cancelled++;
    },
  });
  const started = Date.now();
  const result = await readBoundedBody(new Request(url, streamInit(endless)), {
    maxBytes: 1_000_000_000,
    timeoutMs: 200,
  });
  assert.equal(result.status, "timeout");
  assert.ok(Date.now() - started < 3000, `ended promptly (${Date.now() - started} ms)`);
  assert.equal(cancelled, 1);
});

test("BodyCollector: a million one-byte adds retain a handful of slabs and the exact bytes", () => {
  const collector = new BodyCollector();
  const total = 1_000_000;
  for (let i = 0; i < total; i++) collector.add(Uint8Array.of(i % 251));
  assert.equal(collector.size, total);
  assert.ok(
    collector.pieceCount <= Math.ceil(total / SLAB_BYTES) + 1,
    `${collector.pieceCount} pieces`,
  );
  const out = collector.toBuffer();
  assert.equal(out.length, total);
  for (let i = 0; i < total; i += 4099) assert.equal(out[i], i % 251);
  assert.equal(out[total - 1], (total - 1) % 251);
});

test("BodyCollector: mixed sizes (including empty and slab-sized) keep order and bytes, with bounded pieces", () => {
  let seed = 12345;
  // 32-bit linear congruential generator; the high bits are the good ones.
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
  const collector = new BodyCollector();
  const parts: Buffer[] = [];
  let total = 0;
  for (let n = 0; total < 2_900_000 && n < 100_000; n++) {
    const size = [0, 1, 7, 100, 16_383, 16_384, 40_000, SLAB_BYTES, 100_000][(next() >>> 8) % 9];
    const chunk = Buffer.alloc(size, (next() >>> 8) & 0xff);
    parts.push(chunk);
    collector.add(chunk);
    total += size;
  }
  assert.equal(collector.size, total);
  const out = collector.toBuffer();
  assert.equal(Buffer.compare(out, Buffer.concat(parts)), 0, "identical bytes in identical order");
  assert.ok(
    collector.pieceCount <= (total / 16_384) * 2 + 4,
    `${collector.pieceCount} pieces for ${total} bytes`,
  );
});

test("BodyCollector: a mostly empty slab is copied out, not pinned", () => {
  const collector = new BodyCollector();
  collector.add(Uint8Array.of(1, 2, 3));
  collector.add(new Uint8Array(20_000).fill(9)); // large chunk seals the slab first
  collector.add(Uint8Array.of(4));
  const out = collector.toBuffer();
  assert.deepEqual([...out.subarray(0, 3)], [1, 2, 3]);
  assert.equal(out[3], 9);
  assert.equal(out[out.length - 1], 4);
  assert.equal(out.length, 20_004);
});

test("counters: every outcome and cancel result is counted under a fixed route; unknown labels become 'other'", async () => {
  resetUploadMetrics();
  // ok
  assert.equal(
    (
      await readBoundedBody(request(makeSource({ first: Buffer.from("{}"), end: true })), {
        maxBytes: 10,
        timeoutMs: 5000,
        route: "photos",
      })
    ).status,
    "ok",
  );
  // empty
  await readBoundedBody(new Request(url), { maxBytes: 10, timeoutMs: 1000, route: "photos" });
  // timeout with a cancel that never settles: grace expired
  const hang = makeSource({ first: bytes(1), cancel: "hang" });
  await readBoundedBody(request(hang), { maxBytes: 100, timeoutMs: 60, cancelGraceMs: 60, route: "analyze" });
  // too_large with a cancel that rejects: rejected
  const rejecting = makeSource({ first: bytes(20), cancel: "reject" });
  await readBoundedBody(request(rejecting), { maxBytes: 10, timeoutMs: 5000, route: "wardrobe" });
  // aborted with a normal cancel: settled
  const controller = new AbortController();
  controller.abort();
  const normal = makeSource({ first: bytes(2) });
  await readBoundedBody(request(normal, controller.signal), { maxBytes: 10, timeoutMs: 5000, route: "auth" });
  // stream error
  const failing = makeSource({ first: bytes(1), errorAfterMs: 20 });
  await assert.rejects(
    readBoundedBody(request(failing), { maxBytes: 100, timeoutMs: 5000, route: "auth" }),
    /source failed/,
  );
  // an unknown label cannot create a new row
  countBody("../../not-a-route" as never, "ok");
  const m = uploadMetrics();
  assert.equal(m.bodies.photos.ok, 1);
  assert.equal(m.bodies.photos.empty, 1);
  assert.equal(m.bodies.analyze.timeout, 1);
  assert.equal(m.cancels.analyze.grace_expired, 1);
  assert.equal(m.bodies.wardrobe.too_large, 1);
  assert.equal(m.cancels.wardrobe.rejected, 1);
  assert.equal(m.bodies.auth.aborted, 1);
  assert.equal(m.cancels.auth.settled, 1);
  assert.equal(m.bodies.auth.error, 1);
  assert.equal(m.bodies.other.ok, 1);
  assert.deepEqual(Object.keys(m.bodies), ["auth", "wardrobe", "photos", "analyze", "other"]);
  for (const s of [hang, rejecting, normal, failing]) s.stop();
});
