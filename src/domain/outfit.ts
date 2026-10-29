import type { Garment } from "./types";
export type Season = NonNullable<Garment["seasons"]>[number];
export type StyleContext = {
  occasion: "everyday" | "work" | "evening" | "formal";
  temperature: number;
  variation: number;
  /** Chosen by the user, never inferred. Absent or "any" = no season preference. */
  season?: Season | "any";
};
/**
 * How well the main pieces (everything except a cold-weather layer) are
 * CONFIRMED for the chosen plan, using only tags the user saved:
 * "confirmed" = every main piece tagged for it, "partial" = some tagged or
 * tagged for a closely related occasion and none contradicting, "unconfirmed"
 * = no tags either way (older items), "mismatch" = at least one main piece
 * explicitly tagged for something else.
 */
export type Suitability = "confirmed" | "partial" | "unconfirmed" | "mismatch";
export type LookResult = {
  items: Garment[];
  complete: boolean;
  message: string;
  notes: string[];
  suitability?: Suitability;
};
/** The item tag that answers each plan. "formal" is the dress-code plan; its tag is "event". */
const OCCASION_TAG = {
  everyday: "everyday",
  work: "work",
  evening: "evening",
  formal: "event",
} as const;
const OCCASION_LABEL = {
  everyday: "everyday",
  work: "work",
  evening: "evening",
  formal: "formal event",
} as const;
/**
 * Occasion tags that are compatible with, but weaker than, the plan's own tag.
 * They are never a mismatch and never counted as a confirmed fit. The formal
 * plan only ever sees pieces whose dress code the user set to Formal, and
 * formality stays authoritative: a formal gown tagged "evening" or a formal
 * suit tagged "work" is a plausible event outfit.
 */
const NEAR_TAGS: Record<StyleContext["occasion"], readonly string[]> = {
  everyday: [],
  work: [],
  evening: ["event"],
  formal: ["evening", "work"],
};
/** How many outfits "Another combination" can walk through. */
const VARIATION_POOL = 30;
/** Never let a single, very strong outfit make "Another combination" a no-op. */
const MIN_VARIETY = 3;
/** Per-category candidates kept after sorting by relevance. */
const SLOT_CAP = 60;
const LAYER_BELOW = 20;
const HOT_AT = 27;
const WINTER_WARM_AT = 25;
const SUMMER_COLD_AT = 10;

type Tier = "hit" | "near" | "unknown" | "miss";
type Fit = { hit: number; miss: number; near: number };
const tagFit = (
  tags: readonly string[] | undefined,
  want: string,
  near: readonly string[] = [],
): Tier =>
  !tags?.length
    ? "unknown"
    : tags.includes(want)
      ? "hit"
      : near.some((n) => tags.includes(n))
        ? "near"
        : "miss";
const seasonOf = (context: StyleContext) =>
  context.season && context.season !== "any" ? context.season : null;
const occasionTier = (g: Garment, context: StyleContext) =>
  tagFit(
    g.occasions,
    OCCASION_TAG[context.occasion],
    context.occasion === "formal" && g.formality !== "formal"
      ? []
      : NEAR_TAGS[context.occasion],
  );
const seasonTier = (g: Garment, context: StyleContext): Tier | null => {
  const season = seasonOf(context);
  return season ? tagFit(g.seasons, season) : null;
};
const fitOf = (g: Garment, context: StyleContext): Fit => {
  const fit: Fit = { hit: 0, miss: 0, near: 0 };
  for (const tier of [occasionTier(g, context), seasonTier(g, context)])
    if (tier && tier !== "unknown") fit[tier] += 1;
  return fit;
};
/** Fewest explicit mismatches first, then most confirmed matches, then related-occasion matches. */
const byFit = (a: Fit, b: Fit) =>
  a.miss - b.miss || b.hit - a.hit || b.near - a.near;
/** Names the dimension that actually conflicts, e.g. "Beach tee (seasons: summer, not winter)". */
const mismatchReason = (g: Garment, context: StyleContext) => {
  const parts: string[] = [];
  if (occasionTier(g, context) === "miss")
    parts.push(
      `occasions: ${g.occasions!.join("/")}, not ${OCCASION_TAG[context.occasion]}`,
    );
  if (seasonTier(g, context) === "miss")
    parts.push(`seasons: ${g.seasons!.join("/")}, not ${seasonOf(context)}`);
  return `${g.name || g.category} (${parts.join("; ")})`;
};
const joinReasons = (items: Garment[], context: StyleContext) =>
  items
    .slice(0, 3)
    .map((g) => mismatchReason(g, context))
    .join(", ") + (items.length > 3 ? " and more" : "");
