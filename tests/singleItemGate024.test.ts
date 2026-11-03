import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CROP_UNVERIFIED_WARNING, MULTIPLE_ITEMS_WARNING, SHOE_PAIR_WARNING, refineSingleItem } from "../src/domain/analysis";
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
import { SINGLE_COMMANDS, runSingleCli, writeAllOrNothing } from "../scripts/vision-evaluation/single-item/cli";
import { validateGoldFile, type GoldFile, type GoldLabel } from "../scripts/vision-evaluation/single-item/gold";
import { integrityProblems, strataProblems, type IntegrityInput } from "../scripts/vision-evaluation/single-item/integrity";
import { validateSingleManifest, type FreezeReceipt, type SingleFixture, type SingleManifest } from "../scripts/vision-evaluation/single-item/manifest";
import { DEFAULT_POLICY, METRIC_IDS, METRIC_SPECS, POLICY_FLOORS, REQUIRED_GATE_METRICS, approvePolicy, canonicalJson, policyContentSha256, validatePolicy, type LaunchPolicy, type PolicyChecks } from "../scripts/vision-evaluation/single-item/policy";
import { validateSinglePredictionReport, type SinglePrediction, type SinglePredictionCase, type SinglePredictionReport } from "../scripts/vision-evaluation/single-item/predictions";
import { RELAXED_PRECONDITION, evaluateSingle, percentile, wilson, type SingleReport } from "../scripts/vision-evaluation/single-item/score";
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

/** Synthetic runs only: skips the sample-size rules, never the direction, strictness, required-gate or approval-digest rules. */
const RELAXED: PolicyChecks = { relaxedSampleChecks: true };
const APPROVER = { by: "test-owner", at: "2026-10-20T00:00:00Z", note: "synthetic policy for tests only" };

/** A test edits a policy after approving it; this re-approves the edited content so the edit is what is tested, not the digest. */
const rebind = (p: LaunchPolicy): LaunchPolicy => (p.approval ? approvePolicy(p, APPROVER.by, APPROVER.at, APPROVER.note) : p);

