import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  classifyItems,
  nativeCornersItem,
  parseStrictJson,
  qwenCompactCornersAdapter,
  qwenCompactCornersRun,
  type RecognitionAdapter,
} from "../scripts/vision-evaluation/adapters";
import {
  annotationProblemsForManifest,
  goldProblems,
  validateAnnotationFile,
  type AnnotationFile,
  type FixtureAnnotation,
  type GoldGarment,
} from "../scripts/vision-evaluation/annotations";
import { runCli } from "../scripts/vision-evaluation/cli";
import {
  EvaluationRefusal,
  evaluate,
  writeNewJson,
  type EvaluationInput,
  type ImageResolver,
} from "../scripts/vision-evaluation/evaluate";
import { boxProblems, iou } from "../scripts/vision-evaluation/geometry";
import { inspectImageBytes, sha256Hex } from "../scripts/vision-evaluation/image";
import { maximumMatching } from "../scripts/vision-evaluation/matching";
import {
  KNOWN_DEVELOPMENT_SHA256,
  crossManifestProblems,
  validateManifest,
  type Fixture,
  type Manifest,
} from "../scripts/vision-evaluation/manifest";
import {
  validatePredictionReport,
  type PredictionCase,
  type PredictionReport,
} from "../scripts/vision-evaluation/predictions";
import { aggregate, scoreCase, type CaseScore } from "../scripts/vision-evaluation/scoring";
import type { Box, Category, Dimensions, Split } from "../scripts/vision-evaluation/types";
import { makeTempDir, removeTempDir } from "./helpers/tempDir";

/**
 * Tests of the OFFLINE recognition evaluation harness. All images, labels and
 * predictions below are SYNTHETIC test data written in this file; none of it is
 * a measurement of any model, and nothing here claims recognition works.
 */

const root = process.cwd();
const DIMS: Dimensions = { width: 640, height: 480, exifOrientation: 1 };
const FROZEN = "2026-10-12T00:00:00Z";
const AFTER_FREEZE = "2026-10-12T05:00:00Z";
const hashFor = (id: string) => sha256Hex(Buffer.from(`synthetic-image-${id}`));

// ------------------------------------------------------------------ builders

function fixture(id: string, over: Partial<Fixture> = {}): Fixture {
  return {
    id,
    file: `${id}.jpg`,
    sha256: hashFor(id),
    originalDimensions: DIMS,
    source: { url: `https://example.test/${id}`, author: "synthetic", license: "CC0 1.0", licenseUrl: null, retrievedAt: "2026-10-12" },
    stratum: "single_item",
    priorInference: false,
    notes: null,
    ...over,
  };
}

function manifest(split: Split, fixtures: Fixture[]): Manifest {
  return {
    schemaVersion: 1,
    kind: "fixture-manifest",
    split,
    splitFrozenAt: split === "heldout" ? FROZEN : null,
    purpose: "synthetic test manifest",
    fixtures,
  };
}

function garment(id: string, category: Category, box: Box, over: Partial<GoldGarment> = {}): GoldGarment {
  return { id, category, box, visibility: "fully_visible", truncatedByFrame: false, attributes: null, ...over };
}

function annotation(fixtureId: string, split: Split, garments: GoldGarment[], over: Partial<FixtureAnnotation> = {}): FixtureAnnotation {
  return {
    fixtureId,
    sha256: hashFor(fixtureId),
    split,
    labelStatus: "single_human",
    annotators: [{ id: "annotator-a", kind: "human" }],
    completedAt: "2026-10-12T01:00:00Z",
    emptyTruth: garments.length === 0,
    garments,
    notes: null,
    ...over,
  };
}

const annotationFile = (split: Split, annotations: FixtureAnnotation[]): AnnotationFile => ({
  schemaVersion: 1,
  kind: "annotations",
  split,
  annotations,
});

type Spec = { c: Category; b: Box };
function predicted(fixtureId: string, specs: Spec[], over: Partial<PredictionCase> = {}): PredictionCase {
  return {
    fixtureId,
    imageSha256: hashFor(fixtureId),
    status: "completed",
    elapsedMs: 100,
    firstContentMs: 10,
    error: null,
    rawCount: specs.length,
    invalidCount: 0,
    items: specs.map((s) => ({ category: s.c, box: s.b, attributes: null })),
    invalidReasons: [],
    ...over,
  };
}

const failedCase = (fixtureId: string, status: "failed" | "timeout" | "truncated"): PredictionCase =>
  predicted(fixtureId, [], { status, error: `synthetic ${status}`, rawCount: 0 });

function predictionReport(cases: PredictionCase[], startedAt: string | null = AFTER_FREEZE): PredictionReport {
  return {
    schemaVersion: 1,
    kind: "predictions",
    run: {
      model: "synthetic-model",
      modelVersion: "unrecorded",
      prompt: { id: "synthetic-prompt", sha256: null },
      strategy: "synthetic",
      adapter: "test",
      startedAt,
      timeoutMs: null,
      imageHashSource: "computed-by-runner",
      notes: null,
    },
    cases,
  };
}

const resolver: ImageResolver = (f) => ({ sha256: hashFor(f.id), dimensions: DIMS });

const FULL: Box = [0, 0, 0.5, 0.5];

function input(over: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    manifests: [manifest("development", [fixture("a")])],
    annotationFiles: [annotationFile("development", [annotation("a", "development", [garment("g1", "top", FULL)])])],
    predictions: predictionReport([predicted("a", [{ c: "top", b: FULL }])]),
    images: resolver,
    iouThreshold: 0.5,
    createdAt: "2026-10-12T06:00:00Z",
    inputDigests: [],
    ...over,
  };
}

function refused(over: Partial<EvaluationInput>, pattern: RegExp): void {
  assert.throws(
    () => evaluate(input(over)),
    (e: unknown) => e instanceof EvaluationRefusal && pattern.test(e.message),
    `expected a refusal matching ${pattern}`,
  );
}

