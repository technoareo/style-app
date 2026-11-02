import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CROP_UNVERIFIED_WARNING, MULTIPLE_ITEMS_WARNING, refineSingleItem } from "../src/domain/analysis";
import { runCli } from "../scripts/vision-evaluation/cli";
import { EvaluationRefusal } from "../scripts/vision-evaluation/evaluate";
import { sha256Hex } from "../scripts/vision-evaluation/image";
import { validateManifest } from "../scripts/vision-evaluation/manifest";
import {
  QWEN_SINGLE_ADAPTER_ID,
  singleRunInfo,
  toSingleCase,
  validateAnalyzePhotoRecord,
  type AnalyzePhotoRecord,
} from "../scripts/vision-evaluation/single-item/adapter";
import { SINGLE_COMMANDS, runSingleCli } from "../scripts/vision-evaluation/single-item/cli";
import { validateGoldFile, type GoldFile, type GoldLabel } from "../scripts/vision-evaluation/single-item/gold";
import { integrityProblems, strataProblems, type IntegrityInput } from "../scripts/vision-evaluation/single-item/integrity";
import { validateSingleManifest, type FreezeReceipt, type SingleFixture, type SingleManifest } from "../scripts/vision-evaluation/single-item/manifest";
import { DEFAULT_POLICY, METRIC_IDS, validatePolicy, type LaunchPolicy } from "../scripts/vision-evaluation/single-item/policy";
import { validateSinglePredictionReport, type SinglePrediction, type SinglePredictionCase, type SinglePredictionReport } from "../scripts/vision-evaluation/single-item/predictions";
import { evaluateSingle, percentile, wilson, type SingleReport } from "../scripts/vision-evaluation/single-item/score";
import { templates } from "../scripts/vision-evaluation/single-item/templates";
import {
  ALLOWED_LICENSES,
  mapColor,
  mapPattern,
  type Fit,
  type GoldCategory,
  type GoldColor,
  type GoldMaterial,
  type GoldPattern,
  type RejectionReason,
  type SceneType,
} from "../scripts/vision-evaluation/single-item/vocab";
import type { Box } from "../scripts/vision-evaluation/types";
import { makeTempDir, removeTempDir } from "./helpers/tempDir";

/**
 * Tests of the build 024 single-item launch gate. Every image, label and
 * prediction here is SYNTHETIC and written in this file; none of it measures any
 * model, and nothing here claims recognition works or the product may launch.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const HEX = (c: string) => c.repeat(64);

// ------------------------------------------------------------------ synthetic images

/** A PNG header with a unique tail: enough for the harness (hash + IHDR dimensions). */
function pngBytes(width: number, height: number, salt: string): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(`salt:${salt}`)]);
}
const imageFor = (id: string) => pngBytes(640, 480, id);

// ------------------------------------------------------------------ builders

type Spec = {
  id: string;
  stratum: "in_scope" | "rejection";
  scene?: SceneType;
  category?: GoldCategory;
  color?: GoldColor;
  pattern?: GoldPattern;
  fit?: Fit;
  material?: GoldMaterial;
  box?: Box;
  reason?: RejectionReason;
  shoot?: string;
  garment?: string;
};
const FULL: Box = [0.2, 0.2, 0.8, 0.8];

const rights = (id: string, sha: string) => ({
  sourceCollection: "wikimedia-commons" as const,
  sourcePageUrl: `https://commons.wikimedia.org/wiki/File:${id}.jpg`,
  originalUrl: `https://upload.wikimedia.org/${id}.jpg`,
  creator: "A. Photographer",
  license: { id: "CC-BY", version: "4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  retrievedAt: "2026-09-30",
  attribution: `"${id}" by A. Photographer, CC BY 4.0`,
  modifications: [],
  originalSha256: sha,
  distributedSha256: sha,
  verifiedBy: "rights-reviewer",
  verifiedAt: "2026-09-30",
});

function fixtureOf(s: Spec, split: "development" | "heldout"): SingleFixture {
  const sha = sha256Hex(imageFor(s.id));
  return {
    id: s.id,
    file: `${s.id}.png`,
    sha256: sha,
    dimensions: { width: 640, height: 480, exifOrientation: 1 },
    addedAt: "2026-10-01T00:00:00Z",
    sceneType: s.scene ?? "flat_lay",
    stratum: s.stratum,
    rejectionReason: s.stratum === "rejection" ? (s.reason ?? "multiple_items") : null,
    sourceShootId: s.shoot ?? `shoot-${s.id}`,
    garmentId: s.stratum === "in_scope" ? (s.garment ?? `garment-${s.id}`) : null,
    priorInference: split === "development",
    priorInferenceNote: split === "development" ? "development image, models were run on it" : null,
    rights: rights(s.id, sha),
    notes: null,
  };
}

function labelOf(s: Spec): GoldLabel {
  const annotation = {
    status: "single_human" as const,
    annotators: [{ id: "annotator-one", kind: "human" as const }],
    completedAt: "2026-10-05T00:00:00Z",
    tool: null,
    modelAssisted: false as const,
    notes: null,
  };
  if (s.stratum === "rejection")
    return { imageId: s.id, imageSha256: sha256Hex(imageFor(s.id)), outcome: "reject", rejectionReason: s.reason ?? "multiple_items", item: null, annotation };
  return {
    imageId: s.id,
    imageSha256: sha256Hex(imageFor(s.id)),
    outcome: "single_item",
    rejectionReason: null,
    item: {
      category: s.category ?? "top",
      color: s.color ?? "blue",
      pattern: s.pattern ?? "solid",
      fit: s.fit ?? "regular",
      material: s.material ?? "none_visible",
      box: s.box ?? FULL,
      seasons: [],
      occasions: [],
    },
    annotation,
  };
}

const HELD: Spec[] = [
  { id: "h-top-1", stratum: "in_scope", category: "top", scene: "flat_lay" },
  { id: "h-top-2", stratum: "in_scope", category: "top", scene: "hanging", color: "red", pattern: "striped" },
  { id: "h-bottom", stratum: "in_scope", category: "bottom", scene: "flat_lay", color: "black", fit: "unknown" },
  { id: "h-dress", stratum: "in_scope", category: "dress", scene: "hanging", color: "green", pattern: "floral" },
  { id: "h-outer", stratum: "in_scope", category: "outerwear", scene: "flat_lay", color: "brown", material: "leather" },
  { id: "h-shoe", stratum: "in_scope", category: "shoe", scene: "hanging", color: "white", material: "unknown" },
  { id: "h-acc", stratum: "in_scope", category: "accessory", scene: "flat_lay", color: "yellow" },
  { id: "h-top-3", stratum: "in_scope", category: "top", scene: "hanging", color: "gray", material: "knit" },
  { id: "h-rej-multi-1", stratum: "rejection", reason: "multiple_items", scene: "flat_lay" },
  { id: "h-rej-multi-2", stratum: "rejection", reason: "multiple_items", scene: "hanging" },
  { id: "h-rej-none", stratum: "rejection", reason: "no_garment", scene: "other" },
  { id: "h-rej-quality", stratum: "rejection", reason: "unusable_quality", scene: "other" },
];
const DEV: Spec[] = [
  { id: "d-top", stratum: "in_scope", category: "top" },
  { id: "d-bottom", stratum: "in_scope", category: "bottom", color: "black" },
  { id: "d-rej", stratum: "rejection", reason: "no_garment", scene: "other" },
];

/** A policy that is approved and small, so tests can reach every branch with a dozen images. All rules compare the point value. */
function testPolicy(over: Partial<LaunchPolicy> = {}): LaunchPolicy {
  const p = structuredClone(DEFAULT_POLICY);
  p.approval = { approvedBy: "test-owner", approvedAt: "2026-10-20T00:00:00Z", note: "synthetic policy for tests only" };
  p.minimums = {
    heldoutInScope: 8,
    heldoutRejection: 4,
    perCategory: 1,
    perRequiredScene: 2,
    perRejectionReason: 1,
    requiredScenes: ["flat_lay", "hanging"],
    requiredRejectionReasons: ["multiple_items", "no_garment"],
  };
  p.rules = p.rules.map((r) => ({ ...r, bound: "point" as const, minN: 4 }));
  return { ...p, ...over };
}

type World = {
  manifests: Array<{ manifest: SingleManifest; fileSha256: string | null }>;
  gold: GoldFile[];
  receipts: FreezeReceipt[];
  images: Map<string, Buffer>;
};

function world(held: Spec[] = HELD, dev: Spec[] = DEV): World {
  const heldManifest: SingleManifest = {
    schemaVersion: 1,
    kind: "single-item-manifest",
    benchmarkId: "single-item-test",
    split: "heldout",
    frozenAt: "2026-10-10T00:00:00Z",
    purpose: "synthetic held-out",
    fixtures: held.map((s) => fixtureOf(s, "heldout")),
  };
  const devManifest: SingleManifest = { ...heldManifest, split: "development", frozenAt: null, purpose: "synthetic development", fixtures: dev.map((s) => fixtureOf(s, "development")) };
  const images = new Map<string, Buffer>();
  for (const s of [...held, ...dev]) images.set(`${s.id}.png`, imageFor(s.id));
  return {
    manifests: [
      { manifest: devManifest, fileSha256: HEX("d") },
      { manifest: heldManifest, fileSha256: HEX("a") },
    ],
    gold: [
      { schemaVersion: 1, kind: "single-item-gold", benchmarkId: "single-item-test", split: "development", labels: dev.map(labelOf) },
      { schemaVersion: 1, kind: "single-item-gold", benchmarkId: "single-item-test", split: "heldout", labels: held.map(labelOf) },
    ],
    receipts: [{ schemaVersion: 1, kind: "single-item-freeze-receipt", benchmarkId: "single-item-test", split: "heldout", frozenAt: "2026-10-10T00:00:00Z", manifestSha256: HEX("a"), fixtureCount: held.length }],
    images,
  };
}

const resolverOf = (images: Map<string, Buffer>): IntegrityInput["images"] => (f) => {
  const bytes = images.get(f.file);
  return bytes ? { sha256: sha256Hex(bytes), dimensions: { width: 640, height: 480, exifOrientation: 1 } } : null;
};

function predictionItem(s: Spec, over: Partial<SinglePrediction> = {}): SinglePrediction {
  // A rejection photo has no gold item, but a model may still return one; give it a plausible item.
  const g = labelOf({ ...s, stratum: "in_scope" }).item!;
  return {
    category: g.category,
    categoryRaw: "Tops",
    color: g.color,
    colorRaw: g.color,
    colorStatus: "mapped",
    pattern: g.pattern,
    patternRaw: g.pattern,
    patternStatus: "mapped",
    fit: g.fit,
    material: g.material === "none_visible" || g.material === "unknown" ? "" : g.material,
    seasons: [],
    occasions: [],
    box: g.box,
    boxUnusable: false,
    uncertain: [],
    selfConfidence: 0.75,
    unnamed: false,
    ...over,
  };
}

function okCase(s: Spec, over: Partial<SinglePrediction> = {}, caseOver: Partial<SinglePredictionCase> = {}, elapsedMs = 1000): SinglePredictionCase {
  return {
    fixtureId: s.id,
    imageSha256: sha256Hex(imageFor(s.id)),
    status: "completed",
    elapsedMs,
    error: null,
    itemCount: 1,
    item: predictionItem(s, over),
    multipleItemsWarning: false,
    cropUnverifiedWarning: false,
    invalidReasons: [],
    ...caseOver,
  };
}
const emptyCase = (s: Spec, elapsedMs = 1000): SinglePredictionCase => ({ ...okCase(s, {}, {}, elapsedMs), itemCount: 0, item: null });
const failedCase = (s: Spec, status: "failed" | "timeout" | "invalid" | "unverified", elapsedMs: number | null = 1000): SinglePredictionCase => ({
  fixtureId: s.id,
  imageSha256: sha256Hex(imageFor(s.id)),
  status,
  elapsedMs,
  error: `${status} (synthetic)`,
  itemCount: 0,
  item: null,
  multipleItemsWarning: false,
  cropUnverifiedWarning: false,
  invalidReasons: [],
});

/** The behaviour a perfect model would show: an accepted correct item for in-scope, a notice for a rejection. */
function perfectCases(specs: Spec[], start = 1000): SinglePredictionCase[] {
  return specs.map((s, i) => {
    const elapsed = start + i * 100;
    if (s.stratum === "in_scope") return okCase(s, {}, {}, elapsed);
    return s.reason === "no_garment" || s.reason === "unusable_quality" ? emptyCase(s, elapsed) : okCase(s, {}, { multipleItemsWarning: true }, elapsed);
  });
}

function runInfo(over: Partial<SinglePredictionReport["run"]> = {}): SinglePredictionReport["run"] {
  return {
    model: "synthetic-model",
    modelVersion: "v0",
    adapter: QWEN_SINGLE_ADAPTER_ID,
    analysisMode: "single",
    prompt: { id: "single-item-prompt", sha256: null },
    startedAt: "2026-10-12T00:00:00Z",
    timeoutMs: 180000,
    imageHashSource: "recorded-by-run",
    notes: "synthetic",
    ...over,
  };
}
const reportOf = (cases: SinglePredictionCase[], run = runInfo()): SinglePredictionReport => ({ schemaVersion: 1, kind: "single-item-predictions", run, cases });

function input(w: World, cases: SinglePredictionCase[], policy = testPolicy(), run = runInfo()) {
  return {
    manifests: w.manifests,
    gold: w.gold,
    receipts: w.receipts,
    predictions: reportOf(cases, run),
    images: resolverOf(w.images),
    policy,
    createdAt: "2026-10-21T00:00:00Z",
    inputDigests: [],
  };
}

const allCases = (specs: { held: Spec[]; dev: Spec[] } = { held: HELD, dev: DEV }) => [...perfectCases(specs.dev), ...perfectCases(specs.held)];
const clone = <T>(v: T): T => structuredClone(v);
const heldOf = (w: World) => w.manifests.find((m) => m.manifest.split === "heldout")!.manifest;
const heldGold = (w: World) => w.gold.find((g) => g.split === "heldout")!;
const fixtureById = (m: SingleManifest, id: string) => m.fixtures.find((f) => f.id === id)!;
const labelById = (g: GoldFile, id: string) => g.labels.find((l) => l.imageId === id)!;

function problemsOf(w: World, cases: SinglePredictionCase[] | null = null, run = runInfo()): string[] {
  return integrityProblems({ manifests: w.manifests, gold: w.gold, receipts: w.receipts, predictions: cases ? reportOf(cases, run) : null, images: resolverOf(w.images) });
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof EvaluationRefusal) return e.message;
    throw e;
  }
  assert.fail("expected the evaluation to be refused");
}