/** A policy that is approved and small, so tests can reach every branch with a dozen images. All rules compare the point value. */
function testPolicy(over: Partial<LaunchPolicy> = {}): LaunchPolicy {
  const p = structuredClone(DEFAULT_POLICY);
  p.minimums = {
    heldoutInScope: 8,
    heldoutRejection: 4,
    perCategory: 1,
    perRequiredScene: 2,
    perRejectionReason: 1,
    requiredScenes: ["flat_lay", "hanging"],
    requiredRejectionReasons: ["multiple_items", "no_garment"],
  };
  // Material accuracy is computed only where the model NAMED a texture (a blank is an abstention): two photos here.
  p.rules = p.rules.map((r) => ({ ...r, bound: "point" as const, minN: r.metric === "material.accuracyOnAnswered" ? 2 : 4 }));
  return rebind({ ...p, ...over, approval: over.approval === undefined ? { ...APPROVER, approvedBy: APPROVER.by, approvedAt: APPROVER.at, policySha256: "" } : over.approval });
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
    shoePairNotice: false,
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
  shoePairNotice: false,
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
    policy: rebind(policy),
    policyChecks: RELAXED,
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

/**
 * A synthetic (relaxed-policy) report never carries a PASS: its verdict is NOT_EVALUATED by construction.
 * Tests of the gate LOGIC read what the verdict would be from the per-check statuses, ignoring only that one precondition.
 */
function verdictOf(r: SingleReport): "PASS" | "FAIL" | "NOT_EVALUATED" {
  if (r.policy.validation === "relaxed-sample-checks") {
    assert.equal(r.gate.verdict, "NOT_EVALUATED", "a relaxed report must never display PASS or FAIL as a launch verdict");
    assert.ok(r.gate.preconditions.includes(RELAXED_PRECONDITION));
  }
  if (r.gate.preconditions.some((p) => p !== RELAXED_PRECONDITION)) return "NOT_EVALUATED";
  const gates = r.gate.checks.filter((c) => c.kind === "gate");
  if (gates.some((c) => c.status === "FAIL")) return "FAIL";
  if (gates.some((c) => c.status === "NOT_EVALUATED")) return "NOT_EVALUATED";
  return "PASS";
}

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
  assert.equal(verdictOf(a), "PASS", JSON.stringify(a.gate.preconditions.concat(a.gate.checks.filter((c) => c.status !== "PASS" && c.kind === "gate").map((c) => `${c.id}:${c.detail}`))));
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
  assert.equal(verdictOf(report), "NOT_EVALUATED");
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
  assert.deepEqual(byReason.multiple_items, { reason: "multiple_items", n: 2, refused: 0, acceptedWithFittingNotice: 1, unsafeAccept: 1, silentAccept: 1, failed: 0 });
  assert.deepEqual(byReason.unusable_quality, { reason: "unusable_quality", n: 1, refused: 0, acceptedWithFittingNotice: 0, unsafeAccept: 0, silentAccept: 0, failed: 1 });
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
  assert.equal(verdictOf(perfect), "PASS");

  // A threshold exactly at the observed value passes (>=), one hair above fails.
  const edge = testPolicy();
  edge.rules = edge.rules.map((r) => (r.id === "category-accuracy" ? { ...r, threshold: 1 } : r));
  assert.equal(verdictOf(evaluateSingle(input(world(), allCases(), edge))), "PASS");
  const worse = scored((cases) => {
    caseFor(cases, "h-top-1").item!.category = "bottom";
  }, edge);
  assert.equal(verdictOf(worse), "FAIL");
  assert.equal(worse.gate.checks.find((c) => c.id === "category-accuracy")!.status, "FAIL");

  // minN larger than the data: that rule is NOT_EVALUATED and so is the verdict.
  const hungry = testPolicy();
  hungry.rules = hungry.rules.map((r) => (r.id === "color-accuracy" ? { ...r, minN: 9 } : r));
  const ne = evaluateSingle(input(world(), allCases(), hungry));
  assert.equal(ne.gate.checks.find((c) => c.id === "color-accuracy")!.status, "NOT_EVALUATED");
  assert.match(ne.gate.checks.find((c) => c.id === "color-accuracy")!.detail, /8 observations, rule needs at least 9/);
  assert.equal(verdictOf(ne), "NOT_EVALUATED");

  // FAIL beats NOT_EVALUATED when a rule definitively fails and another lacks data.
  const mixed = testPolicy();
  mixed.rules = mixed.rules.map((r) => (r.id === "color-accuracy" ? { ...r, minN: 9 } : r.id === "category-accuracy" ? { ...r, threshold: 1 } : r));
  const both = scored((cases) => {
    caseFor(cases, "h-top-1").item!.category = "bottom";
  }, mixed);
  assert.equal(verdictOf(both), "FAIL");

  // The shipped default policy is a proposal with no approval: never a PASS.
  const unsigned = evaluateSingle(input(world(), allCases(), { ...testPolicy(), approval: null }));
  assert.equal(verdictOf(unsigned), "NOT_EVALUATED");
  assert.match(unsigned.gate.preconditions.join(" "), /no approval record/);

  // Development-only predictions never give a verdict.
  const devOnly = evaluateSingle(input(world(), perfectCases(DEV)));
  assert.equal(devOnly.splits.heldout, null);
  assert.equal(verdictOf(devOnly), "NOT_EVALUATED");
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
  assert.equal(verdictOf(r), "FAIL");
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
  assert.equal(verdictOf(r), "PASS", "wrong suggestions never fail the gate");
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

// ================================================================== build 024 correction pass

const prodProblems = (mutate: (p: any) => void, base: unknown = DEFAULT_POLICY): string => {
  const p = JSON.parse(JSON.stringify(base));
  mutate(p);
  return validatePolicy(p).problems.join(" | ");
};
const ruleOf = (p: any, id: string) => p.rules.find((r: any) => r.id === id);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- B1: a policy must not be able to pass everything

test("B1 false-PASS probes: rules that cannot fail, wrong-direction comparators and vacuous thresholds are refused", () => {
  // The reviewer's examples, exactly.
  assert.match(
    prodProblems((p) => Object.assign(ruleOf(p, "false-accept-rate"), { comparator: ">=", threshold: 0, bound: "point" })),
    /refusal\.falseAcceptRate must use "<="/,
  );
  assert.match(prodProblems((p) => Object.assign(ruleOf(p, "latency-p95"), { comparator: ">=", threshold: 0 })), /latency\.p95Ms must use "<="/);
  assert.match(prodProblems((p) => (ruleOf(p, "selection-rate").minN = 1)), /minN: 1 is below 240/);
  assert.match(prodProblems((p) => (p.iou.selection = 0.01)), /policy\.iou\.selection: 0\.01 is below 0\.3/);
  assert.match(prodProblems((p) => (p.iou.usefulCrop = 0.05)), /policy\.iou\.usefulCrop/);
  assert.match(prodProblems((p) => (p.iou.usefulCropMinCoverage = 0.1)), /policy\.iou\.usefulCropMinCoverage/);
  // Right direction, threshold nobody can miss.
  assert.match(prodProblems((p) => (ruleOf(p, "category-accuracy").threshold = 0.01)), /below the weakest acceptable 0\.8 for category\.accuracyOnAnswered/);
  assert.match(prodProblems((p) => (ruleOf(p, "false-accept-rate").threshold = 1)), /above the loosest acceptable 0\.2 for refusal\.falseAcceptRate/);
  assert.match(prodProblems((p) => (ruleOf(p, "latency-p95").threshold = 1e12)), /above the loosest acceptable 300000 for latency\.p95Ms/);
  assert.match(prodProblems((p) => (ruleOf(p, "failure-rate").threshold = 0.5)), /above the loosest acceptable 0\.05 for reliability\.failureRate/);
  // Right direction, threshold nobody can meet (a policy that can never pass is a mistake, not rigour).
  assert.match(prodProblems((p) => (ruleOf(p, "false-accept-rate").threshold = 0)), /can never be met/);
  assert.match(prodProblems((p) => (ruleOf(p, "selection-rate").threshold = 1)), /can never be met/);
  // Not even numbers.
  const direct = structuredClone(DEFAULT_POLICY) as any;
  direct.rules[0].threshold = Number.POSITIVE_INFINITY;
  assert.match(validatePolicy(direct).problems.join(" | "), /finite number/);
  direct.rules[0].threshold = Number.NaN;
  assert.match(validatePolicy(direct).problems.join(" | "), /finite number/);
  // The wrong comparator on every gated metric, not only the two examples.
  let checked = 0;
  for (const [metric, spec] of Object.entries(METRIC_SPECS)) {
    if (!spec) continue;
    const rule = DEFAULT_POLICY.rules.find((r) => r.metric === metric && r.kind === "gate");
    if (!rule) continue;
    const flipped = prodProblems((p) => {
      const r = p.rules.find((x: any) => x.id === rule.id);
      r.comparator = spec.comparator === ">=" ? "<=" : ">=";
      r.bound = "point";
    });
    assert.match(flipped, new RegExp(`${esc(metric)} must use "${esc(spec.comparator)}"`), metric);
    checked++;
  }
  assert.ok(checked >= 15);
});

test("B1: the policy must gate on every required metric, and an informational rule does not count", () => {
  for (const needed of ["category.coverage", "inScope.falseRefusalRate", "crop.usefulRate", "category.macroF1", "refusal.unsafeAcceptRate", "inScope.warningRate", "color.coverage", "pattern.coverage", "fit.coverage", "material.accuracyOnAnswered"])
    assert.ok((REQUIRED_GATE_METRICS as readonly string[]).includes(needed), needed);
  for (const metric of REQUIRED_GATE_METRICS) {
    const removed = prodProblems((p) => (p.rules = p.rules.filter((r: any) => r.metric !== metric)));
    assert.match(removed, new RegExp(`must gate on ${esc(metric)}`), `removing ${metric}`);
    const demoted = prodProblems((p) => p.rules.filter((r: any) => r.metric === metric).forEach((r: any) => (r.kind = "informational")));
    assert.match(demoted, new RegExp(`must gate on ${esc(metric)}`), `demoting ${metric}`);
  }
  assert.equal(prodProblems(() => undefined), "", "the shipped proposal itself is valid");
});

test("B1: sample sizes follow the policy strata, interval bounds are required, and the minimums have floors", () => {
  assert.match(prodProblems((p) => (ruleOf(p, "selection-rate").minN = 100)), /minN: 100 is below 240/);
  assert.match(prodProblems((p) => (ruleOf(p, "false-accept-rate").minN = 5)), /minN: 5 is below 60/);
  assert.match(prodProblems((p) => (ruleOf(p, "failure-rate").minN = 10)), /minN: 10 is below 300/);
  assert.match(prodProblems((p) => (ruleOf(p, "fit-accuracy").minN = 10)), /minN: 10 is below 96/);
  assert.match(prodProblems((p) => (ruleOf(p, "selection-rate").minN = 5000)), /minN: 5000 is above 240/);
  assert.match(prodProblems((p) => (ruleOf(p, "false-accept-rate").minN = 61)), /minN: 61 is above 60/);
  assert.match(prodProblems((p) => Object.assign(ruleOf(p, "selection-rate"), { bound: "point" })), /selection\.rate must use wilson95_lower, not point/);
  assert.match(prodProblems((p) => Object.assign(ruleOf(p, "false-refusal-rate"), { bound: "point" })), /inScope\.falseRefusalRate must use wilson95_upper/);
  assert.match(prodProblems((p) => Object.assign(ruleOf(p, "category-macro-f1"), { bound: "wilson95_lower" })), /category\.macroF1 must use point/);
  assert.match(prodProblems((p) => (p.minimums.heldoutInScope = 12)), /heldoutInScope: 12 is below the floor of 100/);
  assert.match(prodProblems((p) => (p.minimums.heldoutRejection = 3)), /heldoutRejection: 3 is below the floor of 40/);
  assert.match(prodProblems((p) => (p.minimums.perCategory = 2)), /perCategory: 2 is below the floor of 10/);
  assert.match(prodProblems((p) => (p.minimums.requiredScenes = ["flat_lay", "hanging"])), /at least three scene types/);
  assert.match(prodProblems((p) => (p.minimums.requiredRejectionReasons = ["unusable_quality"])), /must include "multiple_items"/);
  assert.match(prodProblems((p) => (p.minimums.perCategory = 60)), /perCategory x 6 categories exceeds heldoutInScope/);
  for (const key of Object.keys(POLICY_FLOORS) as Array<keyof typeof POLICY_FLOORS>) assert.ok(DEFAULT_POLICY.minimums[key] >= POLICY_FLOORS[key], key);
});

test("B1: relaxed sample checks (synthetic only) never relax direction, strictness or the required gates; and are disclosed", () => {
  const relaxed = (mutate: (p: LaunchPolicy) => void) => {
    const p = structuredClone(DEFAULT_POLICY);
    mutate(p);
    return validatePolicy(p, { relaxedSampleChecks: true }).problems.join(" | ");
  };
  assert.equal(relaxed((p) => (p.minimums = testPolicy().minimums)), "", "small minimums are what 'relaxed' is for");
  assert.match(relaxed((p) => (p.minimums.heldoutInScope = 8)), /perCategory x 6 categories exceeds heldoutInScope/, "but the strata must still be satisfiable");
  assert.match(relaxed((p) => Object.assign(p.rules[1], { comparator: ">=" as const, threshold: 0 })), /must use "<="/);
  assert.match(relaxed((p) => (p.rules[0].threshold = 0.05)), /below the weakest acceptable/);
  assert.match(relaxed((p) => (p.rules = p.rules.filter((r) => r.metric !== "inScope.warningRate"))), /must gate on inScope\.warningRate/);
  assert.match(relaxed((p) => (p.iou.selection = 0.01)), /policy\.iou\.selection/);
  // A vacuous policy never reaches a verdict: scoring refuses it instead of reporting a PASS.
  const lax = testPolicy();
  lax.rules = lax.rules.map((r) => (r.id === "category-accuracy" ? { ...r, threshold: 0.01 } : r));
  assert.match(refusal(() => evaluateSingle(input(world(), allCases(), lax))), /below the weakest acceptable/);
  const dropped = testPolicy();
  dropped.rules = dropped.rules.filter((r) => r.metric !== "crop.usefulRate");
  assert.match(refusal(() => evaluateSingle(input(world(), allCases(), dropped))), /must gate on crop\.usefulRate/);
  // The synthetic report says its policy was validated loosely.
  const synthetic = evaluateSingle(input(world(), allCases()));
  assert.equal(synthetic.policy.validation, "relaxed-sample-checks");
  assert.ok(synthetic.statements.some((s) => /relaxed sample-size checks .* not launch evidence/.test(s)));
  // Default checks (no option) are production checks: the small synthetic policy is refused.
  assert.match(refusal(() => evaluateSingle({ ...input(world(), allCases()), policyChecks: undefined })), /below the floor|minN/);
  // The production default, once approved, is valid.
  assert.deepEqual(validatePolicy(approvePolicy(DEFAULT_POLICY, "owner", "2026-10-20T00:00:00Z", "approved for review")).problems, []);
});

// ---- B2: held-out evidence needs the development manifest

test("B2: a held-out score or validation without the development manifest is refused and says why", () => {
  const w = world();
  const heldOnly = { ...w, manifests: w.manifests.filter((m) => m.manifest.split === "heldout"), gold: w.gold.filter((g) => g.split === "heldout") } as World;
  const heldCases = allCases().filter((c) => c.fixtureId.startsWith("h-"));
  assert.match(problemsOf(heldOnly, heldCases).join(" | "), /without the development manifest; cross-split leakage .* cannot be checked/);
  assert.match(refusal(() => evaluateSingle(input(heldOnly, heldCases))), /without the development manifest/);
  // The leakage the missing manifest would have hidden is exactly what the full check catches.
  const leaky = clone(w);
  fixtureById(heldOf(leaky), "h-top-1").sourceShootId = "shoot-d-top";
  assert.match(problemsOf(leaky, allCases()).join(" | "), /leakage: source shoot "shoot-d-top" is in the development split/);
  const hidden = { ...leaky, manifests: leaky.manifests.filter((m) => m.manifest.split === "heldout"), gold: leaky.gold.filter((g) => g.split === "heldout") } as World;
  assert.ok(problemsOf(hidden).length > 0, "the same data is not accepted just because the other split was left out");
  // An empty development manifest would make the leakage check vacuous.
  assert.match(problemsOf(world(HELD, []), allCases({ held: HELD, dev: [] })).join(" | "), /development manifest lists no fixtures/);
  // Development-only data is still checkable (it is not held-out evidence).
  const devOnly = { ...w, manifests: w.manifests.filter((m) => m.manifest.split === "development"), gold: w.gold.filter((g) => g.split === "development"), receipts: [] } as World;
  assert.deepEqual(problemsOf(devOnly), []);
});

test("B2: the report states which splits were checked together", () => {
  const r = evaluateSingle(input(world(), allCases()));
  assert.deepEqual(r.integrity.splitsChecked, ["development", "heldout"]);
  assert.equal(r.integrity.crossSplitLeakageChecked, true);
  assert.equal(r.integrity.developmentFixtures, DEV.length);
  assert.equal(r.integrity.heldoutFixtures, HELD.length);
  for (const key of ["source shoot", "garment", "source page", "original file hash", "image hash"]) assert.ok(r.integrity.leakageKeys.includes(key), key);
});

// ---- M1: approval is bound to the policy content

test("M1: an approval binds to a canonical digest of the policy content; any later change breaks it", () => {
  const approved = approvePolicy(DEFAULT_POLICY, "owner@example.com", "2026-10-20T00:00:00Z", "reviewed the thresholds");
  assert.deepEqual(validatePolicy(JSON.parse(JSON.stringify(approved))).problems, []);
  assert.equal(approved.approval!.policySha256, policyContentSha256(DEFAULT_POLICY));
  assert.equal(policyContentSha256(approved), policyContentSha256(DEFAULT_POLICY), "the approval record is not part of what it approves");
  // Tampering after approval: a threshold, a minimum, an IoU, a rule removed, a version, notes.
  const edits: Array<[string, (p: any) => void]> = [
    ["threshold", (p) => (ruleOf(p, "selection-rate").threshold = 0.91)],
    ["minimum", (p) => (p.minimums.heldoutInScope = 239)],
    ["iou", (p) => (p.iou.selection = 0.4)],
    ["rule removed", (p) => (p.rules = p.rules.filter((r: any) => r.id !== "seasons-jaccard"))],
    ["version", (p) => (p.version = "1.1.1")],
    ["notes", (p) => (p.notes = "different notes")],
  ];
  for (const [what, mutate] of edits) assert.match(prodProblems(mutate, approved), /does not match this policy's content/, what);
  // A forged, missing or malformed digest is refused too.
  assert.match(prodProblems((p) => (p.approval.policySha256 = "a".repeat(64)), approved), /does not match this policy's content/);
  assert.match(prodProblems((p) => (p.approval.policySha256 = "nope"), approved), /policySha256/);
  assert.match(prodProblems((p) => delete p.approval.policySha256, approved), /policySha256|missing field/);
  // The approval record's own wording is not part of what it approves.
  const reworded = JSON.parse(JSON.stringify(approved));
  reworded.approval.note = "changed wording of the approval note";
  assert.deepEqual(validatePolicy(reworded).problems, []);
});

test("M1: the digest is canonical (independent of key order) and scoring refuses a tampered approved policy", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), canonicalJson({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), "array order is content");
  const approved = approvePolicy(DEFAULT_POLICY, "owner", "2026-10-20T00:00:00Z", "ok");
  const original = JSON.parse(JSON.stringify(approved));
  const shuffled: Record<string, unknown> = {};
  for (const k of Object.keys(original).reverse()) shuffled[k] = original[k];
  shuffled.rules = original.rules.map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).reverse()));
  assert.deepEqual(validatePolicy(shuffled).problems, [], "key order does not change the digest");
  assert.equal(policyContentSha256(shuffled), policyContentSha256(approved));
  // evaluateSingle re-checks the digest itself, so a caller cannot bypass the file loader.
  const base = testPolicy();
  const stale = { ...base, rules: base.rules.map((r) => (r.id === "category-accuracy" ? { ...r, threshold: 0.81 } : r)) };
  assert.match(refusal(() => evaluateSingle({ ...input(world(), allCases()), policy: stale })), /does not match this policy's content/);
  // The report exposes the content digest, the document digest and that the approval verified.
  const report = evaluateSingle(input(world(), allCases()));
  assert.equal(report.policy.approved, true);
  assert.equal(report.policy.approvalBoundToContent, true);
  assert.match(report.policy.contentSha256, /^[0-9a-f]{64}$/);
  assert.match(report.policy.documentSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(report.policy.contentSha256, report.policy.documentSha256, "the document digest includes the approval");
  assert.equal(report.policy.contentSha256, policyContentSha256(testPolicy()));
  const unsigned = evaluateSingle(input(world(), allCases(), testPolicy({ approval: null })));
  assert.equal(unsigned.policy.approved, false);
  assert.equal(unsigned.policy.approvalBoundToContent, false);
  assert.equal(verdictOf(unsigned), "NOT_EVALUATED");
});

