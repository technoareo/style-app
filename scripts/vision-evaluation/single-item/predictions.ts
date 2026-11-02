import { ID_RE, SHA256_RE, expectKeys, isIsoTimestamp, isNonEmptyString, isNonNegativeFinite, isRecord, oneOf } from "../check";
import { boxProblems } from "../geometry";
import type { Box } from "../types";
import { UNCERTAIN_KEYS, type UncertainKey } from "../../../src/domain/analysis";
import {
  FITS,
  GOLD_CATEGORIES,
  GOLD_COLORS,
  GOLD_PATTERNS,
  OCCASIONS,
  SEASONS,
  type Fit,
  type GoldCategory,
  type GoldColor,
  type GoldPattern,
  type Occasion,
  type Season,
} from "./vocab";

/**
 * What one model run produced for the single-item workflow, in the harness'
 * vocabulary. The adapter fills it from saved analyzePhoto output; this file only
 * defines and strictly validates the shape. The model's own confidence is stored
 * for transparency (`selfConfidence`) and is never used as correctness.
 */

export const CASE_STATUSES = ["completed", "failed", "timeout", "invalid", "unverified"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export type MappingStatus = "mapped" | "empty" | "unmapped";

export type SinglePrediction = {
  /** null = the app's "Unsorted", an abstention. */
  category: GoldCategory | null;
  categoryRaw: string;
  color: GoldColor | null;
  colorRaw: string;
  colorStatus: MappingStatus;
  pattern: GoldPattern | null;
  patternRaw: string;
  patternStatus: MappingStatus;
  fit: Fit;
  /** "" means the model named no visible texture. */
  material: string;
  seasons: Season[];
  occasions: Occasion[];
  /** Normalized corners in display orientation, or null when the box was unusable (the app then shows the full frame). */
  box: Box | null;
  boxUnusable: boolean;
  /** Attributes the model itself flagged as unsure: an explicit abstention. */
  uncertain: UncertainKey[];
  /** The model's self-reported, capped, UNCALIBRATED confidence. Never used to score. */
  selfConfidence: number | null;
  unnamed: boolean;
};

export type SinglePredictionCase = {
  fixtureId: string;
  imageSha256: string;
  status: CaseStatus;
  elapsedMs: number | null;
  error: string | null;
  itemCount: 0 | 1;
  item: SinglePrediction | null;
  /** The app's "more than one item may be visible" notice was present. */
  multipleItemsWarning: boolean;
  /** The app's "bounds could not be verified" notice was present. */
  cropUnverifiedWarning: boolean;
  invalidReasons: string[];
};

export type SingleRunInfo = {
  model: string;
  modelVersion: string;
  adapter: string;
  analysisMode: "single";
  prompt: { id: string; sha256: string | null };
  /** When the first inference started. Required for held-out scoring; must not precede the freeze. */
  startedAt: string | null;
  timeoutMs: number | null;
  imageHashSource: "recorded-by-run" | "asserted-by-operator";
  notes: string;
};

export type SinglePredictionReport = {
  schemaVersion: 1;
  kind: "single-item-predictions";
  run: SingleRunInfo;
  cases: SinglePredictionCase[];
};

const REPORT_KEYS = ["schemaVersion", "kind", "run", "cases"] as const;
const RUN_KEYS = ["model", "modelVersion", "adapter", "analysisMode", "prompt", "startedAt", "timeoutMs", "imageHashSource", "notes"] as const;
const PROMPT_KEYS = ["id", "sha256"] as const;
const CASE_KEYS = [
  "fixtureId",
  "imageSha256",
  "status",
  "elapsedMs",
  "error",
  "itemCount",
  "item",
  "multipleItemsWarning",
  "cropUnverifiedWarning",
  "invalidReasons",
] as const;
const ITEM_KEYS = [
  "category",
  "categoryRaw",
  "color",
  "colorRaw",
  "colorStatus",
  "pattern",
  "patternRaw",
  "patternStatus",
  "fit",
  "material",
  "seasons",
  "occasions",
  "box",
  "boxUnusable",
  "uncertain",
  "selfConfidence",
  "unnamed",
] as const;
const MAPPING_STATUSES = ["mapped", "empty", "unmapped"] as const;

function itemOf(raw: unknown, at: string, out: string[]): SinglePrediction | null {
  if (!isRecord(raw)) {
    out.push(`${at}: must be an object`);
    return null;
  }
  const before = out.length;
  expectKeys(raw, ITEM_KEYS, at, out);
  if (raw.category !== null && !oneOf(GOLD_CATEGORIES, raw.category)) out.push(`${at}.category: must be null or one of ${GOLD_CATEGORIES.join(", ")}`);
  for (const key of ["categoryRaw", "colorRaw", "patternRaw", "material"] as const)
    if (typeof raw[key] !== "string") out.push(`${at}.${key}: must be text`);
  if (raw.color !== null && !oneOf(GOLD_COLORS, raw.color)) out.push(`${at}.color: must be null or a gold colour`);
  if (raw.pattern !== null && !oneOf(GOLD_PATTERNS, raw.pattern)) out.push(`${at}.pattern: must be null or a gold pattern`);
  if (!oneOf(MAPPING_STATUSES, raw.colorStatus)) out.push(`${at}.colorStatus: invalid`);
  else if ((raw.colorStatus === "mapped") !== (raw.color !== null)) out.push(`${at}.color: set exactly when colorStatus is "mapped"`);
  if (!oneOf(MAPPING_STATUSES, raw.patternStatus)) out.push(`${at}.patternStatus: invalid`);
  else if ((raw.patternStatus === "mapped") !== (raw.pattern !== null)) out.push(`${at}.pattern: set exactly when patternStatus is "mapped"`);
  if (!oneOf(FITS, raw.fit)) out.push(`${at}.fit: must be one of ${FITS.join(", ")}`);
  for (const [key, list] of [
    ["seasons", SEASONS],
    ["occasions", OCCASIONS],
  ] as const) {
    const v = raw[key];
    if (!Array.isArray(v) || !v.every((x) => oneOf(list, x)) || new Set(v).size !== v.length) out.push(`${at}.${key}: must be a list of distinct allowed values`);
  }
  if (raw.box !== null) for (const p of boxProblems(raw.box)) out.push(`${at}.box: ${p}`);
  if (typeof raw.boxUnusable !== "boolean") out.push(`${at}.boxUnusable: must be true or false`);
  else if (raw.boxUnusable !== (raw.box === null)) out.push(`${at}.box: null exactly when boxUnusable is true`);
  if (!Array.isArray(raw.uncertain) || !raw.uncertain.every((x) => oneOf(UNCERTAIN_KEYS, x)) || new Set(raw.uncertain).size !== raw.uncertain.length)
    out.push(`${at}.uncertain: must be a list of distinct uncertain keys`);
  if (raw.selfConfidence !== null && !(typeof raw.selfConfidence === "number" && raw.selfConfidence >= 0 && raw.selfConfidence <= 1))
    out.push(`${at}.selfConfidence: must be null or 0..1`);
  if (typeof raw.unnamed !== "boolean") out.push(`${at}.unnamed: must be true or false`);
  return out.length > before ? null : (raw as unknown as SinglePrediction);
}

export function validateSinglePredictionReport(doc: unknown): { report: SinglePredictionReport | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { report: null, problems: ["predictions: must be a JSON object"] };
  expectKeys(doc, REPORT_KEYS, "predictions", problems);
  if (doc.schemaVersion !== 1) problems.push("predictions: schemaVersion must be 1");
  if (doc.kind !== "single-item-predictions") problems.push('predictions: kind must be "single-item-predictions"');
  const run = doc.run;
  if (!isRecord(run)) problems.push("predictions.run: must be an object");
  else {
    expectKeys(run, RUN_KEYS, "run", problems);
    for (const key of ["model", "modelVersion", "adapter", "notes"] as const) if (!isNonEmptyString(run[key])) problems.push(`run.${key}: must be a non-empty string`);
    if (run.analysisMode !== "single") problems.push('run.analysisMode: must be "single"');
    if (run.startedAt !== null && !isIsoTimestamp(run.startedAt)) problems.push("run.startedAt: must be null or an ISO timestamp with a time zone");
    if (run.timeoutMs !== null && !isNonNegativeFinite(run.timeoutMs)) problems.push("run.timeoutMs: must be null or a non-negative number");
    if (run.imageHashSource !== "recorded-by-run" && run.imageHashSource !== "asserted-by-operator") problems.push("run.imageHashSource: invalid");
    if (!isRecord(run.prompt)) problems.push("run.prompt: must be an object");
    else {
      expectKeys(run.prompt, PROMPT_KEYS, "run.prompt", problems);
      if (!isNonEmptyString(run.prompt.id)) problems.push("run.prompt.id: must be a non-empty string");
      if (run.prompt.sha256 !== null && !(typeof run.prompt.sha256 === "string" && SHA256_RE.test(run.prompt.sha256))) problems.push("run.prompt.sha256: must be null or 64 hex characters");
    }
  }
  if (!Array.isArray(doc.cases)) {
    problems.push("predictions.cases: must be an array");
    return { report: null, problems };
  }
  const seen = new Set<string>();
  doc.cases.forEach((raw: unknown, index: number) => {
    const at = `cases[${index}]`;
    if (!isRecord(raw)) return void problems.push(`${at}: must be an object`);
    expectKeys(raw, CASE_KEYS, at, problems);
    if (typeof raw.fixtureId !== "string" || !ID_RE.test(raw.fixtureId)) problems.push(`${at}.fixtureId: invalid`);
    else if (seen.has(raw.fixtureId)) problems.push(`${at}.fixtureId: "${raw.fixtureId}" appears twice`);
    else seen.add(raw.fixtureId);
    if (typeof raw.imageSha256 !== "string" || !SHA256_RE.test(raw.imageSha256)) problems.push(`${at}.imageSha256: must be 64 hex characters`);
    if (!oneOf(CASE_STATUSES, raw.status)) problems.push(`${at}.status: invalid`);
    if (raw.elapsedMs !== null && !isNonNegativeFinite(raw.elapsedMs)) problems.push(`${at}.elapsedMs: must be null or a non-negative number`);
    if (raw.error !== null && typeof raw.error !== "string") problems.push(`${at}.error: must be null or text`);
    if (raw.itemCount !== 0 && raw.itemCount !== 1) problems.push(`${at}.itemCount: single-item mode returns 0 or 1 items`);
    if (typeof raw.multipleItemsWarning !== "boolean" || typeof raw.cropUnverifiedWarning !== "boolean") problems.push(`${at}: warning flags must be true or false`);
    if (!Array.isArray(raw.invalidReasons) || !raw.invalidReasons.every((r) => typeof r === "string")) problems.push(`${at}.invalidReasons: must be a list of text`);
    if (raw.status === "completed") {
      if ((raw.itemCount === 1) !== (raw.item !== null)) problems.push(`${at}.item: present exactly when itemCount is 1`);
      if (raw.item !== null) itemOf(raw.item, `${at}.item`, problems);
      if (raw.error !== null) problems.push(`${at}.error: must be null for a completed case`);
    } else {
      if (raw.itemCount !== 0 || raw.item !== null) problems.push(`${at}: a ${String(raw.status)} case holds no item`);
      if (!isNonEmptyString(raw.error)) problems.push(`${at}.error: a failed case must say why`);
    }
  });
  return problems.length > 0 ? { report: null, problems } : { report: doc as unknown as SinglePredictionReport, problems: [] };
}