// ================================================================== the valid path

test("valid path: the synthetic benchmark passes every schema validator and integrity check", () => {
  const w = world();
  for (const m of w.manifests) assert.deepEqual(validateSingleManifest(JSON.parse(JSON.stringify(m.manifest))).problems, []);
  for (const g of w.gold) assert.deepEqual(validateGoldFile(JSON.parse(JSON.stringify(g))).problems, []);
  assert.deepEqual(validateSinglePredictionReport(JSON.parse(JSON.stringify(reportOf(allCases())))).problems, []);
  assert.deepEqual(problemsOf(w, allCases()), []);
  assert.deepEqual(strataProblems(heldOf(w), heldGold(w), testPolicy()), []);
});

test("a perfect synthetic run passes the gate under an approved synthetic policy, and the report is deterministic", () => {
  const w = world();
  const a = evaluateSingle(input(w, allCases()));
  assert.equal(a.gate.verdict, "PASS", JSON.stringify(a.gate.preconditions.concat(a.gate.checks.filter((c) => c.status !== "PASS" && c.kind === "gate").map((c) => `${c.id}:${c.detail}`))));
  assert.equal(a.splits.heldout?.selection.value, 1);
  // Same inputs, shuffled order, deep-cloned: byte-identical report.
  const shuffled = clone(w);
  shuffled.manifests.reverse();
  shuffled.manifests.forEach((m) => m.manifest.fixtures.reverse());
  shuffled.gold.forEach((g) => g.labels.reverse());
  const b = evaluateSingle({ ...input(shuffled, [...allCases()].reverse()), images: resolverOf(shuffled.images) });
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  // Within a split the cases are ordered by fixture id.
  for (const split of ["development", "heldout"] as const) {
    const ids = a.cases.filter((c) => c.split === split).map((c) => c.fixtureId);
    assert.deepEqual(ids, [...ids].sort());
  }
});

// ================================================================== rights evidence

function manifestWith(mutate: (f: SingleFixture & Record<string, unknown>) => void): string[] {
  const m = clone(heldOf(world())) as SingleManifest;
  mutate(m.fixtures[0] as SingleFixture & Record<string, unknown>);
  return validateSingleManifest(JSON.parse(JSON.stringify(m))).problems;
}

