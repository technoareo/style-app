import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLook,
  rankOutfits,
  scoreItems,
  type SearchStats,
  seasonTemperatureWarning,
  type StyleContext,
} from "../src/domain/outfit";
import { backupSchema } from "../src/domain/backup";
import { starterWardrobe } from "../src/domain/starter";
import type { Garment } from "../src/domain/types";

/** Build 020 repairs after the independent review. */
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

test("formality stays authoritative: a formal gown tagged evening or work is not a mismatch", () => {
  const formalShoes = g("heels", "Shoes", { formality: "formal" });
  for (const tag of ["evening", "work"] as const) {
    const gown = g("gown", "Dresses", {
      formality: "formal",
      occasions: [tag],
    });
    const r = buildLook([gown, formalShoes], ctx({ occasion: "formal" }));
    assert.equal(r.complete, true);
    assert.equal(r.suitability, "partial", tag);
    assert.equal(r.message, "Your formal look");
    assert.ok(r.notes.every((n) => !/not a confirmed fit/.test(n)));
    assert.ok(
      r.notes.some((n) => /evening or work-tagged pieces suit it/.test(n)),
    );
  }
  // The event tag is still stronger than the related ones.
  const best = buildLook(
    [
      g("a-evening", "Dresses", {
        formality: "formal",
        occasions: ["evening"],
      }),
      g("b-event", "Dresses", { formality: "formal", occasions: ["event"] }),
      formalShoes,
    ],
    ctx({ occasion: "formal" }),
  );
  assert.equal(best.items[0].id, "b-event");
  // Formal pieces tagged only for lounge are still flagged.
  const lounge = g("lounge-gown", "Dresses", {
    formality: "formal",
    occasions: ["lounge"],
  });
  assert.equal(
    buildLook([lounge, formalShoes], ctx({ occasion: "formal" })).suitability,
    "mismatch",
  );
  // An evening plan treats an event-tagged piece as compatible too.
  const eventDress = g("d", "Dresses", {
    occasions: ["event"],
    formality: "smart",
  });
  assert.equal(
    buildLook([eventDress, base[1]], ctx({ occasion: "evening" })).suitability,
    "partial",
  );
  // Compatibility never lifts the dress code: casual stays out of a formal plan.
  assert.equal(
    buildLook(
      [
        g("c", "Dresses", { occasions: ["event"], formality: "casual" }),
        formalShoes,
      ],
      ctx({ occasion: "formal" }),
    ).complete,
    false,
  );
});

test("a mismatched cold-weather layer does not downgrade a fully matching core outfit", () => {
  const tag = (id: string, category: string) =>
    g(id, category, { occasions: ["work"], seasons: ["winter"] });
  const wardrobe = [
    tag("t", "Tops"),
    tag("b", "Bottoms"),
    tag("s", "Shoes"),
    g("beach-cover", "Outerwear", {
      occasions: ["lounge"],
      seasons: ["summer"],
    }),
  ];
  const c = ctx({ occasion: "work", season: "winter", temperature: 8 });
  const r = buildLook(wardrobe, c);
  assert.deepEqual(ids(r), ["t", "b", "s", "beach-cover"]);
  assert.equal(r.suitability, "confirmed");
  assert.equal(r.message, "Your work look");
  assert.ok(
    r.notes.some((n) =>
      /Every one of the main pieces is tagged for work in winter/.test(n),
    ),
  );
  assert.ok(
    r.notes.some((n) =>
      /The layer is added for warmth at 8°C and is not confirmed for work in winter: beach-cover \(occasions: lounge, not work; seasons: summer, not winter\)/.test(
        n,
      ),
    ),
  );
  // A matching layer is preferred over a mismatched one and needs no extra note.
  const better = buildLook(
    [
      ...wardrobe,
      g("coat", "Outerwear", { occasions: ["work"], seasons: ["winter"] }),
    ],
    c,
  );
  assert.equal(ids(better).at(-1), "coat");
  assert.ok(better.notes.every((n) => !/The layer is added/.test(n)));
  // A mismatched CORE is still reported even when the layer matches.
  const badCore = buildLook(
    [
      g("t", "Tops", { occasions: ["lounge"] }),
      ...base,
      g("coat", "Outerwear", { occasions: ["work"], seasons: ["winter"] }),
    ],
    c,
  );
  assert.equal(badCore.suitability, "mismatch");
});

