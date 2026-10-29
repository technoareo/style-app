import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLook, type StyleContext } from "../src/domain/outfit";
import { starterWardrobe } from "../src/domain/starter";
import type { Garment } from "../src/domain/types";

const g = (
  id: string,
  category: string,
  patch: Partial<Garment> = {},
): Garment => ({
  id,
  name: id,
  category,
  color: "White",
  brand: "",
  size: "",
  image: "👕",
  ...patch,
});
const ctx = (patch: Partial<StyleContext> = {}): StyleContext => ({
  occasion: "everyday",
  temperature: 22,
  variation: 0,
  ...patch,
});
const ids = (r: ReturnType<typeof buildLook>) => r.items.map((i) => i.id);
const base = [g("jeans", "Bottoms"), g("shoes", "Shoes")];

test("choosing a season picks the top confirmed for that season", () => {
  const wardrobe = [
    g("a-linen", "Tops", { seasons: ["summer"] }),
    g("b-wool", "Tops", { seasons: ["winter"] }),
    ...base,
  ];
  assert.deepEqual(ids(buildLook(wardrobe, ctx({ season: "summer" }))), [
    "a-linen",
    "jeans",
    "shoes",
  ]);
  assert.deepEqual(ids(buildLook(wardrobe, ctx({ season: "winter" }))), [
    "b-wool",
    "jeans",
    "shoes",
  ]);
});

test("choosing an occasion picks the piece tagged for it", () => {
  const wardrobe = [
    g("a-tee", "Tops", { occasions: ["everyday"], formality: "casual" }),
    g("b-blouse", "Tops", { occasions: ["work"], formality: "smart" }),
    ...base,
  ];
  assert.equal(
    ids(buildLook(wardrobe, ctx({ occasion: "everyday" })))[0],
    "a-tee",
  );
  const work = buildLook(wardrobe, ctx({ occasion: "work" }));
  assert.equal(ids(work)[0], "b-blouse");
  assert.equal(work.message, "Your work look");
});

test("a tagged match beats an untagged piece, which beats an explicit mismatch", () => {
  const wardrobe = [
    g("a-mismatch", "Tops", { occasions: ["lounge"] }),
    g("b-unknown", "Tops"),
    g("c-match", "Tops", { occasions: ["work"] }),
    ...base,
  ];
  const order = [0, 1, 2].map(
    (variation) =>
      ids(buildLook(wardrobe, ctx({ occasion: "work", variation })))[0],
  );
  // Match first, then unknown; the explicit mismatch is never reached while others exist.
  assert.deepEqual(order, ["c-match", "b-unknown", "c-match"]);
});

test("ranking is deterministic and variation stays inside the least-mismatched pool", () => {
  const wardrobe = [
    g("t1", "Tops", { occasions: ["work"] }),
    g("t2", "Tops", { occasions: ["work"] }),
    g("t3", "Tops", { occasions: ["lounge"] }),
    ...base,
  ];
  const run = (variation: number) =>
    ids(buildLook(wardrobe, ctx({ occasion: "work", variation })));
  assert.deepEqual(run(0), run(0));
  const tops = new Set([0, 1, 2, 3, 4, 5].map((v) => run(v)[0]));
  // The mismatched top is only reachable when no matched outfit remains.
  assert.deepEqual([...tops].sort(), ["t1", "t2"]);
  assert.notDeepEqual(run(0), run(1));
});

test("old wardrobe without tags behaves as before and says fit is unconfirmed", () => {
  const plain = buildLook(starterWardrobe, ctx());
  const withAny = buildLook(starterWardrobe, ctx({ season: "any" }));
  assert.deepEqual(ids(plain), ids(withAny));
  assert.equal(plain.complete, true);
  assert.equal(plain.suitability, "unconfirmed");
  assert.equal(plain.message, "Your daily edit");
  assert.ok(
    plain.notes.some((n) => /No piece is tagged for everyday yet/.test(n)),
  );
  // Choosing a season cannot exclude untagged pieces.
  const winter = buildLook(starterWardrobe, ctx({ season: "winter" }));
  assert.deepEqual(ids(winter), ids(plain));
  assert.equal(winter.suitability, "unconfirmed");
  // Empty arrays (cleared in the editor) are unknown, not a mismatch.
  const cleared = starterWardrobe.map((i) => ({
    ...i,
    seasons: [],
    occasions: [],
  }));
  assert.equal(
    buildLook(cleared, ctx({ season: "winter" })).suitability,
    "unconfirmed",
  );
});

test("only mismatching pieces: still complete, but no claim of suitability", () => {
  const wardrobe = [
    g("tee", "Tops", { occasions: ["lounge"], seasons: ["summer"] }),
    g("jeans", "Bottoms", { occasions: ["lounge"], seasons: ["summer"] }),
    g("shoes", "Shoes", { occasions: ["lounge"], seasons: ["summer"] }),
  ];
  const r = buildLook(wardrobe, ctx({ occasion: "work", season: "winter" }));
  assert.equal(r.complete, true);
  assert.equal(r.suitability, "mismatch");
  assert.ok(!/Your work look/.test(r.message));
  assert.match(r.message, /^Closest work combination$/);
  assert.ok(r.notes.some((n) => /not a confirmed fit.*work in winter/.test(n)));
  assert.ok(r.notes.every((n) => !/^Every piece is tagged/.test(n)));
});

