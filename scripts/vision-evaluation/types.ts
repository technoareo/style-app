/**
 * Shared vocabulary of the offline recognition evaluation harness (build 014).
 *
 * Nothing in this folder runs a model, opens a socket or touches the app. It
 * only validates JSON files that someone else produced and scores them.
 */

/** The fixed garment categories. Anything else a model says is invalid output. */
export const CATEGORIES = ["top", "bottom", "dress", "outerwear", "shoe", "accessory"] as const;
export type Category = (typeof CATEGORIES)[number];

/** The split is fixed in the manifest BEFORE any inference on that fixture. */
export const SPLITS = ["development", "heldout"] as const;
export type Split = (typeof SPLITS)[number];

/** Photo kind, decided with the fixture, not derived from a model's answer. */
export const STRATA = ["single_item", "crowded", "no_garment"] as const;
export type Stratum = (typeof STRATA)[number];

/**
 * Normalized corner box [x1, y1, x2, y2], each in 0..1, x1 < x2 and y1 < y2,
 * relative to the DISPLAY orientation of the image (EXIF rotation applied).
 */
export type Box = readonly [number, number, number, number];

/** Stored pixel size plus the EXIF orientation tag (1 when absent). */
export type Dimensions = { width: number; height: number; exifOrientation: number };

export const MAX_ITEMS_PER_CASE = 500;