test("mismatch text names the dimension that actually conflicts", () => {
  const only = (patch: Partial<Garment>) =>
    buildLook(
      [g("tee", "Tops", patch), ...base],
      ctx({ occasion: "work", season: "winter" }),
    ).notes.find((n) => /not a confirmed fit/.test(n))!;
  const seasonOnly = only({ occasions: ["work"], seasons: ["summer"] });
  assert.match(seasonOnly, /tee \(seasons: summer, not winter\)/);
  assert.doesNotMatch(seasonOnly, /occasions:/);
  const occasionOnly = only({ occasions: ["lounge"], seasons: ["winter"] });
  assert.match(occasionOnly, /tee \(occasions: lounge, not work\)/);
  assert.doesNotMatch(occasionOnly, /seasons:/);
  assert.match(
    only({ occasions: ["lounge"], seasons: ["summer"] }),
    /occasions: lounge, not work; seasons: summer, not winter/,
  );
});

test("variation starts with the strongest tier and never reaches mismatches or skips a tier", () => {
  const strong = [1, 2, 3, 4].map((n) =>
    g(`m${n}`, "Tops", { occasions: ["work"], seasons: ["winter"] }),
  );
  const unknown = [1, 2, 3].map((n) => g(`u${n}`, "Tops"));
  const bad = g("x", "Tops", { occasions: ["lounge"] });
  const run = (tops: Garment[], variation: number) =>
    buildLook(
      [...tops, ...base],
      ctx({ occasion: "work", season: "winter", variation }),
    );
  // Four full matches fill the pool: variation never drops to untagged/mismatched.
  const picks = Array.from(
    { length: 12 },
    (_, v) => run([...strong, ...unknown, bad], v).items[0].id,
  );
  assert.ok(
    picks.every((p) => /^m\d$/.test(p)),
    picks.join(),
  );
  assert.equal(new Set(picks).size, 4);
  // One strong outfit must not make variation a no-op: it continues into the
  // next tier, in order, and never to the mismatched piece.
  const few = [strong[0], ...unknown, bad];
  const seq = Array.from({ length: 6 }, (_, v) => run(few, v));
  assert.deepEqual(
    seq.slice(0, 3).map((r) => r.items[0].id),
    ["m1", "u1", "u2"],
  );
  assert.ok(seq.every((r) => r.items[0].id !== "x"));
  assert.notEqual(seq[0].suitability, seq[1].suitability); // honest per outfit
});

test("the bounded search agrees with a brute-force ranking on random wardrobes", () => {
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)];
  const colors = ["White", "Red", "Blue", "Black", "Green", ""];
  const occasionSets = [
    undefined,
    [],
    ["work"],
    ["everyday"],
    ["event"],
    ["evening"],
    ["lounge"],
  ] as const;
  const seasonSets = [
    undefined,
    [],
    ["winter"],
    ["summer"],
    ["spring", "winter"],
  ] as const;
  let manyCombinations = 0;
  for (let round = 0; round < 40; round++) {
    const make = (cat: string, n: number) =>
      Array.from({ length: n }, (_, i) => {
        const occasions = pick(occasionSets);
        const seasons = pick(seasonSets);
        return g(`${cat[0]}${round}-${i}`, cat, {
          color: pick(colors),
          pattern: pick(["Solid", "Striped", "", "Plaid"]),
          formality: pick([
            "casual",
            "smart",
            "formal",
            "unknown",
            undefined,
          ] as const),
          occasions: occasions && ([...occasions] as Garment["occasions"]),
          seasons: seasons && ([...seasons] as Garment["seasons"]),
        });
      });
    const wardrobe = [
      ...make("Tops", 5),
      ...make("Bottoms", 4),
      ...make("Shoes", 4),
      ...make("Dresses", 2),
    ];
    for (const occasion of ["everyday", "work", "evening", "formal"] as const) {
      const context = ctx({
        occasion,
        season: pick(["any", "winter", "summer"] as const),
      });
      const result = buildLook(wardrobe, context);
      const eligible = wardrobe.filter(
        (i) => occasion !== "formal" || i.formality === "formal",
      );
      const slot = (c: string) => eligible.filter((i) => i.category === c);
      const sets = [
        ...slot("Dresses").map((d) => [d]),
        ...slot("Tops").flatMap((t) => slot("Bottoms").map((b) => [t, b])),
      ].flatMap((b) => slot("Shoes").map((s) => [...b, s]));
      if (!sets.length) {
        assert.equal(result.complete, false);
        continue;
      }
      const ranked = sets
        .map((items) => ({
          ...scoreItems(items, context),
          key: items.map((i) => i.id).join(),
        }))
        .sort(
          (a, b) =>
            a.miss - b.miss ||
            b.hit - a.hit ||
            b.near - a.near ||
            b.score - a.score ||
            a.key.localeCompare(b.key),
        );
      assert.equal(ids(result).join(), ranked[0].key, `${round}/${occasion}`);
      // The whole retained list, not just the winner, matches brute force.
      for (const limit of [5, 30]) {
        assert.deepEqual(
          rankOutfits(wardrobe, context, limit),
          ranked.slice(0, limit).map((r) => r.key.split(",")),
          `${round}/${occasion}/top${limit}`,
        );
      }
      if (ranked.length > 30) manyCombinations += 1;
    }
  }
  // Guard: the generator must really produce more than 30 combinations.
  assert.ok(manyCombinations > 20, `only ${manyCombinations} rounds had >30`);
});