test("M1: single-approve writes a bound approval; a policy edited afterwards is refused by the CLI", () => {
  const prefix = "single-item-024-approve-";
  const dir = makeTempDir(prefix);
  try {
    const proposed = path.join(dir, "policy.proposed.json");
    const approvedFile = path.join(dir, "policy.approved.json");
    assert.equal(runSingleCli(["single-template", "--kind", "policy", "--out", proposed], cliIo().io), 0);
    const bad = cliIo();
    assert.equal(runSingleCli(["single-approve", "--policy", proposed, "--out", approvedFile], bad.io), 1);
    assert.match(bad.err.join(" "), /--approved-by .* --note/);
    const a = cliIo("2026-10-22T00:00:00Z");
    assert.equal(runSingleCli(["single-approve", "--policy", proposed, "--approved-by", "Owner Name", "--note", "reviewed all thresholds", "--out", approvedFile], a.io), 0, a.err.join("\n"));
    const doc = JSON.parse(readFileSync(approvedFile, "utf8"));
    assert.equal(doc.approval.approvedBy, "Owner Name");
    assert.equal(doc.approval.approvedAt, "2026-10-22T00:00:00.000Z");
    assert.equal(doc.approval.policySha256, policyContentSha256(DEFAULT_POLICY));
    assert.deepEqual(validatePolicy(doc).problems, []);
    assert.match(a.out.join(" "), /does not make the product ready/);
    // never overwritten, never re-approved, never the input path
    assert.equal(runSingleCli(["single-approve", "--policy", proposed, "--approved-by", "x", "--note", "y", "--out", approvedFile], cliIo().io), 1);
    const again = cliIo();
    assert.equal(runSingleCli(["single-approve", "--policy", approvedFile, "--approved-by", "x", "--note", "y", "--out", path.join(dir, "again.json")], again.io), 2);
    assert.match(again.err.join(" "), /already approved/);
    assert.equal(runSingleCli(["single-approve", "--policy", proposed, "--approved-by", "x", "--note", "y", "--out", proposed], cliIo().io), 1);
    // Edit one threshold in the approved file: scoring refuses.
    const edited = path.join(dir, "policy.edited.json");
    const tampered = JSON.parse(readFileSync(approvedFile, "utf8"));
    ruleOf(tampered, "selection-rate").threshold = 0.91;
    writeFileSync(edited, JSON.stringify(tampered));
    const sc = cliIo();
    assert.equal(
      runSingleCli(["single-score", "--manifest", "m.json", "--gold", "g.json", "--predictions", "p.json", "--images-dir", dir, "--policy", edited, "--out", path.join(dir, "r.json")], sc.io),
      2,
    );
    assert.match(sc.err.join(" "), /does not match this policy's content/);
    assert.equal(existsSync(path.join(dir, "r.json")), false);
    const validateTampered = cliIo();
    assert.equal(runSingleCli(["single-validate", "--manifest", "m.json", "--images-dir", dir, "--policy", edited], validateTampered.io), 1, "unreadable manifest is a usage error before the policy matters");
  } finally {
    removeTempDir(dir, prefix);
  }
});

// ---- M2: warning about everything must not pass

test("M2: a rejection photo answered with an item and the WRONG kind of notice is an unsafe accept", () => {
  const spec = (id: string) => HELD.find((s) => s.id === id)!;
  const r = scored((cases) => {
    // multiple_items photo: crop-only notice (not the right notice) -> unsafe; the strict silent metric does not see it
    Object.assign(caseFor(cases, "h-rej-multi-1"), { multipleItemsWarning: false, cropUnverifiedWarning: true });
    // no_garment photo: an item with a multiple-items notice -> unsafe (the notice does not fit the reason)
    Object.assign(caseFor(cases, "h-rej-none"), okCase(spec("h-rej-none"), {}, { multipleItemsWarning: true }));
  });
  const h = r.splits.heldout!;
  assert.equal(heldCase(r, "h-rej-multi-1").disposition, "accepted_with_crop_warning");
  assert.equal(heldCase(r, "h-rej-multi-1").unsafeAccept, true);
  assert.equal(heldCase(r, "h-rej-none").unsafeAccept, true);
  assert.equal(heldCase(r, "h-rej-multi-2").unsafeAccept, false);
  assert.equal(heldCase(r, "h-rej-quality").unsafeAccept, false);
  assert.equal(heldCase(r, "h-top-1").unsafeAccept, null, "in-scope photos have no unsafe-accept notion");
  assert.equal(h.falseAccept.value, 0, "the strict silent-accept metric is unchanged and still blind to notices");
  assert.equal(h.unsafeAccept.value, 0.5);
  assert.equal(r.gate.checks.find((c) => c.id === "unsafe-accept-rate")!.status, "FAIL");
  assert.equal(r.gate.checks.find((c) => c.id === "false-accept-rate")!.status, "PASS");
  assert.equal(verdictOf(r), "FAIL");
  const byReason = Object.fromEntries(h.rejectionByReason.map((x) => [x.reason, x]));
  assert.deepEqual(byReason.multiple_items, { reason: "multiple_items", n: 2, refused: 0, acceptedWithFittingNotice: 1, unsafeAccept: 1, silentAccept: 0, failed: 0 });
  assert.deepEqual(byReason.no_garment, { reason: "no_garment", n: 1, refused: 0, acceptedWithFittingNotice: 0, unsafeAccept: 1, silentAccept: 0, failed: 0 });
  // A failure is not an accept; it is the failure rate's business.
  const failed = scored((cases) => Object.assign(caseFor(cases, "h-rej-multi-1"), failedCase(spec("h-rej-multi-1"), "timeout", 180000)));
  assert.equal(heldCase(failed, "h-rej-multi-1").unsafeAccept, false);
  assert.equal(failed.splits.heldout!.unsafeAccept.value, 0);
});

test("M2: a model that warns about everything cannot pass: it fails the in-scope warning gate", () => {
  const warnEverywhere = scored((cases) => cases.forEach((c) => (c.multipleItemsWarning = true)));
  const h = warnEverywhere.splits.heldout!;
  assert.equal(h.falseAccept.value, 0, "warning everywhere makes the strict metric look perfect");
  assert.equal(h.inScopeWarning.value, 1);
  assert.equal(warnEverywhere.gate.checks.find((c) => c.id === "in-scope-warning-rate")!.status, "FAIL");
  assert.equal(verdictOf(warnEverywhere), "FAIL");
  // Crop-unverified notices count as warnings too; a shoe-pair notice does not.
  const cropEverywhere = scored((cases) => cases.forEach((c) => (c.cropUnverifiedWarning = true)));
  assert.equal(cropEverywhere.splits.heldout!.inScopeWarning.value, 1);
  assert.equal(verdictOf(cropEverywhere), "FAIL");
  const pairNotice = scored((cases) => (caseFor(cases, "h-shoe").shoePairNotice = true));
  assert.equal(pairNotice.splits.heldout!.inScopeWarning.value, 0);
  assert.equal(pairNotice.splits.heldout!.shoePairNotices, 1);
  assert.equal(verdictOf(pairNotice), "PASS", "a shoe-pair notice is carried and reported, not penalised");
  assert.equal(scored(() => undefined).splits.heldout!.inScopeWarning.value, 0);
});

// ---- low items

test("low: the adapter carries the shoe-pair notice through to the prediction report", () => {
  const pair = toSingleCase(record({}, { items: [analysisItem({ category: "Shoes", name: "Black sneakers (pair)" })], warning: SHOE_PAIR_WARNING }));
  assert.equal(pair.status, "completed");
  assert.equal(pair.shoePairNotice, true);
  assert.equal(pair.multipleItemsWarning, false);
  assert.equal(toSingleCase(record()).shoePairNotice, false);
  assert.equal(toSingleCase(record({ outcome: "timeout", analysis: null, error: "t" })).shoePairNotice, false);
  const both = toSingleCase(record({}, { items: [analysisItem()], warning: `${SHOE_PAIR_WARNING} ${MULTIPLE_ITEMS_WARNING}` }));
  assert.equal(both.shoePairNotice && both.multipleItemsWarning, true);
  assert.deepEqual(validateSinglePredictionReport(JSON.parse(JSON.stringify(reportOf([pair])))).problems, []);
  const missing = JSON.parse(JSON.stringify(reportOf([pair])));
  delete missing.cases[0].shoePairNotice;
  assert.match(validateSinglePredictionReport(missing).problems.join(" "), /shoePairNotice|warning flags/);
});

test("low: a blank material is an abstention, not a correct 'none visible' answer", () => {
  const perfect = scored(() => undefined).splits.heldout!.attributes.material;
  // Gold: leather and knit are visible textures; five photos are none_visible; the shoe is unknown. The model named only the two textures.
  assert.equal(perfect.goldKnown, 7);
  assert.equal(perfect.answered, 2);
  assert.equal(perfect.correct, 2);
  assert.equal(perfect.abstained, 5, "five blanks on none-visible gold are not credited as correct");
  assert.equal(perfect.coverage.value, r6(2 / 7));
  assert.equal(perfect.accuracyOnAnswered.value, 1);
  assert.equal(perfect.endToEndCorrect.value, r6(2 / 7));
  const r = scored((cases) => (caseFor(cases, "h-top-1").item!.material = "denim")); // gold none_visible, the model names a texture
  assert.equal(heldCase(r, "h-top-1").attributes!.material.state, "wrong");
  assert.equal(r.splits.heldout!.attributes.material.wrong, 1);
  assert.equal(heldCase(r, "h-top-2").attributes!.material.state, "abstained");
  assert.equal(heldCase(r, "h-top-2").attributes!.material.predicted, null);
  // A model that never names a texture cannot pass the material gate by saying nothing.
  const silent = scored((cases) => cases.forEach((c) => c.item && (c.item.material = "")));
  assert.equal(silent.splits.heldout!.attributes.material.answered, 0);
  assert.equal(silent.splits.heldout!.attributes.material.accuracyOnAnswered.value, null);
  assert.equal(silent.gate.checks.find((c) => c.id === "material-accuracy")!.status, "NOT_EVALUATED");
  assert.equal(verdictOf(silent), "NOT_EVALUATED");
});

test("low: single-freeze refuses colliding paths and writes both files or neither", () => {
  const prefix = "single-item-024-freeze-";
  const dir = makeTempDir(prefix);
  try {
    const images = path.join(dir, "images");
    mkdirSync(images);
    const w = world(HELD, DEV);
    for (const [file, bytes] of w.images) writeFileSync(path.join(images, file), bytes);
    const devFile = path.join(dir, "development.manifest.json");
    const heldFile = path.join(dir, "heldout.manifest.json");
    writeFileSync(devFile, JSON.stringify({ ...w.manifests.find((m) => m.manifest.split === "development")!.manifest, frozenAt: null }));
    writeFileSync(heldFile, JSON.stringify({ ...heldOf(w), frozenAt: null }));
    const names = () => readdirSync(dir).sort().join(",");
    const before = names();
    const same = path.join(dir, "same.json");
    const a = cliIo();
    assert.equal(runSingleCli(["single-freeze", "--manifest", devFile, "--images-dir", images, "--out-manifest", same, "--out-receipt", same], a.io), 1);
    assert.match(a.err.join(" "), /same path/);
    // an output path that is the input manifest
    assert.equal(runSingleCli(["single-freeze", "--manifest", devFile, "--images-dir", images, "--out-manifest", path.join(dir, "x.json"), "--out-receipt", devFile], cliIo().io), 1);
    assert.equal(names(), before, "nothing was written");
    // The second file cannot be created (its directory is missing): neither file exists afterwards, and no temp file is left.
    const b = cliIo();
    assert.equal(
      runSingleCli(["single-freeze", "--manifest", devFile, "--images-dir", images, "--out-manifest", path.join(dir, "dev.frozen.json"), "--out-receipt", path.join(dir, "missing-dir", "dev.receipt.json")], b.io),
      1,
    );
    assert.equal(names(), before, "an incomplete freeze leaves no manifest without its receipt, and no temp files");
    // A held-out freeze without the development manifest is refused (leakage cannot be checked).
    const c = cliIo();
    assert.equal(runSingleCli(["single-freeze", "--manifest", heldFile, "--images-dir", images, "--out-manifest", path.join(dir, "h.frozen.json"), "--out-receipt", path.join(dir, "h.receipt.json")], c.io), 2);
    assert.match(c.err.join(" "), /without the development manifest/);
    assert.equal(names(), before);
    // The happy path still writes both, and the receipt names the file's exact bytes.
    const d = cliIo();
    assert.equal(runSingleCli(["single-freeze", "--manifest", devFile, "--images-dir", images, "--out-manifest", path.join(dir, "dev.frozen.json"), "--out-receipt", path.join(dir, "dev.receipt.json")], d.io), 0, d.err.join("\n"));
    assert.equal(JSON.parse(readFileSync(path.join(dir, "dev.receipt.json"), "utf8")).manifestSha256, sha256Hex(readFileSync(path.join(dir, "dev.frozen.json"))));
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp-")), []);
  } finally {
    removeTempDir(dir, prefix);
  }
});

test("low: the source collection list is closed (no catch-all) and provenance fields are documented as claims", () => {
  const m = clone(heldOf(world()));
  (m.fixtures[0].rights as { sourceCollection: string }).sourceCollection = "other-verified";
  assert.match(validateSingleManifest(JSON.parse(JSON.stringify(m))).problems.join(" "), /sourceCollection: must be one of wikimedia-commons, open-images, self-owned-with-release/);
  assert.ok(!read("scripts/vision-evaluation/templates/single-item-manifest.template.json").includes("other-verified"));
  assert.match(read("scripts/vision-evaluation/single-item/manifest.ts"), /CLAIM by the person who built the manifest/);
  assert.match(read("scripts/vision-evaluation/README.md"), /Provenance fields are claims/);
});

test("documentation: the unexpected build commit, the bound approval and the unsafe-accept gate are recorded", () => {
  const notes = read("docs/reviews/implementation-024-notes.md");
  assert.match(notes, /a288df1/);
  assert.match(notes, /explicit no-commit instruction/i);
  assert.match(notes, /uncommitted for root review/i);
  assert.match(notes, /policySha256|content digest/);
  assert.match(notes, /unsafe accept/i);
  assert.match(notes, /development manifest/i);
  const readme = read("scripts/vision-evaluation/README.md");
  assert.match(readme, /single-approve/);
  assert.match(readme, /refusal\.unsafeAcceptRate/);
});

test("low: writeAllOrNothing never overwrites, rolls back every file it created on failure, and is deterministic (no hard links)", () => {
  const prefix = "single-item-024-atomic-";
  const dir = makeTempDir(prefix);
  try {
    const names = () => readdirSync(dir).sort().join(",");
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "b.json");
    // success: both exist, bytes are the canonical text, digests match the bytes, no temp files
    const digests = writeAllOrNothing([{ file: a, value: { x: 1 } }, { file: b, value: { y: [2] } }]);
    assert.equal(readFileSync(a, "utf8"), JSON.stringify({ x: 1 }, null, 2) + "\n");
    assert.deepEqual(digests, [sha256Hex(readFileSync(a)), sha256Hex(readFileSync(b))]);
    assert.equal(names(), "a.json,b.json");
    // second path exists: refused, existing file untouched, the first new file is rolled back
    const c = path.join(dir, "c.json");
    assert.throws(() => writeAllOrNothing([{ file: c, value: 1 }, { file: b, value: 2 }]), /already exists/);
    assert.equal(existsSync(c), false);
    assert.equal(readFileSync(b, "utf8"), JSON.stringify({ y: [2] }, null, 2) + "\n", "an existing file is never overwritten");
    // first path exists: nothing at all is created
    const d = path.join(dir, "d.json");
    assert.throws(() => writeAllOrNothing([{ file: a, value: 1 }, { file: d, value: 2 }]), /already exists/);
    assert.equal(existsSync(d), false);
    // second path cannot be created (missing directory): first is rolled back
    const e = path.join(dir, "e.json");
    assert.throws(() => writeAllOrNothing([{ file: e, value: 1 }, { file: path.join(dir, "nope", "f.json"), value: 2 }]), /ENOENT/);
    assert.equal(existsSync(e), false);
    // a directory squatting on the second name counts as existing
    mkdirSync(path.join(dir, "g.json"));
    assert.throws(() => writeAllOrNothing([{ file: path.join(dir, "h.json"), value: 1 }, { file: path.join(dir, "g.json"), value: 2 }]), /already exists/);
    assert.equal(existsSync(path.join(dir, "h.json")), false);
    assert.equal(names(), "a.json,b.json,g.json", "no partial or temporary file survives any failure");
    assert.doesNotMatch(read("scripts/vision-evaluation/single-item/cli.ts"), /(?<!un)linkSync/);
  } finally {
    removeTempDir(dir, prefix);
  }
});

