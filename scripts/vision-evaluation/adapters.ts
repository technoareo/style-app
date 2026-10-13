import { isNonEmptyString, isRecord } from "./check";
import { boxProblems } from "./geometry";
import type { PredictedItem, PredictionCase, RunInfo } from "./predictions";
import { CATEGORIES, type Box } from "./types";

/**
 * Model-agnostic adapter seam. An adapter turns ONE model's saved output for ONE
 * image into a PredictionCase. It must never run the model, and it must report
 * bad output as bad: invalid items are counted and listed, not repaired.
 */
export type CaseContext = { fixtureId: string; imageSha256: string };

export interface RecognitionAdapter<Saved> {
  readonly id: string;
  toCase(saved: Saved, context: CaseContext): PredictionCase;
}

export type ItemResult = { ok: true; item: PredictedItem } | { ok: false; reasons: string[] };

const MAX_REASONS = 20;

/** Parse JSON text exactly as written. Truncated or malformed text is an error, never completed. */
export function parseStrictJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid JSON" };
  }
}

/** Validate every raw item with the given item validator and count them honestly. */
export function classifyItems(
  rawItems: readonly unknown[],
  validate: (raw: unknown) => ItemResult,
): Pick<PredictionCase, "rawCount" | "invalidCount" | "items" | "invalidReasons"> {
  const items: PredictedItem[] = [];
  const invalidReasons: string[] = [];
  let invalidCount = 0;
  rawItems.forEach((raw, index) => {
    const result = validate(raw);
    if (result.ok) items.push(result.item);
    else {
      invalidCount++;
      if (invalidReasons.length < MAX_REASONS) invalidReasons.push(`item ${index}: ${result.reasons.join("; ")}`);
    }
  });
  return { rawCount: rawItems.length, invalidCount, items, invalidReasons };
}

/**
 * Qwen3-VL "native corners" item: {"c": category, "b": [x1,y1,x2,y2]} with
 * integers 0..scale relative to the whole image. The only transformation is the
 * division by the declared scale; out-of-range or reversed corners are invalid.
 */
export function nativeCornersItem(raw: unknown, scale: number): ItemResult {
  if (!isRecord(raw)) return { ok: false, reasons: ["not an object"] };
  const reasons: string[] = [];
  for (const k of Object.keys(raw)) if (k !== "c" && k !== "b") reasons.push(`unknown field "${k}"`);
  const category = raw.c;
  if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category))
    reasons.push("category is not one of the fixed categories");
  const corners = raw.b;
  if (!Array.isArray(corners) || corners.length !== 4) reasons.push("b must hold exactly four corners");
  else if (!corners.every((v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= scale))
    reasons.push(`corners must be integers within 0..${scale}`);
  else {
    const box = corners.map((v: number) => v / scale) as unknown as Box;
    reasons.push(...boxProblems(box));
    if (reasons.length === 0)
      return { ok: true, item: { category: category as PredictedItem["category"], box, attributes: null } };
  }
  return { ok: false, reasons };
}

function failedCase(
  ctx: CaseContext,
  status: PredictionCase["status"],
  error: string,
  elapsedMs: number | null,
  firstContentMs: number | null,
): PredictionCase {
  return {
    fixtureId: ctx.fixtureId,
    imageSha256: ctx.imageSha256,
    status,
    elapsedMs,
    firstContentMs,
    error,
    rawCount: 0,
    invalidCount: 0,
    items: [],
    invalidReasons: [],
  };
}

export const QWEN_COMPACT_CORNERS_ADAPTER_ID = "qwen-compact-corners-013";

/**
 * Adapter for the already-saved evidence docs/verification/qwen-compact-corners-013.json
 * (shape written by qwen-compact-corners-013.mjs). It reads that record only; it
 * does not read the runtime folder and does not call any model. The record's
 * own geometryValid flag is ignored: validity is recomputed here.
 */
export const qwenCompactCornersAdapter: RecognitionAdapter<unknown> = {
  id: QWEN_COMPACT_CORNERS_ADAPTER_ID,
  toCase(saved, ctx) {
    if (!isRecord(saved)) return failedCase(ctx, "failed", "saved record is not a JSON object", null, null);
    const elapsed = typeof saved.elapsedMs === "number" && saved.elapsedMs >= 0 ? saved.elapsedMs : null;
    const first = typeof saved.firstContentMs === "number" && saved.firstContentMs >= 0 ? saved.firstContentMs : null;
    if (saved.failure === "timeout") return failedCase(ctx, "timeout", "model call timed out", elapsed, first);
    if (typeof saved.failure === "string") return failedCase(ctx, "failed", `model call failed: ${saved.failure}`, elapsed, first);
    if (saved.completed !== true) return failedCase(ctx, "failed", "record says the run did not complete", elapsed, first);
    if (saved.doneReason === "length")
      return failedCase(ctx, "truncated", "output stopped at the token limit; truncated JSON is not repaired", elapsed, first);
    if (saved.doneReason !== "stop")
      return failedCase(ctx, "failed", `unexpected doneReason ${JSON.stringify(saved.doneReason ?? null)}`, elapsed, first);
    if (!Array.isArray(saved.items)) return failedCase(ctx, "failed", "record has no items array", elapsed, first);
    return {
      fixtureId: ctx.fixtureId,
      imageSha256: ctx.imageSha256,
      status: "completed",
      elapsedMs: elapsed,
      firstContentMs: first,
      error: null,
      ...classifyItems(saved.items as unknown[], (raw) => nativeCornersItem(raw, 1000)),
    };
  },
};

export function qwenCompactCornersRun(saved: unknown): RunInfo {
  const rec = isRecord(saved) ? saved : {};
  return {
    model: isNonEmptyString(rec.model) ? rec.model : "unrecorded",
    modelVersion: "unrecorded",
    prompt: { id: "qwen-compact-corners-013", sha256: null },
    strategy:
      "single pass over the whole image; category and native 0..1000 corner boxes only; at most 20 items; no attributes",
    adapter: QWEN_COMPACT_CORNERS_ADAPTER_ID,
    startedAt: null,
    timeoutMs: typeof rec.timeoutMs === "number" && rec.timeoutMs >= 0 ? rec.timeoutMs : null,
    imageHashSource: "asserted-by-operator",
    notes:
      "Adapted from saved public evidence (docs/verification/qwen-compact-corners-013.json). Start time and image hash were not recorded by the original run; the operator asserts the image.",
  };
}