test("rights fail closed: every gap or unsupported licence is a problem", () => {
  const cases: Array<[string, (f: SingleFixture & Record<string, unknown>) => void, RegExp]> = [
    ["missing source page", (f) => ((f.rights as Record<string, unknown>).sourcePageUrl = ""), /sourcePageUrl/],
    ["non-https original URL", (f) => ((f.rights as Record<string, unknown>).originalUrl = "http://example.org/a.jpg"), /originalUrl: must be an https URL/],
    ["missing creator", (f) => ((f.rights as Record<string, unknown>).creator = " "), /creator/],
    ["missing attribution", (f) => ((f.rights as Record<string, unknown>).attribution = ""), /attribution/],
    ["missing retrieval date", (f) => ((f.rights as Record<string, unknown>).retrievedAt = "yesterday"), /retrievedAt/],
    ["rights nobody verified", (f) => ((f.rights as Record<string, unknown>).verifiedBy = ""), /verifiedBy/],
    ["NonCommercial licence", (f) => ((f.rights as { license: { id: string } }).license.id = "CC-BY-NC"), /non-commercial/],
    ["NoDerivatives licence", (f) => ((f.rights as { license: { id: string } }).license.id = "CC-BY-ND"), /non-commercial, no-derivatives|ND|no-derivatives/],
    ["unknown licence", (f) => ((f.rights as { license: { id: string } }).license.id = "unknown"), /unknown/],
    ["all rights reserved", (f) => ((f.rights as { license: { id: string } }).license.id = "all-rights-reserved"), /reserved|allow-list/],
    ["licence not on the allow-list", (f) => ((f.rights as { license: { id: string } }).license.id = "GFDL"), /allow-list/],
    ["licence version missing", (f) => ((f.rights as { license: { version: string } }).license.version = ""), /version is missing/],
    ["licence version not allowed", (f) => ((f.rights as { license: { version: string } }).license.version = "1.0"), /version "1.0" is not on the allow-list/],
    ["licence URL missing", (f) => ((f.rights as { license: { url: string } }).license.url = "not a url"), /license\.url/],
    ["DeepFashion source", (f) => ((f.rights as Record<string, unknown>).sourcePageUrl = "https://mmlab.ie.cuhk.edu.hk/projects/DeepFashion.html"), /DeepFashion is non-commercial/],
    ["DeepFashion collection name", (f) => ((f.rights as Record<string, unknown>).creator = "DeepFashion team"), /DeepFashion is non-commercial/],
    ["distributed hash differs from the file", (f) => ((f.rights as Record<string, unknown>).distributedSha256 = HEX("e")), /distributedSha256: differs/],
    ["no modification yet a different original", (f) => ((f.rights as Record<string, unknown>).originalSha256 = HEX("e")), /no modification is declared/],
    ["unknown rights field", (f) => ((f.rights as Record<string, unknown>).extra = 1), /unknown field "extra"/],
    ["rights object missing", (f) => delete (f as Record<string, unknown>).rights, /rights/],
  ];
  for (const [label, mutate, expected] of cases) {
    const problems = manifestWith(mutate);
    assert.ok(problems.some((p) => expected.test(p)), `${label}: ${problems.join(" | ")}`);
  }
  // A declared modification may legitimately change the bytes; the original hash is then kept as given.
  assert.deepEqual(
    manifestWith((f) => {
      (f.rights as { modifications: string[] }).modifications = ["resized to 1600 px on the long side"];
      (f.rights as Record<string, unknown>).originalSha256 = HEX("e");
    }),
    [],
  );
  // The allow-list holds only licences that permit evaluation use: no NC, no ND.
  for (const id of Object.keys(ALLOWED_LICENSES)) assert.doesNotMatch(id, /NC|ND/);
});

// ================================================================== manifest fail-closed boundaries

test("manifest: unmeasured dimensions, post-freeze additions, prior inference and missing decisions are refused", () => {
  const expectProblem = (mutate: (f: SingleFixture & Record<string, unknown>) => void, re: RegExp) => {
    const problems = manifestWith(mutate);
    assert.ok(problems.some((p) => re.test(p)), problems.join(" | "));
  };
  expectProblem((f) => ((f as Record<string, unknown>).dimensions = null), /measured dimensions are required/);
  expectProblem((f) => (f.addedAt = "2026-10-11T00:00:00Z"), /added after the freeze/);
  expectProblem((f) => (f.priorInference = true), /a model has seen is contaminated/);
  expectProblem((f) => ((f as Record<string, unknown>).stratum = null), /stratum/);
  expectProblem((f) => ((f as Record<string, unknown>).sourceShootId = ""), /sourceShootId/);
  expectProblem((f) => ((f as Record<string, unknown>).garmentId = null), /garmentId: required for an in-scope/);
  expectProblem((f) => ((f as Record<string, unknown>).sceneType = "somewhere"), /sceneType/);
  expectProblem((f) => ((f as Record<string, unknown>).sha256 = "abc"), /sha256/);
  expectProblem((f) => ((f as Record<string, unknown>).file = "../x.png"), /bare file name/);
  expectProblem((f) => ((f as Record<string, unknown>).surprise = 1), /unknown field "surprise"/);
  const unfrozen = clone(heldOf(world()));
  unfrozen.frozenAt = null;
  assert.ok(validateSingleManifest(JSON.parse(JSON.stringify(unfrozen))).problems.some((p) => /needs frozenAt/.test(p)));
  const rejection = clone(heldOf(world()));
  fixtureById(rejection, "h-rej-none").rejectionReason = null;
  assert.ok(validateSingleManifest(JSON.parse(JSON.stringify(rejection))).problems.some((p) => /rejectionReason/.test(p)));
  const dup = clone(heldOf(world()));
  dup.fixtures[1].id = dup.fixtures[0].id;
  assert.ok(validateSingleManifest(JSON.parse(JSON.stringify(dup))).problems.some((p) => /duplicate id/.test(p)));
});

// ================================================================== gold labels

test("gold labels: exactly one prominent item or an explicit rejection; model-made, incomplete or malformed labels are refused", () => {
  const base = () => JSON.parse(JSON.stringify(heldGold(world())));
  const problemsFor = (mutate: (g: any) => void) => {
    const g = base();
    mutate(g);
    return validateGoldFile(g).problems.join(" | ");
  };
  const rejectionIndex = heldGold(world()).labels.findIndex((l) => l.outcome === "reject");
  assert.match(problemsFor((g) => (g.labels[0].annotation.modelAssisted = true)), /model-assisted or model-made label cannot be gold/);
  assert.match(problemsFor((g) => (g.labels[0].annotation.annotators[0].kind = "model")), /must be "human"/);
  assert.match(problemsFor((g) => (g.labels[0].annotation.annotators[0].id = "qwen3-vl-labeler")), /looks like a model or script/);
  assert.match(problemsFor((g) => (g.labels[0].annotation.tool = "ollama script")), /looks like a model or script/);
  assert.match(problemsFor((g) => (g.labels[0].annotation.notes = "model-generated draft, approved")), /model-made label/);
  assert.match(problemsFor((g) => (g.labels[0].annotation.status = "draft")), /status/);
  assert.match(problemsFor((g) => (g.labels[0].annotation.status = "double_human_adjudicated")), /at least two human annotators/);
  assert.match(problemsFor((g) => (g.labels[0].annotation.annotators = [])), /at least one human annotator/);
  assert.match(problemsFor((g) => (g.labels[0].annotation.completedAt = null)), /completedAt/);
  assert.match(problemsFor((g) => delete g.labels[0].annotation), /annotator provenance is required/);
  assert.match(problemsFor((g) => delete g.labels[0].item.material), /missing field "material"/);
  assert.match(problemsFor((g) => (g.labels[0].item.color = "teal-ish")), /item\.color/);
  assert.match(problemsFor((g) => (g.labels[0].item.category = "Tops")), /item\.category/);
  assert.match(problemsFor((g) => (g.labels[0].item.box = [0.5, 0.5, 0.4, 0.9])), /x2 must be greater than x1/);
  assert.match(problemsFor((g) => (g.labels[0].item.box = [0, 0, 1.2, 1])), /normalized/);
  assert.match(problemsFor((g) => (g.labels[0].item = null)), /needs an item object/);
  assert.match(problemsFor((g) => (g.labels[0].item.seasons = ["monsoon"])), /seasons/);
  assert.match(problemsFor((g) => (g.labels[0].outcome = "maybe")), /outcome/);
  assert.match(problemsFor((g) => (g.labels[0].rejectionReason = "no_garment")), /must be null for a single_item/);
  assert.match(problemsFor((g) => (g.labels[rejectionIndex].item = base().labels[0].item)), /must be null for a rejection/);
  assert.match(problemsFor((g) => (g.labels[rejectionIndex].rejectionReason = null)), /rejection needs one of/);
  assert.match(problemsFor((g) => (g.labels[1].imageId = g.labels[0].imageId)), /labelled twice/);
  assert.match(problemsFor((g) => (g.labels[0].extra = 1)), /unknown field "extra"/);
  // "unknown" is a legal fit and material (the photo may not show them).
  assert.equal(validateGoldFile(base()).problems.length, 0);
});

// ================================================================== integrity

test("integrity: hash mismatch, missing or re-measured images, missing and mismatched labels all fail closed", () => {
  const mutated = (mutate: (w: World) => void) => {
    const w = clone(world());
    mutate(w);
    return problemsOf(w, allCases()).join(" | ");
  };
  assert.match(mutated((w) => w.images.set("h-top-1.png", pngBytes(640, 480, "tampered"))), /image bytes differ from the immutable manifest hash/);
  assert.match(mutated((w) => w.images.delete("h-top-1.png")), /absent or unreadable/);
  assert.match(mutated((w) => (fixtureById(heldOf(w), "h-top-1").dimensions.width = 641)), /measured dimensions differ/);
  assert.match(mutated((w) => (heldGold(w).labels = heldGold(w).labels.filter((l) => l.imageId !== "h-top-1"))), /no gold label \(incomplete labels\)/);
  assert.match(mutated((w) => (labelById(heldGold(w), "h-top-1").imageSha256 = HEX("c"))), /gold label was made for different bytes/);
  assert.match(mutated((w) => heldGold(w).labels.push({ ...labelById(heldGold(w), "h-top-1"), imageId: "ghost" })), /has no fixture/);
  assert.match(mutated((w) => (fixtureById(heldOf(w), "h-top-1").stratum = "rejection")), /disagrees with the gold outcome/);
  assert.match(mutated((w) => (labelById(heldGold(w), "h-rej-none").rejectionReason = "multiple_items")), /rejection reason differs/);
  assert.match(mutated((w) => (w.gold = w.gold.filter((g) => g.split !== "heldout"))), /heldout split: no gold labels/);
  // A dimensions measurement that cannot be taken is also a refusal.
  const w = world();
  assert.match(
    integrityProblems({ manifests: w.manifests, gold: w.gold, receipts: w.receipts, predictions: null, images: (f) => ({ sha256: f.sha256, dimensions: null }) }).join(" | "),
    /dimensions could not be measured/,
  );
});

