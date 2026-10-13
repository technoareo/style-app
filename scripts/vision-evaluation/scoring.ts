import type { FixtureAnnotation, GoldGarment } from "./annotations";
import { normalizeText } from "./check";
import { iou } from "./geometry";
import { maximumMatching } from "./matching";
import type { PredictionCase, PredictedItem } from "./predictions";
import { STRATA, type Split, type Stratum } from "./types";

/**
 * Pure scoring. No clock, no file, no randomness: the same inputs give the same
 * numbers. A ratio whose denominator is zero is null, never 1 and never 0.
 */

export type CaseFailure = "failed" | "timeout" | "truncated" | "invalid_output" | "missing";

type AttributeKey = "color" | "pattern";
export type AttributeTally = Record<
  AttributeKey,
  {
    /** Human-labelled gold values over ALL gold garments, failed and missing cases included. */
    goldLabelledTotal: number;
    /** Of those, on garments matched geometrically. correct/wrong/notPredicted are conditional on this. */
    matchedGoldLabelled: number;
    correct: number;
    wrong: number;
    notPredicted: number;
  }
>;

export type CaseScore = {
  fixtureId: string;
  split: Split;
  stratum: Stratum;
  outcome: "scored" | "failed";
  failure: CaseFailure | null;
  failureDetail: string | null;
  goldCount: number;
  emptyTruth: boolean;
  /** Valid predictions used for scoring (0 for a failed case: nothing is salvaged). */
  predictedCount: number;
  rawCount: number;
  invalidCount: number;
  tp: number;
  fp: number;
  fn: number;
  /** Unmatched predictions that overlap a gold item already matched to another prediction. */
  duplicateFp: number;
  otherFp: number;
  /** Among geometry matches, category agreement; geometry is scored without looking at category. */
  categoryCorrect: number;
  categoryWrong: number;
  confusion: Record<string, number>;
  /** predicted minus gold; null for a failed case. */
  countError: number | null;
  matches: Array<{ goldId: string; predictionIndex: number; iou: number; categoryCorrect: boolean }>;
  elapsedMs: number | null;
  attributes: AttributeTally;
};

const ATTRIBUTE_KEYS: readonly AttributeKey[] = ["color", "pattern"];

const emptyAttributes = (gold: readonly GoldGarment[] = []): AttributeTally => {
  const tally = (k: AttributeKey) => ({
    goldLabelledTotal: gold.filter((g) => (g.attributes?.[k] ?? null) !== null).length,
    matchedGoldLabelled: 0,
    correct: 0,
    wrong: 0,
    notPredicted: 0,
  });
  return { color: tally("color"), pattern: tally("pattern") };
};

function compareBoxes(a: PredictedItem, b: PredictedItem): number {
  for (let k = 0; k < 4; k++) if (a.box[k] !== b.box[k]) return a.box[k] - b.box[k];
  return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
}

