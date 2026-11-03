import { createHash } from "node:crypto";
import { ID_RE, SHA256_RE, expectKeys, isIsoTimestamp, isNonEmptyString, isRecord, oneOf } from "../check";
import { GOLD_CATEGORIES, REJECTION_REASONS, SCENE_TYPES, type RejectionReason, type SceneType } from "./vocab";

/**
 * Versioned launch policy for the single-item workflow. Every threshold is
 * explicit, attribute-specific and tied to a minimum sample count; a check with
 * too little data is NOT EVALUATED, never a pass. The shipped default policy is
 * a PROPOSAL with no approval record, so the gate cannot report PASS until a
 * named person approves a policy, and that approval is bound to the policy's
 * content by a digest: change one threshold and the approval no longer verifies.
 *
 * The validator refuses a policy that could not fail (a rule in the wrong
 * direction, a threshold that every run meets, a sample minimum of one) and a
 * policy that leaves out a gate the launch decision needs.
 */

/** Every metric a policy may gate on. Suggestion metrics may only be informational. */
export const METRIC_IDS = [
  "selection.rate",
  "refusal.falseAcceptRate",
  "refusal.unsafeAcceptRate",
  "inScope.falseRefusalRate",
  "inScope.warningRate",
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

export type PolicyApproval = {
  approvedBy: string;
  approvedAt: string;
  note: string;
  /** sha256 of the canonical policy content WITHOUT this approval. Any later change to the policy breaks it. */
  policySha256: string;
};

export type LaunchPolicy = {
  schemaVersion: 1;
  kind: "single-item-launch-policy";
  id: string;
  version: string;
  /** null = a proposal. The gate returns NOT EVALUATED until a person approves this exact policy content. */
  approval: PolicyApproval | null;
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

// ----------------------------------------------------------------------------- canonical digest

/** JSON with object keys sorted at every depth, so the text does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256Text = (text: string) => createHash("sha256").update(text).digest("hex");

/** Digest of everything a person approves: the whole policy except the approval record itself. */
export function policyContentSha256(policy: unknown): string {
  const { approval: _approval, ...content } = policy as Record<string, unknown>;
  return sha256Text(canonicalJson(content));
}

/** Digest of the whole document including the approval, for the report. */
export function policyDocumentSha256(policy: unknown): string {
  return sha256Text(canonicalJson(policy));
}

// ----------------------------------------------------------------------------- what a rule may say

type Basis = "inScope" | "inScopeAnswered" | "inScopeSubset" | "rejection" | "all" | "none";

type MetricSpec = {
  /** The only direction that makes sense: a rate of errors is bounded above, a rate of successes below. */
  comparator: ">=" | "<=";
  /** A threshold must be at least this strict: for ">=" at least `limit`, for "<=" at most `limit`. */
  limit: number;
  /** Bounds a gate on this metric may use (production). */
  bounds: readonly Bound[];
  /** Which part of the held-out sample the metric is computed on; the rule's minN must follow the policy minimums for it. */
  basis: Basis;
  /** A launch policy must gate on it. */
  required: boolean;
};

const WL = ["wilson95_lower"] as const;
const WU = ["wilson95_upper"] as const;

/**
 * The guard rails. The limits are the builder's judgement of the weakest
 * threshold that still means something; they are deliberately loose (a policy
 * should be stricter) and are NOT product standards. They exist so that a
 * policy cannot be written that every run meets.
 */
export const METRIC_SPECS: Readonly<Record<MetricId, MetricSpec | null>> = {
  "selection.rate": { comparator: ">=", limit: 0.8, bounds: WL, basis: "inScope", required: true },
  "refusal.falseAcceptRate": { comparator: "<=", limit: 0.2, bounds: WU, basis: "rejection", required: true },
  "refusal.unsafeAcceptRate": { comparator: "<=", limit: 0.3, bounds: WU, basis: "rejection", required: true },
  "inScope.falseRefusalRate": { comparator: "<=", limit: 0.15, bounds: WU, basis: "inScope", required: true },
  "inScope.warningRate": { comparator: "<=", limit: 0.3, bounds: WU, basis: "inScope", required: true },
  "reliability.failureRate": { comparator: "<=", limit: 0.05, bounds: WU, basis: "all", required: true },
  "category.accuracyOnAnswered": { comparator: ">=", limit: 0.8, bounds: WL, basis: "inScopeAnswered", required: true },
  "category.coverage": { comparator: ">=", limit: 0.8, bounds: ["point", "wilson95_lower"], basis: "inScope", required: true },
  "category.macroF1": { comparator: ">=", limit: 0.6, bounds: ["point"], basis: "inScope", required: true },
  "color.accuracyOnAnswered": { comparator: ">=", limit: 0.6, bounds: WL, basis: "inScopeAnswered", required: true },
  "color.coverage": { comparator: ">=", limit: 0.7, bounds: ["point", "wilson95_lower"], basis: "inScope", required: true },
  "color.macroF1": { comparator: ">=", limit: 0.4, bounds: ["point"], basis: "inScope", required: false },
  "pattern.accuracyOnAnswered": { comparator: ">=", limit: 0.6, bounds: WL, basis: "inScopeAnswered", required: true },
  "pattern.coverage": { comparator: ">=", limit: 0.7, bounds: ["point", "wilson95_lower"], basis: "inScope", required: true },
  "pattern.macroF1": { comparator: ">=", limit: 0.4, bounds: ["point"], basis: "inScope", required: false },
  "fit.accuracyOnAnswered": { comparator: ">=", limit: 0.5, bounds: WL, basis: "inScopeSubset", required: true },
  "fit.coverage": { comparator: ">=", limit: 0.3, bounds: ["point", "wilson95_lower"], basis: "inScopeSubset", required: true },
  "material.accuracyOnAnswered": { comparator: ">=", limit: 0.6, bounds: WL, basis: "inScopeSubset", required: true },
  "material.coverage": { comparator: ">=", limit: 0.1, bounds: ["point", "wilson95_lower"], basis: "inScopeSubset", required: false },
  "material.visibleMaterialRecall": { comparator: ">=", limit: 0.3, bounds: ["point", "wilson95_lower"], basis: "none", required: false },
  "crop.usefulRate": { comparator: ">=", limit: 0.7, bounds: WL, basis: "inScope", required: true },
  "latency.p50Ms": { comparator: "<=", limit: 180000, bounds: ["point"], basis: "all", required: false },
  "latency.p95Ms": { comparator: "<=", limit: 300000, bounds: ["point"], basis: "all", required: true },
  "latency.maxMs": { comparator: "<=", limit: 900000, bounds: ["point"], basis: "all", required: false },
  "suggestions.seasons.meanJaccard": null,
  "suggestions.occasions.meanJaccard": null,
};

export const REQUIRED_GATE_METRICS: readonly MetricId[] = METRIC_IDS.filter((m) => METRIC_SPECS[m]?.required);

/** Smallest samples a launch policy may ask for. Builder judgement: below these the sample says almost nothing. */
export const POLICY_FLOORS = {
  heldoutInScope: 100,
  heldoutRejection: 40,
  perCategory: 10,
  perRequiredScene: 10,
  perRejectionReason: 5,
} as const;

/**
 * Accuracy-on-answered is computed only over photos the model ANSWERED, so its sample
 * is the in-scope count times the coverage, never the full in-scope count. A rule that
 * demanded all of them would stay NOT_EVALUATED for any model that abstains at all,
 * making PASS unreachable. The rule may demand any share from this one up to the full
 * minimum; the coverage gates (floors 0.7 to 0.8, shipped 0.9 to 0.95) are what bound
 * abstention, and this share sits below the lowest coverage floor so a policy that
 * passes its coverage gates always has enough answers to be evaluated.
 */
const ANSWERED_MIN_SHARE = 0.6;

/** Share of the in-scope minimum a metric on a subset (fit and material known) must still demand. */
const SUBSET_MIN_SHARE = 0.4;

export type PolicyChecks = {
  /**
   * true: skip ONLY the sample-size rules (absolute minimum floors, minN following
   * the strata, interval bounds). Direction, threshold strictness, the required
   * gate set and the approval digest are always enforced. For synthetic tests;
   * the CLI never relaxes, and a report says which checks ran.
   */
  relaxedSampleChecks: boolean;
};
export const PRODUCTION_CHECKS: PolicyChecks = { relaxedSampleChecks: false };

// ----------------------------------------------------------------------------- validation

const POLICY_KEYS = ["schemaVersion", "kind", "id", "version", "approval", "notes", "iou", "minimums", "rules"] as const;
const APPROVAL_KEYS = ["approvedBy", "approvedAt", "note", "policySha256"] as const;
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

/** An IoU or coverage setting. Below these values a "match" would be almost any overlap. */
const IOU_FLOORS = { selection: 0.3, usefulCrop: 0.4, usefulCropMinCoverage: 0.6 } as const;

const unit = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1;
const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1;

function validateMinimums(m: Record<string, unknown>, checks: PolicyChecks, problems: string[]): void {
  expectKeys(m, MIN_KEYS, "policy.minimums", problems);
  for (const k of ["heldoutInScope", "heldoutRejection", "perCategory", "perRequiredScene", "perRejectionReason"] as const) {
    if (!count(m[k])) problems.push(`policy.minimums.${k}: must be a positive integer`);
    else if (!checks.relaxedSampleChecks && (m[k] as number) < POLICY_FLOORS[k])
      problems.push(`policy.minimums.${k}: ${String(m[k])} is below the floor of ${POLICY_FLOORS[k]}; a sample that small cannot support a launch decision`);
  }
  for (const [k, list] of [
    ["requiredScenes", SCENE_TYPES],
    ["requiredRejectionReasons", REJECTION_REASONS],
  ] as const) {
    const v = m[k];
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => oneOf(list, x)) || new Set(v).size !== v.length)
      problems.push(`policy.minimums.${k}: must be a non-empty list of distinct allowed values`);
  }
  if (!checks.relaxedSampleChecks) {
    if (Array.isArray(m.requiredScenes) && new Set(m.requiredScenes).size < 3) problems.push("policy.minimums.requiredScenes: require at least three scene types");
    if (Array.isArray(m.requiredRejectionReasons))
      for (const r of ["multiple_items", "no_garment"] as const)
        if (!m.requiredRejectionReasons.includes(r)) problems.push(`policy.minimums.requiredRejectionReasons: must include "${r}"`);
  }
  // The strata must be satisfiable: the per-stratum minimums have to fit inside the totals.
  if (count(m.heldoutInScope) && count(m.perCategory) && (m.perCategory as number) * GOLD_CATEGORIES.length > (m.heldoutInScope as number))
    problems.push(`policy.minimums: perCategory x ${GOLD_CATEGORIES.length} categories exceeds heldoutInScope; the strata could never be met`);
  if (count(m.heldoutInScope) && count(m.perRequiredScene) && Array.isArray(m.requiredScenes) && (m.perRequiredScene as number) * m.requiredScenes.length > (m.heldoutInScope as number))
    problems.push("policy.minimums: perRequiredScene x requiredScenes exceeds heldoutInScope; the strata could never be met");
  if (count(m.heldoutRejection) && count(m.perRejectionReason) && Array.isArray(m.requiredRejectionReasons) && (m.perRejectionReason as number) * m.requiredRejectionReasons.length > (m.heldoutRejection as number))
    problems.push("policy.minimums: perRejectionReason x requiredRejectionReasons exceeds heldoutRejection; the strata could never be met");
}

