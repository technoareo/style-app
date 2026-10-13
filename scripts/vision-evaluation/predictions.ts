import {
  ID_RE,
  SHA256_RE,
  expectKeys,
  isIsoTimestamp,
  isNonEmptyString,
  isNonNegativeFinite,
  isNonNegativeInt,
  isRecord,
  oneOf,
} from "./check";
import { boxProblems } from "./geometry";
import { CATEGORIES, MAX_ITEMS_PER_CASE, type Box, type Category } from "./types";

/**
 * Prediction report: what one model run returned for each fixture. It is
 * model-agnostic. A failed, timed-out, truncated or partly invalid case is
 * recorded as such and later counted as a failure; nothing here repairs output.
 */

export const CASE_STATUS = ["completed", "failed", "timeout", "truncated"] as const;
export type CaseStatus = (typeof CASE_STATUS)[number];

export type PredictedItem = {
  category: Category;
  box: Box;
  /** null = the model gave no attributes; they are scored only against human gold. */
  attributes: { color: string | null; pattern: string | null } | null;
};

export type PredictionCase = {
  fixtureId: string;
  /** Hash of the image the model was given (lowercase hex). */
  imageSha256: string;
  status: CaseStatus;
  elapsedMs: number | null;
  firstContentMs: number | null;
  error: string | null;
  /** Items the model emitted before validation. */
  rawCount: number;
  /** Of those, items that failed strict validation. Any value above 0 makes the case a failure. */
  invalidCount: number;
  /** Items that passed validation (kept for the record; ignored when invalidCount > 0). */
  items: PredictedItem[];
  invalidReasons: string[];
};

export type RunInfo = {
  model: string;
  /** "unrecorded" is allowed and visible; it is never silently filled in. */
  modelVersion: string;
  prompt: { id: string; sha256: string | null };
  strategy: string;
  adapter: string;
  /** null when the saved evidence did not record it; a held-out run then cannot be scored. */
  startedAt: string | null;
  timeoutMs: number | null;
  imageHashSource: "computed-by-runner" | "asserted-by-operator";
  notes: string | null;
};

export type PredictionReport = {
  schemaVersion: 1;
  kind: "predictions";
  run: RunInfo;
  cases: PredictionCase[];
};

const REPORT_KEYS = ["schemaVersion", "kind", "run", "cases"] as const;
const RUN_KEYS = [
  "model",
  "modelVersion",
  "prompt",
  "strategy",
  "adapter",
  "startedAt",
  "timeoutMs",
  "imageHashSource",
  "notes",
] as const;
const CASE_KEYS = [
  "fixtureId",
  "imageSha256",
  "status",
  "elapsedMs",
  "firstContentMs",
  "error",
  "rawCount",
  "invalidCount",
  "items",
  "invalidReasons",
] as const;