// ================================================================== N1: production-scale sample sizes

const PROD_CATEGORIES: GoldCategory[] = ["top", "bottom", "dress", "outerwear", "shoe", "accessory"];
const PROD_SCENES: SceneType[] = ["flat_lay", "hanging", "mannequin", "worn", "product_shot"];
const PROD_REASONS: RejectionReason[] = ["multiple_items", "no_garment", "unusable_quality"];
const PROD_COLORS: GoldColor[] = ["black", "white", "gray", "beige", "brown", "red", "blue", "green"];
const PROD_PATTERNS: GoldPattern[] = ["solid", "striped", "checked", "floral"];
const pad = (n: number) => String(n).padStart(3, "0");

/** The shipped benchmark shape: 240 in-scope + 60 rejection held-out photos (synthetic images), a small development split. */
function productionSpecs(): { held: Spec[]; dev: Spec[] } {
  const held: Spec[] = [];
  for (let i = 0; i < 240; i++)
    held.push({
      id: `p-in-${pad(i)}`,
      stratum: "in_scope",
      category: PROD_CATEGORIES[i % 6],
      scene: PROD_SCENES[i % 5],
      color: PROD_COLORS[i % PROD_COLORS.length],
      pattern: PROD_PATTERNS[i % PROD_PATTERNS.length],
      fit: "regular",
      material: i % 2 === 0 ? "leather" : "none_visible",
    });
  for (let i = 0; i < 60; i++) held.push({ id: `p-rej-${pad(i)}`, stratum: "rejection", reason: PROD_REASONS[i % 3], scene: "other" });
  const dev: Spec[] = [
    { id: "pd-1", stratum: "in_scope", category: "top" },
    { id: "pd-2", stratum: "in_scope", category: "bottom" },
    { id: "pd-3", stratum: "rejection", reason: "no_garment", scene: "other" },
  ];
  return { held, dev };
}