/** The minN a rule must demand, given the policy's strata minimums. */
function minNRange(basis: Basis, m: Record<string, unknown>): { min: number; max: number } | null {
  const inScope = m.heldoutInScope;
  const rejection = m.heldoutRejection;
  if (!count(inScope) || !count(rejection)) return null;
  const a = inScope as number;
  const r = rejection as number;
  switch (basis) {
    case "inScope":
      return { min: a, max: a };
    case "inScopeAnswered":
      return { min: Math.ceil(a * ANSWERED_MIN_SHARE), max: a };
    case "inScopeSubset":
      return { min: Math.ceil(a * SUBSET_MIN_SHARE), max: a };
    case "rejection":
      return { min: r, max: r };
    case "all":
      return { min: a + r, max: a + r };
    default:
      return null;
  }
}

function validateRule(r: unknown, i: number, m: unknown, checks: PolicyChecks, ids: Set<string>, problems: string[]): void {
  const at = `policy.rules[${i}]`;
  if (!isRecord(r)) return void problems.push(`${at}: must be an object`);
  expectKeys(r, RULE_KEYS, at, problems);
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) problems.push(`${at}.id: invalid`);
  else if (ids.has(r.id)) problems.push(`${at}.id: duplicate "${r.id}"`);
  else ids.add(r.id);
  if (r.kind !== "gate" && r.kind !== "informational") problems.push(`${at}.kind: must be gate or informational`);
  if (!isNonEmptyString(r.note)) problems.push(`${at}.note: say why this threshold`);
  if (!oneOf(METRIC_IDS, r.metric)) return void problems.push(`${at}.metric: unknown metric`);
  if (r.comparator !== ">=" && r.comparator !== "<=") problems.push(`${at}.comparator: must be >= or <=`);
  const finite = typeof r.threshold === "number" && Number.isFinite(r.threshold);
  if (!finite) problems.push(`${at}.threshold: must be a finite number`);
  if (!oneOf(BOUNDS, r.bound)) problems.push(`${at}.bound: must be point, wilson95_lower or wilson95_upper`);
  if (!count(r.minN)) problems.push(`${at}.minN: every rule needs an explicit minimum sample count (positive integer)`);

  const metric = r.metric;
  const spec = METRIC_SPECS[metric];
  if (r.kind === "gate" && oneOf(SUGGESTION_METRICS, metric))
    problems.push(`${at}: seasons and occasions are suggestions, not visible truth; they may only be informational`);
  if (!spec) return; // suggestion metrics: informational only, nothing more to bound
  if (r.comparator !== spec.comparator) problems.push(`${at}.comparator: ${metric} must use "${spec.comparator}" (the other direction cannot fail when the metric is good, or passes when it is bad)`);
  if (oneOf(BOUNDS, r.bound)) {
    if (r.bound === "wilson95_lower" && r.comparator !== ">=") problems.push(`${at}: a lower bound is compared with >=`);
    if (r.bound === "wilson95_upper" && r.comparator !== "<=") problems.push(`${at}: an upper bound is compared with <=`);
    if (metric.startsWith("latency.") && r.bound !== "point") problems.push(`${at}.bound: latency is compared as a point value`);
    else if (r.kind === "gate" && !checks.relaxedSampleChecks && !spec.bounds.includes(r.bound))
      problems.push(`${at}.bound: a gate on ${metric} must use ${spec.bounds.join(" or ")}, not ${r.bound}`);
  }
  if (finite && r.kind === "gate") {
    const t = r.threshold as number;
    const proportion = !metric.startsWith("latency.");
    if (spec.comparator === ">=") {
      if (t < spec.limit) problems.push(`${at}.threshold: ${t} is below the weakest acceptable ${spec.limit} for ${metric}; a run that barely works would pass`);
      if (proportion && (t > 1 || (r.bound === "wilson95_lower" && t >= 1))) problems.push(`${at}.threshold: ${t} can never be met for ${metric}`);
    } else {
      if (t > spec.limit) problems.push(`${at}.threshold: ${t} is above the loosest acceptable ${spec.limit} for ${metric}; a run that fails often would pass`);
      if (t <= 0) problems.push(`${at}.threshold: ${t} can never be met for ${metric}`);
    }
  }
  if (finite && r.kind !== "gate") {
    const t = r.threshold as number;
    if (!metric.startsWith("latency.") && (t < 0 || t > 1)) problems.push(`${at}.threshold: a proportion must be between 0 and 1`);
  }
  if (count(r.minN) && r.kind === "gate" && !checks.relaxedSampleChecks) {
    const n = r.minN as number;
    if (spec.basis === "none") {
      if (n < 20) problems.push(`${at}.minN: ${n} is too small for ${metric}; at least 20`);
    } else if (isRecord(m)) {
      const range = minNRange(spec.basis, m);
      if (range && n < range.min) problems.push(`${at}.minN: ${n} is below ${range.min}, the sample the policy minimums guarantee for ${metric}; a rule with a smaller minimum would judge on a thin sample`);
      if (range && n > range.max) problems.push(`${at}.minN: ${n} is above ${range.max}, the largest sample the policy minimums guarantee for ${metric}; the rule could stay NOT_EVALUATED forever`);
    }
  }
}