const score = (gold: GoldGarment[], specs: Spec[], over: Partial<PredictionCase> = {}, threshold = 0.5): CaseScore =>
  scoreCase({
    fixtureId: "a",
    split: "development",
    stratum: gold.length === 0 ? "no_garment" : gold.length === 1 ? "single_item" : "crowded",
    annotation: annotation("a", "development", gold),
    prediction: predicted("a", specs, over),
    iouThreshold: threshold,
  });

// --------------------------------------------------------- geometry validation

test("boxes that are non-finite, mis-sized, out of range, reversed or zero-size are rejected, never repaired", () => {
  const bad: unknown[] = [
    [0, 0, 1],
    [0, 0, 1, 1, 1],
    [Number.NaN, 0, 1, 1],
    [0, 0, Number.POSITIVE_INFINITY, 1],
    ["0", 0, 1, 1],
    [-0.1, 0, 1, 1],
    [0, 0, 1.1, 1],
    [0.5, 0, 0.5, 1],
    [0.6, 0, 0.5, 1],
    [0, 0.5, 1, 0.5],
    [0, 0.7, 1, 0.2],
    null,
    "box",
    {},
  ];
  for (const box of bad) assert.ok(boxProblems(box).length > 0, JSON.stringify(box));
  assert.deepEqual(boxProblems([0, 0, 1, 1]), []);
  assert.match(boxProblems([0, 0, 1.1, 1]).join(), /nothing is clipped/);
});

test("IoU is exact for identical, half-overlapping, touching and disjoint boxes", () => {
  assert.equal(iou([0, 0, 1, 1], [0, 0, 1, 1]), 1);
  assert.equal(iou([0, 0, 1, 1], [0, 0, 0.5, 1]), 0.5);
  assert.equal(iou([0, 0, 0.5, 1], [0.5, 0, 1, 1]), 0);
  assert.equal(iou([0, 0, 0.2, 0.2], [0.6, 0.6, 0.9, 0.9]), 0);
});

test("native 0..1000 corner items are validated exactly; the only change is division by the declared scale", () => {
  const ok = nativeCornersItem({ c: "top", b: [0, 250, 1000, 500] }, 1000);
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.item.box, [0, 0.25, 1, 0.5]);
  const rejected: unknown[] = [
    { c: "top", b: [970, 435, 104, 999] }, // reversed: the real item 14 of the saved Qwen record
    { c: "top", b: [10, 10, 1001, 20] },
    { c: "top", b: [1.5, 0, 10, 10] },
    { c: "top", b: [0, 0, 10] },
    { c: "top", b: [10, 10, 10, 20] },
    { c: "hat", b: [0, 0, 10, 10] },
    { c: "top", b: [0, 0, 10, 10], extra: 1 },
    { b: [0, 0, 10, 10] },
    "top",
    null,
  ];
  for (const raw of rejected) assert.equal(nativeCornersItem(raw, 1000).ok, false, JSON.stringify(raw));
});

// ------------------------------------------------------------------- matching

test("maximum matching beats greedy best-IoU-first on a known counterexample", () => {
  const gold: Box[] = [
    [0, 0, 0.5, 1], // A
    [0.2, 0, 0.7, 1], // B
  ];
  const pred: Box[] = [
    [0.08, 0, 0.58, 1], // P1: IoU .724 with A, .613 with B
    [0, 0, 0.3, 1], // P2: IoU .6 with A, .143 with B
  ];
  const edges: Array<{ g: number; p: number; v: number }> = [];
  gold.forEach((g, gi) => pred.forEach((p, pi) => iou(g, p) >= 0.5 && edges.push({ g: gi, p: pi, v: iou(g, p) })));
  edges.sort((x, y) => y.v - x.v);
  const usedG = new Set<number>();
  const usedP = new Set<number>();
  let greedy = 0;
  for (const e of edges)
    if (!usedG.has(e.g) && !usedP.has(e.p)) {
      usedG.add(e.g);
      usedP.add(e.p);
      greedy++;
    }
  assert.equal(greedy, 1, "the counterexample must actually fool greedy matching");
  const pairs = maximumMatching(gold, pred, 0.5);
  assert.equal(pairs.length, 2);
  assert.deepEqual(
    pairs.map((p) => [p.gold, p.pred]),
    [
      [0, 1],
      [1, 0],
    ],
  );
});

test("matching is one-to-one, inclusive at the threshold, and prefers the larger total IoU at equal size", () => {
  assert.equal(maximumMatching([FULL], [FULL, FULL], 0.5).length, 1);
  assert.equal(maximumMatching([[0, 0, 1, 1]], [[0, 0, 0.5, 1]], 0.5).length, 1);
  assert.equal(maximumMatching([[0, 0, 1, 1]], [[0, 0, 0.5, 1]], 0.51).length, 0);
  assert.deepEqual(maximumMatching([], [FULL], 0.5), []);
  assert.deepEqual(maximumMatching([FULL], [], 0.5), []);
  const gold: Box[] = [
    [0, 0, 0.6, 1],
    [0.4, 0, 1, 1],
  ];
  const diagonal = maximumMatching(gold, [gold[0], gold[1]], 0.1);
  assert.deepEqual(diagonal.map((p) => [p.gold, p.pred]), [[0, 0], [1, 1]]);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => maximumMatching([FULL], [FULL], bad), RangeError);
});

// -------------------------------------------------------------------- scoring

test("category disagreement is reported apart from geometry", () => {
  const s = score([garment("g1", "top", FULL)], [{ c: "bottom", b: FULL }]);
  assert.deepEqual([s.tp, s.fp, s.fn], [1, 0, 0]);
  assert.deepEqual([s.categoryCorrect, s.categoryWrong], [0, 1]);
  assert.deepEqual(s.confusion, { "top->bottom": 1 });
  const agg = aggregate([s]);
  assert.equal(agg.detection.precision, 1);
  assert.equal(agg.categoryAccuracyGivenGeometryMatch, 0);
  assert.equal(agg.categoryCorrectOfAllGold, 0);
});