const sumFit = (items: Garment[], context: StyleContext) =>
  items.reduce<Fit>(
    (total, g) => {
      const f = fitOf(g, context);
      return {
        hit: total.hit + f.hit,
        miss: total.miss + f.miss,
        near: total.near + f.near,
      };
    },
    { hit: 0, miss: 0, near: 0 },
  );

export const categorySlot = (category: string) => {
  const c = category.toLowerCase().trim();
  if (/^(tops?|shirts?|t-shirts?|blouses?|knitwear)$/.test(c)) return "top";
  if (/^(bottoms?|pants|trousers|jeans|skirts?|shorts)$/.test(c))
    return "bottom";
  if (/^(dresses|dress|jumpsuits?|one-piece)$/.test(c)) return "onepiece";
  if (/^(shoes|footwear|sneakers|boots|loafers|sandals|heels)$/.test(c))
    return "shoes";
  if (/^(outerwear|jackets?|coats?|blazers?|cardigans?)$/.test(c))
    return "layer";
  if (/^(accessories|accessory|bags?|jewelry|belts?|scarves)$/.test(c))
    return "accessory";
  return "unknown";
};
const neutral = (c: string) =>
  /black|white|cream|ivory|beige|sand|navy|indigo|denim|grey|gray|brown|tan/.test(
    c.toLowerCase(),
  );
const colorScore = (items: Garment[]) => {
  const colored = items.filter((g) => g.color && !neutral(g.color));
  const patterned = items.filter(
    (g) => g.pattern && !/solid|plain|unknown/i.test(g.pattern),
  );
  return (
    (colored.length <= 1
      ? 8
      : colored.every(
            (g) => g.color.toLowerCase() === colored[0].color.toLowerCase(),
          )
        ? 5
        : -3) -
    Math.max(0, patterned.length - 1) * 4
  );
};
const formalityPoints = (g: Garment, context: StyleContext) =>
  context.occasion === "work" || context.occasion === "evening"
    ? g.formality === "smart" || g.formality === "formal"
      ? 5
      : -2
    : g.formality === "casual"
      ? 3
      : 0;
/** Straightforward reference score of a set of pieces; the fast search below must agree with it. */
export function scoreItems(items: Garment[], context: StyleContext) {
  return {
    ...sumFit(items, context),
    score:
      colorScore(items) +
      items.reduce((sum, g) => sum + formalityPoints(g, context), 0),
  };
}

/** Per-item numbers computed once, so ranking 60x60x60 outfits allocates nothing per outfit. */
type Info = Fit & {
  g: Garment;
  form: number;
  colored: boolean;
  color: string;
  patterned: boolean;
};
const infoOf = (g: Garment, context: StyleContext): Info => ({
  ...fitOf(g, context),
  g,
  form: formalityPoints(g, context),
  colored: !!g.color && !neutral(g.color),
  color: g.color.toLowerCase(),
  patterned: !!g.pattern && !/solid|plain|unknown/i.test(g.pattern),
});
type Base = Fit & {
  items: Garment[];
  key: string;
  form: number;
  colored: number;
  firstColor: string;
  mixed: boolean;
  patterned: number;
};
const baseOf = (parts: Info[]): Base => {
  const base: Base = {
    items: parts.map((p) => p.g),
    key: parts.map((p) => p.g.id).join(),
    hit: 0,
    miss: 0,
    near: 0,
    form: 0,
    colored: 0,
    firstColor: "",
    mixed: false,
    patterned: 0,
  };
  for (const p of parts) {
    base.hit += p.hit;
    base.miss += p.miss;
    base.near += p.near;
    base.form += p.form;
    if (p.patterned) base.patterned += 1;
    if (p.colored) {
      if (!base.colored) base.firstColor = p.color;
      else if (p.color !== base.firstColor) base.mixed = true;
      base.colored += 1;
    }
  }
  return base;
};
/** Optional counters for tests: how many pairs were scanned and the most entries ever held at once. */
export type SearchStats = { examined: number; maxRetained: number };
type Entry = Fit & { base: Base; shoe: Info; score: number; key: string };
const keyOf = (base: Base, shoe: Info) => `${base.key},${shoe.g.id}`;

/**
 * The best `limit` outfits in the order: fewest mismatches, most matches, most
 * related matches, highest formality/colour score, item ids. A bounded
 * selection: it looks at every base x shoe pair but only ever keeps `limit`.
 */