export function validatePredictionReport(doc: unknown): { report: PredictionReport | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { report: null, problems: ["predictions: must be a JSON object"] };
  expectKeys(doc, REPORT_KEYS, "predictions", problems);
  if (doc.schemaVersion !== 1) problems.push("predictions: schemaVersion must be 1");
  if (doc.kind !== "predictions") problems.push('predictions: kind must be "predictions"');

  const run = doc.run;
  if (!isRecord(run)) problems.push("predictions.run: must be an object");
  else {
    expectKeys(run, RUN_KEYS, "predictions.run", problems);
    for (const k of ["model", "modelVersion", "strategy", "adapter"] as const)
      if (!isNonEmptyString(run[k])) problems.push(`predictions.run.${k}: required text`);
    const prompt = run.prompt;
    if (!isRecord(prompt)) problems.push("predictions.run.prompt: must be an object");
    else {
      expectKeys(prompt, ["id", "sha256"], "predictions.run.prompt", problems);
      if (!isNonEmptyString(prompt.id)) problems.push("predictions.run.prompt.id: required text");
      if (prompt.sha256 !== null && !(typeof prompt.sha256 === "string" && SHA256_RE.test(prompt.sha256)))
        problems.push("predictions.run.prompt.sha256: null or 64 hex characters");
    }
    if (run.startedAt !== null && !isIsoTimestamp(run.startedAt))
      problems.push("predictions.run.startedAt: null or an ISO timestamp with a time zone");
    if (run.timeoutMs !== null && !isNonNegativeFinite(run.timeoutMs))
      problems.push("predictions.run.timeoutMs: null or a non-negative number");
    if (run.imageHashSource !== "computed-by-runner" && run.imageHashSource !== "asserted-by-operator")
      problems.push('predictions.run.imageHashSource: "computed-by-runner" or "asserted-by-operator"');
    if (run.notes !== null && !isNonEmptyString(run.notes)) problems.push("predictions.run.notes: null or text");
  }

  const rawCases = doc.cases;
  const cases: PredictionCase[] = [];
  if (!Array.isArray(rawCases)) problems.push("predictions.cases: must be an array");
  else {
    const seen = new Set<string>();
    rawCases.forEach((raw: unknown, index: number) => {
      const at = `predictions.cases[${index}]`;
      if (!isRecord(raw)) return void problems.push(`${at}: must be an object`);
      expectKeys(raw, CASE_KEYS, at, problems);
      if (typeof raw.fixtureId !== "string" || !ID_RE.test(raw.fixtureId)) problems.push(`${at}.fixtureId: invalid id`);
      else if (seen.has(raw.fixtureId)) problems.push(`${at}.fixtureId: duplicate case for "${raw.fixtureId}"`);
      else seen.add(raw.fixtureId);
      const sha = typeof raw.imageSha256 === "string" && SHA256_RE.test(raw.imageSha256) ? raw.imageSha256.toLowerCase() : null;
      if (!sha) problems.push(`${at}.imageSha256: must be 64 hex characters`);
      const status = oneOf(CASE_STATUS, raw.status) ? raw.status : null;
      if (!status) problems.push(`${at}.status: must be one of ${CASE_STATUS.join(", ")}`);
      if (raw.elapsedMs !== null && !isNonNegativeFinite(raw.elapsedMs)) problems.push(`${at}.elapsedMs: null or non-negative number`);
      if (raw.firstContentMs !== null && !isNonNegativeFinite(raw.firstContentMs))
        problems.push(`${at}.firstContentMs: null or non-negative number`);
      if (raw.error !== null && !isNonEmptyString(raw.error)) problems.push(`${at}.error: null or text`);
      if (!isNonNegativeInt(raw.rawCount)) problems.push(`${at}.rawCount: non-negative integer`);
      if (!isNonNegativeInt(raw.invalidCount)) problems.push(`${at}.invalidCount: non-negative integer`);

      const items: PredictedItem[] = [];
      if (!Array.isArray(raw.items)) problems.push(`${at}.items: must be an array`);
      else {
        if (raw.items.length > MAX_ITEMS_PER_CASE) problems.push(`${at}.items: more than ${MAX_ITEMS_PER_CASE}`);
        raw.items.forEach((it: unknown, i: number) => {
          const iAt = `${at}.items[${i}]`;
          if (!isRecord(it)) return void problems.push(`${iAt}: must be an object`);
          expectKeys(it, ["category", "box", "attributes"], iAt, problems);
          if (!oneOf(CATEGORIES, it.category)) problems.push(`${iAt}.category: must be one of ${CATEGORIES.join(", ")}`);
          for (const p of boxProblems(it.box)) problems.push(`${iAt}.${p}`);
          let attributes: PredictedItem["attributes"] = null;
          if (it.attributes !== null) {
            if (!isRecord(it.attributes)) problems.push(`${iAt}.attributes: null or an object`);
            else {
              expectKeys(it.attributes, ["color", "pattern"], `${iAt}.attributes`, problems);
              attributes = {
                color: isNonEmptyString(it.attributes.color) ? it.attributes.color : null,
                pattern: isNonEmptyString(it.attributes.pattern) ? it.attributes.pattern : null,
              };
            }
          }
          if (oneOf(CATEGORIES, it.category) && boxProblems(it.box).length === 0)
            items.push({ category: it.category, box: it.box as Box, attributes });
        });
      }
      if (!Array.isArray(raw.invalidReasons) || !raw.invalidReasons.every((r: unknown) => typeof r === "string"))
        problems.push(`${at}.invalidReasons: array of text`);

      if (isNonNegativeInt(raw.rawCount) && isNonNegativeInt(raw.invalidCount) && Array.isArray(raw.items)) {
        if (status === "completed") {
          if (raw.items.length + raw.invalidCount !== raw.rawCount)
            problems.push(`${at}: items (${raw.items.length}) + invalidCount (${raw.invalidCount}) must equal rawCount (${raw.rawCount})`);
          if (raw.error !== null) problems.push(`${at}.error: must be null for a completed case`);
        } else if (status !== null) {
          if (raw.rawCount !== 0 || raw.invalidCount !== 0 || raw.items.length !== 0)
            problems.push(`${at}: a ${status} case must report no items (nothing is salvaged)`);
          if (raw.error === null) problems.push(`${at}.error: a ${status} case must say why`);
        }
      }

      if (sha && status)
        cases.push({
          fixtureId: String(raw.fixtureId),
          imageSha256: sha,
          status,
          elapsedMs: typeof raw.elapsedMs === "number" ? raw.elapsedMs : null,
          firstContentMs: typeof raw.firstContentMs === "number" ? raw.firstContentMs : null,
          error: typeof raw.error === "string" ? raw.error : null,
          rawCount: isNonNegativeInt(raw.rawCount) ? raw.rawCount : 0,
          invalidCount: isNonNegativeInt(raw.invalidCount) ? raw.invalidCount : 0,
          items,
          invalidReasons: Array.isArray(raw.invalidReasons) ? raw.invalidReasons.map(String) : [],
        });
    });
  }

  if (problems.length > 0) return { report: null, problems };
  return { report: { schemaVersion: 1, kind: "predictions", run: run as unknown as RunInfo, cases }, problems };
}