test("a duplicate box is a duplicate false positive; a far box is another false positive", () => {
  const dup = score([garment("g1", "top", FULL)], [
    { c: "top", b: FULL },
    { c: "top", b: FULL },
  ]);
  assert.deepEqual([dup.tp, dup.fp, dup.duplicateFp, dup.otherFp], [1, 1, 1, 0]);
  const far = score([garment("g1", "top", FULL)], [
    { c: "top", b: FULL },
    { c: "top", b: [0.6, 0.6, 0.9, 0.9] },
  ]);
  assert.deepEqual([far.tp, far.fp, far.duplicateFp, far.otherFp], [1, 1, 0, 1]);
  assert.equal(far.countError, 1);
});

test("empty truth and empty prediction is explicit agreement, not a perfect precision/recall", () => {
  const agree = score([], []);
  assert.equal(agree.emptyTruth, true);
  const a = aggregate([agree]);
  assert.deepEqual([a.detection.precision, a.detection.recall, a.detection.f1], [null, null, null]);
  assert.deepEqual([a.images.emptyTruthImages, a.images.emptyTruthCorrect, a.images.emptyTruthFalseAlarms], [1, 1, 0]);
  assert.equal(a.images.exactCountImages, 1);
  assert.equal(a.perImage.precisionUndefinedImages, 1);
  assert.equal(a.perImage.macroPrecision, null);
  const alarm = aggregate([score([], [{ c: "top", b: FULL }])]);
  assert.deepEqual([alarm.images.emptyTruthFalseAlarms, alarm.detection.precision], [1, 0]);
  const missed = aggregate([score([garment("g1", "top", FULL)], [])]);
  assert.deepEqual([missed.detection.recall, missed.detection.precision], [0, null]);
});

test("attributes count only against human gold and only on matched garments", () => {
  const gold = [garment("g1", "top", FULL, { attributes: { color: "Red", pattern: null } })];
  const hit = score(gold, []).attributes; // no prediction: nothing matched, nothing scored
  assert.equal(hit.color.matchedGoldLabelled, 0);
  const withColor = scoreCase({
    fixtureId: "a",
    split: "development",
    stratum: "single_item",
    annotation: annotation("a", "development", gold),
    prediction: predicted("a", [], {
      items: [{ category: "top", box: FULL, attributes: { color: " red ", pattern: "striped" } }],
      rawCount: 1,
    }),
    iouThreshold: 0.5,
  });
  assert.deepEqual(withColor.attributes.color, { goldLabelledTotal: 1, matchedGoldLabelled: 1, correct: 1, wrong: 0, notPredicted: 0 });
  assert.equal(withColor.attributes.pattern.matchedGoldLabelled, 0, "an unlabelled gold attribute is never scored");
  assert.equal(hit.color.goldLabelledTotal, 1, "an unmatched labelled gold attribute still counts in the coverage denominator");
  const failedWithGold = scoreCase({
    fixtureId: "a",
    split: "development",
    stratum: "single_item",
    annotation: annotation("a", "development", gold),
    prediction: failedCase("a", "timeout"),
    iouThreshold: 0.5,
  });
  const agg = aggregate([withColor, failedWithGold]);
  assert.deepEqual([agg.attributes.color.goldLabelledTotal, agg.attributes.color.matchedGoldLabelled, agg.attributes.color.correct], [2, 1, 1]);
});

test("failed, timed-out, truncated, invalid and missing cases stay in the denominators", () => {
  const good = score([garment("g1", "top", FULL)], [{ c: "top", b: FULL }]);
  const kinds: Array<[PredictionCase | undefined, string]> = [
    [failedCase("a", "failed"), "failed"],
    [failedCase("a", "timeout"), "timeout"],
    [failedCase("a", "truncated"), "truncated"],
    [predicted("a", [{ c: "top", b: FULL }], { rawCount: 3, invalidCount: 2 }), "invalid_output"],
    [undefined, "missing"],
  ];
  for (const [prediction, kind] of kinds) {
    const bad = scoreCase({
      fixtureId: "a",
      split: "development",
      stratum: "single_item",
      annotation: annotation("a", "development", [garment("g1", "top", FULL)]),
      prediction,
      iouThreshold: 0.5,
    });
    assert.equal(bad.outcome, "failed", kind);
    assert.equal(bad.failure, kind);
    assert.deepEqual([bad.tp, bad.fp, bad.fn, bad.predictedCount], [0, 0, 1, 0], "no item of a failed case is salvaged");
    const agg = aggregate([good, bad]);
    assert.equal(agg.images.total, 2);
    assert.equal(agg.images.failed, 1);
    assert.equal(agg.detection.recall, 0.5);
    assert.equal(agg.perImage.macroRecall, 0.5);
    assert.equal(agg.perImage.macroPrecision, 1, "precision is over scored images only; the failure is shown beside it");
    assert.deepEqual([agg.perImage.failedImages, agg.perImage.precisionUndefinedImages], [1, 1]);
    assert.equal(agg.categoryCorrectOfAllGold, 0.5, "unconditional category correctness keeps the failure in its denominator");
    const onlyBad = aggregate([bad]);
    assert.equal(onlyBad.detection.precision, null, "no scored prediction: precision is null, never 1");
    assert.equal(onlyBad.perImage.macroPrecision, null);
    assert.equal(onlyBad.detection.recall, 0);
    assert.equal(agg.countError.allImagesMeanAbsolute, 0.5);
  }
  const invalid = scoreCase({
    fixtureId: "a",
    split: "development",
    stratum: "single_item",
    annotation: annotation("a", "development", [garment("g1", "top", FULL)]),
    prediction: predicted("a", [{ c: "top", b: FULL }], { rawCount: 3, invalidCount: 2 }),
    iouThreshold: 0.5,
  });
  assert.deepEqual([invalid.rawCount, invalid.invalidCount], [3, 2]);
  const failedEmpty = scoreCase({
    fixtureId: "a",
    split: "development",
    stratum: "no_garment",
    annotation: annotation("a", "development", []),
    prediction: failedCase("a", "timeout"),
    iouThreshold: 0.5,
  });
  const agg = aggregate([failedEmpty]);
  assert.deepEqual([agg.images.emptyTruthFailed, agg.images.emptyTruthCorrect], [1, 0]);
});

// ------------------------------------------- manifest, annotation, prediction schemas