function bestOutfits(
  bases: Base[],
  shoes: Info[],
  limit: number,
  stats?: SearchStats,
): Entry[] {
  const top: Entry[] = [];
  // Negative: the candidate ranks ahead of `o`. The key is only built on a full tie.
  const compare = (
    o: Entry,
    miss: number,
    hit: number,
    near: number,
    score: number,
    base: Base,
    shoe: Info,
  ) =>
    miss - o.miss ||
    o.hit - hit ||
    o.near - near ||
    o.score - score ||
    keyOf(base, shoe).localeCompare(o.key);
  for (const base of bases) {
    for (const shoe of shoes) {
      if (stats) stats.examined += 1;
      const miss = base.miss + shoe.miss;
      const hit = base.hit + shoe.hit;
      const near = base.near + shoe.near;
      const coloredCount = base.colored + (shoe.colored ? 1 : 0);
      const mixed =
        base.mixed ||
        (base.colored > 0 && shoe.colored && shoe.color !== base.firstColor);
      const patterned = base.patterned + (shoe.patterned ? 1 : 0);
      const score =
        (coloredCount <= 1 ? 8 : mixed ? -3 : 5) -
        Math.max(0, patterned - 1) * 4 +
        base.form +
        shoe.form;
      if (
        top.length === limit &&
        compare(top[limit - 1], miss, hit, near, score, base, shoe) >= 0
      )
        continue;
      let at = top.length;
      while (
        at > 0 &&
        compare(top[at - 1], miss, hit, near, score, base, shoe) < 0
      )
        at -= 1;
      top.splice(at, 0, {
        base,
        shoe,
        hit,
        miss,
        near,
        score,
        key: keyOf(base, shoe),
      });
      if (stats) stats.maxRetained = Math.max(stats.maxRetained, top.length);
      if (top.length > limit) top.pop();
    }
  }
  return top;
}

/** Winter chosen with a hot day (or summer with a cold one): likely a slip, so say so. */
export const seasonTemperatureWarning = (
  context: Pick<StyleContext, "season" | "temperature">,
) => {
  if (context.season === "winter" && context.temperature >= WINTER_WARM_AT)
    return `Winter is selected but the temperature is ${context.temperature}°C. Check the season and temperature you entered.`;
  if (context.season === "summer" && context.temperature <= SUMMER_COLD_AT)
    return `Summer is selected but the temperature is ${context.temperature}°C. Check the season and temperature you entered.`;
  return "";
};

function candidateGroups(wardrobe: Garment[], context: StyleContext) {
  const usable = wardrobe.filter(
    (g) =>
      g.available !== false &&
      g.reviewed !== false &&
      categorySlot(g.category) !== "unknown",
  );
  const formal = context.occasion === "formal";
  const candidates = usable.filter(
    (g) =>
      !(formal && g.formality !== "formal") &&
      !(context.temperature >= HOT_AT && g.warmth === "warm"),
  );
  // Most relevant first (fit, then formality, then id), so the per-category
  // cap keeps the relevant pieces and never depends on the order they were added.
  const groups = (slot: string) =>
    candidates
      .filter((g) => categorySlot(g.category) === slot)
      .map((g) => infoOf(g, context))
      .sort(
        (a, b) =>
          byFit(a, b) || b.form - a.form || a.g.id.localeCompare(b.g.id),
      )
      .slice(0, SLOT_CAP);
  return groups;
}
type Groups = ReturnType<typeof candidateGroups>;
function baseList(groups: Groups) {
  const bases: Base[] = groups("onepiece").map((p) => baseOf([p]));
  const bottoms = groups("bottom");
  for (const top of groups("top"))
    for (const bottom of bottoms) bases.push(baseOf([top, bottom]));
  return bases;
}
/**
 * The ranked outfits (best first, at most `limit`) as lists of item ids,
 * without building a look. Exposed so tests can check the full ordering.
 */
export function rankOutfits(
  wardrobe: Garment[],
  context: StyleContext,
  limit = VARIATION_POOL,
  stats?: SearchStats,
): string[][] {
  const groups = candidateGroups(wardrobe, context);
  const bases = baseList(groups);
  const shoes = groups("shoes");
  if (!bases.length || !shoes.length) return [];
  return bestOutfits(bases, shoes, limit, stats).map((o) => [
    ...o.base.items.map((g) => g.id),
    o.shoe.g.id,
  ]);
}