test("fully tagged outfit is reported as confirmed; a mix is partial", () => {
  const tagged = (id: string, category: string) =>
    g(id, category, { occasions: ["work"], seasons: ["autumn"] });
  const all = [
    tagged("t", "Tops"),
    tagged("b", "Bottoms"),
    tagged("s", "Shoes"),
  ];
  const full = buildLook(all, ctx({ occasion: "work", season: "autumn" }));
  assert.equal(full.suitability, "confirmed");
  assert.ok(
    full.notes.some((n) => /Every piece is tagged for work in autumn/.test(n)),
  );
  const mixed = [tagged("t", "Tops"), g("b", "Bottoms"), tagged("s", "Shoes")];
  assert.equal(
    buildLook(mixed, ctx({ occasion: "work", season: "autumn" })).suitability,
    "partial",
  );
});

test("formal dress code and event tag work together; casual pieces stay excluded", () => {
  const formalItem = (
    id: string,
    category: string,
    extra: Partial<Garment> = {},
  ) => g(id, category, { formality: "formal", ...extra });
  const wardrobe = [
    formalItem("a-untagged", "Tops"),
    formalItem("b-event", "Tops", { occasions: ["event"] }),
    formalItem("skirt", "Bottoms"),
    formalItem("heels", "Shoes"),
    g("casual-top", "Tops", { occasions: ["event"], formality: "casual" }),
  ];
  const r = buildLook(wardrobe, ctx({ occasion: "formal" }));
  assert.equal(ids(r)[0], "b-event");
  assert.ok(!ids(r).includes("casual-top"));
  // A casual item tagged "event" still cannot satisfy a formal dress code.
  assert.equal(
    buildLook(
      wardrobe.filter(
        (i) => i.formality !== "formal" || i.category !== "Shoes",
      ),
      ctx({ occasion: "formal" }),
    ).complete,
    false,
  );
  // Formal pieces tagged only for everyday are used, but flagged.
  const everydayOnly = wardrobe.map((i) =>
    i.formality === "formal" ? { ...i, occasions: ["everyday" as const] } : i,
  );
  const m = buildLook(everydayOnly, ctx({ occasion: "formal" }));
  assert.equal(m.complete, true);
  assert.equal(m.suitability, "mismatch");
});

test("a perfectly tagged item is still excluded when unreviewed, in laundry, or too warm", () => {
  const perfect = {
    occasions: ["work" as const],
    seasons: ["winter" as const],
  };
  const wardrobe = [
    g("ok", "Tops"),
    g("star-unreviewed", "Tops", { ...perfect, reviewed: false }),
    g("star-laundry", "Tops", { ...perfect, available: false }),
    g("star-warm", "Tops", { ...perfect, warmth: "warm" }),
    ...base,
  ];
  const r = buildLook(
    wardrobe,
    ctx({ occasion: "work", season: "winter", temperature: 30 }),
  );
  assert.equal(ids(r)[0], "ok");
});

test("cold weather layer prefers the one confirmed for the season", () => {
  const wardrobe = [
    g("t", "Tops"),
    ...base,
    g("a-light-jacket", "Outerwear", { seasons: ["summer"] }),
    g("b-coat", "Outerwear", { seasons: ["winter"] }),
  ];
  const r = buildLook(wardrobe, ctx({ temperature: 5, season: "winter" }));
  assert.equal(ids(r).at(-1), "b-coat");
  assert.deepEqual(
    ids(buildLook(wardrobe, ctx({ temperature: 5, season: "summer" }))).at(-1),
    "a-light-jacket",
  );
});

test("a confirmed match is not lost behind the per-category cap of 60", () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    g(`top-${String(i).padStart(2, "0")}`, "Tops", { occasions: ["lounge"] }),
  );
  const wardrobe = [
    ...many,
    g("late-match", "Tops", { occasions: ["work"] }),
    ...base,
  ];
  assert.equal(
    ids(buildLook(wardrobe, ctx({ occasion: "work" })))[0],
    "late-match",
  );
});

test("results only contain owned items", () => {
  const wardrobe = [
    g("a", "Tops", { seasons: ["summer"] }),
    g("b", "Tops", { occasions: ["work"] }),
    ...base,
  ];
  for (const season of ["any", "spring", "summer", "autumn", "winter"] as const)
    for (const occasion of ["everyday", "work", "evening", "formal"] as const)
      for (const variation of [0, 1, 2])
        for (const item of buildLook(
          wardrobe,
          ctx({ season, occasion, variation }),
        ).items)
          assert.ok(wardrobe.includes(item));
});