// ================================================================== leakage and contamination

test("leakage: the same bytes, shoot, garment, source page or original file in two splits is refused; sharing inside a split is allowed", () => {
  const leak = (mutate: (dev: SingleFixture, held: SingleFixture) => void) => {
    const w = clone(world());
    const dev = w.manifests.find((m) => m.manifest.split === "development")!.manifest.fixtures[0];
    mutate(dev, heldOf(w).fixtures[0]);
    return problemsOf(w, null).join(" | ");
  };
  assert.match(leak((d, h) => (d.sourceShootId = h.sourceShootId)), /leakage: source shoot/);
  assert.match(leak((d, h) => (d.garmentId = h.garmentId)), /leakage: garment/);
  assert.match(leak((d, h) => (d.rights.sourcePageUrl = h.rights.sourcePageUrl)), /leakage: source page/);
  assert.match(leak((d, h) => (d.rights.originalUrl = h.rights.originalUrl)), /leakage: original URL/);
  assert.match(leak((d, h) => (d.rights.originalSha256 = h.rights.originalSha256)), /leakage: original file hash/);
  assert.match(leak((d, h) => (d.sha256 = h.sha256)), /leakage: image hash/);
  assert.match(leak((d, h) => (d.id = h.id)), /leakage: fixture id/);
  // Two photos of one garment in the SAME split are fine (they cannot leak across it).
  const w = clone(world());
  heldOf(w).fixtures[1].garmentId = heldOf(w).fixtures[0].garmentId;
  heldOf(w).fixtures[1].sourceShootId = heldOf(w).fixtures[0].sourceShootId;
  assert.deepEqual(problemsOf(w, null), []);
  // The same image listed twice in one split is a duplicate.
  const twice = clone(world());
  heldOf(twice).fixtures[1].sha256 = heldOf(twice).fixtures[0].sha256;
  assert.match(problemsOf(twice, null).join(" | "), /duplicate image hash/);
});

test("contamination: prior inference, known development images, missing or stale freeze, early runs and late labels are refused", () => {
  const w0 = world();
  const withPrior = clone(w0);
  fixtureById(heldOf(withPrior), "h-top-1").priorInference = true;
  assert.match(problemsOf(withPrior, null).join(" | "), /a model has already seen/);

  const known = clone(w0);
  const KNOWN = "71e077ab678b3b692e579d8cd9423d03967816e5f62919f071c0554f8b0f05d0";
  fixtureById(heldOf(known), "h-top-1").sha256 = KNOWN;
  labelById(heldGold(known), "h-top-1").imageSha256 = KNOWN;
  const knownProblems = integrityProblems({
    manifests: known.manifests,
    gold: known.gold,
    receipts: known.receipts,
    predictions: null,
    images: (f) => (f.id === "h-top-1" ? { sha256: KNOWN, dimensions: f.dimensions } : resolverOf(known.images)(f)),
  });
  assert.match(knownProblems.join(" | "), /known development image/);

  const noReceipt = clone(w0);
  noReceipt.receipts = [];
  assert.match(problemsOf(noReceipt, null).join(" | "), /no freeze receipt/);

  const changed = clone(w0);
  changed.manifests.find((m) => m.manifest.split === "heldout")!.fileSha256 = HEX("b");
  assert.match(problemsOf(changed, null).join(" | "), /changed after the freeze/);

  const added = clone(w0);
  added.receipts[0].fixtureCount = HELD.length - 1;
  assert.match(problemsOf(added, null).join(" | "), /different number of fixtures/);

  const retimed = clone(w0);
  retimed.receipts[0].frozenAt = "2026-10-11T00:00:00Z";
  assert.match(problemsOf(retimed, null).join(" | "), /freeze receipt time differs/);

  const early = problemsOf(w0, allCases(), runInfo({ startedAt: "2026-10-09T00:00:00Z" })).join(" | ");
  assert.match(early, /run started before the held-out split was frozen/);
  assert.match(problemsOf(w0, allCases(), runInfo({ startedAt: null })).join(" | "), /needs run\.startedAt/);
  assert.match(problemsOf(w0, allCases(), runInfo({ imageHashSource: "asserted-by-operator" })).join(" | "), /hashes recorded by the run/);

  const lateLabel = clone(w0);
  labelById(heldGold(lateLabel), "h-top-1").annotation.completedAt = "2026-10-13T00:00:00Z";
  assert.match(problemsOf(lateLabel, allCases()).join(" | "), /completed after the run started/);

  const wrongBytes = allCases();
  wrongBytes[3] = { ...wrongBytes[3], imageSha256: HEX("c") };
  assert.match(problemsOf(w0, wrongBytes).join(" | "), /different image/);
  assert.match(problemsOf(w0, [...allCases(), okCase({ id: "stranger", stratum: "in_scope" })]).join(" | "), /unknown fixture/);
});

test("scoring refuses (writes nothing) when the inputs are not trustworthy evidence", () => {
  const w = clone(world());
  w.images.set("h-top-1.png", pngBytes(640, 480, "tampered"));
  assert.match(refusal(() => evaluateSingle(input(w, allCases()))), /hash/);
  assert.match(refusal(() => evaluateSingle({ ...input(world(), allCases()), predictions: null })), /no prediction report/);
});

// ================================================================== strata and minimum samples

test("too-small strata make the gate NOT_EVALUATED (never PASS) and are listed with the policy minimum", () => {
  const small = HELD.filter((s) => s.id !== "h-shoe" && s.id !== "h-rej-none");
  const w = world(small, DEV);
  const report = evaluateSingle(input(w, allCases({ held: small, dev: DEV })));
  assert.equal(report.gate.verdict, "NOT_EVALUATED");
  const text = report.gate.preconditions.join(" | ");
  assert.match(text, /held-out in-scope images: 7 \(policy minimum 8\)/);
  assert.match(text, /held-out category "shoe": 0/);
  assert.match(text, /held-out rejection images: 3 \(policy minimum 4\)/);
  assert.match(text, /held-out rejection reason "no_garment": 0/);
  assert.deepEqual(strataProblems(undefined, undefined, testPolicy()), ["no held-out fixtures"]);
  // Scene strata: only flat-lay photos is not enough either.
  const flatOnly = HELD.map((s) => ({ ...s, scene: s.stratum === "in_scope" ? ("flat_lay" as const) : s.scene }));
  const flat = evaluateSingle(input(world(flatOnly, DEV), allCases({ held: flatOnly, dev: DEV })));
  assert.match(flat.gate.preconditions.join(" | "), /held-out scene "hanging": 0 \(policy minimum 2\)/);
});

// ================================================================== selection, crop, abstention, rejection

function scored(mutateCases: (cases: SinglePredictionCase[]) => void, policy = testPolicy()): SingleReport {
  const cases = allCases();
  mutateCases(cases);
  return evaluateSingle(input(world(), cases, policy));
}
const caseFor = (cases: SinglePredictionCase[], id: string) => cases.find((c) => c.fixtureId === id)!;
const heldCase = (r: SingleReport, id: string) => r.cases.find((c) => c.fixtureId === id)!;

test("primary-item selection and crop usefulness use IoU and coverage of the human box", () => {
  const r = scored((cases) => {
    caseFor(cases, "h-top-1").item!.box = [0.2, 0.2, 0.8, 0.8]; // exact
    caseFor(cases, "h-top-2").item!.box = [0.2, 0.2, 0.8, 0.5]; // top half: IoU 0.5, coverage 0.5
    caseFor(cases, "h-bottom").item!.box = [0.1, 0.1, 0.9, 0.9]; // slightly loose: IoU 0.5625, coverage 1
    caseFor(cases, "h-dress").item!.box = [0.0, 0.0, 0.15, 0.15]; // elsewhere
    caseFor(cases, "h-outer").item!.box = null; // unusable crop
    caseFor(cases, "h-outer").item!.boxUnusable = true;
  });
  assert.equal(heldCase(r, "h-top-1").selected, true);
  assert.equal(heldCase(r, "h-top-1").cropUseful, true);
  assert.equal(heldCase(r, "h-top-2").iou, 0.5);
  assert.equal(heldCase(r, "h-top-2").selected, true, "IoU exactly at the policy selection threshold selects");
  assert.equal(heldCase(r, "h-top-2").cropUseful, false, "half the item is not a useful crop");
  assert.equal(heldCase(r, "h-bottom").iou, 0.5625);
  assert.equal(heldCase(r, "h-bottom").cropUseful, false, "IoU 0.5625 is below the useful-crop IoU 0.6");
  assert.equal(heldCase(r, "h-dress").selected, false);
  assert.equal(heldCase(r, "h-outer").selected, false);
  assert.equal(heldCase(r, "h-outer").cropUseful, false);
  assert.equal(r.splits.heldout?.selection.value, 0.75);
  assert.equal(r.splits.heldout?.selection.n, 8);
});