test("manifests reject unknown fields, bad paths, duplicates and missing licenses", () => {
  const base = JSON.parse(JSON.stringify(manifest("development", [fixture("a"), fixture("b")]))) as Record<string, unknown>;
  assert.equal(validateManifest(base).problems.length, 0);
  const clone = () => JSON.parse(JSON.stringify(base)) as { fixtures: Array<Record<string, unknown>> } & Record<string, unknown>;
  const cases: Array<[(m: ReturnType<typeof clone>) => void, RegExp]> = [
    [(m) => (m.extra = 1), /unknown field "extra"/],
    [(m) => (m.fixtures[0].file = "../a.jpg"), /bare file name/],
    [(m) => (m.fixtures[1].id = "a"), /duplicate fixture id/],
    [(m) => (m.fixtures[1].sha256 = m.fixtures[0].sha256), /listed twice/],
    [(m) => (m.fixtures[0].sha256 = "xyz"), /64 hex/],
    [(m) => ((m.fixtures[0].source as Record<string, unknown>).license = ""), /license: required/],
    [(m) => (m.fixtures[0].originalDimensions = { width: 0, height: 5, exifOrientation: 1 }), /positive integer/],
    [(m) => (m.fixtures[0].stratum = "huge"), /stratum/],
    [(m) => (m.fixtures[0].priorInference = "no"), /priorInference/],
  ];
  for (const [mutate, pattern] of cases) {
    const m = clone();
    mutate(m);
    assert.match(validateManifest(m).problems.join("\n"), pattern);
  }
  const upper = validateManifest(JSON.parse(JSON.stringify(manifest("development", [fixture("a", { sha256: hashFor("a") })]))));
  assert.equal(upper.manifest?.fixtures[0].sha256, hashFor("a"));
});

test("a held-out manifest cannot hold a known development image, an already-inferred image, or lack a freeze time", () => {
  const known = [...KNOWN_DEVELOPMENT_SHA256][0];
  const knownUpper = validateManifest(manifest("heldout", [fixture("h", { sha256: known.toUpperCase() })]));
  assert.match(knownUpper.problems.join("\n"), /known development image/);
  for (const hash of [
    "533022322A8A986840CCC0B12F7CF3C18C216A824A4232B927558EE02F7C5A39", // public-shirt.jpg
    "7BF2BDCF116AE5E22517F3165A576F156204794CA83E6C200779AD624019967B", // public-hoodie.jpg
    "2A74DC6022DE2AC8739A58395D450558207CE4CAA3F114759DB2198C46076FC9", // two-garments.jpg
  ]) {
    assert.ok(KNOWN_DEVELOPMENT_SHA256.has(hash.toLowerCase()), hash);
    assert.match(validateManifest(manifest("heldout", [fixture("h", { sha256: hash })])).problems.join("\n"), /known development image/);
  }
  assert.equal(KNOWN_DEVELOPMENT_SHA256.size, 6);
  assert.match(
    validateManifest(manifest("heldout", [fixture("h", { priorInference: true })])).problems.join("\n"),
    /priorInference true/,
  );
  const unfrozen = { ...manifest("heldout", [fixture("h")]), splitFrozenAt: null };
  assert.match(validateManifest(unfrozen).problems.join("\n"), /needs splitFrozenAt/);
  assert.equal(validateManifest(manifest("heldout", [])).problems.length, 0);
});

test("the same image or id in the development and held-out manifests is contamination", () => {
  const dev = manifest("development", [fixture("a")]);
  assert.match(
    crossManifestProblems([dev, manifest("heldout", [fixture("h", { sha256: dev.fixtures[0].sha256 })])]).join("\n"),
    /contaminated/,
  );
  assert.match(crossManifestProblems([dev, manifest("heldout", [fixture("a", { sha256: hashFor("z") })])]).join("\n"), /appears in both/);
  assert.match(crossManifestProblems([dev, manifest("development", [])]).join("\n"), /at most one per split/);
  assert.deepEqual(crossManifestProblems([dev, manifest("heldout", [fixture("h")])]), []);
});

test("annotations: unlabeled, model-made, inconsistent and mis-wired labels are not gold", () => {
  const good = annotation("a", "development", [garment("g1", "top", FULL)]);
  assert.deepEqual(goldProblems(good), []);
  assert.match(goldProblems({ ...good, labelStatus: "unlabeled", emptyTruth: null, garments: [] }).join(), /not gold/);
  assert.match(goldProblems({ ...good, labelStatus: "draft" }).join(), /not gold/);
  assert.match(goldProblems({ ...good, annotators: [{ id: "m", kind: "model" }] }).join(), /model-made labels cannot be gold/);

  const file = (a: unknown) => JSON.parse(JSON.stringify({ ...annotationFile("development", []), annotations: [a] })) as unknown;
  const mutations: Array<[Partial<FixtureAnnotation>, RegExp]> = [
    [{ emptyTruth: true }, /emptyTruth is true but garments are listed/],
    [{ emptyTruth: false, garments: [] }, /emptyTruth is false but no garment/],
    [{ completedAt: null }, /needs completedAt/],
    [{ labelStatus: "double_human_adjudicated" }, /at least 2 annotator/],
    [{ labelStatus: "unlabeled" }, /unlabeled record must have emptyTruth null/],
    [{ split: "heldout" }, /differs from the file split/],
    [{ garments: [garment("g1", "top", [0.5, 0.5, 0.4, 0.9]), garment("g1", "top", FULL)] }, /reversed|x2 must be greater|duplicate garment id/],
    [{ garments: [garment("g1", "top", [0, 0, 1, 1.2])] }, /nothing is clipped/],
  ];
  for (const [patch, pattern] of mutations)
    assert.match(validateAnnotationFile(file({ ...good, ...patch })).problems.join("\n"), pattern);
  assert.match(validateAnnotationFile(file({ ...good, brand: "x" })).problems.join("\n"), /unknown field "brand"/);
  const withSize = { ...good, garments: [{ ...good.garments[0], size: "M" }] };
  assert.match(validateAnnotationFile(file(withSize)).problems.join("\n"), /unknown field "size"/);
});

