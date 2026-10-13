import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLook } from "../src/domain/outfit";
import { starterWardrobe } from "../src/domain/starter";
import { analysisSchema } from "../src/domain/analysis";
import { backupSchema } from "../src/domain/backup";
const everyday = {
  occasion: "everyday" as const,
  temperature: 30,
  variation: 0,
};
test("composes complete outfits rather than first four items", () => {
  const wardrobe = [
    starterWardrobe[1],
    { ...starterWardrobe[1], id: "duplicate-top" },
    ...starterWardrobe,
  ];
  const result = buildLook(wardrobe, everyday);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.items.map((g) => g.category),
    ["Tops", "Bottoms", "Shoes"],
  );
});
test("does not hallucinate missing owned items", () => {
  assert.equal(buildLook([starterWardrobe[1]], everyday).complete, false);
  assert.equal(buildLook([], everyday).items.length, 0);
});
test("excludes laundry, unreviewed and warm items in hot weather", () => {
  for (const patch of [
    { available: false },
    { reviewed: false },
    { warmth: "warm" as const },
  ])
    assert.equal(
      buildLook(
        starterWardrobe.map((g) =>
          g.category === "Shoes" ? { ...g, ...patch } : g,
        ),
        everyday,
      ).complete,
      false,
    );
});
test("formal event cannot silently use casual pieces", () =>
  assert.equal(
    buildLook(starterWardrobe, { ...everyday, occasion: "formal" }).complete,
    false,
  ));
test("dress substitutes for top and bottom", () => {
  const dress = { ...starterWardrobe[1], category: "Dresses", id: "dress" };
  assert.deepEqual(
    buildLook([dress, starterWardrobe[3]], everyday).items.map((g) => g.id),
    ["dress", "4"],
  );
});
test("cold weather adds an available layer", () =>
  assert.ok(
    buildLook(starterWardrobe, { ...everyday, temperature: 12 }).items.some(
      (g) => g.category === "Outerwear",
    ),
  ));
test("new combinations stay within owned items", () => {
  const wardrobe = [
    ...starterWardrobe,
    { ...starterWardrobe[1], id: "second-top", color: "Blue" },
  ];
  const first = buildLook(wardrobe, everyday);
  const second = buildLook(wardrobe, { ...everyday, variation: 1 });
  assert.notDeepEqual(
    first.items.map((g) => g.id),
    second.items.map((g) => g.id),
  );
  assert.ok(second.items.every((g) => wardrobe.some((w) => w.id === g.id)));
});
test("validates bounded detection records and rejects malformed model output", () => {
  const item = {
    name: "White tee",
    category: "Tops",
    color: "White",
    pattern: "Solid",
    formality: "casual",
    brand: "",
    size: "",
    confidence: 0.8,
    evidence: "Visible short sleeves",
    box: [0.1, 0.1, 0.5, 0.5],
  };
  assert.equal(
    analysisSchema.safeParse({ items: [item], warning: "" }).success,
    true,
  );
  assert.equal(
    analysisSchema.safeParse({
      items: [{ ...item, box: [0.9, 0.9, 0.5, 0.5] }],
      warning: "",
    }).success,
    false,
  );
  assert.equal(
    analysisSchema.safeParse({
      items: [{ ...item, confidence: 2 }],
      warning: "",
    }).success,
    false,
  );
});
test("backup preserves items and rejects duplicates, executable image formats and unknown version", () => {
  const data = {
    version: 1,
    name: "Personal",
    wardrobe: starterWardrobe,
    looks: [],
  };
  assert.equal(backupSchema.safeParse(data).success, true);
  assert.equal(backupSchema.safeParse({ ...data, version: 2 }).success, false);
  assert.equal(
    backupSchema.safeParse({
      ...data,
      wardrobe: [starterWardrobe[0], starterWardrobe[0]],
    }).success,
    false,
  );
  assert.equal(
    backupSchema.safeParse({
      ...data,
      wardrobe: [
        { ...starterWardrobe[0], image: "data:image/svg+xml;base64,abc" },
      ],
    }).success,
    false,
  );
});