export function buildLook(
  wardrobe: Garment[],
  context: StyleContext,
): LookResult {
  const formal = context.occasion === "formal";
  const groups = candidateGroups(wardrobe, context);
  const bases = baseList(groups);
  const shoes = groups("shoes");
  if (!bases.length || !shoes.length) {
    const missing = !bases.length
      ? "a reviewed top and bottom, or a dress"
      : "reviewed shoes";
    return {
      items: [],
      complete: false,
      message: formal
        ? `No complete formal outfit yet. Add formal ${missing}, or choose another occasion.`
        : `Add ${missing} to build a complete look.`,
      notes: [],
    };
  }
  const options = bestOutfits(bases, shoes, VARIATION_POOL);
  // Variation walks the strongest relevance tier first. Only when that tier has
  // fewer than MIN_VARIETY outfits does it continue into the next-strongest, so
  // it never skips a stronger tier and never reaches a mismatched outfit while
  // a mismatch-free one exists.
  const free = options.filter((o) => o.miss === options[0].miss);
  const pool: Entry[] = [];
  for (let i = 0; i < free.length && pool.length < MIN_VARIETY;) {
    const tier = free.filter(
      (o) => o.hit === free[i].hit && o.near === free[i].near,
    );
    // The first tier is used whole; later tiers only top the pool up to MIN_VARIETY.
    pool.push(
      ...(pool.length ? tier.slice(0, MIN_VARIETY - pool.length) : tier),
    );
    i += tier.length;
  }
  const picked = pool[Math.abs(context.variation) % pool.length];
  const core = [...picked.base.items, picked.shoe.g];
  const choice = [...core];
  const season = seasonOf(context);
  const plan = season
    ? `${OCCASION_LABEL[context.occasion]} in ${season}`
    : OCCASION_LABEL[context.occasion];
  const notes = [
    "Only items in your wardrobe are included.",
    "Colors and patterns are balanced with a simple outfit rule.",
  ];
  let layer: Garment | undefined;
  if (context.temperature < LAYER_BELOW) {
    layer = groups("layer")
      .map((p) => ({ p, score: scoreItems([...core, p.g], context).score }))
      .sort((a, b) => byFit(a.p, b.p) || b.score - a.score)[0]?.p.g;
    if (layer) choice.push(layer);
    else
      notes.push("No suitable layer available. Add one for this temperature.");
  }
  if (
    (context.occasion === "work" || context.occasion === "evening") &&
    choice.some(
      (g) =>
        g.formality === "casual" || !g.formality || g.formality === "unknown",
    )
  )
    notes.push("Best available combination; check your event’s dress code.");
  if (choice.some((g) => !g.warmth || g.warmth === "unknown"))
    notes.push("Warmth is unconfirmed. Check comfort before heading out.");
  // Suitability describes the main outfit only: a layer is chosen for the
  // temperature and must not downgrade (or upgrade) the core, but is reported.
  const total = sumFit(core, context);
  const dims = season ? 2 : 1;
  const suitability: Suitability = total.miss
    ? "mismatch"
    : total.hit === core.length * dims
      ? "confirmed"
      : total.hit || total.near
        ? "partial"
        : "unconfirmed";
  const main = layer ? "main pieces" : "pieces";
  if (suitability === "mismatch")
    notes.push(
      `Closest match, not a confirmed fit for ${plan}: ${joinReasons(
        core.filter((g) => fitOf(g, context).miss > 0),
        context,
      )}. Tag more pieces for ${plan} to improve this.`,
    );
  else if (suitability === "confirmed")
    notes.push(
      `${layer ? "Every one of the main pieces" : "Every piece"} is tagged for ${plan}.`,
    );
  else if (suitability === "partial" && total.hit) {
    // Say which dimension each piece actually supports.
    const count = (tier: (g: Garment) => Tier | null) =>
      core.filter((g) => tier(g) === "hit").length;
    const parts = [
      `${count((g) => occasionTier(g, context))} of ${core.length} ${main} tagged for ${OCCASION_LABEL[context.occasion]}`,
    ];
    if (season)
      parts.push(
        `${count((g) => seasonTier(g, context))} of ${core.length} ${main} tagged for ${season}`,
      );
    notes.push(
      `${parts.join(", ")}; the others have no matching tag yet, so their fit is unconfirmed.`,
    );
  } else if (suitability === "partial")
    notes.push(
      `No piece is tagged for ${plan} itself; ${NEAR_TAGS[context.occasion].join(" or ")}-tagged pieces suit it and are used.`,
    );
  else
    notes.push(
      `No piece is tagged for ${plan} yet, so this is chosen by formality and colour only. Add seasons and occasions to your items to improve it.`,
    );
  if (layer && fitOf(layer, context).miss > 0)
    notes.push(
      `The layer is added for warmth at ${context.temperature}°C and is not confirmed for ${plan}: ${mismatchReason(layer, context)}.`,
    );
  return {
    items: choice,
    complete: true,
    message:
      suitability === "mismatch"
        ? `Closest ${OCCASION_LABEL[context.occasion]} combination`
        : context.occasion === "everyday"
          ? "Your daily edit"
          : `Your ${context.occasion} look`,
    notes,
    suitability,
  };
}
export const suggestLook = (wardrobe: Garment[]) =>
  buildLook(wardrobe, { occasion: "everyday", temperature: 25, variation: 0 })
    .items;