test("annotations are checked against their manifest: hash, split, strata and missing records", () => {
  const m = manifest("development", [fixture("a"), fixture("b", { stratum: "crowded" })]);
  const one = annotation("a", "development", [garment("g1", "top", FULL)]);
  const two = annotation("b", "development", [garment("g1", "top", FULL)]);
  const problems = annotationProblemsForManifest(annotationFile("development", [one, two]), m).join("\n");
  assert.match(problems, /stratum crowded but 1 gold/);
  assert.match(annotationProblemsForManifest(annotationFile("development", [one]), m).join("\n"), /"b": no gold annotation/);
  assert.match(annotationProblemsForManifest(annotationFile("heldout", [one, two]), m).join("\n"), /does not match manifest split/);
  assert.match(
    annotationProblemsForManifest(annotationFile("development", [{ ...one, sha256: hashFor("q") }, two]), m).join("\n"),
    /differs from the manifest's immutable hash/,
  );
  assert.match(
    annotationProblemsForManifest(annotationFile("development", [one, two, annotation("zzz", "development", [])]), m).join("\n"),
    /no fixture in the development manifest/,
  );
  const unset = manifest("development", [fixture("a", { stratum: null })]);
  assert.match(annotationProblemsForManifest(annotationFile("development", [one]), unset).join("\n"), /stratum is not set/);
  const empty = manifest("development", [fixture("e", { stratum: "no_garment" })]);
  assert.deepEqual(annotationProblemsForManifest(annotationFile("development", [annotation("e", "development", [])]), empty), []);
});

test("prediction reports reject inconsistent counts, salvaged items on failures, unknown fields and duplicates", () => {
  const raw = (cases: unknown[]) => JSON.parse(JSON.stringify({ ...predictionReport([]), cases })) as unknown;
  assert.equal(validatePredictionReport(raw([predicted("a", [{ c: "top", b: FULL }])])).problems.length, 0);
  const cases: Array<[unknown[], RegExp]> = [
    [[predicted("a", [{ c: "top", b: FULL }], { rawCount: 5 })], /must equal rawCount/],
    [[predicted("a", [{ c: "top", b: FULL }], { status: "timeout", error: "t" })], /must report no items/],
    [[predicted("a", [], { status: "failed", error: null })], /must say why/],
    [[predicted("a", [], { error: "should be null" })], /must be null for a completed case/],
    [[predicted("a", []), predicted("a", [])], /duplicate case/],
    [[{ ...predicted("a", []), extra: 1 }], /unknown field "extra"/],
    [[predicted("a", [{ c: "top", b: [0, 0, 2, 1] }])], /nothing is clipped/],
    [[{ ...predicted("a", []), status: "done" }], /status/],
  ];
  for (const [list, pattern] of cases) assert.match(validatePredictionReport(raw(list)).problems.join("\n"), pattern);
  const noRun = { ...predictionReport([]), run: { model: "m" } };
  assert.match(validatePredictionReport(JSON.parse(JSON.stringify(noRun))).problems.join("\n"), /missing field "modelVersion"/);
});

// ------------------------------------------------------------ evaluation guards

test("a consistent development evaluation scores and reports no readiness claim", () => {
  const report = evaluate(input());
  assert.equal(report.results.heldout, null);
  assert.equal(report.results.development?.overall.detection.recall, 1);
  assert.ok(report.statements.some((s) => /No launch or readiness threshold/.test(s)));
  assert.ok(report.statements.some((s) => /No held-out fixture was scored/.test(s)));
});

test("scoring is refused for missing images, hash or dimension mismatches", () => {
  refused({ images: () => null }, /absent or unreadable/);
  refused({ images: (f) => ({ sha256: hashFor("other"), dimensions: DIMS }) }, /differs from the immutable manifest hash/);
  refused({ images: (f) => ({ sha256: hashFor(f.id), dimensions: { ...DIMS, width: 1 } }) }, /dimensions differ/);
  refused({ images: (f) => ({ sha256: hashFor(f.id), dimensions: null }) }, /cannot read the image dimensions/);
  refused({ manifests: [manifest("development", [fixture("a", { originalDimensions: null })])] }, /originalDimensions not recorded/);
});

test("scoring is refused without human gold labels", () => {
  const unlabeled = annotation("a", "development", [], { labelStatus: "unlabeled", emptyTruth: null, completedAt: null, annotators: [] });
  refused({ annotationFiles: [annotationFile("development", [unlabeled])] }, /not gold/);
  refused({ annotationFiles: [annotationFile("development", [])] }, /no gold annotation/);
  refused({ annotationFiles: [] }, /need exactly one development annotation file/);
  refused({ annotationFiles: [annotationFile("heldout", [])] }, /need exactly one development annotation file|without its manifest/);
  const model = annotation("a", "development", [garment("g1", "top", FULL)], { annotators: [{ id: "m", kind: "model" }] });
  refused({ annotationFiles: [annotationFile("development", [model])] }, /model-made labels cannot be gold/);
});

test("scoring is refused for predictions of the wrong image, an unknown fixture, or an unmeasured threshold", () => {
  refused({ predictions: predictionReport([predicted("a", [], { imageSha256: hashFor("x") })]) }, /different image/);
  refused({ predictions: predictionReport([predicted("ghost", [])]) }, /unknown fixture "ghost"/);
  for (const bad of [0, -0.1, 1.2, Number.NaN]) refused({ iouThreshold: bad }, /IoU threshold/);
  refused({ manifests: [] , annotationFiles: [] }, /no manifest was supplied/);
  refused({ manifests: [manifest("development", [])], annotationFiles: [annotationFile("development", [])] }, /nothing to score/);
});

