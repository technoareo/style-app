import { EvaluationRefusal } from "../evaluate";
import { iou } from "../geometry";
import type { Box, Split } from "../types";
import type { GoldFile, GoldItem, GoldLabel } from "./gold";
import { LEAKAGE_KEYS, integrityProblems, strataCounts, strataProblems, type IntegrityInput } from "./integrity";
import type { SingleFixture, SingleManifest } from "./manifest";
import { PRODUCTION_CHECKS, policyContentSha256, policyDocumentSha256, validatePolicy, type GateRule, type LaunchPolicy, type MetricId, type PolicyChecks } from "./policy";
import type { CaseStatus, SinglePredictionCase } from "./predictions";
import { VISIBLE_MATERIALS, type GoldMaterial } from "./vocab";

/**
 * Deterministic scoring and launch gate for the single-item workflow. Nothing
 * here reads the clock, a file or the network; the same inputs always give the
 * same report. A missing, failed, timed-out or invalid case keeps its gold in
 * every denominator. Model confidence is never used as correctness.
 */

export const ATTRIBUTES = ["category", "color", "pattern", "fit", "material"] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

export type Disposition = "accepted" | "accepted_with_multiple_warning" | "accepted_with_crop_warning" | "refused_empty" | "failed";
export type AttrState = "correct" | "wrong" | "abstained" | "notRun" | "excluded";

export type AttrCell = { gold: string | null; predicted: string | null; state: AttrState; unmapped: boolean; overclaim: boolean };

export type CaseResult = {
  fixtureId: string;
  split: Split;
  stratum: SingleFixture["stratum"];
  sceneType: SingleFixture["sceneType"];
  rejectionReason: SingleFixture["rejectionReason"];
  predictionStatus: CaseStatus | "missing";
  disposition: Disposition;
  /** Rejection photos only: an item came back without the notice that fits the rejection reason. null for in-scope photos. */
  unsafeAccept: boolean | null;
  /** The app attached a multiple-items or crop-unverified notice. */
  warned: boolean;
  /** The app merged two shoes into one pair and said so. Reported, never scored. */
  shoePairNotice: boolean;
  elapsedMs: number | null;
  iou: number | null;
  coverage: number | null;
  selected: boolean | null;
  cropUseful: boolean | null;
  attributes: Record<Attribute, AttrCell> | null;
  seasonsJaccard: number | null;
  occasionsJaccard: number | null;
};

export type Metric = { value: number | null; n: number; lower: number | null; upper: number | null; detail: string | null };

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** 95 % Wilson score interval. */
export function wilson(k: number, n: number): { lower: number; upper: number } | null {
  if (n <= 0) return null;
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { lower: r6(Math.max(0, (c - m) / d)), upper: r6(Math.min(1, (c + m) / d)) };
}

/** Nearest-rank percentile of a non-empty list (p in (0,1]). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

const proportion = (k: number, n: number, detail: string | null = null): Metric => {
  const w = wilson(k, n);
  return { value: n > 0 ? r6(k / n) : null, n, lower: w?.lower ?? null, upper: w?.upper ?? null, detail: n > 0 ? detail : "no observations" };
};
const point = (value: number | null, n: number, detail: string | null = null): Metric => ({ value: value === null ? null : r6(value), n, lower: null, upper: null, detail });

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const inter = a.filter((x) => b.includes(x)).length;
  return inter / (a.length + b.length - inter);
}

function coverageOfGold(gold: Box, pred: Box): number {
  const iw = Math.min(gold[2], pred[2]) - Math.max(gold[0], pred[0]);
  const ih = Math.min(gold[3], pred[3]) - Math.max(gold[1], pred[1]);
  if (iw <= 0 || ih <= 0) return 0;
  return (iw * ih) / ((gold[2] - gold[0]) * (gold[3] - gold[1]));
}

function disposition(c: SinglePredictionCase | null): Disposition {
  if (!c || c.status !== "completed") return "failed";
  if (c.itemCount === 0) return "refused_empty";
  if (c.multipleItemsWarning) return "accepted_with_multiple_warning";
  if (c.cropUnverifiedWarning) return "accepted_with_crop_warning";
  return "accepted";
}

/**
 * A rejection photo is handled safely when the app returned no item, or returned
 * one WITH the notice that fits the reason (a multiple-items notice on a
 * multiple-items photo). A silent item, a crop-only notice, or a multiple-items
 * notice on some other kind of rejection is an unsafe accept. A failed case is
 * not an accept (it counts in the failure rate instead).
 */
