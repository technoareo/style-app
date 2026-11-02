import { CROP_UNVERIFIED_WARNING, MULTIPLE_ITEMS_WARNING, reviewAnalysisSchema } from "../../../src/domain/analysis";
import { ID_RE, SHA256_RE, expectKeys, isIsoTimestamp, isNonEmptyString, isNonNegativeFinite, isRecord, oneOf } from "../check";
import type { Box } from "../types";
import type { SinglePrediction, SinglePredictionCase, SingleRunInfo } from "./predictions";
import { APP_CATEGORY_TO_GOLD, mapColor, mapPattern } from "./vocab";

/**
 * Adapter for the qwen single-item path: it turns ONE saved `analyzePhoto()`
 * result (the app's validated, server-processed output, not the raw model text)
 * into a SinglePredictionCase. It never runs a model and never repairs output.
 *
 * What it relies on, because the app does it before returning (src/server/vision.ts):
 *  - at most one item is returned in single mode, with brand and size blanked;
 *  - the item's confidence is capped at 0.5 whenever the model lists doubts
 *    (`uncertain`), so a record that violates this did not come from analyzePhoto
 *    and is refused as invalid;
 *  - an unusable model box becomes the full frame [0,0,1,1] together with
 *    CROP_UNVERIFIED_WARNING; that box is NOT scored as a real box;
 *  - the notices MULTIPLE_ITEMS_WARNING / CROP_UNVERIFIED_WARNING are appended to the warning.
 * The model's confidence is recorded as `selfConfidence` and is never used as
 * correctness: only `uncertain` (an explicit abstention) and unknown/empty values are.
 */

export const QWEN_SINGLE_ADAPTER_ID = "qwen-single-item-analyze-photo-024";

export type AnalyzePhotoOutcome = "ok" | "timeout" | "unavailable" | "unverified";

/** The record an operator's wrapper saves around one analyzePhoto() call. */
export type AnalyzePhotoRecord = {
  schemaVersion: 1;
  kind: "analyze-photo-record";
  fixtureId: string;
  imageSha256: string;
  model: string;
  modelVersion: string;
  promptId: string;
  startedAt: string;
  elapsedMs: number;
  timeoutMs: number | null;
  outcome: AnalyzePhotoOutcome;
  error: string | null;
  analysis: unknown;
};

const RECORD_KEYS = [
  "schemaVersion",
  "kind",
  "fixtureId",
  "imageSha256",
  "model",
  "modelVersion",
  "promptId",
  "startedAt",
  "elapsedMs",
  "timeoutMs",
  "outcome",
  "error",
  "analysis",
] as const;
const OUTCOMES = ["ok", "timeout", "unavailable", "unverified"] as const;

