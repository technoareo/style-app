import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { dominantColor, fashionClipEnvironment, parseFashionClipOutput, topCandidate, validateFashionClipImage } from "../src/server/fashionClip";

test("topCandidate rejects malformed entries and returns the highest score", () => {
  const result = topCandidate([
    { label: "tops", score: 0.2 },
    { label: "shoes", score: 0.8 },
    { label: "bad", score: Number.NaN },
  ]);
  assert.deepEqual(result, { label: "shoes", score: 0.8 });
});

test("dominantColor ignores a plain light border and finds the garment colour", async () => {
  const image = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "white" },
  })
    .composite([{ input: { create: { width: 60, height: 70, channels: 3, background: "#1f4f8f" } }, left: 20, top: 15 }])
    .jpeg()
    .toBuffer();
  assert.equal(await dominantColor(image), "blue");
});

test("the child environment excludes application secrets", () => {
  const env = fashionClipEnvironment({ PATH: "tools", STYLE_AUTH_SECRET: "do-not-share", DATABASE_URL: "private" });
  assert.equal(env.PATH, "tools");
  assert.equal(env.HF_HUB_OFFLINE, "1");
  assert.equal(env.STYLE_AUTH_SECRET, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test("model output is strict, bounded and uses known labels", () => {
  assert.equal(parseFashionClipOutput(JSON.stringify({
    category: { label: "tops", score: 0.9 }, pattern: { label: "solid", score: 0.8 }, material: { label: "denim", score: 0.7 },
  })).category.label, "tops");
  assert.throws(() => parseFashionClipOutput(JSON.stringify({
    category: { label: "instructions", score: 0.9 }, pattern: { label: "solid", score: 0.8 }, material: { label: "denim", score: 0.7 },
  })));
  assert.throws(() => parseFashionClipOutput("not json"));
});

test("image validation refuses unsupported and empty input", async () => {
  await assert.rejects(validateFashionClipImage(Buffer.alloc(0)));
  await assert.rejects(validateFashionClipImage(Buffer.from("not an image")));
});

test("dominantColor remains honest on dark and light plain backgrounds", async () => {
  for (const background of ["#ffffff", "#111111"]) {
    const image = await sharp({ create: { width: 90, height: 90, channels: 3, background } })
      .composite([{ input: { create: { width: 50, height: 60, channels: 3, background: "#a52f38" } }, left: 20, top: 15 }])
      .png().toBuffer();
    assert.equal(await dominantColor(image), "red");
  }
});
