import { ID_RE, expectKeys, isIsoTimestamp, isNonEmptyString, isRecord, oneOf } from "../check";
import { REJECTION_REASONS, SCENE_TYPES, type RejectionReason, type SceneType } from "./vocab";

/**
 * Versioned launch policy for the single-item workflow. Every threshold is
 * explicit, attribute-specific and tied to a minimum sample count; a check with
 * too little data is NOT EVALUATED, never a pass. The shipped default policy is
 * a PROPOSAL with no approval record, so the gate cannot report PASS until a
 * named person signs a policy.
 */

/** Every metric a policy may gate on. Suggestion metrics may only be informational. */
export const METRIC_IDS = [
  "selection.rate",
  "refusal.falseAcceptRate",
  "inScope.falseRefusalRate",
  "reliability.failureRate",
  "category.accuracyOnAnswered",
  "category.coverage",
  "category.macroF1",
  "color.accuracyOnAnswered",
  "color.coverage",
  "color.macroF1",
  "pattern.accuracyOnAnswered",
  "pattern.coverage",
  "pattern.macroF1",
  "fit.accuracyOnAnswered",
  "fit.coverage",
  "material.accuracyOnAnswered",
  "material.coverage",
  "material.visibleMaterialRecall",
  "crop.usefulRate",
  "latency.p50Ms",
  "latency.p95Ms",
  "latency.maxMs",
  "suggestions.seasons.meanJaccard",
  "suggestions.occasions.meanJaccard",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

const SUGGESTION_METRICS: readonly MetricId[] = ["suggestions.seasons.meanJaccard", "suggestions.occasions.meanJaccard"];

export const BOUNDS = ["point", "wilson95_lower", "wilson95_upper"] as const;
export type Bound = (typeof BOUNDS)[number];

export type GateRule = {
  id: string;
  metric: MetricId;
  /** ">=" : the (bounded) value must be at least `threshold`; "<=" : at most. */
  comparator: ">=" | "<=";
  threshold: number;
  /** Which number is compared: the point estimate or a 95 % Wilson bound. Latency uses "point". */
  bound: Bound;
  /** Fewer observations than this: NOT EVALUATED. */
  minN: number;
  /** "informational" rules are reported but never decide the verdict. */
  kind: "gate" | "informational";
  note: string;
};

export type LaunchPolicy = {
  schemaVersion: 1;
  kind: "single-item-launch-policy";
  id: string;
  version: string;
  /** null = a proposal. The gate returns NOT EVALUATED until a person approves this exact policy. */
  approval: { approvedBy: string; approvedAt: string; note: string } | null;
  notes: string;
  iou: {
    /** IoU at which the model's box counts as selecting the gold item. */
    selection: number;
    /** IoU at which a crop is useful ... */
    usefulCrop: number;
    /** ... and the share of the gold box it must cover. */
    usefulCropMinCoverage: number;
  };
  minimums: {
    heldoutInScope: number;
    heldoutRejection: number;
    perCategory: number;
    perRequiredScene: number;
    perRejectionReason: number;
    requiredScenes: SceneType[];
    requiredRejectionReasons: RejectionReason[];
  };
  rules: GateRule[];
};

const POLICY_KEYS = ["schemaVersion", "kind", "id", "version", "approval", "notes", "iou", "minimums", "rules"] as const;
const IOU_KEYS = ["selection", "usefulCrop", "usefulCropMinCoverage"] as const;
const MIN_KEYS = [
  "heldoutInScope",
  "heldoutRejection",
  "perCategory",
  "perRequiredScene",
  "perRejectionReason",
  "requiredScenes",
  "requiredRejectionReasons",
] as const;
const RULE_KEYS = ["id", "metric", "comparator", "threshold", "bound", "minN", "kind", "note"] as const;

const unit = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1;
const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1;

export function validatePolicy(doc: unknown): { policy: LaunchPolicy | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { policy: null, problems: ["policy: must be a JSON object"] };
  expectKeys(doc, POLICY_KEYS, "policy", problems);
  if (doc.schemaVersion !== 1) problems.push("policy: schemaVersion must be 1");
  if (doc.kind !== "single-item-launch-policy") problems.push('policy: kind must be "single-item-launch-policy"');
  if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) problems.push("policy: id is invalid");
  if (!isNonEmptyString(doc.version)) problems.push("policy: version must be a non-empty string");
  if (!isNonEmptyString(doc.notes)) problems.push("policy: notes must say where the thresholds come from");
  if (doc.approval !== null) {
    if (!isRecord(doc.approval)) problems.push("policy.approval: must be null or an object");
    else {
      expectKeys(doc.approval, ["approvedBy", "approvedAt", "note"], "policy.approval", problems);
      if (!isNonEmptyString(doc.approval.approvedBy)) problems.push("policy.approval.approvedBy: must name a person");
      if (!isIsoTimestamp(doc.approval.approvedAt)) problems.push("policy.approval.approvedAt: must be an ISO timestamp");
      if (!isNonEmptyString(doc.approval.note)) problems.push("policy.approval.note: must say what was approved");
    }
  }
  if (!isRecord(doc.iou)) problems.push("policy.iou: must be an object");
  else {
    expectKeys(doc.iou, IOU_KEYS, "policy.iou", problems);
    for (const k of IOU_KEYS) if (!unit(doc.iou[k])) problems.push(`policy.iou.${k}: must be above 0 and at most 1`);
  }
  const m = doc.minimums;
  if (!isRecord(m)) problems.push("policy.minimums: must be an object");
  else {
    expectKeys(m, MIN_KEYS, "policy.minimums", problems);
    for (const k of ["heldoutInScope", "heldoutRejection", "perCategory", "perRequiredScene", "perRejectionReason"] as const)
      if (!count(m[k])) problems.push(`policy.minimums.${k}: must be a positive integer`);
    for (const [k, list] of [
      ["requiredScenes", SCENE_TYPES],
      ["requiredRejectionReasons", REJECTION_REASONS],
    ] as const) {
      const v = m[k];
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => oneOf(list, x)) || new Set(v).size !== v.length)
        problems.push(`policy.minimums.${k}: must be a non-empty list of distinct allowed values`);
    }
  }
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) problems.push("policy.rules: must be a non-empty list");
  else {
    const ids = new Set<string>();
    doc.rules.forEach((r: unknown, i: number) => {
      const at = `policy.rules[${i}]`;
      if (!isRecord(r)) return void problems.push(`${at}: must be an object`);
      expectKeys(r, RULE_KEYS, at, problems);
      if (typeof r.id !== "string" || !ID_RE.test(r.id)) problems.push(`${at}.id: invalid`);
      else if (ids.has(r.id)) problems.push(`${at}.id: duplicate "${r.id}"`);
      else ids.add(r.id);
      if (!oneOf(METRIC_IDS, r.metric)) problems.push(`${at}.metric: unknown metric`);
      if (r.comparator !== ">=" && r.comparator !== "<=") problems.push(`${at}.comparator: must be >= or <=`);
      if (!(typeof r.threshold === "number" && Number.isFinite(r.threshold) && r.threshold >= 0)) problems.push(`${at}.threshold: must be a non-negative number`);
      if (!oneOf(BOUNDS, r.bound)) problems.push(`${at}.bound: must be point, wilson95_lower or wilson95_upper`);
      else if (typeof r.metric === "string" && r.metric.startsWith("latency.") && r.bound !== "point") problems.push(`${at}.bound: latency is compared as a point value`);
      else if (r.bound === "wilson95_lower" && r.comparator !== ">=") problems.push(`${at}: a lower bound is compared with >=`);
      else if (r.bound === "wilson95_upper" && r.comparator !== "<=") problems.push(`${at}: an upper bound is compared with <=`);
      if (!count(r.minN)) problems.push(`${at}.minN: every rule needs an explicit minimum sample count (positive integer)`);
      if (r.kind !== "gate" && r.kind !== "informational") problems.push(`${at}.kind: must be gate or informational`);
      if (r.kind === "gate" && oneOf(SUGGESTION_METRICS, r.metric))
        problems.push(`${at}: seasons and occasions are suggestions, not visible truth; they may only be informational`);
      if (!isNonEmptyString(r.note)) problems.push(`${at}.note: say why this threshold`);
      if (typeof r.threshold === "number" && /rate|accuracy|coverage|F1|Recall|Jaccard/.test(String(r.metric)) && r.threshold > 1)
        problems.push(`${at}.threshold: a proportion cannot exceed 1`);
    });
    const gateMetrics = new Set(doc.rules.filter((r: unknown) => isRecord(r) && r.kind === "gate").map((r: unknown) => (r as Record<string, unknown>).metric));
    for (const required of ["selection.rate", "refusal.falseAcceptRate", "category.accuracyOnAnswered", "reliability.failureRate", "latency.p95Ms"] as const)
      if (!gateMetrics.has(required)) problems.push(`policy.rules: a launch policy must gate on ${required}`);
  }
  return problems.length > 0 ? { policy: null, problems } : { policy: doc as unknown as LaunchPolicy, problems: [] };
}

