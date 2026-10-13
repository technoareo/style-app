import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";

// Limits are read per call, so the environment can be changed per test.
process.env.STYLE_DATA_DIR = path.join(
  process.cwd(),
  ".data",
  "tests",
  randomUUID(),
);
mkdirSync(process.env.STYLE_DATA_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dataUrl = (mime: string, bytes: Buffer) =>
  `data:${mime};base64,${bytes.toString("base64")}`;

async function status(work: Promise<unknown>) {
  try {
    await work;
    return { status: 200 };
  } catch (e) {
    const err = e as { status?: number; extra?: { retryAfterSeconds?: number }; message: string };
    return { status: err.status, retry: err.extra?.retryAfterSeconds, message: err.message };
  }
}

test("image-work semaphore bounds concurrency, queue and wait, and always releases", async () => {
  process.env.STYLE_IMAGE_CONCURRENCY = "1";
  process.env.STYLE_IMAGE_QUEUE = "1";
  process.env.STYLE_IMAGE_WAIT_MS = "400";
  const { withImageWork, imageWorkStats } = await import("../src/server/admission");
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const order: string[] = [];
  const first = withImageWork(async () => {
    order.push("first");
    await hold;
  });
  const second = withImageWork(async () => {
    order.push("second");
  });
  await sleep(20);
  assert.deepEqual(imageWorkStats(), { active: 1, queued: 1, refused: 0 });
  // Queue is full: the third caller is refused at once with a retry hint.
  const third = await status(withImageWork(async () => order.push("third")));
  assert.equal(third.status, 503);
  assert.ok((third.retry ?? 0) > 0);
  assert.equal(imageWorkStats().refused, 1);
  release();
  await first;
  await second;
  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(imageWorkStats(), { active: 0, queued: 0, refused: 1 });

  // A waiter that is not served within the wait bound is removed and refused.
  let release2!: () => void;
  const hold2 = new Promise<void>((r) => (release2 = r));
  const holder = withImageWork(() => hold2);
  const started = Date.now();
  const waiter = await status(withImageWork(async () => 1));
  assert.equal(waiter.status, 503);
  assert.ok(Date.now() - started >= 300, "waited about the configured bound");
  assert.equal(imageWorkStats().queued, 0, "timed-out waiter left the queue");
  release2();
  await holder;

  // A throwing job releases its slot.
  await assert.rejects(
    withImageWork(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(imageWorkStats().active, 0);
  assert.equal(await withImageWork(async () => "ok"), "ok");
});

test("upload inspection rejects by header metadata before any decode", async () => {
  delete process.env.STYLE_MAX_UPLOAD_BYTES;
  delete process.env.STYLE_MAX_UPLOAD_SIDE;
  delete process.env.STYLE_MAX_UPLOAD_PIXELS;
  const { inspectUpload, decodeDataUrl } = await import("../src/server/imageAdmission");
  const solid = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: "#fff" } });

  // A small compressed file that would expand to 9 megapixels.
  const bomb = await solid(3000, 3000).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 200_000, `compressed size ${bomb.length}`);
  assert.equal((await status(inspectUpload(bomb))).status, 413);

  // Long thin image: within pixels, over the side limit.
  const thin = await solid(2600, 100).png().toBuffer();
  assert.equal((await status(inspectUpload(thin))).status, 413);

  // Exactly what the app's client sends is accepted.
  const jpeg = await solid(1600, 1200).jpeg().toBuffer();
  assert.deepEqual(await inspectUpload(jpeg), {
    format: "jpeg",
    width: 1600,
    height: 1200,
  });

  // Unsupported container and garbage are refused as unreadable.
  const tiff = await solid(50, 50).tiff().toBuffer();
  assert.equal((await status(inspectUpload(tiff))).status, 400);
  assert.equal((await status(inspectUpload(Buffer.alloc(64, 7)))).status, 400);

  // The claimed MIME type is not trusted: JPEG bytes labelled PNG are
  // judged by what they are.
  const claimedPng = decodeDataUrl(dataUrl("image/png", jpeg));
  assert.equal((await inspectUpload(claimedPng)).format, "jpeg");
  // ...and a label that is not an accepted image type is refused outright.
  assert.equal(
    (await status(Promise.resolve().then(() => decodeDataUrl(dataUrl("image/gif", jpeg))))).status,
    400,
  );
  assert.equal(
    (await status(Promise.resolve().then(() => decodeDataUrl("data:image/png;base64,AAAA")))).status,
    400,
  );
});

