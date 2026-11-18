import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { dominantColor, topCandidate } from "../src/server/fashionClip";

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
