import type { Box } from "./types";

/**
 * Strict box validation. A box is REJECTED, never repaired: no clipping to the
 * frame, no swapping of reversed corners, no widening of a zero-size box.
 */
export function boxProblems(v: unknown): string[] {
  if (!Array.isArray(v) || v.length !== 4)
    return ["box must be an array of exactly four numbers [x1, y1, x2, y2]"];
  const bad = v.findIndex((n) => typeof n !== "number" || !Number.isFinite(n));
  if (bad >= 0) return [`box coordinate ${bad} is not a finite number`];
  const [x1, y1, x2, y2] = v as number[];
  const out: string[] = [];
  if (v.some((n: number) => n < 0 || n > 1))
    out.push("box coordinates must already be normalized to 0..1 (nothing is clipped)");
  if (!(x2 > x1)) out.push("x2 must be greater than x1 (corner order is x1, y1, x2, y2)");
  if (!(y2 > y1)) out.push("y2 must be greater than y1 (corner order is x1, y1, x2, y2)");
  return out;
}

/** Intersection over union of two valid boxes; 0 when they do not overlap. */
export function iou(a: Box, b: Box): number {
  const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}