const PROD_APPROVED = () => approvePolicy(DEFAULT_POLICY, "owner", "2026-10-20T00:00:00Z", "synthetic production-scale test of the shipped proposal");

/** Scores the production-scale world under the shipped policy and PRODUCTION checks. `abstain` marks which in-scope photos get doubts. */
function productionRun(abstain: { category?: (i: number) => boolean; color?: (i: number) => boolean }, policy: LaunchPolicy = PROD_APPROVED()): SingleReport {
  const { held, dev } = productionSpecs();
  const w = world(held, dev);
  const cases = [...perfectCases(dev), ...perfectCases(held)];
  held
    .filter((s) => s.stratum === "in_scope")
    .forEach((s, i) => {
      const item = caseFor(cases, s.id).item!;
      const doubts: Array<"category" | "color" | "pattern"> = [];
      if (abstain.category?.(i)) doubts.push("category");
      if (abstain.color?.(i)) doubts.push("color", "pattern");
      item.uncertain = doubts;
    });
  return evaluateSingle({ ...input(w, cases, policy), policy, policyChecks: undefined });
}

test("N1: the shipped benchmark shape is valid under production checks (strata, floors and the shipped sample sizes agree)", () => {
  const { held, dev } = productionSpecs();
  const w = world(held, dev);
  assert.deepEqual(strataProblems(heldOf(w), heldGold(w), DEFAULT_POLICY), []);
  assert.deepEqual(validatePolicy(PROD_APPROVED()).problems, []);
  for (const id of ["category-accuracy", "color-accuracy", "pattern-accuracy"]) {
    const minN = DEFAULT_POLICY.rules.find((r) => r.id === id)!.minN;
    assert.ok(minN >= Math.ceil(0.6 * 240) && minN <= 240, `${id} minN ${minN} lies in the answered-sample range`);
  }
});