const rule = (
  id: string,
  metric: MetricId,
  comparator: ">=" | "<=",
  threshold: number,
  bound: Bound,
  minN: number,
  kind: "gate" | "informational",
  note: string,
): GateRule => ({ id, metric, comparator, threshold, bound, minN, kind, note });

/**
 * PROPOSED launch policy, version 1. These numbers are engineering proposals,
 * not an established standard and not derived from user research; they exist so
 * the gate is explicit and testable. They have no approval record, so the gate
 * returns NOT EVALUATED until a named person approves a policy. Latency limits
 * are placeholders for a product decision about acceptable waiting time; the only
 * real-model evidence so far (3 development photos, 75-132 s on CPU) would not meet them.
 */
export const DEFAULT_POLICY: LaunchPolicy = {
  schemaVersion: 1,
  kind: "single-item-launch-policy",
  id: "single-item-launch-policy",
  version: "1.0.0-proposed",
  approval: null,
  notes:
    "Proposed by the build 024 builder from the recommended benchmark shape (360 images: 60 development, 240 in-scope held-out, 60 held-out rejection). The numbers are proposals for the owner to accept or change, not a proven standard.",
  iou: { selection: 0.5, usefulCrop: 0.6, usefulCropMinCoverage: 0.85 },
  minimums: {
    heldoutInScope: 240,
    heldoutRejection: 60,
    perCategory: 20,
    perRequiredScene: 20,
    perRejectionReason: 10,
    requiredScenes: ["flat_lay", "hanging", "mannequin", "worn", "product_shot"],
    requiredRejectionReasons: ["multiple_items", "no_garment", "unusable_quality"],
  },
  rules: [
    rule("selection-rate", "selection.rate", ">=", 0.9, "wilson95_lower", 200, "gate", "Share of in-scope photos where the model's single item overlaps the gold item (IoU)."),
    rule("false-accept-rate", "refusal.falseAcceptRate", "<=", 0.1, "wilson95_upper", 60, "gate", "Share of rejection photos the app accepted silently as a clean single item."),
    rule("false-refusal-rate", "inScope.falseRefusalRate", "<=", 0.05, "wilson95_upper", 200, "gate", "Share of in-scope photos where the app returned no item."),
    rule("failure-rate", "reliability.failureRate", "<=", 0.02, "wilson95_upper", 300, "gate", "Failed, timed-out, invalid, unverified and missing cases, all of them, over all held-out cases."),
    rule("category-accuracy", "category.accuracyOnAnswered", ">=", 0.9, "wilson95_lower", 200, "gate", "Category exactness where the model answered."),
    rule("category-coverage", "category.coverage", ">=", 0.95, "point", 200, "gate", "Share of known-gold in-scope photos where the model answered the category (no Unsorted, no doubt, no failure)."),
    rule("category-macro-f1", "category.macroF1", ">=", 0.85, "point", 200, "gate", "Macro F1 over categories, abstentions counted as misses."),
    rule("color-accuracy", "color.accuracyOnAnswered", ">=", 0.8, "wilson95_lower", 200, "gate", "Coarse colour exactness where the model answered; an unmappable colour counts as wrong."),
    rule("color-coverage", "color.coverage", ">=", 0.9, "point", 200, "gate", "Share of in-scope photos with a mapped, undoubted colour."),
    rule("pattern-accuracy", "pattern.accuracyOnAnswered", ">=", 0.8, "wilson95_lower", 200, "gate", "Pattern exactness where the model answered."),
    rule("pattern-coverage", "pattern.coverage", ">=", 0.9, "point", 200, "gate", "Share of in-scope photos with a mapped, undoubted pattern."),
    rule("fit-accuracy", "fit.accuracyOnAnswered", ">=", 0.7, "wilson95_lower", 100, "gate", "Fit exactness where the model answered; unknown is an allowed abstention, so coverage is gated separately."),
    rule("fit-coverage", "fit.coverage", ">=", 0.4, "point", 100, "gate", "Fit may often be unknown; require some useful answers."),
    rule("material-accuracy", "material.accuracyOnAnswered", ">=", 0.9, "wilson95_lower", 100, "gate", "Observable material exactness where the model answered (none-visible counts as an answer)."),
    rule("material-visible-recall", "material.visibleMaterialRecall", ">=", 0.5, "point", 20, "informational", "Recall on photos whose gold material is a visible texture; reported only."),
    rule("crop-useful", "crop.usefulRate", ">=", 0.85, "wilson95_lower", 200, "gate", "Share of in-scope photos with a crop that covers the item well."),
    rule("latency-p50", "latency.p50Ms", "<=", 60000, "point", 200, "gate", "Placeholder for an owner decision on waiting time; not derived from research."),
    rule("latency-p95", "latency.p95Ms", "<=", 120000, "point", 200, "gate", "Placeholder for an owner decision on waiting time; not derived from research."),
    rule("latency-max", "latency.maxMs", "<=", 300000, "point", 200, "gate", "Placeholder for an owner decision on waiting time; not derived from research."),
    rule("seasons-jaccard", "suggestions.seasons.meanJaccard", ">=", 0.5, "point", 200, "informational", "Suggestion metric only: seasons are not visible objective truth."),
    rule("occasions-jaccard", "suggestions.occasions.meanJaccard", ">=", 0.5, "point", 200, "informational", "Suggestion metric only: occasions are not visible objective truth."),
  ],
};
