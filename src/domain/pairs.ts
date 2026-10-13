/**
 * Shoe-pair handling for the upload review. The model sometimes returns the
 * two shoes of one pair as separate detections. This module only *suggests*
 * pairs; nothing is merged unless the user confirms, because colour or
 * adjacency alone cannot tell a pair from two different pairs placed together.
 */

export type PairCandidate = {
  id: string;
  category: string;
  /** [x, y, width, height], each 0..1 of the source photo. */
  box: number[];
};

export type Box = [number, number, number, number];

const SHOE_CATEGORY =
  /^(shoes?|footwear|sneakers?|boots?|loafers?|sandals?|heels?)$/i;
export const isShoeCategory = (category: string) =>
  SHOE_CATEGORY.test(category.trim());

const area = (b: number[]) => b[2] * b[3];

/** Smallest box containing both, clamped to the photo. */
export function unionBox(a: number[], b: number[]): Box {
  const x1 = Math.max(0, Math.min(a[0], b[0]));
  const y1 = Math.max(0, Math.min(a[1], b[1]));
  const x2 = Math.min(1, Math.max(a[0] + a[2], b[0] + b[2]));
  const y2 = Math.min(1, Math.max(a[1] + a[3], b[1] + b[3]));
  return [x1, y1, x2 - x1, y2 - y1];
}

/** Distance between two boxes; 0 when they overlap or touch. */
export function boxGap(a: number[], b: number[]): number {
  const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]));
  const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));
  return Math.hypot(dx, dy);
}

/** A full-frame box is the fallback for unusable model bounds: not evidence. */
const isFallbackBox = (b: number[]) => area(b) >= 0.95;

export const PAIR_MAX_GAP = 0.12;
export const PAIR_SIZE_RATIO = 4;

/**
 * Pairs of shoe detections that are close together, of comparable size and
 * have usable bounds. Each detection appears in at most one suggestion
 * (closest first). Other categories - for example two separate bags - are
 * never suggested.
 */
export function suggestShoePairs(
  items: PairCandidate[],
): [string, string][] {
  const shoes = items.filter(
    (g) =>
      isShoeCategory(g.category) &&
      g.box.length === 4 &&
      !isFallbackBox(g.box) &&
      area(g.box) > 0,
  );
  const candidates: { a: string; b: string; gap: number }[] = [];
  for (let i = 0; i < shoes.length; i++)
    for (let j = i + 1; j < shoes.length; j++) {
      const ratio = area(shoes[i].box) / area(shoes[j].box);
      const gap = boxGap(shoes[i].box, shoes[j].box);
      if (
        gap <= PAIR_MAX_GAP &&
        ratio <= PAIR_SIZE_RATIO &&
        ratio >= 1 / PAIR_SIZE_RATIO
      )
        candidates.push({ a: shoes[i].id, b: shoes[j].id, gap });
    }
  candidates.sort((x, y) => x.gap - y.gap);
  const used = new Set<string>();
  const pairs: [string, string][] = [];
  for (const c of candidates) {
    if (used.has(c.a) || used.has(c.b)) continue;
    used.add(c.a);
    used.add(c.b);
    pairs.push([c.a, c.b]);
  }
  return pairs;
}

type Mergeable = {
  id: string;
  name: string;
  color: string;
  box: number[];
  evidence?: string;
  confidence?: number;
};

const plural = (name: string) => (/s$/i.test(name) ? name : `${name}s`);

/**
 * One record for a confirmed pair: the union crop, a pair name, both
 * pieces of evidence. The caller regenerates the crop image and resets review.
 */
export function mergeShoePair<T extends Mergeable>(a: T, b: T): T {
  const same = a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
  const name = same
    ? /pair/i.test(a.name)
      ? a.name
      : `Pair of ${plural(a.name.trim() || "shoe")}`
    : a.name;
  const color =
    a.color.trim().toLowerCase() === b.color.trim().toLowerCase()
      ? a.color
      : [a.color, b.color].filter(Boolean).join(" / ").slice(0, 60);
  const evidence = [a.evidence, b.evidence].filter(Boolean).join("; ");
  return {
    ...a,
    name: name.slice(0, 100),
    color,
    box: unionBox(a.box, b.box),
    evidence: evidence.slice(0, 250),
    confidence:
      a.confidence !== undefined && b.confidence !== undefined
        ? Math.min(a.confidence, b.confidence)
        : a.confidence,
    reviewed: false,
  };
}