test("N1: about 95% answered with perfect accuracy CAN PASS under the shipped policy and production checks", () => {
  // Category answered on 228 of 240 (0.95 coverage), colour and pattern on 216 (0.90): exactly at the shipped coverage gates.
  const r = productionRun({ category: (i) => i % 20 === 0, color: (i) => i % 10 === 0 });
  const h = r.splits.heldout!;
  assert.equal(r.policy.validation, "production");
  assert.equal(h.attributes.category.answered, 228);
  assert.equal(h.attributes.color.answered, 216);
  assert.equal(h.attributes.pattern.answered, 216);
  assert.equal(h.attributes.category.accuracyOnAnswered.value, 1);
  assert.deepEqual(r.gate.preconditions, []);
  const notPassing = r.gate.checks.filter((c) => c.kind === "gate" && c.status !== "PASS").map((c) => `${c.id}: ${c.status} ${c.detail}`);
  assert.deepEqual(notPassing, []);
  for (const id of ["category-accuracy", "color-accuracy", "pattern-accuracy"]) assert.equal(r.gate.checks.find((c) => c.id === id)!.status, "PASS", id);
  assert.equal(r.gate.verdict, "PASS", "a compliant model with ~95% coverage and perfect accuracy reaches PASS when every other gate passes");
  assert.equal(r.policy.approved, true);
});