export function validateAnalyzePhotoRecord(doc: unknown): { record: AnalyzePhotoRecord | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { record: null, problems: ["record: must be a JSON object"] };
  expectKeys(doc, RECORD_KEYS, "record", problems);
  if (doc.schemaVersion !== 1) problems.push("record: schemaVersion must be 1");
  if (doc.kind !== "analyze-photo-record") problems.push('record: kind must be "analyze-photo-record"');
  if (typeof doc.fixtureId !== "string" || !ID_RE.test(doc.fixtureId)) problems.push("record.fixtureId: invalid");
  if (typeof doc.imageSha256 !== "string" || !SHA256_RE.test(doc.imageSha256)) problems.push("record.imageSha256: the run must record the hash of the image it analysed");
  for (const key of ["model", "modelVersion", "promptId"] as const) if (!isNonEmptyString(doc[key])) problems.push(`record.${key}: must be a non-empty string`);
  if (!isIsoTimestamp(doc.startedAt)) problems.push("record.startedAt: must be an ISO timestamp with a time zone");
  if (!isNonNegativeFinite(doc.elapsedMs)) problems.push("record.elapsedMs: must be a non-negative number");
  if (doc.timeoutMs !== null && !isNonNegativeFinite(doc.timeoutMs)) problems.push("record.timeoutMs: must be null or a non-negative number");
  if (!oneOf(OUTCOMES, doc.outcome)) problems.push("record.outcome: must be ok, timeout, unavailable or unverified");
  if (doc.error !== null && typeof doc.error !== "string") problems.push("record.error: must be null or text");
  if (doc.outcome === "ok" && doc.analysis === null) problems.push("record.analysis: an ok record needs the analysis");
  if (doc.outcome !== "ok" && doc.analysis !== null) problems.push("record.analysis: must be null unless the outcome is ok");
  return problems.length > 0 ? { record: null, problems } : { record: doc as unknown as AnalyzePhotoRecord, problems: [] };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function failure(
  rec: AnalyzePhotoRecord,
  status: SinglePredictionCase["status"],
  error: string,
  reasons: string[] = [],
): SinglePredictionCase {
  return {
    fixtureId: rec.fixtureId,
    imageSha256: rec.imageSha256.toLowerCase(),
    status,
    elapsedMs: rec.elapsedMs,
    error,
    itemCount: 0,
    item: null,
    multipleItemsWarning: false,
    cropUnverifiedWarning: false,
    invalidReasons: reasons,
  };
}

/** Converts one saved record. A record that cannot be an analyzePhoto output is "invalid", never repaired. */
export function toSingleCase(rec: AnalyzePhotoRecord): SinglePredictionCase {
  if (rec.outcome === "timeout") return failure(rec, "timeout", rec.error ?? "analysis timed out");
  if (rec.outcome === "unavailable") return failure(rec, "failed", rec.error ?? "model unavailable");
  if (rec.outcome === "unverified") return failure(rec, "unverified", rec.error ?? "analysis could not be verified");

  const parsed = reviewAnalysisSchema.safeParse(rec.analysis);
  if (!parsed.success)
    return failure(rec, "invalid", "analysis does not match the app's result schema", parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`));
  const { items, warning } = parsed.data;
  if (items.length > 1) return failure(rec, "invalid", "single-item mode returns at most one item; this is not an analyzePhoto output", [`${items.length} items`]);

  const multipleItemsWarning = warning.includes(MULTIPLE_ITEMS_WARNING);
  const cropUnverifiedWarning = warning.includes(CROP_UNVERIFIED_WARNING);
  const base = {
    fixtureId: rec.fixtureId,
    imageSha256: rec.imageSha256.toLowerCase(),
    status: "completed" as const,
    elapsedMs: rec.elapsedMs,
    error: null,
    multipleItemsWarning,
    cropUnverifiedWarning,
    invalidReasons: [] as string[],
  };
  if (items.length === 0) return { ...base, itemCount: 0, item: null };

  const raw = items[0];
  const reasons: string[] = [];
  if (raw.brand !== "" || raw.size !== "") reasons.push("brand or size is not blank; the app blanks them before returning");
  const uncertain = raw.uncertain ?? [];
  if (uncertain.length > 0 && raw.confidence > 0.5)
    reasons.push(`confidence ${raw.confidence} is above the 0.5 cap although doubts are listed (${uncertain.join(", ")}); not an analyzePhoto output`);
  const [x, y, w, h] = raw.box;
  const corners = [round6(x), round6(y), round6(x + w), round6(y + h)];
  const fullFrameFallback = corners[0] === 0 && corners[1] === 0 && corners[2] === 1 && corners[3] === 1 && cropUnverifiedWarning;
  if (!fullFrameFallback && (corners[2] > 1 || corners[3] > 1)) reasons.push("box extends outside the frame; the app clamps boxes before returning");
  if (reasons.length > 0) return failure(rec, "invalid", "record is not a valid analyzePhoto output", reasons);

  const color = mapColor(raw.color);
  const pattern = mapPattern(raw.pattern);
  const item: SinglePrediction = {
    category: APP_CATEGORY_TO_GOLD[raw.category] ?? null,
    categoryRaw: raw.category,
    color: color.value,
    colorRaw: raw.color,
    colorStatus: color.status,
    pattern: pattern.value,
    patternRaw: raw.pattern,
    patternStatus: pattern.status,
    fit: raw.fit ?? "unknown",
    material: raw.material ?? "",
    seasons: raw.seasons ?? [],
    occasions: raw.occasions ?? [],
    box: fullFrameFallback ? null : (corners as unknown as Box),
    boxUnusable: fullFrameFallback,
    uncertain,
    selfConfidence: raw.confidence,
    unnamed: raw.name.trim() === "",
  };
  return { ...base, itemCount: 1, item };
}

/** Run information for a set of records of ONE run: they must agree on model, version and prompt. */
export function singleRunInfo(records: readonly AnalyzePhotoRecord[]): { run: SingleRunInfo | null; problems: string[] } {
  if (records.length === 0) return { run: null, problems: ["no records"] };
  const first = records[0];
  const problems: string[] = [];
  for (const r of records) {
    if (r.model !== first.model || r.modelVersion !== first.modelVersion || r.promptId !== first.promptId)
      problems.push(`record for "${r.fixtureId}" was made by another model/version/prompt than "${first.fixtureId}"; one prediction report is one run`);
  }
  if (problems.length > 0) return { run: null, problems };
  const startedAt = records.map((r) => r.startedAt).reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
  const timeouts = [...new Set(records.map((r) => r.timeoutMs))];
  return {
    run: {
      model: first.model,
      modelVersion: first.modelVersion,
      adapter: QWEN_SINGLE_ADAPTER_ID,
      analysisMode: "single",
      prompt: { id: first.promptId, sha256: null },
      startedAt,
      timeoutMs: timeouts.length === 1 ? timeouts[0] : null,
      imageHashSource: "recorded-by-run",
      notes: "Adapted from saved analyzePhoto() records. The image hash was recorded by the run and is checked against the immutable manifest hash.",
    },
    problems: [],
  };
}
