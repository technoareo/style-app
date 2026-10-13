import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analysisSchema } from "../src/domain/analysis";
import {
  mergeShoePair,
  suggestShoePairs,
  unionBox,
} from "../src/domain/pairs";
import { buildLook } from "../src/domain/outfit";
import type { Garment } from "../src/domain/types";

const recorded = (name: string) =>
  analysisSchema.parse(
    JSON.parse(readFileSync(`docs/verification/${name}.json`, "utf8")).analysis,
  );
const withIds = (items: ReturnType<typeof recorded>["items"]) =>
  items.map((item, index) => ({ ...item, id: `d${index}` }));

test("recorded shoe output is only suggested as a pair, and becomes one item when confirmed", () => {
  const items = withIds(recorded("candidate-handmade-shoes").items);
  assert.equal(items.length, 2, "the model really returned two records");
  const pairs = suggestShoePairs(items);
  assert.deepEqual(pairs, [["d0", "d1"]], "suggested, not merged");
  // Nothing was merged by the suggestion itself.
  assert.equal(items.length, 2);

  const merged = mergeShoePair(items[0], items[1]);
  const after = items.filter((i) => i.id !== "d1").map((i) =>
    i.id === "d0" ? merged : i,
  );
  assert.equal(after.length, 1);
  assert.equal(after[0].category, "Shoes");
  assert.equal(
    (after[0] as { reviewed?: boolean }).reviewed,
    false,
    "merging resets review",
  );
  assert.match(after[0].name, /pair/i);
  const [x, y, w, h] = after[0].box;
  // Union crop covers both source boxes.
  for (const b of items.map((i) => i.box)) {
    assert.ok(x <= b[0] + 1e-9 && y <= b[1] + 1e-9);
    assert.ok(x + w >= b[0] + b[2] - 1e-9 && y + h >= b[1] + b[3] - 1e-9);
  }
});

test("two distinct bags are never suggested for merging", () => {
  const items = withIds(recorded("candidate-handbag").items);
  assert.equal(items.length, 2);
  assert.deepEqual(suggestShoePairs(items), []);
});

test("distant shoes, unusable full-frame bounds and mismatched sizes are not suggested", () => {
  const shoe = (id: string, box: number[]) => ({ id, category: "Shoes", box });
  assert.deepEqual(
    suggestShoePairs([shoe("a", [0, 0, 0.2, 0.2]), shoe("b", [0.7, 0.7, 0.2, 0.2])]),
    [],
  );
  assert.deepEqual(
    suggestShoePairs([shoe("a", [0, 0, 1, 1]), shoe("b", [0, 0, 1, 1])]),
    [],
    "full-frame fallback boxes are not evidence of a pair",
  );
  assert.deepEqual(
    suggestShoePairs([shoe("a", [0.1, 0.1, 0.5, 0.5]), shoe("b", [0.62, 0.1, 0.05, 0.05])]),
    [],
  );
  // A third nearby shoe is not silently grouped: each shoe is in one pair.
  const pairs = suggestShoePairs([
    shoe("a", [0.1, 0.1, 0.2, 0.2]),
    shoe("b", [0.32, 0.1, 0.2, 0.2]),
    shoe("c", [0.54, 0.1, 0.2, 0.2]),
  ]);
  assert.equal(pairs.length, 1);
  const union = unionBox([0.1, 0.1, 0.2, 0.2], [0.32, 0.1, 0.2, 0.2]);
  [0.1, 0.1, 0.42, 0.2].forEach((expected, i) =>
    assert.ok(Math.abs(union[i] - expected) < 1e-9),
  );
});

test("an unseen AI 'formal' guess is not confirmed formal; a deliberate choice is", () => {
  const base = (id: string, category: string, extra: Partial<Garment> = {}) =>
    ({
      id,
      name: id,
      category,
      color: "black",
      brand: "",
      size: "",
      image: "x",
      reviewed: true,
      available: true,
      ...extra,
    }) as Garment;
  // The review dialog stores the model's guess as aiFormality and keeps
  // formality "unknown" until the user picks it.
  const unconfirmed = [
    base("top", "Tops", { formality: "unknown" }),
    base("bottom", "Bottoms", { formality: "unknown" }),
    base("shoes", "Shoes", { formality: "unknown" }),
  ];
  const formal = { occasion: "formal" as const, temperature: 20, variation: 0 };
  assert.equal(buildLook(unconfirmed, formal).complete, false);
  const confirmed = unconfirmed.map((g) => ({ ...g, formality: "formal" as const }));
  assert.equal(buildLook(confirmed, formal).complete, true);
});
