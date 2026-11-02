import { FITS, OCCASIONS, SEASONS, VISIBLE_MATERIALS } from "../../../src/domain/analysis";
import { CATEGORIES } from "../types";

/**
 * Vocabulary of the single-item launch gate (build 024). Gold labels use closed
 * vocabularies so a prediction can be compared exactly; the free text a model
 * writes is mapped to the same vocabulary by the deterministic tables below, and
 * what cannot be mapped is counted as wrong, never guessed.
 */

export const GOLD_CATEGORIES = CATEGORIES;
export type GoldCategory = (typeof GOLD_CATEGORIES)[number];

export const GOLD_COLORS = [
  "black",
  "white",
  "gray",
  "beige",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "multicolor",
] as const;
export type GoldColor = (typeof GOLD_COLORS)[number];

export const GOLD_PATTERNS = ["solid", "striped", "checked", "floral", "dotted", "graphic", "other_pattern"] as const;
export type GoldPattern = (typeof GOLD_PATTERNS)[number];

export { FITS, OCCASIONS, SEASONS, VISIBLE_MATERIALS };
export type Fit = (typeof FITS)[number];
export type Season = (typeof SEASONS)[number];
export type Occasion = (typeof OCCASIONS)[number];

/** Gold material: a visibly identifiable texture, none visible, or "unknown" (not scored, only checked for overclaiming). */
export const GOLD_MATERIALS = [...VISIBLE_MATERIALS, "none_visible", "unknown"] as const;
export type GoldMaterial = (typeof GOLD_MATERIALS)[number];

export const SCENE_TYPES = ["flat_lay", "hanging", "mannequin", "worn", "surface_or_floor", "product_shot", "other"] as const;
export type SceneType = (typeof SCENE_TYPES)[number];

export const STRATA = ["in_scope", "rejection"] as const;
export type SingleStratum = (typeof STRATA)[number];

/** Why a photo is outside the supported easy single-item workflow. */
export const REJECTION_REASONS = [
  "multiple_items",
  "no_garment",
  "unusable_quality",
  "item_mostly_out_of_frame",
  "not_apparel",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** The app's category names mapped to the gold vocabulary. "Unsorted" is an abstention, not a category. */
export const APP_CATEGORY_TO_GOLD: Readonly<Record<string, GoldCategory | null>> = {
  Tops: "top",
  Bottoms: "bottom",
  Dresses: "dress",
  Outerwear: "outerwear",
  Shoes: "shoe",
  Accessories: "accessory",
  Unsorted: null,
};

// ---------------------------------------------------------------- rights

/**
 * The ONLY licences accepted as evaluation evidence: (id, version) pairs. Anything
 * else, including every NonCommercial or NoDerivatives licence, an unknown or
 * missing one, or "all rights reserved", is refused. DeepFashion is non-commercial
 * and is refused by name as well, wherever it appears in the rights evidence.
 */
export const ALLOWED_LICENSES: Readonly<Record<string, readonly string[]>> = {
  CC0: ["1.0"],
  PDM: ["1.0"],
  "CC-BY": ["2.0", "2.5", "3.0", "4.0"],
  "CC-BY-SA": ["2.0", "2.5", "3.0", "4.0"],
};

export const SOURCE_COLLECTIONS = ["wikimedia-commons", "open-images", "self-owned-with-release", "other-verified"] as const;
export type SourceCollection = (typeof SOURCE_COLLECTIONS)[number];

const BLOCKED_LICENSE_WORDS = /(^|[^a-z])(nc|nd|noncommercial|non-commercial|noderivs|no-derivatives|unknown|proprietary|reserved)([^a-z]|$)/i;

/** Reasons a licence id/version is not usable; an empty list means it is on the allow-list. */
export function licenseProblems(id: unknown, version: unknown): string[] {
  if (typeof id !== "string" || id.trim() === "") return ["licence id is missing"];
  if (typeof version !== "string" || version.trim() === "") return ["licence version is missing"];
  const versions = ALLOWED_LICENSES[id];
  if (!versions) {
    return [
      BLOCKED_LICENSE_WORDS.test(id)
        ? `licence "${id}" is non-commercial, no-derivatives, unknown or reserved and cannot be used`
        : `licence "${id}" is not on the allow-list (${Object.keys(ALLOWED_LICENSES).join(", ")})`,
    ];
  }
  return versions.includes(version) ? [] : [`licence "${id}" version "${version}" is not on the allow-list (${versions.join(", ")})`];
}

// ---------------------------------------------------------------- free text -> gold vocabulary

export type TextMapping<T extends string> = { value: T | null; status: "mapped" | "empty" | "unmapped" };

const tokens = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);