test("N1: too few answers keep the accuracy gates NOT_EVALUATED, and coverage still bounds abstention", () => {
  // Half of the categories unanswered: 120 answers < minN 216.
  const half = productionRun({ category: (i) => i % 2 === 0 });
  const acc = half.gate.checks.find((c) => c.id === "category-accuracy")!;
  assert.equal(acc.status, "NOT_EVALUATED");
  assert.match(acc.detail, /120 observations, rule needs at least 216/);
  assert.equal(half.gate.checks.find((c) => c.id === "category-coverage")!.status, "FAIL");
  assert.notEqual(half.gate.verdict, "PASS");
  // Boundary: 216 answers meet minN (the accuracy gate is evaluated), 215 do not.
  const at = productionRun({ category: (i) => i % 10 === 0 }); // 24 abstentions: 216 answered
  assert.equal(at.splits.heldout!.attributes.category.answered, 216);
  assert.equal(at.gate.checks.find((c) => c.id === "category-accuracy")!.status, "PASS");
  assert.equal(at.gate.checks.find((c) => c.id === "category-coverage")!.status, "FAIL", "0.90 is below the 0.95 coverage gate: abstention is bounded there");
  assert.equal(at.gate.verdict, "FAIL");
  const below = productionRun({ category: (i) => i < 25 }); // 25 abstentions: 215 answered
  assert.equal(below.splits.heldout!.attributes.category.answered, 215);
  assert.equal(below.gate.checks.find((c) => c.id === "category-accuracy")!.status, "NOT_EVALUATED");
  // A model that answers nothing is not evaluated on accuracy and fails coverage: never a PASS.
  const none = productionRun({ category: () => true, color: () => true });
  assert.equal(none.gate.checks.find((c) => c.id === "category-accuracy")!.status, "NOT_EVALUATED");
  assert.equal(none.gate.verdict, "FAIL");
});