export function validatePolicy(doc: unknown, checks: PolicyChecks = PRODUCTION_CHECKS): { policy: LaunchPolicy | null; problems: string[] } {
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
      expectKeys(doc.approval, APPROVAL_KEYS, "policy.approval", problems);
      if (!isNonEmptyString(doc.approval.approvedBy)) problems.push("policy.approval.approvedBy: must name a person");
      if (!isIsoTimestamp(doc.approval.approvedAt)) problems.push("policy.approval.approvedAt: must be an ISO timestamp");
      if (!isNonEmptyString(doc.approval.note)) problems.push("policy.approval.note: must say what was approved");
      if (typeof doc.approval.policySha256 !== "string" || !SHA256_RE.test(doc.approval.policySha256))
        problems.push("policy.approval.policySha256: must be the sha256 of the approved policy content (use single-approve)");
      else if (doc.approval.policySha256.toLowerCase() !== policyContentSha256(doc))
        problems.push("policy.approval: the approval does not match this policy's content (the policy changed after it was approved); approve it again");
    }
  }
  if (!isRecord(doc.iou)) problems.push("policy.iou: must be an object");
  else {
    expectKeys(doc.iou, IOU_KEYS, "policy.iou", problems);
    for (const k of IOU_KEYS) {
      const v = doc.iou[k];
      if (!unit(v)) problems.push(`policy.iou.${k}: must be above 0 and at most 1`);
      else if ((v as number) < IOU_FLOORS[k]) problems.push(`policy.iou.${k}: ${String(v)} is below ${IOU_FLOORS[k]}; almost any overlap would count`);
    }
  }
  const m = doc.minimums;
  if (!isRecord(m)) problems.push("policy.minimums: must be an object");
  else validateMinimums(m, checks, problems);
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) problems.push("policy.rules: must be a non-empty list");
  else {
    const ids = new Set<string>();
    doc.rules.forEach((r: unknown, i: number) => validateRule(r, i, m, checks, ids, problems));
    const gated = new Set(doc.rules.filter((r: unknown) => isRecord(r) && r.kind === "gate").map((r: unknown) => (r as Record<string, unknown>).metric));
    for (const required of REQUIRED_GATE_METRICS) if (!gated.has(required)) problems.push(`policy.rules: a launch policy must gate on ${required}`);
  }
  return problems.length > 0 ? { policy: null, problems } : { policy: doc as unknown as LaunchPolicy, problems: [] };
}