const COLOR_WORDS: Readonly<Record<string, GoldColor>> = {
  black: "black",
  charcoal: "black",
  white: "white",
  ivory: "white",
  gray: "gray",
  grey: "gray",
  silver: "gray",
  beige: "beige",
  cream: "beige",
  tan: "beige",
  khaki: "beige",
  camel: "beige",
  sand: "beige",
  taupe: "beige",
  brown: "brown",
  chocolate: "brown",
  red: "red",
  burgundy: "red",
  maroon: "red",
  orange: "orange",
  rust: "orange",
  yellow: "yellow",
  mustard: "yellow",
  gold: "yellow",
  green: "green",
  olive: "green",
  teal: "green",
  blue: "blue",
  navy: "blue",
  denim: "blue",
  purple: "purple",
  violet: "purple",
  lavender: "purple",
  pink: "pink",
  rose: "pink",
  multicolor: "multicolor",
  multicolored: "multicolor",
  multi: "multicolor",
  colorful: "multicolor",
  rainbow: "multicolor",
};
const COLOR_FILLER = new Set(["light", "dark", "pale", "bright", "deep", "off", "washed", "faded", "and", "with", "or"]);

/**
 * Free-text colour to the gold vocabulary. Qualifiers ("light", "dark") are
 * ignored. Exactly one distinct colour must remain; two different colours
 * ("black and white") or an unknown word are "unmapped" (counted wrong, not guessed).
 */
export function mapColor(raw: string): TextMapping<GoldColor> {
  const words = tokens(raw);
  if (words.length === 0) return { value: null, status: "empty" };
  const found = new Set<GoldColor>();
  for (const w of words) {
    if (COLOR_FILLER.has(w)) continue;
    const hit = COLOR_WORDS[w];
    if (!hit) return { value: null, status: "unmapped" };
    found.add(hit);
  }
  if (found.size === 1) return { value: [...found][0], status: "mapped" };
  return { value: null, status: "unmapped" };
}

const PATTERN_WORDS: Readonly<Record<string, GoldPattern>> = {
  solid: "solid",
  plain: "solid",
  none: "solid",
  striped: "striped",
  stripe: "striped",
  stripes: "striped",
  checked: "checked",
  check: "checked",
  checkered: "checked",
  plaid: "checked",
  gingham: "checked",
  tartan: "checked",
  floral: "floral",
  flower: "floral",
  flowers: "floral",
  dotted: "dotted",
  dot: "dotted",
  dots: "dotted",
  polka: "dotted",
  graphic: "graphic",
  print: "graphic",
  printed: "graphic",
  logo: "graphic",
  text: "graphic",
  camouflage: "other_pattern",
  camo: "other_pattern",
  animal: "other_pattern",
  leopard: "other_pattern",
  paisley: "other_pattern",
  geometric: "other_pattern",
  abstract: "other_pattern",
  tie: "other_pattern",
  dye: "other_pattern",
  patterned: "other_pattern",
};
const PATTERN_FILLER = new Set(["and", "with", "dot", "dye"]);

export function mapPattern(raw: string): TextMapping<GoldPattern> {
  const words = tokens(raw);
  if (words.length === 0) return { value: null, status: "empty" };
  const found = new Set<GoldPattern>();
  for (const w of words) {
    const hit = PATTERN_WORDS[w];
    if (!hit) {
      if (PATTERN_FILLER.has(w)) continue;
      return { value: null, status: "unmapped" };
    }
    found.add(hit);
  }
  if (found.size === 1) return { value: [...found][0], status: "mapped" };
  return { value: null, status: "unmapped" };
}