test("abstention: doubt, Unsorted, unknown fit and empty values lower coverage, not accuracy-on-answered", () => {
  const r = scored((cases) => {
    caseFor(cases, "h-top-1").item!.uncertain = ["color"];
    caseFor(cases, "h-top-1").item!.color = "red"; // wrong, but flagged as doubtful: an abstention, not an error
    caseFor(cases, "h-top-2").item!.category = null; // Unsorted
    caseFor(cases, "h-top-3").item!.colorStatus = "empty";
    caseFor(cases, "h-top-3").item!.color = null;
    caseFor(cases, "h-acc").item!.fit = "unknown";
  });
  const a = r.splits.heldout!.attributes;
  assert.equal(a.color.abstained, 2);
  assert.equal(a.color.answered, 6);
  assert.equal(a.color.correct, 6, "the doubtful wrong colour is not counted as a wrong answer");
  assert.equal(a.color.coverage.value, 0.75);
  assert.equal(a.color.accuracyOnAnswered.value, 1);
  assert.equal(a.color.wrong, 0);
  assert.equal(a.category.abstained, 1);
  assert.equal(a.category.coverage.value, 0.875);
  assert.equal(a.category.accuracyOnAnswered.value, 1);
  assert.equal(a.category.endToEndCorrect.value, 0.875, "abstentions are misses end to end");
  // h-bottom has gold fit "unknown": excluded from fit scoring.
  assert.equal(a.fit.goldUnknownExcluded, 1);
  assert.equal(a.fit.goldKnown, 7);
  assert.equal(a.fit.abstained, 1);
});

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

test("unmappable colour or pattern text is wrong, not guessed; known mappings are exact", () => {
  assert.deepEqual(mapColor("navy blue"), { value: "blue", status: "mapped" });
  assert.deepEqual(mapColor("Light-Gray"), { value: "gray", status: "mapped" });
  assert.deepEqual(mapColor("off white"), { value: "white", status: "mapped" });
  assert.deepEqual(mapColor("cream"), { value: "beige", status: "mapped" });
  assert.deepEqual(mapColor(""), { value: null, status: "empty" });
  assert.deepEqual(mapColor("black and white"), { value: null, status: "unmapped" });
  assert.deepEqual(mapColor("chartreuse"), { value: null, status: "unmapped" });
  assert.deepEqual(mapColor("rainbow"), { value: "multicolor", status: "mapped" });
  assert.deepEqual(mapPattern("polka dot"), { value: "dotted", status: "mapped" });
  assert.deepEqual(mapPattern("plaid"), { value: "checked", status: "mapped" });
  assert.deepEqual(mapPattern("solid"), { value: "solid", status: "mapped" });
  assert.deepEqual(mapPattern("striped checked"), { value: null, status: "unmapped" });
  assert.deepEqual(mapPattern("  "), { value: null, status: "empty" });
  const r = scored((cases) => {
    const item = caseFor(cases, "h-top-1").item!;
    item.colorStatus = "unmapped";
    item.color = null;
    item.colorRaw = "black and white";
  });
  const color = r.splits.heldout!.attributes.color;
  assert.equal(color.unmapped, 1);
  assert.equal(color.wrong, 1);
  assert.equal(color.answered, 8, "an unmappable colour is an answer (wrong), not an abstention");
});

test("rejection cases: a silent clean accept is a false accept; a refusal or a notice is not; a failure is neither", () => {
  const r = scored((cases) => {
    // h-rej-multi-1: accepted silently (model missed the clutter). multi-2: accepted with the multiple-items notice.
    caseFor(cases, "h-rej-multi-1").multipleItemsWarning = false;
    // h-rej-none: the app returned an item for a photo with no garment.
    Object.assign(caseFor(cases, "h-rej-none"), okCase(HELD.find((s) => s.id === "h-rej-none")!, {}, {}, 1000), { itemCount: 1 });
    // h-rej-quality: timed out.
    Object.assign(caseFor(cases, "h-rej-quality"), failedCase(HELD.find((s) => s.id === "h-rej-quality")!, "timeout", 180000));
  });
  const h = r.splits.heldout!;
  assert.equal(heldCase(r, "h-rej-multi-1").disposition, "accepted");
  assert.equal(heldCase(r, "h-rej-multi-2").disposition, "accepted_with_multiple_warning");
  assert.equal(heldCase(r, "h-rej-none").disposition, "accepted");
  assert.equal(heldCase(r, "h-rej-quality").disposition, "failed");
  assert.equal(h.falseAccept.n, 4);
  assert.equal(h.falseAccept.value, 0.5);
  const byReason = Object.fromEntries(h.rejectionByReason.map((x) => [x.reason, x]));
  assert.deepEqual(byReason.multiple_items, { reason: "multiple_items", n: 2, refusedOrWarned: 1, falseAccept: 1, failed: 0 });
  assert.deepEqual(byReason.unusable_quality, { reason: "unusable_quality", n: 1, refusedOrWarned: 0, falseAccept: 0, failed: 1 });
  // An in-scope photo the app refused is a false refusal.
  const refused = scored((cases) => {
    Object.assign(caseFor(cases, "h-top-1"), emptyCase(HELD.find((s) => s.id === "h-top-1")!));
  });
  assert.equal(refused.splits.heldout!.falseRefusal.value, 0.125);
  assert.equal(heldCase(refused, "h-top-1").attributes!.category.state, "notRun");
});

test("failed, timed-out, invalid, unverified and missing cases keep their gold in every denominator", () => {
  const specs = HELD;
  const r = scored((cases) => {
    const i = (id: string) => cases.findIndex((c) => c.fixtureId === id);
    cases[i("h-top-1")] = failedCase(specs.find((s) => s.id === "h-top-1")!, "failed");
    cases[i("h-top-2")] = failedCase(specs.find((s) => s.id === "h-top-2")!, "timeout", 180000);
    cases[i("h-bottom")] = failedCase(specs.find((s) => s.id === "h-bottom")!, "invalid");
    cases[i("h-dress")] = failedCase(specs.find((s) => s.id === "h-dress")!, "unverified");
    cases.splice(i("h-outer"), 1); // missing: no record at all
  });
  const h = r.splits.heldout!;
  assert.equal(h.reliability.failed, 1);
  assert.equal(h.reliability.timeout, 1);
  assert.equal(h.reliability.invalid, 1);
  assert.equal(h.reliability.unverified, 1);
  assert.equal(h.reliability.missing, 1);
  assert.equal(h.reliability.failureRate.value, r6(5 / 12));
  assert.equal(h.attributes.category.goldKnown, 8);
  assert.equal(h.attributes.category.answered, 3);
  assert.equal(h.attributes.category.notRun, 5);
  assert.equal(h.attributes.category.endToEndCorrect.value, r6(3 / 8));
  assert.equal(h.selection.value, r6(3 / 8));
  assert.equal(heldCase(r, "h-outer").predictionStatus, "missing");
  assert.equal(h.latency.missing, 1, "a missing case has no duration, so latency is not evaluated");
  assert.equal(h.latency.p95Ms, null);
});

// ================================================================== thresholds, minimums, approval

test("thresholds: boundary equality passes, a miss fails, too few observations is NOT_EVALUATED, an unapproved policy is NOT_EVALUATED", () => {
  const perfect = evaluateSingle(input(world(), allCases()));
  assert.equal(perfect.gate.verdict, "PASS");

  // A threshold exactly at the observed value passes (>=), one hair above fails.
  const edge = testPolicy();
  edge.rules = edge.rules.map((r) => (r.id === "category-accuracy" ? { ...r, threshold: 1 } : r));
  assert.equal(evaluateSingle(input(world(), allCases(), edge)).gate.verdict, "PASS");
  const worse = scored((cases) => {
    caseFor(cases, "h-top-1").item!.category = "bottom";
  }, edge);
  assert.equal(worse.gate.verdict, "FAIL");
  assert.equal(worse.gate.checks.find((c) => c.id === "category-accuracy")!.status, "FAIL");

  // minN larger than the data: that rule is NOT_EVALUATED and so is the verdict.
  const hungry = testPolicy();
  hungry.rules = hungry.rules.map((r) => (r.id === "color-accuracy" ? { ...r, minN: 9 } : r));
  const ne = evaluateSingle(input(world(), allCases(), hungry));
  assert.equal(ne.gate.checks.find((c) => c.id === "color-accuracy")!.status, "NOT_EVALUATED");
  assert.match(ne.gate.checks.find((c) => c.id === "color-accuracy")!.detail, /8 observations, rule needs at least 9/);
  assert.equal(ne.gate.verdict, "NOT_EVALUATED");

  // FAIL beats NOT_EVALUATED when a rule definitively fails and another lacks data.
  const mixed = testPolicy();
  mixed.rules = mixed.rules.map((r) => (r.id === "color-accuracy" ? { ...r, minN: 9 } : r.id === "category-accuracy" ? { ...r, threshold: 1 } : r));
  const both = scored((cases) => {
    caseFor(cases, "h-top-1").item!.category = "bottom";
  }, mixed);
  assert.equal(both.gate.verdict, "FAIL");

  // The shipped default policy is a proposal with no approval: never a PASS.
  const unsigned = evaluateSingle(input(world(), allCases(), { ...testPolicy(), approval: null }));
  assert.equal(unsigned.gate.verdict, "NOT_EVALUATED");
  assert.match(unsigned.gate.preconditions.join(" "), /no approval record/);

  // Development-only predictions never give a verdict.
  const devOnly = evaluateSingle(input(world(), perfectCases(DEV)));
  assert.equal(devOnly.splits.heldout, null);
  assert.equal(devOnly.gate.verdict, "NOT_EVALUATED");
  assert.match(devOnly.gate.preconditions.join(" "), /no held-out predictions/);
});