function unsafeAccept(d: Disposition, reason: SingleFixture["rejectionReason"]): boolean {
  if (d === "failed" || d === "refused_empty") return false;
  if (d === "accepted_with_multiple_warning") return reason !== "multiple_items";
  return true;
}

function attributeCells(gold: GoldItem, c: SinglePredictionCase | null): Record<Attribute, AttrCell> {
  const item = c && c.status === "completed" ? c.item : null;
  const cell = (attr: Attribute): AttrCell => {
    const g: string = attr === "material" ? gold.material : (gold[attr] as string);
    const known = !(attr === "fit" && g === "unknown") && !(attr === "material" && g === "unknown");
    if (!item) return { gold: g, predicted: null, state: known ? "notRun" : "excluded", unmapped: false, overclaim: false };
    let predicted: string | null;
    let abstained = item.uncertain.includes(attr);
    let unmapped = false;
    if (attr === "category") {
      predicted = item.category;
      if (item.category === null) abstained = true;
    } else if (attr === "color" || attr === "pattern") {
      const status = attr === "color" ? item.colorStatus : item.patternStatus;
      predicted = attr === "color" ? item.color : item.pattern;
      if (status === "empty") abstained = true;
      if (status === "unmapped") unmapped = true;
    } else if (attr === "fit") {
      predicted = item.fit;
      if (item.fit === "unknown") abstained = true;
    } else {
      // A blank material is "named nothing", an abstention: crediting it as "none_visible" would let a model that never names a texture score on every plain garment.
      predicted = item.material === "" ? null : item.material;
      if (item.material === "") abstained = true;
    }
    const answered = !abstained;
    if (!known) return { gold: g, predicted: answered ? predicted : null, state: "excluded", unmapped: false, overclaim: answered };
    if (abstained) return { gold: g, predicted: null, state: "abstained", unmapped: false, overclaim: false };
    return { gold: g, predicted: unmapped ? null : predicted, state: !unmapped && predicted === g ? "correct" : "wrong", unmapped, overclaim: false };
  };
  return { category: cell("category"), color: cell("color"), pattern: cell("pattern"), fit: cell("fit"), material: cell("material") };
}

export function scoreCase(
  fixture: SingleFixture,
  split: Split,
  gold: GoldLabel,
  prediction: SinglePredictionCase | null,
  policy: LaunchPolicy,
): CaseResult {
  const base = {
    fixtureId: fixture.id,
    split,
    stratum: fixture.stratum,
    sceneType: fixture.sceneType,
    rejectionReason: fixture.rejectionReason,
    predictionStatus: (prediction?.status ?? "missing") as CaseStatus | "missing",
    disposition: disposition(prediction),
    unsafeAccept: fixture.stratum === "rejection" ? unsafeAccept(disposition(prediction), fixture.rejectionReason) : null,
    warned: prediction?.status === "completed" && (prediction.multipleItemsWarning || prediction.cropUnverifiedWarning),
    shoePairNotice: prediction?.status === "completed" && prediction.shoePairNotice,
    elapsedMs: prediction?.elapsedMs ?? null,
  };
  if (gold.outcome !== "single_item" || !gold.item) {
    return { ...base, iou: null, coverage: null, selected: null, cropUseful: null, attributes: null, seasonsJaccard: null, occasionsJaccard: null };
  }
  const item = prediction && prediction.status === "completed" ? prediction.item : null;
  const box = item?.box ?? null;
  // Rounded before any comparison, so a threshold met exactly is met despite float error.
  const overlap = box ? r6(iou(gold.item.box, box)) : null;
  const cover = box ? r6(coverageOfGold(gold.item.box, box)) : null;
  const selected = overlap !== null && overlap >= policy.iou.selection;
  return {
    ...base,
    iou: overlap,
    coverage: cover,
    selected: item ? selected : false,
    cropUseful: overlap !== null && cover !== null && overlap >= policy.iou.usefulCrop && cover >= policy.iou.usefulCropMinCoverage,
    attributes: attributeCells(gold.item, prediction),
    seasonsJaccard: item ? r6(jaccard(item.seasons, gold.item.seasons)) : null,
    occasionsJaccard: item ? r6(jaccard(item.occasions, gold.item.occasions)) : null,
  };
}