test("limits are configurable and size is judged on decoded bytes", async () => {
  process.env.STYLE_MAX_UPLOAD_BYTES = "100000";
  process.env.STYLE_MAX_UPLOAD_SIDE = "1000";
  const { decodeDataUrl, inspectUpload, assertDeclaredLength } = await import(
    "../src/server/imageAdmission"
  );
  const noisy = await sharp({
    create: {
      width: 600,
      height: 600,
      channels: 3,
      background: "#808080",
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();
  assert.ok(noisy.length > 100_000);
  assert.equal(
    (await status(Promise.resolve().then(() => decodeDataUrl(dataUrl("image/png", noisy))))).status,
    413,
  );
  const wide = await sharp({
    create: { width: 1200, height: 40, channels: 3, background: "#000" },
  })
    .png()
    .toBuffer();
  assert.equal((await status(inspectUpload(wide))).status, 413, "side limit follows STYLE_MAX_UPLOAD_SIDE");

  // Declared Content-Length is refused before any body is read.
  const big = {
    headers: new Headers({ "content-length": "50000000" }),
  } as unknown as NextRequest;
  assert.throws(() => assertDeclaredLength(big), { status: 413 });
  const small = {
    headers: new Headers({ "content-length": "1000" }),
  } as unknown as NextRequest;
  assert.doesNotThrow(() => assertDeclaredLength(small));
  // Invalid overrides fall back to safe defaults rather than disabling a bound.
  process.env.STYLE_MAX_UPLOAD_BYTES = "-5";
  process.env.STYLE_MAX_UPLOAD_SIDE = "banana";
  const { limits } = await import("../src/server/limits");
  assert.equal(limits().maxUploadBytes, 2_500_000);
  assert.equal(limits().maxUploadSide, 2400);
  delete process.env.STYLE_MAX_UPLOAD_BYTES;
  delete process.env.STYLE_MAX_UPLOAD_SIDE;
});

test("a burst of oversize and over-quota uploads is refused cheaply and boundedly", async () => {
  delete process.env.STYLE_MAX_UPLOAD_BYTES;
  delete process.env.STYLE_MAX_UPLOAD_SIDE;
  process.env.STYLE_IMAGE_CONCURRENCY = "2";
  process.env.STYLE_IMAGE_QUEUE = "4";
  process.env.STYLE_IMAGE_WAIT_MS = "2000";
  const { withImageWork, imageWorkStats } = await import("../src/server/admission");
  const { inspectUpload } = await import("../src/server/imageAdmission");
  const bomb = await sharp({
    create: { width: 5000, height: 5000, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  let peak = 0;
  let running = 0;
  const results = await Promise.all(
    Array.from({ length: 40 }, () =>
      status(
        withImageWork(async () => {
          running++;
          peak = Math.max(peak, running, imageWorkStats().active);
          try {
            return await inspectUpload(bomb);
          } finally {
            running--;
          }
        }),
      ),
    ),
  );
  assert.ok(peak <= 2, `at most 2 concurrent, saw ${peak}`);
  const refusedBusy = results.filter((r) => r.status === 503).length;
  const refusedSize = results.filter((r) => r.status === 413).length;
  assert.ok(refusedBusy > 0, "the burst beyond the queue was refused");
  assert.equal(refusedBusy + refusedSize, 40, "nothing was accepted or hung");
  assert.deepEqual(
    { active: imageWorkStats().active, queued: imageWorkStats().queued },
    { active: 0, queued: 0 },
  );
});