test("the Wilson bound is what a wilson95 rule compares, not the point estimate", () => {
  const near = wilson(0, 60)!;
  assert.ok(Math.abs(near.upper - 0.0602) < 0.001, String(near.upper));
  assert.equal(near.lower, 0);
  const w = wilson(230, 240)!;
  assert.ok(w.lower < 230 / 240 && w.upper > 230 / 240);
  assert.equal(wilson(0, 0), null);
  const strict = testPolicy();
  strict.rules = strict.rules.map((r) => (r.id === "selection-rate" ? { ...r, bound: "wilson95_lower" as const, threshold: 0.9, minN: 4 } : r));
  const gate = evaluateSingle(input(world(), allCases(), strict)).gate;
  const check = gate.checks.find((c) => c.id === "selection-rate")!;
  assert.equal(check.status, "FAIL", "8 of 8 correct has a Wilson lower bound far below 0.9");
  assert.ok((check.observed as number) < 0.9);
});

// ================================================================== latency

test("latency percentiles are nearest-rank, over every case that ran, and gate on the explicit policy", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95), 19);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 1), 20);
  assert.equal(percentile([], 0.5), null);
  const times = [60000, 70000, 75000, 80000, 90000, 100000, 110000, 120000, 130000, 132000, 140000, 150000];
  const r = scored((cases) => {
    const held = cases.filter((c) => HELD.some((s) => s.id === c.fixtureId));
    held.forEach((c, i) => (c.elapsedMs = times[i]));
  });
  const l = r.splits.heldout!.latency;
  assert.equal(l.p50Ms, 100000);
  assert.equal(l.p95Ms, 150000);
  assert.equal(l.maxMs, 150000);
  const p95 = r.gate.checks.find((c) => c.id === "latency-p95")!;
  assert.equal(p95.status, "FAIL", "150 s is over the 120 s placeholder limit");
  assert.equal(r.gate.verdict, "FAIL");
  assert.match(read("docs/reviews/implementation-024-notes.md"), /75 to 132 seconds/);
});

// ================================================================== self-confidence

test("the model's self-confidence is recorded but never changes any metric or verdict", () => {
  const base = scored(() => undefined);
  const other = scored((cases) => {
    for (const c of cases) if (c.item) c.item.selfConfidence = 0.25;
  });
  const strip = (r: SingleReport) => JSON.stringify({ splits: r.splits, gate: r.gate, cases: r.cases });
  assert.equal(strip(base), strip(other));
});

test("seasons and occasions are suggestions: metrics only, never a gate", () => {
  const withSuggestions = clone(world());
  labelById(heldGold(withSuggestions), "h-top-1").item!.seasons = ["summer"];
  const cases = allCases();
  caseFor(cases, "h-top-1").item!.seasons = ["winter"];
  const r = evaluateSingle(input(withSuggestions, cases));
  assert.equal(heldCase(r, "h-top-1").seasonsJaccard, 0);
  assert.equal(r.splits.heldout!.suggestions.seasons.value, 0.875);
  assert.equal(r.gate.verdict, "PASS", "wrong suggestions never fail the gate");
  assert.match(r.splits.heldout!.suggestions.note, /not visible objective truth/);
  const bad = testPolicy();
  bad.rules = [...bad.rules.filter((x) => x.kind === "gate"), { ...bad.rules.find((x) => x.metric === "suggestions.seasons.meanJaccard")!, kind: "gate" as const }];
  const problems = validatePolicy(JSON.parse(JSON.stringify(bad))).problems.join(" | ");
  assert.match(problems, /suggestions, not visible truth/);
});

test("gold-unknown fit and material are excluded from scoring but overclaiming on them is counted", () => {
  const r = scored((cases) => {
    caseFor(cases, "h-bottom").item!.fit = "relaxed"; // gold fit unknown, model asserts one
    caseFor(cases, "h-shoe").item!.material = "leather"; // gold material unknown, model asserts one
  });
  const a = r.splits.heldout!.attributes;
  assert.equal(a.fit.overclaimOnUnknown, 1);
  assert.equal(a.material.overclaimOnUnknown, 1);
  assert.equal(a.fit.goldUnknownExcluded, 1);
  assert.equal(a.material.goldUnknownExcluded, 1);
  assert.equal(heldCase(r, "h-bottom").attributes!.fit.state, "excluded");
  assert.equal(a.fit.goldKnown, 7);
});

test("macro F1 treats abstentions as misses and counts a spurious predicted class", () => {
  const r = scored((cases) => {
    caseFor(cases, "h-top-1").item!.category = "bottom"; // top -> bottom
    caseFor(cases, "h-top-2").item!.uncertain = ["category"]; // top abstained
  });
  const cat = r.splits.heldout!.attributes.category;
  const row = (label: string) => cat.perClass.find((c) => c.label === label)!;
  assert.deepEqual({ gold: row("top").goldCount, correct: row("top").correct, wrong: row("top").wrong, abstained: row("top").abstained }, { gold: 3, correct: 1, wrong: 1, abstained: 1 });
  assert.equal(row("top").recall, r6(1 / 3));
  assert.equal(row("bottom").precision, 0.5, "one right and one stolen prediction");
  const mean = cat.perClass.reduce((s, c) => s + c.f1, 0) / cat.perClass.length;
  assert.equal(cat.macroF1.value, r6(mean));
  assert.ok(cat.macroF1.value! < 1);
});

// ================================================================== adapter

const NOW = "2026-10-12T01:00:00Z";
function analysisItem(over: Record<string, unknown> = {}) {
  return {
    name: "Blue shirt",
    category: "Tops",
    color: "navy blue",
    pattern: "solid",
    formality: "casual",
    brand: "",
    size: "",
    confidence: 0.75,
    evidence: "collared shirt",
    material: "",
    fit: "regular",
    seasons: ["summer"],
    occasions: ["everyday"],
    uncertain: [],
    box: [0.2, 0.2, 0.6, 0.6],
    ...over,
  };
}
function record(over: Partial<AnalyzePhotoRecord> = {}, analysis: unknown = { items: [analysisItem()], warning: "" }): AnalyzePhotoRecord {
  return {
    schemaVersion: 1,
    kind: "analyze-photo-record",
    fixtureId: "h-top-1",
    imageSha256: sha256Hex(imageFor("h-top-1")),
    model: "qwen3-vl:4b-instruct",
    modelVersion: "sha256:abc",
    promptId: "single-item-prompt-018",
    startedAt: NOW,
    elapsedMs: 90000,
    timeoutMs: 180000,
    outcome: "ok",
    error: null,
    analysis,
    ...over,
  };
}

test("adapter: a real analyzePhoto-shaped result maps to the harness vocabulary", () => {
  const c = toSingleCase(record());
  assert.equal(c.status, "completed");
  assert.equal(c.elapsedMs, 90000);
  assert.equal(c.itemCount, 1);
  const item = c.item!;
  assert.equal(item.category, "top");
  assert.equal(item.color, "blue");
  assert.equal(item.colorStatus, "mapped");
  assert.equal(item.pattern, "solid");
  assert.deepEqual(item.box, [0.2, 0.2, 0.8, 0.8], "[x,y,w,h] becomes corners");
  assert.equal(item.boxUnusable, false);
  assert.equal(item.fit, "regular");
  assert.equal(item.material, "");
  assert.deepEqual(item.seasons, ["summer"]);
  assert.equal(item.selfConfidence, 0.75);
  assert.equal(c.multipleItemsWarning, false);
  // Category names of the app map to the gold vocabulary; Unsorted is an abstention.
  for (const [app, gold] of [["Bottoms", "bottom"], ["Dresses", "dress"], ["Outerwear", "outerwear"], ["Shoes", "shoe"], ["Accessories", "accessory"], ["Unsorted", null]] as const)
    assert.equal(toSingleCase(record({}, { items: [analysisItem({ category: app, uncertain: app === "Unsorted" ? ["category"] : [], confidence: 0.5 })], warning: "" })).item!.category, gold);
  // The report built from adapted cases validates.
  const report = reportOf([c]);
  assert.deepEqual(validateSinglePredictionReport(JSON.parse(JSON.stringify(report))).problems, []);
});