// ----------------------------------------------------------------------------- aggregation

type ClassRow = { label: string; goldCount: number; correct: number; wrong: number; abstained: number; notRun: number; predicted: number; precision: number | null; recall: number | null; f1: number };

export type AttributeReport = {
  goldKnown: number;
  goldUnknownExcluded: number;
  overclaimOnUnknown: number;
  answered: number;
  correct: number;
  wrong: number;
  unmapped: number;
  abstained: number;
  notRun: number;
  coverage: Metric;
  accuracyOnAnswered: Metric;
  endToEndCorrect: Metric;
  macroF1: Metric;
  perClass: ClassRow[];
};

function attributeReport(cases: readonly CaseResult[], attr: Attribute): AttributeReport {
  const cells = cases.flatMap((c) => (c.attributes ? [c.attributes[attr]] : []));
  const known = cells.filter((x) => x.state !== "excluded");
  const answered = known.filter((x) => x.state === "correct" || x.state === "wrong");
  const correct = known.filter((x) => x.state === "correct").length;
  const labels = [...new Set([...known.map((x) => x.gold as string), ...answered.map((x) => x.predicted).filter((p): p is string => p !== null)])].sort();
  const perClass: ClassRow[] = labels.map((label) => {
    const goldRows = known.filter((x) => x.gold === label);
    const tp = goldRows.filter((x) => x.state === "correct").length;
    const fp = answered.filter((x) => x.predicted === label && x.gold !== label).length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = goldRows.length > 0 ? tp / goldRows.length : null;
    const f1 = tp > 0 && precision !== null && recall !== null ? (2 * precision * recall) / (precision + recall) : 0;
    return {
      label,
      goldCount: goldRows.length,
      correct: tp,
      wrong: goldRows.filter((x) => x.state === "wrong").length,
      abstained: goldRows.filter((x) => x.state === "abstained").length,
      notRun: goldRows.filter((x) => x.state === "notRun").length,
      predicted: answered.filter((x) => x.predicted === label).length,
      precision: precision === null ? null : r6(precision),
      recall: recall === null ? null : r6(recall),
      f1: r6(f1),
    };
  });
  const macro = perClass.length > 0 ? perClass.reduce((s, r) => s + r.f1, 0) / perClass.length : null;
  return {
    goldKnown: known.length,
    goldUnknownExcluded: cells.length - known.length,
    overclaimOnUnknown: cells.filter((x) => x.overclaim).length,
    answered: answered.length,
    correct,
    wrong: answered.length - correct,
    unmapped: known.filter((x) => x.unmapped).length,
    abstained: known.filter((x) => x.state === "abstained").length,
    notRun: known.filter((x) => x.state === "notRun").length,
    coverage: proportion(answered.length, known.length, "answered / known gold; abstentions and failures lower it"),
    accuracyOnAnswered: proportion(correct, answered.length, "correct / answered; says nothing about the abstained"),
    endToEndCorrect: proportion(correct, known.length, "correct / known gold, abstentions and failures count as misses"),
    macroF1: point(macro, known.length, "mean F1 over gold and predicted labels; abstentions are misses"),
    perClass,
  };
}