test("held-out scoring is refused after contamination or for a run that began before the split was fixed", () => {
  const heldInput = (startedAt: string | null, h = fixture("h")): Partial<EvaluationInput> => ({
    manifests: [manifest("development", [fixture("a")]), manifest("heldout", [h])],
    annotationFiles: [
      annotationFile("development", [annotation("a", "development", [garment("g1", "top", FULL)])]),
      annotationFile("heldout", [annotation(h.id, "heldout", [garment("g1", "top", FULL)])]),
    ],
    predictions: predictionReport([predicted("a", [{ c: "top", b: FULL }]), predicted(h.id, [{ c: "top", b: FULL }])], startedAt),
    images: (f) => ({ sha256: f.sha256, dimensions: DIMS }),
  });
  const ok = evaluate(input(heldInput(AFTER_FREEZE)));
  assert.ok(ok.results.heldout && ok.results.development);
  refused(heldInput("2026-10-11T00:00:00Z"), /before the held-out split was fixed/);
  refused(heldInput(null), /need run\.startedAt/);
  refused(heldInput(AFTER_FREEZE, fixture("h", { sha256: hashFor("a") })), /contaminated/);
  refused(heldInput(AFTER_FREEZE, fixture("h", { sha256: [...KNOWN_DEVELOPMENT_SHA256][0] })), /known development image/);
});

test("direct typed calls cannot bypass schema or contamination checks", () => {
  const known = [...KNOWN_DEVELOPMENT_SHA256][0];
  // Labels and predictions are consistent with the known hash, so only contamination can refuse it.
  const h = fixture("h", { sha256: known });
  const consistent: Partial<EvaluationInput> = {
    manifests: [manifest("heldout", [h])],
    annotationFiles: [annotationFile("heldout", [annotation("h", "heldout", [garment("g1", "top", FULL)], { sha256: known })])],
    predictions: predictionReport([predicted("h", [{ c: "top", b: FULL }], { imageSha256: known })]),
    images: () => ({ sha256: known, dimensions: DIMS }),
  };
  refused(consistent, /known development image/);
  const badBox = predicted("a", [{ c: "top", b: [0, 0, Number.NaN, 1] }]);
  refused({ predictions: predictionReport([badBox]) }, /box coordinate 2 is not a finite number/);
  const extra = { ...manifest("development", [fixture("a")]), surprise: 1 } as unknown as Manifest;
  refused({ manifests: [extra] }, /unknown field "surprise"/);
});

test("development and held-out, and single-item and crowded photos, are aggregated separately", () => {
  const h = fixture("h", { stratum: "crowded" });
  const crowdedGold = [garment("g1", "top", [0, 0, 0.4, 0.4]), garment("g2", "bottom", [0.5, 0.5, 0.9, 0.9])];
  const report = evaluate(
    input({
      manifests: [manifest("development", [fixture("a")]), manifest("heldout", [h])],
      annotationFiles: [
        annotationFile("development", [annotation("a", "development", [garment("g1", "top", FULL)])]),
        annotationFile("heldout", [annotation("h", "heldout", crowdedGold)]),
      ],
      predictions: predictionReport([
        predicted("a", [{ c: "top", b: FULL }]),
        predicted("h", [{ c: "top", b: [0, 0, 0.4, 0.4] }]),
      ]),
      images: (f) => ({ sha256: f.sha256, dimensions: DIMS }),
    }),
  );
  const dev = report.results.development!;
  const held = report.results.heldout!;
  assert.equal(dev.overall.detection.recall, 1);
  assert.equal(held.overall.detection.recall, 0.5);
  assert.ok(dev.byStratum.single_item && dev.byStratum.crowded === null);
  assert.ok(held.byStratum.crowded && held.byStratum.single_item === null);
  assert.equal(held.byStratum.crowded?.items.gold, 2);
  assert.deepEqual(
    report.cases.map((c) => [c.fixtureId, c.split]),
    [["a", "development"], ["h", "heldout"]],
  );
});

test("the report is reproducible and independent of prediction order", () => {
  const specs: Spec[] = [
    { c: "top", b: [0, 0, 0.4, 0.4] },
    { c: "bottom", b: [0.5, 0.5, 0.9, 0.9] },
    { c: "top", b: [0.05, 0.05, 0.4, 0.4] },
  ];
  const gold = [garment("g1", "top", [0, 0, 0.4, 0.4]), garment("g2", "bottom", [0.5, 0.5, 0.9, 0.9])];
  const make = (s: Spec[], cases?: PredictionCase[]) =>
    input({
      manifests: [manifest("development", [fixture("a", { stratum: "crowded" }), fixture("b")])],
      annotationFiles: [
        annotationFile("development", [
          annotation("a", "development", gold),
          annotation("b", "development", [garment("g1", "top", FULL)]),
        ]),
      ],
      predictions: predictionReport(cases ?? [predicted("a", s), predicted("b", [{ c: "top", b: FULL }])]),
    });
  const first = JSON.stringify(evaluate(make(specs)));
  assert.equal(JSON.stringify(evaluate(make(specs))), first);
  const reordered = evaluate(make([...specs].reverse(), [predicted("b", [{ c: "top", b: FULL }]), predicted("a", [...specs].reverse())]));
  assert.deepEqual(
    reordered.cases.map((c) => [c.fixtureId, c.tp, c.fp, c.fn, c.duplicateFp]),
    JSON.parse(first).cases.map((c: CaseScore) => [c.fixtureId, c.tp, c.fp, c.fn, c.duplicateFp]),
  );
  assert.deepEqual(reordered.results, JSON.parse(first).results);
});

// ---------------------------------------------------------------------- adapters

test("the saved Qwen compact-corners evidence is adapted honestly: one reversed box makes the whole case a failure", () => {
  const file = path.join(root, "docs/verification/qwen-compact-corners-013.json");
  assert.ok(existsSync(file), "saved public evidence must be preserved");
  const saved = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const c = qwenCompactCornersAdapter.toCase(saved, { fixtureId: "a", imageSha256: hashFor("a") });
  assert.equal(c.status, "completed");
  assert.equal(c.rawCount, 20);
  assert.equal(c.invalidCount, 1);
  assert.equal(c.items.length, 19);
  assert.match(c.invalidReasons.join(), /item 13/);
  const run = qwenCompactCornersRun(saved);
  assert.equal(run.model, "qwen3-vl:2b-instruct");
  assert.equal(run.startedAt, null);
  assert.equal(run.imageHashSource, "asserted-by-operator");
  assert.equal(run.modelVersion, "unrecorded");
  const s = scoreCase({
    fixtureId: "a",
    split: "development",
    stratum: "single_item",
    annotation: annotation("a", "development", [garment("g1", "top", FULL)]),
    prediction: c,
    iouThreshold: 0.5,
  });
  assert.equal(s.failure, "invalid_output");
  assert.equal(s.predictedCount, 0);
});