test("N1: when the coverage gate is passed but too few answers exist, the VERDICT is NOT_EVALUATED (not FAIL, not PASS)", () => {
  // A valid production policy: category coverage at its floor (0.8) and the accuracy rule demanding the full 240 answers.
  const strictSample = structuredClone(DEFAULT_POLICY);
  strictSample.rules = strictSample.rules.map((r) =>
    r.id === "category-coverage" ? { ...r, threshold: 0.8 } : r.id === "category-accuracy" ? { ...r, minN: 240 } : r,
  );
  const approved = approvePolicy(strictSample, "owner", "2026-10-20T00:00:00Z", "stricter sample for the accuracy gate");
  assert.deepEqual(validatePolicy(approved).problems, []);
  const r = productionRun({ category: (i) => i % 36 < 6 }, approved); // 42 abstentions spread over every category: 198 answered, coverage 0.825
  assert.equal(r.splits.heldout!.attributes.category.answered, 198);
  assert.equal(r.gate.checks.find((c) => c.id === "category-coverage")!.status, "PASS");
  assert.equal(r.gate.checks.find((c) => c.id === "category-accuracy")!.status, "NOT_EVALUATED");
  assert.deepEqual(r.gate.checks.filter((c) => c.kind === "gate" && c.status === "FAIL").map((c) => c.id), []);
  assert.equal(r.gate.verdict, "NOT_EVALUATED");
});

test("N1: the answered-sample range is enforced by the validator and does not weaken the other minN rules", () => {
  const accRule = (id: string, minN: number) => prodProblems((p) => (ruleOf(p, id).minN = minN));
  for (const id of ["category-accuracy", "color-accuracy", "pattern-accuracy"]) {
    assert.equal(accRule(id, 144), "", `${id}: 60% of 240 is allowed`);
    assert.equal(accRule(id, 216), "");
    assert.equal(accRule(id, 240), "");
    assert.match(accRule(id, 143), /minN: 143 is below 144/, id);
    assert.match(accRule(id, 1), /is below 144/, id);
    assert.match(accRule(id, 241), /minN: 241 is above 240/, id);
  }
  // Metrics over the FULL in-scope sample still demand all of it.
  assert.match(accRule("selection-rate", 216), /minN: 216 is below 240/);
  assert.match(accRule("category-coverage", 216), /minN: 216 is below 240/);
  assert.match(accRule("crop-useful", 100), /is below 240/);
  assert.match(accRule("false-accept-rate", 59), /is below 60/);
  // Every other protection is untouched.
  assert.match(prodProblems((p) => (ruleOf(p, "category-accuracy").threshold = 0.05)), /below the weakest acceptable/);
  assert.match(prodProblems((p) => (p.rules = p.rules.filter((r: any) => r.metric !== "category.coverage"))), /must gate on category\.coverage/);
  assert.match(prodProblems((p) => Object.assign(ruleOf(p, "category-accuracy"), { bound: "point" })), /must use wilson95_lower/);
});

// ================================================================== relaxed checks never display a verdict

test("relaxed sample checks force the overall verdict to NOT_EVALUATED, even for a perfect synthetic run", () => {
  const r = evaluateSingle(input(world(), allCases()));
  assert.equal(r.policy.validation, "relaxed-sample-checks");
  assert.equal(r.gate.verdict, "NOT_EVALUATED");
  assert.ok(r.gate.preconditions.includes(RELAXED_PRECONDITION));
  // The per-check statuses still show the gate logic working (this is what the logic tests read).
  assert.ok(r.gate.checks.filter((c) => c.kind === "gate").every((c) => c.status === "PASS"));
  assert.equal(verdictOf(r), "PASS");
  assert.equal(JSON.stringify(r.gate).includes('"verdict":"PASS"'), false, "a synthetic report never contains a PASS verdict");
  // A failing synthetic run does not display FAIL as a verdict either; its failing check is visible.
  const bad = scored((cases) => (caseFor(cases, "h-top-1").item!.category = "bottom"));
  assert.equal(bad.gate.verdict, "NOT_EVALUATED");
  assert.ok(bad.gate.checks.some((c) => c.status === "FAIL"));
  // The production default is not affected: unapproved is NOT_EVALUATED for its own reason.
  const production = evaluateSingle({ ...input(world(), allCases(), testPolicy({ approval: null })), policyChecks: undefined, policy: DEFAULT_POLICY });
  assert.ok(!production.gate.preconditions.includes(RELAXED_PRECONDITION));
});