export type SplitReport = {
  counts: { fixtures: number; inScope: number; rejection: number; predicted: number; missing: number };
  strata: ReturnType<typeof strataCounts>;
  dispositions: Record<"in_scope" | "rejection", Record<Disposition, number>>;
  selection: Metric;
  falseRefusal: Metric;
  /** Silent accepts only: an item with no notice at all. Stays strict, and is not the whole story (see unsafeAccept). */
  falseAccept: Metric;
  /** An item came back without the notice that fits the rejection reason. Warning about everything cannot pass this. */
  unsafeAccept: Metric;
  /** In-scope photos that came back with a multiple-items or crop-unverified notice. */
  inScopeWarning: Metric;
  shoePairNotices: number;
  rejectionByReason: Array<{ reason: string; n: number; refused: number; acceptedWithFittingNotice: number; unsafeAccept: number; silentAccept: number; failed: number }>;
  crop: Metric & { meanIou: number | null };
  attributes: Record<Attribute, AttributeReport>;
  visibleMaterialRecall: Metric;
  suggestions: { seasons: Metric; occasions: Metric; note: string };
  reliability: { cases: number; failed: number; timeout: number; invalid: number; unverified: number; missing: number; failureRate: Metric };
  latency: { n: number; missing: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  metrics: Record<MetricId, Metric>;
};

const DISPOSITIONS: Disposition[] = ["accepted", "accepted_with_multiple_warning", "accepted_with_crop_warning", "refused_empty", "failed"];
const emptyDispositions = () => Object.fromEntries(DISPOSITIONS.map((d) => [d, 0])) as Record<Disposition, number>;

export function aggregateSplit(
  results: readonly CaseResult[],
  manifest: SingleManifest,
  gold: GoldFile | undefined,
): SplitReport {
  const inScope = results.filter((r) => r.stratum === "in_scope");
  const rejection = results.filter((r) => r.stratum === "rejection");
  const attributes = Object.fromEntries(ATTRIBUTES.map((a) => [a, attributeReport(inScope, a)])) as Record<Attribute, AttributeReport>;
  const dispositions = { in_scope: emptyDispositions(), rejection: emptyDispositions() };
  for (const r of results) dispositions[r.stratum][r.disposition]++;

  const selection = proportion(inScope.filter((r) => r.selected).length, inScope.length, "in-scope photos whose single returned item overlaps the gold item at the selection IoU");
  const falseRefusal = proportion(inScope.filter((r) => r.disposition === "refused_empty").length, inScope.length, "in-scope photos where the app returned no item");
  const falseAccept = proportion(rejection.filter((r) => r.disposition === "accepted").length, rejection.length, "rejection photos accepted as a clean single item without any notice");
  const unsafe = proportion(rejection.filter((r) => r.unsafeAccept).length, rejection.length, "rejection photos where an item came back without the notice that fits the rejection reason (silent, crop-only, or a multiple-items notice on another kind of rejection)");
  const inScopeWarning = proportion(inScope.filter((r) => r.warned).length, inScope.length, "in-scope photos that came back with a multiple-items or crop-unverified notice");
  const reasons = [...new Set(rejection.map((r) => r.rejectionReason ?? "none"))].sort();
  const rejectionByReason = reasons.map((reason) => {
    const rows = rejection.filter((r) => (r.rejectionReason ?? "none") === reason);
    return {
      reason,
      n: rows.length,
      refused: rows.filter((r) => r.disposition === "refused_empty").length,
      acceptedWithFittingNotice: rows.filter((r) => r.disposition === "accepted_with_multiple_warning" && !r.unsafeAccept).length,
      unsafeAccept: rows.filter((r) => r.unsafeAccept).length,
      silentAccept: rows.filter((r) => r.disposition === "accepted").length,
      failed: rows.filter((r) => r.disposition === "failed").length,
    };
  });
  const ious = inScope.map((r) => r.iou).filter((v): v is number => v !== null);
  const crop = { ...proportion(inScope.filter((r) => r.cropUseful).length, inScope.length, "IoU and coverage of the gold box both meet the policy; no box or an unusable box is not useful"), meanIou: ious.length ? r6(ious.reduce((s, v) => s + v, 0) / ious.length) : null };

  const visibleRows = inScope.flatMap((r) => (r.attributes && (VISIBLE_MATERIALS as readonly string[]).includes(r.attributes.material.gold as GoldMaterial) ? [r.attributes.material] : []));
  const visibleMaterialRecall = proportion(visibleRows.filter((x) => x.state === "correct").length, visibleRows.length, "gold has a visible texture and the model named the same one");

  const seasons = inScope.map((r) => r.seasonsJaccard).filter((v): v is number => v !== null);
  const occasions = inScope.map((r) => r.occasionsJaccard).filter((v): v is number => v !== null);
  const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
  const suggestionNote = "Seasons and occasions are suggestions from one photo, not visible objective truth; mean Jaccard against a person's suggested sets, informational only.";

  const all = results.length;
  const count = (s: CaseStatus | "missing") => results.filter((r) => r.predictionStatus === s).length;
  const failedTotal = results.filter((r) => r.predictionStatus !== "completed").length;
  const failureRate = proportion(failedTotal, all, "failed, timeout, invalid, unverified and missing cases over all cases");

  const withTime = results.filter((r) => r.elapsedMs !== null).map((r) => r.elapsedMs as number);
  const missingTime = results.length - withTime.length;
  const latency = {
    n: withTime.length,
    missing: missingTime,
    p50Ms: missingTime === 0 ? percentile(withTime, 0.5) : null,
    p95Ms: missingTime === 0 ? percentile(withTime, 0.95) : null,
    maxMs: missingTime === 0 ? percentile(withTime, 1) : null,
  };
  const lat = (v: number | null) => point(v, withTime.length, missingTime ? `${missingTime} case(s) have no recorded duration; latency is not evaluated` : "nearest-rank percentile over every case that ran or timed out");

  const metrics: Record<MetricId, Metric> = {
    "selection.rate": selection,
    "refusal.falseAcceptRate": falseAccept,
    "refusal.unsafeAcceptRate": unsafe,
    "inScope.warningRate": inScopeWarning,
    "inScope.falseRefusalRate": falseRefusal,
    "reliability.failureRate": failureRate,
    "category.accuracyOnAnswered": attributes.category.accuracyOnAnswered,
    "category.coverage": attributes.category.coverage,
    "category.macroF1": attributes.category.macroF1,
    "color.accuracyOnAnswered": attributes.color.accuracyOnAnswered,
    "color.coverage": attributes.color.coverage,
    "color.macroF1": attributes.color.macroF1,
    "pattern.accuracyOnAnswered": attributes.pattern.accuracyOnAnswered,
    "pattern.coverage": attributes.pattern.coverage,
    "pattern.macroF1": attributes.pattern.macroF1,
    "fit.accuracyOnAnswered": attributes.fit.accuracyOnAnswered,
    "fit.coverage": attributes.fit.coverage,
    "material.accuracyOnAnswered": attributes.material.accuracyOnAnswered,
    "material.coverage": attributes.material.coverage,
    "material.visibleMaterialRecall": visibleMaterialRecall,
    "crop.usefulRate": crop,
    "latency.p50Ms": lat(latency.p50Ms),
    "latency.p95Ms": lat(latency.p95Ms),
    "latency.maxMs": lat(latency.maxMs),
    "suggestions.seasons.meanJaccard": point(mean(seasons), seasons.length, suggestionNote),
    "suggestions.occasions.meanJaccard": point(mean(occasions), occasions.length, suggestionNote),
  };

  return {
    counts: { fixtures: manifest.fixtures.length, inScope: inScope.length, rejection: rejection.length, predicted: all - count("missing"), missing: count("missing") },
    strata: strataCounts(manifest, gold),
    dispositions,
    selection,
    falseRefusal,
    falseAccept,
    unsafeAccept: unsafe,
    inScopeWarning,
    shoePairNotices: results.filter((r) => r.shoePairNotice).length,
    rejectionByReason,
    crop,
    attributes,
    visibleMaterialRecall,
    suggestions: { seasons: metrics["suggestions.seasons.meanJaccard"], occasions: metrics["suggestions.occasions.meanJaccard"], note: suggestionNote },
    reliability: { cases: all, failed: count("failed"), timeout: count("timeout"), invalid: count("invalid"), unverified: count("unverified"), missing: count("missing"), failureRate },
    latency,
    metrics,
  };
}

// ----------------------------------------------------------------------------- gate

export type GateStatus = "PASS" | "FAIL" | "NOT_EVALUATED";
export type GateCheck = {
  id: string;
  metric: MetricId;
  kind: GateRule["kind"];
  comparator: GateRule["comparator"];
  threshold: number;
  bound: GateRule["bound"];
  minN: number;
  n: number;
  observed: number | null;
  status: GateStatus;
  detail: string;
};

/** A policy validated with relaxed sample checks is for synthetic tests: it can never produce a verdict, only per-check statuses. */
export const RELAXED_PRECONDITION =
  "the policy was validated with relaxed sample-size checks (synthetic use only); no launch verdict is given, read the per-check statuses";

export type GateReport = { verdict: GateStatus; preconditions: string[]; checks: GateCheck[] };

function evaluateRule(rule: GateRule, m: Metric | undefined): GateCheck {
  const base = { id: rule.id, metric: rule.metric, kind: rule.kind, comparator: rule.comparator, threshold: rule.threshold, bound: rule.bound, minN: rule.minN };
  const notEvaluated = (n: number, detail: string): GateCheck => ({ ...base, n, observed: null, status: "NOT_EVALUATED", detail });
  if (!m || m.value === null) return notEvaluated(m?.n ?? 0, m?.detail ?? "metric is not available");
  if (m.n < rule.minN) return notEvaluated(m.n, `${m.n} observations, rule needs at least ${rule.minN}`);
  const observed = rule.bound === "point" ? m.value : rule.bound === "wilson95_lower" ? m.lower : m.upper;
  if (observed === null) return notEvaluated(m.n, `metric has no ${rule.bound} bound`);
  const pass = rule.comparator === ">=" ? observed >= rule.threshold : observed <= rule.threshold;
  return { ...base, n: m.n, observed, status: pass ? "PASS" : "FAIL", detail: `${rule.bound} ${observed} ${rule.comparator} ${rule.threshold}` };
}

/**
 * The launch gate. It looks at the HELD-OUT split only. Preconditions that are
 * not met (unapproved policy, no held-out predictions, strata below the policy
 * minimums) make the verdict NOT_EVALUATED regardless of the numbers: the sample
 * is then not valid evidence. Otherwise any failing gate rule is FAIL, any gate
 * rule without enough data is NOT_EVALUATED, and only all-passing is PASS.
 */
export function launchGate(policy: LaunchPolicy, heldout: SplitReport | null, manifest: SingleManifest | undefined, gold: GoldFile | undefined, relaxedSampleChecks = false): GateReport {
  const preconditions: string[] = [];
  if (relaxedSampleChecks) preconditions.push(RELAXED_PRECONDITION);
  if (!policy.approval) preconditions.push(`policy ${policy.id}@${policy.version} has no approval record; it is a proposal, so no launch decision can be made from it`);
  if (!heldout) preconditions.push("no held-out predictions were scored");
  preconditions.push(...strataProblems(manifest, gold, policy));
  const checks = policy.rules.map((r) => evaluateRule(r, heldout?.metrics[r.metric]));
  const gates = checks.filter((c) => c.kind === "gate");
  let verdict: GateStatus;
  if (preconditions.length > 0) verdict = "NOT_EVALUATED";
  else if (gates.some((c) => c.status === "FAIL")) verdict = "FAIL";
  else if (gates.some((c) => c.status === "NOT_EVALUATED")) verdict = "NOT_EVALUATED";
  else verdict = "PASS";
  return { verdict, preconditions, checks };
}

// ----------------------------------------------------------------------------- evaluation

export const SINGLE_REPORT_STATEMENTS: readonly string[] = [
  "This report measures one run against the supplied labels. It is not a claim that photo recognition works.",
  "A PASS verdict, if any, is only as good as the rights, labels, split history and policy that were supplied; the harness refuses contradictions but cannot prove them.",
  "The model's self-reported confidence is recorded but never used as correctness.",
  "Seasons and occasions are suggestions, not visible objective truth, and never decide the verdict.",
  "Crowded and multi-item recognition is out of scope for this gate.",
  "A policy approval binds to the policy content by digest; the harness cannot prove who approved it or that the approver understood it.",
];

export type SingleEvaluationInput = IntegrityInput & {
  policy: LaunchPolicy;
  /** Default: production checks. A caller (synthetic tests only) may relax the sample-size rules; the report says so. */
  policyChecks?: PolicyChecks;
  createdAt: string;
  inputDigests: Array<{ role: string; path: string; sha256: string }>;
};

export type SingleReport = {
  schemaVersion: 1;
  kind: "single-item-report";
  createdAt: string;
  policy: {
    id: string;
    version: string;
    approved: boolean;
    /** The approval names this exact content (always true here: a mismatch is refused). */
    approvalBoundToContent: boolean;
    /** sha256 of the canonical policy content without the approval; what an approval binds to. */
    contentSha256: string;
    /** sha256 of the canonical whole document, approval included. */
    documentSha256: string;
    validation: "production" | "relaxed-sample-checks";
  };
  /** What the cross-file checks covered. A held-out score is refused unless both splits were checked together. */
  integrity: { splitsChecked: Split[]; crossSplitLeakageChecked: boolean; leakageKeys: readonly string[]; developmentFixtures: number; heldoutFixtures: number };
  inputDigests: SingleEvaluationInput["inputDigests"];
  run: NonNullable<IntegrityInput["predictions"]>["run"];
  splits: { development: SplitReport | null; heldout: SplitReport | null };
  gate: GateReport;
  cases: CaseResult[];
  statements: readonly string[];
};

export function evaluateSingle(input: SingleEvaluationInput): SingleReport {
  if (!input.predictions) throw new EvaluationRefusal(["no prediction report was supplied"]);
  const checks = input.policyChecks ?? PRODUCTION_CHECKS;
  const policyCheck = validatePolicy(input.policy, checks);
  if (policyCheck.problems.length > 0) throw new EvaluationRefusal(policyCheck.problems.map((p) => `policy ${input.policy?.id ?? "?"}: ${p}`));
  const problems = integrityProblems(input);
  if (problems.length > 0) throw new EvaluationRefusal(problems);
  const preds = new Map(input.predictions.cases.map((c) => [c.fixtureId, c]));
  const goldBySplit = new Map(input.gold.map((g) => [g.split, g]));
  const results: CaseResult[] = [];
  const splits: SingleReport["splits"] = { development: null, heldout: null };
  // Fixed split order, so the report does not depend on the order the files were passed.
  const ordered = [...input.manifests].sort((a, b) => (a.manifest.split < b.manifest.split ? -1 : a.manifest.split > b.manifest.split ? 1 : 0));
  for (const { manifest } of ordered) {
    const gold = goldBySplit.get(manifest.split);
    if (!gold || !manifest.fixtures.some((f) => preds.has(f.id))) continue; // nothing was run on this split
    const labels = new Map(gold.labels.map((l) => [l.imageId, l]));
    const rows = [...manifest.fixtures]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((f) => scoreCase(f, manifest.split, labels.get(f.id) as GoldLabel, preds.get(f.id) ?? null, input.policy));
    results.push(...rows);
    splits[manifest.split] = aggregateSplit(rows, manifest, gold);
  }
  const heldoutManifest = input.manifests.find((m) => m.manifest.split === "heldout")?.manifest;
  return {
    schemaVersion: 1,
    kind: "single-item-report",
    createdAt: input.createdAt,
    policy: {
      id: input.policy.id,
      version: input.policy.version,
      approved: input.policy.approval !== null,
      approvalBoundToContent: input.policy.approval !== null,
      contentSha256: policyContentSha256(input.policy),
      documentSha256: policyDocumentSha256(input.policy),
      validation: checks.relaxedSampleChecks ? "relaxed-sample-checks" : "production",
    },
    integrity: {
      splitsChecked: input.manifests.map((m) => m.manifest.split).sort() as Split[],
      crossSplitLeakageChecked: input.manifests.length === 2,
      leakageKeys: LEAKAGE_KEYS,
      developmentFixtures: input.manifests.find((m) => m.manifest.split === "development")?.manifest.fixtures.length ?? 0,
      heldoutFixtures: heldoutManifest?.fixtures.length ?? 0,
    },
    inputDigests: input.inputDigests,
    run: input.predictions.run,
    splits,
    gate: launchGate(input.policy, splits.heldout, heldoutManifest, goldBySplit.get("heldout"), checks.relaxedSampleChecks),
    cases: results,
    statements: checks.relaxedSampleChecks
      ? [...SINGLE_REPORT_STATEMENTS, "The policy was validated with relaxed sample-size checks (synthetic use only); this report is not launch evidence."]
      : SINGLE_REPORT_STATEMENTS,
  };
}