test("the Qwen adapter maps timeouts, failures, token-limit stops and malformed records to failures", () => {
  const ctx = { fixtureId: "a", imageSha256: hashFor("a") };
  const adapt = (r: unknown) => qwenCompactCornersAdapter.toCase(r, ctx);
  assert.equal(adapt({ completed: false, failure: "timeout", elapsedMs: 5 }).status, "timeout");
  assert.equal(adapt({ completed: false, failure: "http-500" }).status, "failed");
  assert.equal(adapt({ completed: false }).status, "failed");
  assert.equal(adapt({ completed: true, doneReason: "length", items: [] }).status, "truncated");
  assert.equal(adapt({ completed: true, doneReason: "stop" }).status, "failed");
  assert.equal(adapt({ completed: true, doneReason: "other", items: [] }).status, "failed");
  assert.equal(adapt("text").status, "failed");
  assert.equal(adapt(null).status, "failed");
  const ok = adapt({ completed: true, doneReason: "stop", geometryValid: false, items: [{ c: "top", b: [0, 0, 1000, 1000] }] });
  assert.deepEqual([ok.status, ok.rawCount, ok.invalidCount], ["completed", 1, 0]);
  assert.deepEqual(ok.items[0].box, [0, 0, 1, 1]);
  for (const c of [adapt({ completed: false, failure: "timeout" }), adapt({ completed: true, doneReason: "length" })])
    assert.deepEqual([c.rawCount, c.invalidCount, c.items.length], [0, 0, 0]);
});

test("another model plugs in through the adapter interface, and truncated JSON text is never repaired", () => {
  const rawTextAdapter: RecognitionAdapter<string> = {
    id: "raw-text-test",
    toCase(text, ctx) {
      const parsed = parseStrictJson(text);
      const base = { fixtureId: ctx.fixtureId, imageSha256: ctx.imageSha256, elapsedMs: null, firstContentMs: null };
      if (!parsed.ok)
        return { ...base, status: "failed", error: `unparseable output: ${parsed.error}`, rawCount: 0, invalidCount: 0, items: [], invalidReasons: [] };
      const items = (parsed.value as { items: unknown[] }).items;
      return { ...base, status: "completed", error: null, ...classifyItems(items, (r) => nativeCornersItem(r, 1000)) };
    },
  };
  const ctx = { fixtureId: "a", imageSha256: hashFor("a") };
  const cut = rawTextAdapter.toCase('{"items":[{"c":"top","b":[0,0,500,500]},{"c":"top","b":[0,0', ctx);
  assert.equal(cut.status, "failed");
  assert.equal(cut.items.length, 0, "the complete first item of a cut-off answer is NOT salvaged");
  const whole = rawTextAdapter.toCase('{"items":[{"c":"top","b":[0,0,500,500]}]}', ctx);
  assert.deepEqual([whole.status, whole.items.length], ["completed", 1]);
  assert.equal(parseStrictJson("").ok, false);
});

// ----------------------------------------------- shipped manifests and templates

test("the shipped development manifest is development-only and the held-out manifest is empty", () => {
  const dir = path.join(root, "scripts/vision-evaluation");
  const dev = validateManifest(JSON.parse(readFileSync(path.join(dir, "manifests/development.manifest.json"), "utf8")));
  assert.deepEqual(dev.problems, []);
  assert.equal(dev.manifest?.split, "development");
  assert.equal(dev.manifest?.fixtures.length, 3);
  for (const f of dev.manifest!.fixtures) {
    assert.ok(f.priorInference, `${f.id} was already inferred`);
    assert.ok(KNOWN_DEVELOPMENT_SHA256.has(f.sha256), `${f.id} must be on the contamination list`);
    assert.equal(f.originalDimensions, null, "dimensions are not guessed");
  }
  const held = validateManifest(JSON.parse(readFileSync(path.join(dir, "manifests/heldout.manifest.json"), "utf8")));
  assert.deepEqual(held.problems, []);
  assert.deepEqual([held.manifest?.split, held.manifest?.fixtures.length], ["heldout", 0]);

  const template = validateAnnotationFile(JSON.parse(readFileSync(path.join(dir, "templates/annotations-development.unlabeled.json"), "utf8")));
  assert.deepEqual(template.problems, []);
  assert.ok(template.file!.annotations.every((a) => a.labelStatus === "unlabeled" && a.emptyTruth === null && a.garments.length === 0));
  // Scoring development fixtures against the unlabeled template must be refused.
  const refusal = annotationProblemsForManifest(template.file!, dev.manifest!).join("\n");
  assert.match(refusal, /"natural-closet": labelStatus "unlabeled" is not gold/);
  assert.match(refusal, /"handbag": stratum is not set/);
  const emptyHeld = validateAnnotationFile(JSON.parse(readFileSync(path.join(dir, "templates/annotations-heldout.empty.json"), "utf8")));
  assert.deepEqual(emptyHeld.problems, []);
  assert.deepEqual(annotationProblemsForManifest(emptyHeld.file!, held.manifest!), []);
});

// -------------------------------------------------------- image header inspection

function pngBytes(width: number, height: number, salt = 0): Buffer {
  const b = Buffer.alloc(34);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 2;
  b[26] = salt;
  return b;
}

function jpegBytes(width: number, height: number, orientation?: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation !== undefined) {
    const tiff = Buffer.alloc(26);
    tiff.write("MM", 0, "latin1");
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = 0xe1;
    head.writeUInt16BE(payload.length + 2, 2);
    parts.push(head, payload);
  }
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

