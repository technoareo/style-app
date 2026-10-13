import type { Garment } from "./types";
export type StyleContext = {
  occasion: "everyday" | "work" | "evening" | "formal";
  temperature: number;
  variation: number;
};
export type LookResult = {
  items: Garment[];
  complete: boolean;
  message: string;
  notes: string[];
};
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
export function buildLook(
  wardrobe: Garment[],
  context: StyleContext,
): LookResult {
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
      !(context.temperature >= 27 && g.warmth === "warm"),
  );
  const groups = (slot: string) =>
    candidates.filter((g) => categorySlot(g.category) === slot).slice(0, 60);
  const bases: Garment[][] = groups("onepiece").map((g) => [g]);
  for (const top of groups("top"))
    for (const bottom of groups("bottom")) bases.push([top, bottom]);
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
  const rank = (items: Garment[]) =>
    colorScore(items) +
    items.reduce(
      (sum, g) =>
        sum +
        (context.occasion === "work" || context.occasion === "evening"
          ? g.formality === "smart" || g.formality === "formal"
            ? 5
            : -2
          : g.formality === "casual"
            ? 3
            : 0),
      0,
    );
  const options = bases
    .flatMap((base) => shoes.map((shoe) => [...base, shoe]))
    .sort(
      (a, b) =>
        rank(b) - rank(a) ||
        a
          .map((g) => g.id)
          .join()
          .localeCompare(b.map((g) => g.id).join()),
    );
  const choice = [
    ...options[Math.abs(context.variation) % Math.min(options.length, 30)],
  ];
  const notes = [
    "Only items in your wardrobe are included.",
    "Colors and patterns are balanced with a simple outfit rule.",
  ];
  if (context.temperature < 20) {
    const layer = groups("layer").sort(
      (a, b) => rank([...choice, b]) - rank([...choice, a]),
    )[0];
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
  return {
    items: choice,
    complete: true,
    message:
      context.occasion === "everyday"
        ? "Your daily edit"
        : `Your ${context.occasion} look`,
    notes,
  };
}
export const suggestLook = (wardrobe: Garment[]) =>
  buildLook(wardrobe, { occasion: "everyday", temperature: 25, variation: 0 })
    .items;