test("adapter: notices, empty answers, unusable boxes and uncertain fields are carried exactly", () => {
  const multiple = toSingleCase(record({}, { items: [analysisItem()], warning: `Looks blurry. ${MULTIPLE_ITEMS_WARNING}` }));
  assert.equal(multiple.multipleItemsWarning, true);
  const empty = toSingleCase(record({}, { items: [], warning: "" }));
  assert.equal(empty.status, "completed");
  assert.equal(empty.itemCount, 0);
  assert.equal(empty.item, null);
  // The app's full-frame fallback is NOT a real box.
  const fallback = toSingleCase(record({}, { items: [analysisItem({ box: [0, 0, 1, 1] })], warning: CROP_UNVERIFIED_WARNING }));
  assert.equal(fallback.cropUnverifiedWarning, true);
  assert.equal(fallback.item!.box, null);
  assert.equal(fallback.item!.boxUnusable, true);
  // A genuine full-frame box without the notice stays a box.
  assert.deepEqual(toSingleCase(record({}, { items: [analysisItem({ box: [0, 0, 1, 1] })], warning: "" })).item!.box, [0, 0, 1, 1]);
  const doubtful = toSingleCase(record({}, { items: [analysisItem({ uncertain: ["color", "material"], confidence: 0.5, color: "chartreuse" })], warning: "" }));
  assert.deepEqual(doubtful.item!.uncertain, ["color", "material"]);
  assert.equal(doubtful.item!.colorStatus, "unmapped");
  const unnamed = toSingleCase(record({}, { items: [analysisItem({ name: "" })], warning: "" }));
  assert.equal(unnamed.item!.unnamed, true);
});

test("adapter: the server's confidence cap is enforced, and output that cannot come from analyzePhoto is invalid, never repaired", () => {
  // The app caps confidence at 0.5 whenever doubts are listed (src/domain/analysis.ts refineSingleItem).
  const refined = refineSingleItem({ ...analysisItem({ confidence: 1, uncertain: ["color", "pattern"] }) }) as { confidence: number; uncertain: string[] };
  assert.equal(refined.confidence, 0.5);
  assert.equal(toSingleCase(record({}, { items: [{ ...analysisItem(), ...refined }], warning: "" })).status, "completed");
  // A record that carries the model's raw 1.0 beside doubts did not pass through the app.
  const raw = toSingleCase(record({}, { items: [analysisItem({ confidence: 1, uncertain: ["color"] })], warning: "" }));
  assert.equal(raw.status, "invalid");
  assert.match(raw.invalidReasons.join(" "), /above the 0\.5 cap/);
  assert.equal(raw.item, null);
  assert.equal(toSingleCase(record({}, { items: [analysisItem(), analysisItem()], warning: "" })).status, "invalid");
  assert.match(toSingleCase(record({}, { items: [analysisItem({ brand: "Acme" })], warning: "" })).invalidReasons.join(" "), /brand or size/);
  assert.equal(toSingleCase(record({}, { items: [analysisItem({ box: [0.9, 0.9, 0.5, 0.5] })], warning: "" })).status, "invalid");
  assert.equal(toSingleCase(record({}, { items: [analysisItem({ box: [0.7, 0.7, 0.4, 0.4] })], warning: "" })).status, "invalid", "x+w beyond the frame");
  assert.equal(toSingleCase(record({}, { items: "nope", warning: "" })).status, "invalid");
  assert.equal(toSingleCase(record({}, { items: [analysisItem({ category: "Hats" })], warning: "" })).status, "invalid");
  // Outcomes of the app map to failure statuses and keep the duration.
  for (const [outcome, status] of [["timeout", "timeout"], ["unavailable", "failed"], ["unverified", "unverified"]] as const) {
    const c = toSingleCase(record({ outcome, analysis: null, error: "synthetic" }));
    assert.equal(c.status, status);
    assert.equal(c.elapsedMs, 90000);
    assert.equal(c.itemCount, 0);
  }
});

test("adapter: saved record validation and run information", () => {
  assert.deepEqual(validateAnalyzePhotoRecord(JSON.parse(JSON.stringify(record()))).problems, []);
  const bad = (mutate: (r: any) => void) => {
    const r = JSON.parse(JSON.stringify(record()));
    mutate(r);
    return validateAnalyzePhotoRecord(r).problems.join(" | ");
  };
  assert.match(bad((r) => delete r.imageSha256), /imageSha256/);
  assert.match(bad((r) => (r.startedAt = "noon")), /startedAt/);
  assert.match(bad((r) => (r.outcome = "ok") && (r.analysis = null)), /needs the analysis/);
  assert.match(bad((r) => (r.outcome = "timeout")), /must be null unless the outcome is ok/);
  assert.match(bad((r) => (r.extra = 1)), /unknown field "extra"/);
  const a = record({ fixtureId: "h-top-1", startedAt: "2026-10-12T02:00:00Z" });
  const b = record({ fixtureId: "h-top-2", startedAt: "2026-10-12T01:00:00Z" });
  const { run } = singleRunInfo([a, b]);
  assert.equal(run?.startedAt, "2026-10-12T01:00:00Z", "the run started when the first inference did");
  assert.equal(run?.imageHashSource, "recorded-by-run");
  assert.equal(run?.adapter, QWEN_SINGLE_ADAPTER_ID);
  assert.match(singleRunInfo([a, record({ fixtureId: "h-top-2", modelVersion: "other" })]).problems.join(" "), /another model\/version\/prompt/);
});

// ================================================================== policy

test("policy: the default is a valid, unsigned proposal; malformed policies are refused", () => {
  assert.deepEqual(validatePolicy(JSON.parse(JSON.stringify(DEFAULT_POLICY))).problems, []);
  assert.equal(DEFAULT_POLICY.approval, null);
  for (const r of DEFAULT_POLICY.rules) assert.ok(r.minN >= 1 && r.note.length > 10, r.id);
  for (const r of DEFAULT_POLICY.rules) assert.ok((METRIC_IDS as readonly string[]).includes(r.metric), r.metric);
  const bad = (mutate: (p: any) => void) => {
    const p = JSON.parse(JSON.stringify(DEFAULT_POLICY));
    mutate(p);
    return validatePolicy(p).problems.join(" | ");
  };
  assert.match(bad((p) => delete p.rules[0].minN), /minN|missing field/);
  assert.match(bad((p) => (p.rules[0].minN = 0)), /explicit minimum sample count/);
  assert.match(bad((p) => (p.rules[0].metric = "vibes")), /unknown metric/);
  assert.match(bad((p) => (p.rules[0].bound = "wilson95_upper")), /upper bound is compared with <=/);
  assert.match(bad((p) => (p.rules = p.rules.filter((r: any) => r.metric !== "latency.p95Ms"))), /must gate on latency\.p95Ms/);
  assert.match(bad((p) => (p.rules = p.rules.filter((r: any) => r.metric !== "refusal.falseAcceptRate"))), /must gate on refusal\.falseAcceptRate/);
  assert.match(bad((p) => (p.approval = { approvedBy: "", approvedAt: "x", note: "" })), /approval/);
  assert.match(bad((p) => (p.iou.selection = 0)), /policy\.iou\.selection/);
  assert.match(bad((p) => (p.minimums.requiredScenes = [])), /requiredScenes/);
  assert.match(bad((p) => (p.surprise = 1)), /unknown field "surprise"/);
  // Attribute-specific: category, colour, pattern, fit and material each have their own rule.
  for (const a of ["category", "color", "pattern", "fit", "material"]) assert.ok(DEFAULT_POLICY.rules.some((r) => r.metric === `${a}.accuracyOnAnswered`), a);
});

// ================================================================== templates and CLI

test("templates are deliberately invalid until filled in; the policy template is the unsigned proposal", () => {
  assert.ok(validateSingleManifest(templates.manifest()).problems.length > 0);
  assert.ok(validateGoldFile(templates.gold()).problems.length > 0);
  assert.ok(validateAnalyzePhotoRecord(templates.record()).problems.length > 0);
  assert.deepEqual(validatePolicy(templates.policy()).problems, []);
  assert.equal(templates.policy().approval, null);
  for (const [name, make] of [
    ["single-item-manifest.template.json", templates.manifest],
    ["single-item-gold.template.json", templates.gold],
    ["analyze-photo-record.template.json", templates.record],
    ["single-item-launch-policy.proposed.json", templates.policy],
  ] as const) {
    const file = path.join(root, "scripts/vision-evaluation/templates", name);
    assert.ok(existsSync(file), `${name} exists`);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), JSON.parse(JSON.stringify(make())), `${name} matches the generator`);
  }
});

function cliIo(now = "2026-10-11T00:00:00Z") {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l), now: () => new Date(now) } };
}