/** The same policy with an approval bound to its content. The caller supplies who approved and when. */
export function approvePolicy(policy: LaunchPolicy, approvedBy: string, approvedAt: string, note: string): LaunchPolicy {
  const content = { ...policy, approval: null } as LaunchPolicy;
  return { ...content, approval: { approvedBy, approvedAt, note, policySha256: policyContentSha256(content) } };
}

// ----------------------------------------------------------------------------- the proposed policy

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
  version: "1.2.0-proposed",
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
    rule("selection-rate", "selection.rate", ">=", 0.9, "wilson95_lower", 240, "gate", "Share of in-scope photos where the model's single item overlaps the gold item (IoU)."),
    rule("false-accept-rate", "refusal.falseAcceptRate", "<=", 0.1, "wilson95_upper", 60, "gate", "Share of rejection photos the app accepted silently as a clean single item (no notice at all)."),
    rule("unsafe-accept-rate", "refusal.unsafeAcceptRate", "<=", 0.15, "wilson95_upper", 60, "gate", "Share of rejection photos where an item came back without the notice that fits the rejection reason (silent, crop-only, or a multiple-items notice on a photo that is not a multiple-items case). Stops a model passing by warning about everything."),
    rule("false-refusal-rate", "inScope.falseRefusalRate", "<=", 0.05, "wilson95_upper", 240, "gate", "Share of in-scope photos where the app returned no item."),
    rule("in-scope-warning-rate", "inScope.warningRate", "<=", 0.1, "wilson95_upper", 240, "gate", "Share of in-scope photos that came back with a multiple-items or crop-unverified notice. A model that warns on everything fails here."),
    rule("failure-rate", "reliability.failureRate", "<=", 0.02, "wilson95_upper", 300, "gate", "Failed, timed-out, invalid, unverified and missing cases, all of them, over all held-out cases."),
    rule("category-accuracy", "category.accuracyOnAnswered", ">=", 0.9, "wilson95_lower", 216, "gate", "Category exactness where the model answered. minN 216 is 90 % of the in-scope minimum: the answered count, bounded below by the 0.95 coverage gate."),
    rule("category-coverage", "category.coverage", ">=", 0.95, "point", 240, "gate", "Share of known-gold in-scope photos where the model answered the category (no Unsorted, no doubt, no failure)."),
    rule("category-macro-f1", "category.macroF1", ">=", 0.85, "point", 240, "gate", "Macro F1 over categories, abstentions counted as misses."),
    rule("color-accuracy", "color.accuracyOnAnswered", ">=", 0.8, "wilson95_lower", 216, "gate", "Coarse colour exactness where the model answered; an unmappable colour counts as wrong. minN 216 = the answered count the 0.9 coverage gate guarantees."),
    rule("color-coverage", "color.coverage", ">=", 0.9, "point", 240, "gate", "Share of in-scope photos with a mapped, undoubted colour."),
    rule("pattern-accuracy", "pattern.accuracyOnAnswered", ">=", 0.8, "wilson95_lower", 216, "gate", "Pattern exactness where the model answered. minN 216 = the answered count the 0.9 coverage gate guarantees."),
    rule("pattern-coverage", "pattern.coverage", ">=", 0.9, "point", 240, "gate", "Share of in-scope photos with a mapped, undoubted pattern."),
    rule("fit-accuracy", "fit.accuracyOnAnswered", ">=", 0.7, "wilson95_lower", 100, "gate", "Fit exactness where the model answered; unknown is an allowed abstention, so coverage is gated separately."),
    rule("fit-coverage", "fit.coverage", ">=", 0.4, "point", 100, "gate", "Fit may often be unknown; require some useful answers."),
    rule("material-accuracy", "material.accuracyOnAnswered", ">=", 0.9, "wilson95_lower", 100, "gate", "Exactness of the visible texture the model named. A blank material is an abstention, not an answer, so a model cannot score by naming nothing."),
    rule("material-visible-recall", "material.visibleMaterialRecall", ">=", 0.5, "point", 20, "informational", "Recall on photos whose gold material is a visible texture; reported only."),
    rule("crop-useful", "crop.usefulRate", ">=", 0.85, "wilson95_lower", 240, "gate", "Share of in-scope photos with a crop that covers the item well."),
    rule("latency-p50", "latency.p50Ms", "<=", 60000, "point", 300, "gate", "Placeholder for an owner decision on waiting time; not derived from research."),
    rule("latency-p95", "latency.p95Ms", "<=", 120000, "point", 300, "gate", "Placeholder for an owner decision on waiting time; not derived from research."),
    rule("latency-max", "latency.maxMs", "<=", 300000, "point", 300, "gate", "Placeholder for an owner decision on waiting time; not derived from research."),
    rule("seasons-jaccard", "suggestions.seasons.meanJaccard", ">=", 0.5, "point", 240, "informational", "Suggestion metric only: seasons are not visible objective truth."),
    rule("occasions-jaccard", "suggestions.occasions.meanJaccard", ">=", 0.5, "point", 240, "informational", "Suggestion metric only: occasions are not visible objective truth."),
  ],
};