export function scoreCase(args: {
  fixtureId: string;
  split: Split;
  stratum: Stratum;
  annotation: FixtureAnnotation;
  prediction: PredictionCase | undefined;
  iouThreshold: number;
}): CaseScore {
  const { fixtureId, split, stratum, annotation, prediction, iouThreshold } = args;
  const gold = [...annotation.garments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const base = {
    fixtureId,
    split,
    stratum,
    goldCount: gold.length,
    emptyTruth: annotation.emptyTruth === true,
    elapsedMs: prediction?.elapsedMs ?? null,
  };

  let failure: CaseFailure | null = null;
  let detail: string | null = null;
  if (!prediction) {
    failure = "missing";
    detail = "no prediction was supplied for this fixture";
  } else if (prediction.status !== "completed") {
    failure = prediction.status;
    detail = prediction.error;
  } else if (prediction.invalidCount > 0) {
    failure = "invalid_output";
    detail = `${prediction.invalidCount} of ${prediction.rawCount} items failed strict validation; no item of this case was used`;
  }
  if (failure !== null) {
    return {
      ...base,
      outcome: "failed",
      failure,
      failureDetail: detail,
      predictedCount: 0,
      rawCount: prediction?.rawCount ?? 0,
      invalidCount: prediction?.invalidCount ?? 0,
      tp: 0,
      fp: 0,
      fn: gold.length,
      duplicateFp: 0,
      otherFp: 0,
      categoryCorrect: 0,
      categoryWrong: 0,
      confusion: {},
      countError: null,
      matches: [],
      attributes: emptyAttributes(gold),
    };
  }

  // prediction is defined and completed with no invalid item here.
  const done = prediction as PredictionCase;
  const preds = done.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareBoxes(a.item, b.item) || a.index - b.index);
  const pairs = maximumMatching(
    gold.map((g) => g.box),
    preds.map((p) => p.item.box),
    iouThreshold,
  );

  const goldMatched = new Set(pairs.map((p) => p.gold));
  const predMatched = new Set(pairs.map((p) => p.pred));
  let duplicateFp = 0;
  let otherFp = 0;
  preds.forEach((p, pi) => {
    if (predMatched.has(pi)) return;
    const repeatsMatchedGold = gold.some((g, gi) => goldMatched.has(gi) && iou(g.box, p.item.box) >= iouThreshold);
    if (repeatsMatchedGold) duplicateFp++;
    else otherFp++;
  });

  let categoryCorrect = 0;
  let categoryWrong = 0;
  const confusion: Record<string, number> = {};
  const attributes = emptyAttributes(gold);
  const matches = pairs.map((pair) => {
    const g = gold[pair.gold];
    const p = preds[pair.pred];
    const same = g.category === p.item.category;
    if (same) categoryCorrect++;
    else categoryWrong++;
    const key = `${g.category}->${p.item.category}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
    for (const k of ATTRIBUTE_KEYS) {
      const want = g.attributes?.[k] ?? null;
      if (want === null) continue; // never scored without an independent human label
      const tally = attributes[k];
      tally.matchedGoldLabelled++;
      const got = p.item.attributes?.[k] ?? null;
      if (got === null) tally.notPredicted++;
      else if (normalizeText(got) === normalizeText(want)) tally.correct++;
      else tally.wrong++;
    }
    return { goldId: g.id, predictionIndex: p.index, iou: pair.iou, categoryCorrect: same };
  });

  return {
    ...base,
    outcome: "scored",
    failure: null,
    failureDetail: null,
    predictedCount: preds.length,
    rawCount: done.rawCount,
    invalidCount: 0,
    tp: pairs.length,
    fp: preds.length - pairs.length,
    fn: gold.length - pairs.length,
    duplicateFp,
    otherFp,
    categoryCorrect,
    categoryWrong,
    confusion: Object.fromEntries(Object.entries(confusion).sort(([a], [b]) => (a < b ? -1 : 1))),
    countError: preds.length - gold.length,
    matches,
    attributes,
  };
}

// ---------------------------------------------------------------- aggregation

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export type Aggregate = {
  images: {
    total: number;
    scored: number;
    failed: number;
    failuresByKind: Record<CaseFailure, number>;
    emptyTruthImages: number;
    emptyTruthCorrect: number;
    emptyTruthFalseAlarms: number;
    emptyTruthFailed: number;
    exactCountImages: number;
    allGoldFoundImages: number;
  };
  items: {
    gold: number;
    predicted: number;
    rawPredictions: number;
    invalidPredictions: number;
    tp: number;
    fp: number;
    fn: number;
    duplicateFp: number;
    otherFp: number;
    categoryCorrect: number;
    categoryWrong: number;
  };
  /** Item-pooled (micro) detection; null where the denominator is zero. */
  detection: { precision: number | null; recall: number | null; f1: number | null };
  /** CONDITIONAL on a geometry match: correct / matched. Failed and unmatched gold are not in this denominator. */
  categoryAccuracyGivenGeometryMatch: number | null;
  /** NOT conditional: category-correct matches / all gold garments, so failures and misses count against it. */
  categoryCorrectOfAllGold: number | null;
  /**
   * Per-image averages. macroRecall counts a failed image as 0. macroPrecision is
   * over SCORED images with at least one prediction only (a failed image has no
   * precision; it is never counted as perfect, and it is listed in
   * precisionUndefinedImages together with scored images that predicted nothing).
   */
  perImage: {
    macroRecall: number | null;
    macroPrecision: number | null;
    precisionUndefinedImages: number;
    failedImages: number;
  };
  countError: {
    scoredMeanAbsolute: number | null;
    scoredMeanSigned: number | null;
    /** Failed images are treated as predicting 0 items, so they cannot look good. */
    allImagesMeanAbsolute: number | null;
  };
  latencyMs: { n: number; mean: number | null; max: number | null };
  attributes: AttributeTally;
};

export function aggregate(cases: readonly CaseScore[]): Aggregate {
  const failuresByKind: Record<CaseFailure, number> = { failed: 0, timeout: 0, truncated: 0, invalid_output: 0, missing: 0 };
  const attributes = emptyAttributes();
  const sum = { gold: 0, predicted: 0, raw: 0, invalid: 0, tp: 0, fp: 0, fn: 0, dup: 0, other: 0, cc: 0, cw: 0 };
  let scored = 0;
  let emptyTruthImages = 0;
  let emptyTruthCorrect = 0;
  let emptyTruthFalseAlarms = 0;
  let emptyTruthFailed = 0;
  let exactCount = 0;
  let allGold = 0;
  const recalls: number[] = [];
  const precisions: number[] = [];
  let undefinedPrecision = 0;
  const abs: number[] = [];
  const signed: number[] = [];
  const absAll: number[] = [];
  const latencies: number[] = [];

  for (const c of cases) {
    sum.gold += c.goldCount;
    sum.predicted += c.predictedCount;
    sum.raw += c.rawCount;
    sum.invalid += c.invalidCount;
    sum.tp += c.tp;
    sum.fp += c.fp;
    sum.fn += c.fn;
    sum.dup += c.duplicateFp;
    sum.other += c.otherFp;
    sum.cc += c.categoryCorrect;
    sum.cw += c.categoryWrong;
    for (const k of ATTRIBUTE_KEYS) {
      attributes[k].goldLabelledTotal += c.attributes[k].goldLabelledTotal;
      attributes[k].matchedGoldLabelled += c.attributes[k].matchedGoldLabelled;
      attributes[k].correct += c.attributes[k].correct;
      attributes[k].wrong += c.attributes[k].wrong;
      attributes[k].notPredicted += c.attributes[k].notPredicted;
    }
    if (c.elapsedMs !== null) latencies.push(c.elapsedMs);
    if (c.emptyTruth) emptyTruthImages++;
    absAll.push(c.countError === null ? c.goldCount : Math.abs(c.countError));

    if (c.outcome === "failed") {
      if (c.failure) failuresByKind[c.failure]++;
      if (c.emptyTruth) emptyTruthFailed++;
      if (c.goldCount > 0) recalls.push(0);
      undefinedPrecision++;
      continue;
    }
    scored++;
    abs.push(Math.abs(c.countError ?? 0));
    signed.push(c.countError ?? 0);
    if (c.emptyTruth) {
      if (c.predictedCount === 0) emptyTruthCorrect++;
      else emptyTruthFalseAlarms++;
    }
    if (c.predictedCount === c.goldCount) exactCount++;
    if (c.goldCount > 0 && c.fn === 0) allGold++;
    if (c.goldCount > 0) recalls.push(c.tp / c.goldCount);
    if (c.predictedCount > 0) precisions.push(c.tp / c.predictedCount);
    else undefinedPrecision++;
  }

  return {
    images: {
      total: cases.length,
      scored,
      failed: cases.length - scored,
      failuresByKind,
      emptyTruthImages,
      emptyTruthCorrect,
      emptyTruthFalseAlarms,
      emptyTruthFailed,
      exactCountImages: exactCount,
      allGoldFoundImages: allGold,
    },
    items: {
      gold: sum.gold,
      predicted: sum.predicted,
      rawPredictions: sum.raw,
      invalidPredictions: sum.invalid,
      tp: sum.tp,
      fp: sum.fp,
      fn: sum.fn,
      duplicateFp: sum.dup,
      otherFp: sum.other,
      categoryCorrect: sum.cc,
      categoryWrong: sum.cw,
    },
    detection: {
      precision: ratio(sum.tp, sum.tp + sum.fp),
      recall: ratio(sum.tp, sum.tp + sum.fn),
      f1: ratio(2 * sum.tp, 2 * sum.tp + sum.fp + sum.fn),
    },
    categoryAccuracyGivenGeometryMatch: ratio(sum.cc, sum.cc + sum.cw),
    categoryCorrectOfAllGold: ratio(sum.cc, sum.gold),
    perImage: {
      macroRecall: mean(recalls),
      macroPrecision: mean(precisions),
      precisionUndefinedImages: undefinedPrecision,
      failedImages: cases.length - scored,
    },
    countError: { scoredMeanAbsolute: mean(abs), scoredMeanSigned: mean(signed), allImagesMeanAbsolute: mean(absAll) },
    latencyMs: { n: latencies.length, mean: mean(latencies), max: latencies.length ? Math.max(...latencies) : null },
    attributes,
  };
}

export type Section = { overall: Aggregate; byStratum: Record<Stratum, Aggregate | null> };

/** Development and held-out are always reported apart; a split with no case is null, not zeros. */
export function aggregateSections(cases: readonly CaseScore[]): Record<Split, Section | null> {
  return {
    development: section(cases.filter((c) => c.split === "development")),
    heldout: section(cases.filter((c) => c.split === "heldout")),
  };
}

export function section(cases: readonly CaseScore[]): Section | null {
  if (cases.length === 0) return null;
  const byStratum = {} as Record<Stratum, Aggregate | null>;
  for (const s of STRATA) {
    const subset = cases.filter((c) => c.stratum === s);
    byStratum[s] = subset.length ? aggregate(subset) : null;
  }
  return { overall: aggregate(cases), byStratum };
}