test("CLI end to end: template, freeze, validate, adapt saved records, score; evidence is never overwritten and tampering is refused", () => {
  const prefix = "single-item-024-";
  const dir = makeTempDir(prefix);
  try {
    const images = path.join(dir, "images");
    mkdirSync(images);
    const w = world(HELD, DEV);
    for (const [file, bytes] of w.images) writeFileSync(path.join(images, file), bytes);
    const write = (name: string, value: unknown) => {
      const file = path.join(dir, name);
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      return file;
    };
    // Unfrozen manifests as an operator would write them.
    const heldDoc = { ...heldOf(w), frozenAt: null };
    const devDoc = { ...w.manifests.find((m) => m.manifest.split === "development")!.manifest, frozenAt: null };
    const heldFile = write("heldout.manifest.json", heldDoc);
    const devFile = write("development.manifest.json", devDoc);
    const a = cliIo();

    // 1. freeze (held-out) against the development manifest
    const frozen = path.join(dir, "heldout.frozen.json");
    const receipt = path.join(dir, "heldout.receipt.json");
    const devFrozen = path.join(dir, "development.frozen.json");
    const devReceipt = path.join(dir, "development.receipt.json");
    assert.equal(runSingleCli(["single-freeze", "--manifest", devFile, "--images-dir", images, "--out-manifest", devFrozen, "--out-receipt", devReceipt], a.io), 0, a.err.join("\n"));
    assert.equal(runSingleCli(["single-freeze", "--manifest", heldFile, "--images-dir", images, "--out-manifest", frozen, "--out-receipt", receipt, "--against", devFrozen], a.io), 0, a.err.join("\n"));
    const receiptDoc = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(receiptDoc.manifestSha256, sha256Hex(readFileSync(frozen)), "the receipt hashes the frozen file's exact bytes");
    assert.equal(receiptDoc.frozenAt, "2026-10-11T00:00:00.000Z");
    // never overwritten, never refrozen
    const again = cliIo();
    assert.equal(runSingleCli(["single-freeze", "--manifest", heldFile, "--images-dir", images, "--out-manifest", frozen, "--out-receipt", path.join(dir, "r2.json")], again.io), 1);
    assert.match(again.err.join(" "), /already exists/);
    assert.equal(runSingleCli(["single-freeze", "--manifest", frozen, "--images-dir", images, "--out-manifest", path.join(dir, "x.json"), "--out-receipt", path.join(dir, "y.json")], again.io), 2);
    assert.match(again.err.join(" "), /already frozen/);

    // 2. gold labels (written by people; here synthetic) and validate, with and without the policy's size minimums
    const heldGoldFile = write("heldout.gold.json", heldGold(w));
    const devGoldFile = write("development.gold.json", w.gold.find((g) => g.split === "development"));
    const v = cliIo();
    assert.equal(
      runSingleCli(["single-validate", "--manifest", devFrozen, "--manifest", frozen, "--gold", devGoldFile, "--gold", heldGoldFile, "--receipt", receipt, "--images-dir", images], v.io),
      0,
      v.err.join("\n"),
    );
    assert.equal(JSON.parse(v.out.join("")).ok, true);
    const sized = cliIo();
    const defaultPolicy = path.join(dir, "policy.json");
    assert.equal(runSingleCli(["single-template", "--kind", "policy", "--out", defaultPolicy], sized.io), 0);
    assert.equal(
      runSingleCli(["single-validate", "--manifest", frozen, "--gold", heldGoldFile, "--receipt", receipt, "--images-dir", images, "--policy", defaultPolicy], sized.io),
      2,
      "the default policy needs 240 in-scope images",
    );
    assert.match(sized.err.join(" "), /held-out in-scope images: 8 \(policy minimum 240\)/);

    // 3. saved analyzePhoto records -> predictions
    const records = path.join(dir, "records");
    mkdirSync(records);
    for (const s of [...DEV, ...HELD]) {
      const analysis = s.stratum === "in_scope" ? { items: [analysisItem({ box: [0.2, 0.2, 0.6, 0.6] })], warning: "" } : { items: [], warning: "" };
      writeFileSync(path.join(records, `${s.id}.json`), JSON.stringify(record({ fixtureId: s.id, imageSha256: sha256Hex(imageFor(s.id)), startedAt: "2026-10-12T00:00:00Z" }, analysis)));
    }
    const predictions = path.join(dir, "predictions.json");
    const adapt = cliIo();
    assert.equal(runSingleCli(["single-adapt-qwen", "--records-dir", records, "--manifest", devFrozen, "--manifest", frozen, "--images-dir", images, "--out", predictions], adapt.io), 0, adapt.err.join("\n"));
    const predDoc = JSON.parse(readFileSync(predictions, "utf8"));
    assert.equal(predDoc.cases.length, DEV.length + HELD.length);
    assert.equal(predDoc.run.imageHashSource, "recorded-by-run");
    assert.deepEqual(predDoc.cases.map((c: { fixtureId: string }) => c.fixtureId), [...predDoc.cases.map((c: { fixtureId: string }) => c.fixtureId)].sort());

    // 4. score
    const reportFile = path.join(dir, "report.json");
    const sc = cliIo("2026-10-21T00:00:00Z");
    const scoreArgs = ["single-score", "--manifest", devFrozen, "--manifest", frozen, "--gold", devGoldFile, "--gold", heldGoldFile, "--receipt", receipt, "--receipt", devReceipt, "--predictions", predictions, "--images-dir", images, "--policy", defaultPolicy];
    assert.equal(runSingleCli([...scoreArgs, "--out", reportFile], sc.io), 0, sc.err.join("\n"));
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as SingleReport;
    assert.equal(report.kind, "single-item-report");
    assert.equal(report.gate.verdict, "NOT_EVALUATED", "the shipped policy is unsigned and the sample is tiny");
    assert.ok(report.inputDigests.some((d) => d.role === "predictions") && report.inputDigests.some((d) => d.role === "policy"));
    assert.ok(report.statements.some((s) => /not a claim that photo recognition works/.test(s)));
    assert.match(sc.out.join(" "), /not a launch-readiness claim/);
    // evidence is never overwritten
    const second = cliIo();
    assert.equal(runSingleCli([...scoreArgs, "--out", reportFile], second.io), 1);
    assert.match(second.err.join(" "), /already exists/);
    // a tampered image makes scoring refuse and write nothing
    writeFileSync(path.join(images, "h-top-1.png"), pngBytes(640, 480, "tampered"));
    const tampered = cliIo();
    const out2 = path.join(dir, "report2.json");
    assert.equal(runSingleCli([...scoreArgs, "--out", out2], tampered.io), 2);
    assert.match(tampered.err.join(" "), /hash/);
    assert.equal(existsSync(out2), false);
    // usage errors
    assert.equal(runSingleCli(["single-score"], cliIo().io), 1);
    assert.equal(runSingleCli(["single-nope"], cliIo().io), 1);
    assert.equal(runSingleCli(["single-template", "--kind", "gold", "--out", path.join(dir, "gold.template.json")], cliIo().io), 0);
    assert.ok(validateGoldFile(JSON.parse(readFileSync(path.join(dir, "gold.template.json"), "utf8"))).problems.length > 0);
  } finally {
    removeTempDir(dir, prefix);
  }
});

// ================================================================== compatibility with the existing suite

test("compatibility: the crowded harness keeps its own schemas and commands; the two never accept each other's files", () => {
  const existing = JSON.parse(read("scripts/vision-evaluation/manifests/development.manifest.json"));
  assert.equal(validateManifest(existing).problems.length, 0, "build 014 development manifest still validates");
  assert.ok(validateSingleManifest(existing).problems.length > 0, "the single-item validator refuses a crowded manifest");
  const single = JSON.parse(JSON.stringify(heldOf(world())));
  assert.ok(validateManifest(single).problems.length > 0, "the crowded validator refuses a single-item manifest");
  for (const command of SINGLE_COMMANDS) assert.ok(command.startsWith("single-"), command);
  const crowded = cliIo();
  assert.equal(runCli(["single-score"], crowded.io), 1, "the build 014 CLI does not know the single-item commands");
  assert.match(crowded.err.join(" "), /usage: inspect \| adapt-qwen \| score/);
  assert.equal(runCli(["inspect"], crowded.io), 1, "inspect is still the build 014 command (needs an image path)");
  // The entry point routes by command name and leaves build 014 untouched.
  const run = read("scripts/vision-evaluation/run.ts");
  assert.match(run, /SINGLE_COMMANDS/);
  assert.match(run, /runCli\(argv\)/);
});

test("documentation: the notes state the scope honestly and make no readiness claim", () => {
  const notes = read("docs/reviews/implementation-024-notes.md");
  assert.match(notes, /360/);
  assert.match(notes, /recommendation/i);
  assert.match(notes, /not a proven standard/i);
  assert.match(notes, /DeepFashion/);
  assert.match(notes, /75 to 132 seconds/);
  assert.match(notes, /3 development photos/);
  for (const line of notes.split(String.fromCharCode(10)))
    if (/ready to launch|launch[- ]ready|launch readiness/i.test(line)) assert.match(line, /no claim|not |never|cannot|open|remain/i, `a readiness phrase without a negation: ${line.slice(0, 120)}`);
  const readme = read("scripts/vision-evaluation/README.md");
  assert.match(readme, /single-score/);
  assert.match(readme, /single-freeze/);
  assert.match(readme, /NOT EVALUATED|NOT_EVALUATED/);
  assert.match(read("package.json"), /"vision:single"/);
});