test("image headers give stored size and EXIF orientation; anything damaged gives null", () => {
  assert.deepEqual(inspectImageBytes(pngBytes(4, 3)), { width: 4, height: 3, exifOrientation: 1 });
  assert.deepEqual(inspectImageBytes(jpegBytes(300, 200)), { width: 300, height: 200, exifOrientation: 1 });
  assert.deepEqual(inspectImageBytes(jpegBytes(300, 200, 6)), { width: 300, height: 200, exifOrientation: 6 });
  assert.equal(inspectImageBytes(Buffer.from("not an image")), null);
  assert.equal(inspectImageBytes(jpegBytes(300, 200).subarray(0, 12)), null);
  assert.equal(inspectImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(inspectImageBytes(pngBytes(0, 5)), null);
});

// ------------------------------------------------------------ overwrite and CLI

test("a report is written to a new file and an existing file is never overwritten", () => {
  const dir = makeTempDir("vision-eval-");
  try {
    const out = path.join(dir, "report.json");
    writeNewJson(out, { n: 1 });
    assert.throws(() => writeNewJson(out, { n: 2 }), /Refusing to overwrite/);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { n: 1 });
  } finally {
    removeTempDir(dir, "vision-eval-");
  }
});

test("the command line scores a consistent set, refuses inconsistent sets without writing, and never overwrites", () => {
  const dir = makeTempDir("vision-eval-");
  try {
    const bytes = pngBytes(8, 6, 1);
    writeFileSync(path.join(dir, "a.png"), bytes);
    const sha = sha256Hex(bytes);
    const fx = fixture("a", { file: "a.png", sha256: sha, originalDimensions: { width: 8, height: 6, exifOrientation: 1 } });
    const write = (name: string, value: unknown) => {
      const p = path.join(dir, name);
      writeFileSync(p, JSON.stringify(value));
      return p;
    };
    const manifestPath = write("manifest.json", manifest("development", [fx]));
    const gold = annotation("a", "development", [garment("g1", "top", FULL)], { sha256: sha });
    const annPath = write("ann.json", annotationFile("development", [gold]));
    const predPath = write("pred.json", predictionReport([predicted("a", [{ c: "top", b: FULL }], { imageSha256: sha })]));
    const logs: string[] = [];
    const errors: string[] = [];
    const io = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s), now: () => new Date("2026-10-12T07:00:00Z") };
    const args = (out: string, extra: string[] = []) => [
      "score", "--manifest", manifestPath, "--annotations", annPath, "--predictions", predPath, "--images-dir", dir, "--out", out, ...extra,
    ];

    const out1 = path.join(dir, "report-1.json");
    assert.equal(runCli(args(out1), io), 0, errors.join("\n"));
    const report = JSON.parse(readFileSync(out1, "utf8"));
    assert.equal(report.createdAt, "2026-10-12T07:00:00.000Z");
    assert.equal(report.inputs.length, 3);
    assert.equal(report.results.development.overall.detection.recall, 1);

    const before = readFileSync(out1, "utf8");
    assert.equal(runCli(args(out1), io), 1);
    assert.match(errors.join("\n"), /already exists/);
    assert.equal(readFileSync(out1, "utf8"), before);

    const out2 = path.join(dir, "report-2.json");
    writeFileSync(path.join(dir, "a.png"), pngBytes(8, 6, 2)); // image changed after the manifest froze its hash
    errors.length = 0;
    assert.equal(runCli(args(out2), io), 2);
    assert.match(errors.join("\n"), /differs from the immutable manifest hash/);
    assert.equal(existsSync(out2), false, "a refused run writes nothing");
    writeFileSync(path.join(dir, "a.png"), bytes);

    const unlabeled = write("unlabeled.json", annotationFile("development", [{ ...gold, labelStatus: "unlabeled", emptyTruth: null, garments: [], annotators: [], completedAt: null }]));
    errors.length = 0;
    assert.equal(runCli(["score", "--manifest", manifestPath, "--annotations", unlabeled, "--predictions", predPath, "--images-dir", dir, "--out", out2], io), 2);
    assert.match(errors.join("\n"), /not gold/);
    assert.equal(existsSync(out2), false);

    assert.equal(runCli(args(out2, ["--iou", "0"]), io), 2, "a zero threshold is refused");
    assert.equal(runCli(args(out2, ["--iou", "abc"]), io), 1);
    assert.equal(runCli(args(out2, ["--bogus", "1"]), io), 1, "unknown options are refused");
    assert.equal(runCli(["score"], io), 1);
    assert.equal(runCli(["nope"], io), 1);

    writeFileSync(predPath, '{"schemaVersion":1,"kind":"predictions","run":');
    errors.length = 0;
    assert.equal(runCli(args(out2), io), 2, "truncated prediction JSON is refused, not repaired");
    assert.equal(existsSync(out2), false);

    logs.length = 0;
    assert.equal(runCli(["inspect", path.join(dir, "a.png")], io), 0);
    const inspected = JSON.parse(logs.join("\n"));
    assert.deepEqual([inspected[0].sha256, inspected[0].dimensions], [sha, { width: 8, height: 6, exifOrientation: 1 }]);

    // adapt-qwen on a saved record, then the cut-off case stays a failure.
    const record = write("qwen.json", { completed: true, doneReason: "stop", elapsedMs: 9, model: "m", items: [{ c: "top", b: [0, 0, 500, 500] }] });
    const adapted = path.join(dir, "adapted.json");
    logs.length = 0;
    assert.equal(runCli(["adapt-qwen", "--record", record, "--fixture-id", "a", "--manifest", manifestPath, "--images-dir", dir, "--out", adapted], io), 0, errors.join("\n"));
    const adaptedReport = JSON.parse(readFileSync(adapted, "utf8"));
    assert.equal(adaptedReport.cases[0].imageSha256, sha);
    assert.equal(adaptedReport.run.imageHashSource, "asserted-by-operator");
    assert.equal(runCli(["adapt-qwen", "--record", record, "--fixture-id", "a", "--manifest", manifestPath, "--images-dir", dir, "--out", adapted], io), 1, "adapt never overwrites");
    assert.equal(runCli(["adapt-qwen", "--record", record, "--fixture-id", "ghost", "--manifest", manifestPath, "--images-dir", dir, "--out", path.join(dir, "x.json")], io), 2);
  } finally {
    removeTempDir(dir, "vision-eval-");
  }
});