test("a maximum-size wardrobe does bounded retained work and a late relevant item is not discarded", (t) => {
  const colors = ["White", "Red", "Blue", "Black", "Green"];
  const make = (cat: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      g(`${cat}-${String(i).padStart(4, "0")}`, cat, {
        color: colors[i % colors.length],
        pattern: i % 3 ? "Solid" : "Striped",
        formality: "smart",
        occasions: ["lounge"],
      }),
    );
  const wardrobe = [
    ...make("Tops", 600),
    ...make("Bottoms", 600),
    ...make("Shoes", 600),
    ...make("Dresses", 100),
    g("zz-late-top", "Tops", { occasions: ["work"], seasons: ["winter"] }),
  ];
  const context = ctx({ occasion: "work", season: "winter" });
  const stats: SearchStats = { examined: 0, maxRetained: 0 };
  const start = performance.now();
  const ranked = rankOutfits(wardrobe, context, 30, stats);
  const elapsed = performance.now() - start;
  // Contract, independent of machine speed: the per-category cap bounds the
  // scan (60 dresses + 60 x 60 top/bottom pairs, each with 60 shoes) and the
  // search never holds more than limit + 1 entries, however many it scans.
  assert.equal(stats.examined, (60 + 60 * 60) * 60);
  assert.ok(stats.maxRetained <= 31, `retained ${stats.maxRetained}`);
  assert.equal(ranked.length, 30);
  // The relevant item added last is still the winner (relevance-sorted cap).
  assert.equal(ranked[0][0], "zz-late-top");
  assert.equal(buildLook(wardrobe, context).items[0].id, "zz-late-top");
  // Wall time is informational only; the bound is a deliberately huge sanity check.
  t.diagnostic(`ranked ${stats.examined} outfits in ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed < 10_000, `took ${elapsed.toFixed(0)} ms`);
});

test("variation tops up from weaker tiers only as far as MIN_VARIETY", () => {
  const strong = (n: number) =>
    g(`m${n}`, "Tops", { occasions: ["work"], seasons: ["winter"] });
  const weak = (n: number) => g(`u${String(n).padStart(2, "0")}`, "Tops");
  const run = (tops: Garment[], variation: number) =>
    buildLook(
      [...tops, ...base],
      ctx({ occasion: "work", season: "winter", variation }),
    ).items[0].id;
  const distinct = (tops: Garment[]) =>
    new Set(Array.from({ length: 60 }, (_, v) => run(tops, v)));
  // 2 strongest + 28 weaker = 30 searched outfits: the pool is the 2 strongest
  // plus ONE weaker, not all 28.
  const two = [
    strong(1),
    strong(2),
    ...Array.from({ length: 28 }, (_, i) => weak(i)),
  ];
  assert.equal(
    rankOutfits([...two, ...base], ctx({ occasion: "work", season: "winter" }))
      .length,
    30,
  );
  assert.deepEqual([...distinct(two)].sort(), ["m1", "m2", "u00"]);
  assert.deepEqual(
    [0, 1, 2, 3].map((v) => run(two, v)),
    ["m1", "m2", "u00", "m1"],
  );
  // 1 strongest + 29 weaker: the strongest plus two weaker.
  const one = [strong(1), ...Array.from({ length: 29 }, (_, i) => weak(i))];
  assert.deepEqual([...distinct(one)].sort(), ["m1", "u00", "u01"]);
  // 3 or more in the strongest tier are used whole and nothing weaker is added.
  const three = [
    strong(1),
    strong(2),
    strong(3),
    ...Array.from({ length: 27 }, (_, i) => weak(i)),
  ];
  assert.deepEqual([...distinct(three)].sort(), ["m1", "m2", "m3"]);
});

test("partial copy says which dimension the evidence supports", () => {
  const notes = (top: Partial<Garment>, patch: Partial<StyleContext>) =>
    buildLook(
      [g("tee", "Tops", top), ...base],
      ctx({ occasion: "work", ...patch }),
    );
  // Season-only evidence: nothing is claimed for the occasion.
  const seasonOnly = notes({ seasons: ["winter"] }, { season: "winter" });
  assert.equal(seasonOnly.suitability, "partial");
  const s1 = seasonOnly.notes.find((n) => /tagged for/.test(n))!;
  assert.match(
    s1,
    /^0 of 3 pieces tagged for work, 1 of 3 pieces tagged for winter; the others have no matching tag/,
  );
  // Occasion-only evidence: nothing is claimed for the season.
  const occasionOnly = notes({ occasions: ["work"] }, { season: "winter" });
  assert.equal(occasionOnly.suitability, "partial");
  const s2 = occasionOnly.notes.find((n) => /tagged for/.test(n))!;
  assert.match(
    s2,
    /^1 of 3 pieces tagged for work, 0 of 3 pieces tagged for winter;/,
  );
  // No season chosen: only the occasion is described.
  const noSeason = notes({ occasions: ["work"], seasons: ["winter"] }, {});
  const s3 = noSeason.notes.find((n) => /tagged for/.test(n))!;
  assert.match(s3, /^1 of 3 pieces tagged for work; the others/);
  assert.doesNotMatch(s3, /winter/);
  // With a layer the count is of the main pieces and the layer is not counted.
  const layered = buildLook(
    [
      g("tee", "Tops", { seasons: ["winter"] }),
      ...base,
      g("coat", "Outerwear", { occasions: ["work"], seasons: ["winter"] }),
    ],
    ctx({ occasion: "work", season: "winter", temperature: 5 }),
  );
  assert.ok(
    layered.notes.some((n) =>
      /^0 of 3 main pieces tagged for work, 1 of 3 main pieces tagged for winter;/.test(
        n,
      ),
    ),
  );
});

test("winter with a hot day (or summer with a cold one) is flagged; plausible choices are not", () => {
  assert.match(
    seasonTemperatureWarning({ season: "winter", temperature: 30 }),
    /Winter is selected but the temperature is 30°C/,
  );
  assert.match(
    seasonTemperatureWarning({ season: "summer", temperature: 5 }),
    /Summer is selected/,
  );
  assert.equal(
    seasonTemperatureWarning({ season: "winter", temperature: 5 }),
    "",
  );
  assert.equal(
    seasonTemperatureWarning({ season: "any", temperature: 40 }),
    "",
  );
  assert.equal(seasonTemperatureWarning({ temperature: 40 }), "");
});

test("saved looks may carry the chosen season; older looks without one still validate", () => {
  const look = {
    id: "l",
    name: "Your work look",
    occasion: "work",
    createdAt: "2026-10-29T10:00:00.000Z",
    items: [starterWardrobe[1]],
  };
  const data = { version: 1, name: "P", wardrobe: [], looks: [] as unknown[] };
  assert.equal(
    backupSchema.safeParse({ ...data, looks: [look] }).success,
    true,
  );
  const withSeason = backupSchema.parse({
    ...data,
    looks: [{ ...look, season: "winter" }],
  });
  assert.equal(withSeason.looks[0].season, "winter");
  assert.equal(
    backupSchema.safeParse({ ...data, looks: [{ ...look, season: "monsoon" }] })
      .success,
    false,
  );
});
