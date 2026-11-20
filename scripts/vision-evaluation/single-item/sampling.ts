import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { ID_RE, expectKeys, isNonEmptyString, isRecord } from "../check";
import { EvaluationRefusal } from "../evaluate";
import { sha256Hex } from "../image";
import type { Box } from "../types";
import { Creations, readWorkspaceFile, realFs, type FsOps } from "./fsx";
import { validateGoldFile, type GoldLabel } from "./gold";
import { integrityProblems } from "./integrity";
import { nearDuplicate, poolPath, readSeal, stableText, type IntakeRecord, type Seal, type Workspace } from "./intake";
import { validateFreezeReceipt, validateSingleManifest, type FreezeReceipt, type SingleManifest } from "./manifest";
import { DEFAULT_POLICY, canonicalJson, policyContentSha256, type LaunchPolicy } from "./policy";
import { goldFile, type FinalLabel, type FinalReason } from "./review";
import { imagesFrom } from "./runner";
import {
  BACKGROUNDS,
  CAMERAS,
  GOLD_CATEGORIES,
  GOLD_COLORS,
  GOLD_PATTERNS,
  ITEM_SIZES,
  LIGHTINGS,
  WEARABLE_TYPES,
  type ItemSize,
  type SceneType,
  type WearableType,
} from "./vocab";

/**
 * Deterministic sampling and freeze for the intake workspace (build 026).
 *
 * `planSample` assigns every reviewed photo to the development or held-out split from a coverage spec and a
 * seed, never splitting a shoot, a garment or a near-duplicate group across the two, and reports every
 * coverage deficit explicitly. `freezeFromPlan` re-derives the plan, refuses it if anything changed or if any
 * deficit remains, and writes the manifests, gold files, freeze receipts and image folders through the
 * existing Build 024/025 schemas and integrity checks. Nothing here measures accuracy.
 */

export const COVERAGE_DIMENSIONS = ["category", "color", "pattern", "background", "lighting", "camera", "itemSize", "wearableType"] as const;
export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

const VALUES: Record<CoverageDimension, readonly string[]> = {
  category: GOLD_CATEGORIES,
  color: GOLD_COLORS,
  pattern: GOLD_PATTERNS,
  background: BACKGROUNDS,
  lighting: LIGHTINGS,
  camera: CAMERAS,
  itemSize: ITEM_SIZES,
  wearableType: WEARABLE_TYPES,
};

export type CoverageSpec = {
  schemaVersion: 1;
  kind: "single-item-coverage-spec";
  id: string;
  version: string;
  /** Any text; the same seed on the same inputs gives the same split. Record it with the benchmark. */
  seed: string;
  development: { minInScope: number };
  heldout: { inScope: number; rejection: number } & Record<CoverageDimension, Record<string, number>>;
};

/** A PROPOSED spec derived from the default launch policy. The owner reviews and edits it; nothing here is a standard. */
export function defaultCoverageSpec(policy: LaunchPolicy = DEFAULT_POLICY): CoverageSpec {
  return {
    schemaVersion: 1,
    kind: "single-item-coverage-spec",
    id: "single-item-coverage",
    version: "1.0.0-proposed",
    seed: "REPLACE-record-a-seed-before-sampling",
    development: { minInScope: 60 },
    heldout: {
      inScope: policy.minimums.heldoutInScope,
      rejection: policy.minimums.heldoutRejection,
      category: Object.fromEntries(GOLD_CATEGORIES.map((c) => [c, policy.minimums.perCategory])),
      color: { black: 15, white: 15, gray: 10, blue: 15, red: 8, green: 8, beige: 8 },
      pattern: { solid: 60, striped: 15, checked: 10, floral: 10, graphic: 10 },
      background: { plain: 40, textured: 30, cluttered: 30 },
      lighting: { daylight: 40, indoor_artificial: 40, low_light: 15 },
      camera: { phone: 60, dedicated_camera: 20 },
      itemSize: { small: 20, medium: 60, large: 60 },
      wearableType: { unworn: 100, mannequin: 20, worn: 30 },
    },
  };
}

const SPEC_KEYS = ["schemaVersion", "kind", "id", "version", "seed", "development", "heldout"] as const;
const HELD_KEYS = ["inScope", "rejection", ...COVERAGE_DIMENSIONS] as const;

/** Strict reader. The spec may not be weaker than the launch policy it is meant to serve. */
export function validateCoverageSpec(doc: unknown, policy: LaunchPolicy): { spec: CoverageSpec | null; problems: string[] } {
  const out: string[] = [];
  if (!isRecord(doc)) return { spec: null, problems: ["coverage: must be a JSON object"] };
  expectKeys(doc, SPEC_KEYS, "coverage", out);
  if (doc.schemaVersion !== 1 || doc.kind !== "single-item-coverage-spec") out.push('coverage: schemaVersion must be 1 and kind "single-item-coverage-spec"');
  if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) out.push("coverage: id must be a lowercase id");
  if (!isNonEmptyString(doc.version)) out.push("coverage: version is required");
  if (!isNonEmptyString(doc.seed) || doc.seed.startsWith("REPLACE-")) out.push("coverage: seed must be written down by a person (it makes the split reproducible)");
  const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100000;
  if (!isRecord(doc.development) || !count(doc.development.minInScope)) out.push("coverage.development.minInScope: must be a whole number");
  else if ((doc.development.minInScope as number) < 1) out.push("coverage.development.minInScope: at least 1 (a held-out split is only trustworthy next to a development split)");
  if (!isRecord(doc.heldout)) out.push("coverage.heldout: must be an object");
  else {
    const h = doc.heldout;
    expectKeys(h, HELD_KEYS, "coverage.heldout", out);
    if (!count(h.inScope)) out.push("coverage.heldout.inScope: must be a whole number");
    else if ((h.inScope as number) < policy.minimums.heldoutInScope) out.push(`coverage.heldout.inScope: ${h.inScope} is below the policy minimum ${policy.minimums.heldoutInScope}`);
    if (!count(h.rejection)) out.push("coverage.heldout.rejection: must be a whole number");
    else if ((h.rejection as number) < policy.minimums.heldoutRejection) out.push(`coverage.heldout.rejection: ${h.rejection} is below the policy minimum ${policy.minimums.heldoutRejection}`);
    for (const dim of COVERAGE_DIMENSIONS) {
      const cells = h[dim];
      if (!isRecord(cells)) {
        out.push(`coverage.heldout.${dim}: must be an object of minimum counts`);
        continue;
      }
      for (const [k, n] of Object.entries(cells)) {
        if (!VALUES[dim].includes(k)) out.push(`coverage.heldout.${dim}.${k}: not a known ${dim} value (${VALUES[dim].join(", ")})`);
        if (!count(n)) out.push(`coverage.heldout.${dim}.${k}: must be a whole number`);
        else if (typeof h.inScope === "number" && (n as number) > h.inScope) out.push(`coverage.heldout.${dim}.${k}: ${n} exceeds the in-scope total`);
      }
      if (dim === "category")
        for (const c of GOLD_CATEGORIES) {
          const n = cells[c];
          if (typeof n !== "number") out.push(`coverage.heldout.category.${c}: every category needs a minimum`);
          else if (n < policy.minimums.perCategory) out.push(`coverage.heldout.category.${c}: ${n} is below the policy per-category minimum ${policy.minimums.perCategory}`);
        }
      if (Object.keys(cells).length === 0 && dim !== "category") out.push(`coverage.heldout.${dim}: list at least one required value (an empty requirement checks nothing)`);
    }
  }
  if (out.length > 0) return { spec: null, problems: out };
  return { spec: doc as unknown as CoverageSpec, problems: [] };
}

// ----------------------------------------------------------------------------- facts

export const itemSizeOf = (box: Box): ItemSize => {
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  return area < 0.12 ? "small" : area < 0.45 ? "medium" : "large";
};
export const wearableOf = (scene: SceneType): WearableType => (scene === "worn" ? "worn" : scene === "mannequin" ? "mannequin" : "unworn");

export type Candidate = { record: IntakeRecord; final: FinalLabel };

/** The coverage cells one in-scope photo counts toward. */
export function cellsOf(c: Candidate): Array<[CoverageDimension, string]> {
  const item = c.final.label.item;
  if (!item) return [];
  return [
    ["category", item.category],
    ["color", item.color],
    ["pattern", item.pattern],
    ["background", c.record.capture.background],
    ["lighting", c.record.capture.lighting],
    ["camera", c.record.capture.camera],
    ["itemSize", itemSizeOf(item.box)],
    ["wearableType", wearableOf(c.record.capture.sceneType)],
  ];
}

// ----------------------------------------------------------------------------- plan

export type CellReport = { have: number; need: number; deficit: number };
export type SamplePlan = {
  schemaVersion: 1;
  kind: "single-item-sample-plan";
  benchmarkId: string;
  coverageId: string;
  coverageVersion: string;
  seed: string;
  coverageSha256: string;
  policySha256: string;
  inputsSha256: string;
  heldout: string[];
  development: string[];
  excluded: Array<{ imageId: string; reason: FinalReason | "not-labelled" | "heldout-ineligible" }>;
  heldoutCoverage: { inScope: CellReport; rejection: CellReport } & Record<CoverageDimension, Record<string, CellReport>>;
  developmentCoverage: { inScope: CellReport };
  deficits: string[];
  verdict: "NO_DEFICITS" | "DEFICITS";
};

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export function inputsDigest(records: IntakeRecord[], finals: ReadonlyMap<string, FinalLabel>, spec: CoverageSpec, policy: LaunchPolicy): string {
  return sha(
    canonicalJson({
      spec,
      policy: policyContentSha256(policy),
      records: records
        .map((r) => ({ id: r.imageId, sha: r.sha256, stratum: r.stratum, reason: r.rejectionReason, shoot: r.sourceShootId, garment: r.garmentId, capture: r.capture, near: r.receipt.nearDuplicateOf, label: finals.has(r.imageId) ? sha(canonicalJson(finals.get(r.imageId))) : null }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    }),
  );
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r) as string;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/** Groups that must stay together: same shoot, same garment, or a near-duplicate. Over ALL imported photos, labelled or not. */
export function groupsOf(records: IntakeRecord[]): Map<string, string> {
  const uf = new UnionFind();
  for (const r of records) {
    uf.union(r.imageId, `shoot:${r.sourceShootId}`);
    if (r.garmentId !== null) uf.union(r.imageId, `garment:${r.garmentId}`);
    for (const d of r.receipt.nearDuplicateOf) uf.union(r.imageId, d);
  }
  for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) if (nearDuplicate(records[i].signature, records[j].signature)) uf.union(records[i].imageId, records[j].imageId);
  return new Map(records.map((r) => [r.imageId, uf.find(r.imageId)]));
}

const cell = (have: number, need: number): CellReport => ({ have, need, deficit: Math.max(0, need - have) });

export function planSample(ws: Workspace, records: IntakeRecord[], finals: ReadonlyMap<string, FinalLabel>, excludedReasons: ReadonlyMap<string, FinalReason>, spec: CoverageSpec, policy: LaunchPolicy): SamplePlan {
  const groupOf = groupsOf(records);
  const candidates: Candidate[] = records.filter((r) => finals.has(r.imageId)).map((r) => ({ record: r, final: finals.get(r.imageId) as FinalLabel }));
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const g = groupOf.get(c.record.imageId) as string;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(c);
  }
  const order = (g: string) => sha(`${spec.seed}:${g}`);
  const eligible = [...groups.entries()].filter(([, members]) => members.every((m) => m.final.doubleReviewed)).sort(([a], [b]) => (order(a) < order(b) ? -1 : 1));

  const need = new Map<string, number>();
  for (const dim of COVERAGE_DIMENSIONS) for (const [k, n] of Object.entries(spec.heldout[dim])) need.set(`${dim}:${k}`, n);
  need.set("inScope", spec.heldout.inScope);
  need.set("rejection", spec.heldout.rejection);
  const have = new Map<string, number>();
  const bump = (key: string, by: number) => have.set(key, (have.get(key) ?? 0) + by);
  const memberCells = (m: Candidate): string[] => (m.final.label.outcome === "single_item" ? ["inScope", ...cellsOf(m).map(([d, v]) => `${d}:${v}`)] : ["rejection"]);
  const gain = (members: Candidate[]) => {
    const add = new Map<string, number>();
    for (const m of members) for (const k of memberCells(m)) add.set(k, (add.get(k) ?? 0) + 1);
    let g = 0;
    for (const [k, n] of add) g += Math.max(0, Math.min(n, (need.get(k) ?? 0) - (have.get(k) ?? 0)));
    return g;
  };
  const chosen = new Set<string>();
  for (;;) {
    let best: { g: string; gain: number } | null = null;
    for (const [g, members] of eligible) {
      if (chosen.has(g)) continue;
      const v = gain(members);
      if (v > 0 && (!best || v > best.gain)) best = { g, gain: v };
    }
    if (!best) break;
    chosen.add(best.g);
    for (const m of groups.get(best.g) as Candidate[]) for (const k of memberCells(m)) bump(k, 1);
  }

  const heldout = candidates.filter((c) => chosen.has(groupOf.get(c.record.imageId) as string));
  const development = candidates.filter((c) => !chosen.has(groupOf.get(c.record.imageId) as string));
  const count = (list: Candidate[], pick: (c: Candidate) => boolean) => list.filter(pick).length;
  const inScope = (c: Candidate) => c.final.label.outcome === "single_item";

  const heldoutCoverage = {
    inScope: cell(count(heldout, inScope), spec.heldout.inScope),
    rejection: cell(count(heldout, (c) => !inScope(c)), spec.heldout.rejection),
  } as SamplePlan["heldoutCoverage"];
  const deficits: string[] = [];
  if (heldoutCoverage.inScope.deficit > 0) deficits.push(`held-out in-scope photos: ${heldoutCoverage.inScope.have} of ${heldoutCoverage.inScope.need}`);
  if (heldoutCoverage.rejection.deficit > 0) deficits.push(`held-out rejection photos: ${heldoutCoverage.rejection.have} of ${heldoutCoverage.rejection.need}`);
  for (const dim of COVERAGE_DIMENSIONS) {
    const report: Record<string, CellReport> = {};
    for (const [value, n] of Object.entries(spec.heldout[dim]).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const got = count(heldout, (c) => inScope(c) && cellsOf(c).some(([d, v]) => d === dim && v === value));
      report[value] = cell(got, n);
      if (got < n) deficits.push(`held-out ${dim} "${value}": ${got} of ${n}`);
    }
    heldoutCoverage[dim] = report;
  }
  const developmentCoverage = { inScope: cell(count(development, inScope), spec.development.minInScope) };
  if (developmentCoverage.inScope.deficit > 0) deficits.push(`development in-scope photos: ${developmentCoverage.inScope.have} of ${developmentCoverage.inScope.need}`);

  const excluded: SamplePlan["excluded"] = [];
  for (const r of records) {
    if (finals.has(r.imageId)) continue;
    excluded.push({ imageId: r.imageId, reason: excludedReasons.get(r.imageId) ?? "not-labelled" });
  }
  return {
    schemaVersion: 1,
    kind: "single-item-sample-plan",
    benchmarkId: ws.benchmarkId,
    coverageId: spec.id,
    coverageVersion: spec.version,
    seed: spec.seed,
    coverageSha256: sha(canonicalJson(spec)),
    policySha256: policyContentSha256(policy),
    inputsSha256: inputsDigest(records, finals, spec, policy),
    heldout: heldout.map((c) => c.record.imageId).sort(),
    development: development.map((c) => c.record.imageId).sort(),
    excluded: excluded.sort((a, b) => (a.imageId < b.imageId ? -1 : 1)),
    heldoutCoverage,
    developmentCoverage,
    deficits,
    verdict: deficits.length === 0 ? "NO_DEFICITS" : "DEFICITS",
  };
}

// ----------------------------------------------------------------------------- freeze

const manifestRights = (r: IntakeRecord) => {
  const base = { retrievedAt: r.rights.acquiredAt, modifications: [] as string[], originalSha256: r.sha256, distributedSha256: r.sha256, verifiedBy: r.rights.verifiedBy, verifiedAt: r.rights.verifiedAt };
  if (r.rights.sourceType === "open-license" && r.rights.openLicense) {
    const o = r.rights.openLicense;
    return { ...base, sourceCollection: o.sourceCollection, sourcePageUrl: o.sourcePageUrl, originalUrl: o.originalUrl, creator: r.rights.rightsHolder, license: o.license, attribution: o.attribution };
  }
  // a private source: a pseudonymous reference, no name, no URL, no licence
  return { ...base, sourceCollection: r.rights.sourceType, sourcePageUrl: null, originalUrl: null, creator: r.rightsHolderRef, license: null, attribution: "private-rights-holder" };
};

function manifestFor(ws: Workspace, split: "development" | "heldout", picks: Candidate[], frozenAt: string): unknown {
  return {
    schemaVersion: 1,
    kind: "single-item-manifest",
    benchmarkId: ws.benchmarkId,
    split,
    frozenAt,
    purpose:
      split === "heldout"
        ? "Held-out single-prominent-item benchmark from the rights-cleared intake workspace (build 026). Sealed: never tune, prompt-engineer or inspect results against it."
        : "Development split from the rights-cleared intake workspace (build 026). Models and prompts may be tuned against these photos.",
    fixtures: picks
      .slice()
      .sort((a, b) => (a.record.imageId < b.record.imageId ? -1 : 1))
      .map(({ record: r, final }) => ({
        id: r.imageId,
        file: r.file,
        sha256: r.sha256,
        dimensions: r.dimensions,
        addedAt: r.importedAt,
        sceneType: r.capture.sceneType,
        stratum: final.label.outcome === "single_item" ? "in_scope" : "rejection",
        rejectionReason: final.label.rejectionReason,
        sourceShootId: r.sourceShootId,
        garmentId: r.garmentId,
        priorInference: false,
        priorInferenceNote: null,
        rights: manifestRights(r),
        notes: null,
      })),
  };
}

export type FreezeInput = {
  ws: Workspace;
  records: IntakeRecord[];
  finals: ReadonlyMap<string, FinalLabel>;
  excluded: ReadonlyMap<string, FinalReason>;
  spec: CoverageSpec;
  policy: LaunchPolicy;
  plan: SamplePlan;
  outDir: string;
  now: Date;
  fs?: FsOps;
};

export type FreezeResult = { heldoutFixtures: number; developmentFixtures: number; heldoutManifestSha256: string; files: string[] };

/**
 * Freezes a plan. Refused if the plan is not exactly what the current workspace, labels, spec and policy
 * produce (a stale or hand-edited plan), if any coverage deficit remains, if a held-out photo was not double
 * reviewed, or if the finished benchmark fails the Build 024/025 integrity checks. Writes into a NEW directory
 * (images, manifests, gold, receipts) and then the workspace seal; if any write fails everything this call
 * created is removed.
 */
export function freezeFromPlan(input: FreezeInput): FreezeResult {
  const { ws, records, finals, spec, policy, plan, outDir } = input;
  if (readSeal(ws)) throw new EvaluationRefusal(["this workspace is already frozen and sealed; a frozen benchmark is never refrozen, start a new benchmark version"]);
  const fresh = planSample(ws, records, finals, input.excluded, spec, policy);
  if (canonicalJson(fresh) !== canonicalJson(plan)) throw new EvaluationRefusal(["the plan is not what the current workspace, labels, coverage spec and policy produce (stale or edited); run single-sample again"]);
  if (fresh.deficits.length > 0) throw new EvaluationRefusal([`coverage deficits remain, so nothing is frozen: ${fresh.deficits.slice(0, 20).join("; ")}${fresh.deficits.length > 20 ? ` (+${fresh.deficits.length - 20} more)` : ""}`]);
  const byId = new Map(records.map((r) => [r.imageId, r]));
  const pick = (ids: string[]): Candidate[] => ids.map((id) => ({ record: byId.get(id) as IntakeRecord, final: finals.get(id) as FinalLabel }));
  const held = pick(fresh.heldout);
  const dev = pick(fresh.development);
  const single = held.filter((c) => !c.final.doubleReviewed);
  if (single.length > 0) throw new EvaluationRefusal(["a held-out photo has fewer than two independent reviews"]);
  if (existsSync(outDir)) throw new EvaluationRefusal(["--out-dir already exists; a freeze never writes into an existing directory"]);
  const frozenAt = input.now.toISOString();

  const parse = (raw: unknown, what: string): SingleManifest => {
    const { manifest, problems } = validateSingleManifest(JSON.parse(JSON.stringify(raw)));
    if (!manifest) throw new EvaluationRefusal(problems.map((p) => `${what} manifest: ${p}`));
    return manifest;
  };
  const devManifest = parse(manifestFor(ws, "development", dev, frozenAt), "development");
  const heldManifest = parse(manifestFor(ws, "heldout", held, frozenAt), "held-out");
  const goldOf = (split: "development" | "heldout", picks: Candidate[]) => {
    const raw = goldFile(ws.benchmarkId, split, picks.map((p) => p.final.label));
    const { file, problems } = validateGoldFile(JSON.parse(JSON.stringify(raw)));
    if (!file) throw new EvaluationRefusal(problems.map((p) => `${split} gold: ${p}`));
    return file;
  };
  const devGold = goldOf("development", dev);
  const heldGold = goldOf("heldout", held);
  const text = { dev: stableText(devManifest), held: stableText(heldManifest) };
  const receipt = (m: SingleManifest, t: string): FreezeReceipt => ({ schemaVersion: 1, kind: "single-item-freeze-receipt", benchmarkId: m.benchmarkId, split: m.split, frozenAt, manifestSha256: sha256Hex(Buffer.from(t)), fixtureCount: m.fixtures.length });
  const devReceipt = receipt(devManifest, text.dev);
  const heldReceipt = receipt(heldManifest, text.held);
  for (const r of [devReceipt, heldReceipt]) {
    const v = validateFreezeReceipt(JSON.parse(JSON.stringify(r)));
    if (!v.receipt) throw new EvaluationRefusal(v.problems);
  }
  const issues = integrityProblems({
    manifests: [
      { manifest: devManifest, fileSha256: devReceipt.manifestSha256 },
      { manifest: heldManifest, fileSha256: heldReceipt.manifestSha256 },
    ],
    gold: [devGold, heldGold],
    receipts: [devReceipt, heldReceipt],
    predictions: null,
    images: imagesFrom(path.join(ws.dir, "pool")),
  });
  if (issues.length > 0) throw new EvaluationRefusal(issues);

  const sealDoc: Seal = {
    schemaVersion: 1,
    kind: "single-item-intake-seal",
    benchmarkId: ws.benchmarkId,
    sealedAt: frozenAt,
    planSha256: sha(canonicalJson(plan)),
    heldoutImageIds: fresh.heldout,
    developmentImageIds: fresh.development,
    heldoutManifestSha256: heldReceipt.manifestSha256,
  };
  const made = new Creations(input.fs ?? realFs);
  try {
    made.dir(outDir);
    for (const sub of ["images", path.join("images", "development"), path.join("images", "heldout")]) made.dir(path.join(outDir, sub));
    for (const [split, picks] of [["development", dev], ["heldout", held]] as const)
      for (const c of picks) {
        const bytes = readWorkspaceFile(poolPath(ws, c.record.file));
        if (sha256Hex(bytes) !== c.record.sha256) throw new EvaluationRefusal([`${c.record.imageId}: pooled bytes changed since import; nothing was frozen`]);
        made.file(path.join(outDir, "images", split, c.record.file), bytes);
      }
    made.file(path.join(outDir, "development.gold.json"), Buffer.from(stableText(devGold)));
    made.file(path.join(outDir, "heldout.gold.json"), Buffer.from(stableText(heldGold)));
    made.file(path.join(outDir, "sample-plan.json"), Buffer.from(stableText(plan)));
    made.file(path.join(outDir, "development.manifest.json"), Buffer.from(text.dev));
    made.file(path.join(outDir, "heldout.manifest.json"), Buffer.from(text.held));
    // receipts and the seal last: a half-written freeze has manifests without receipts, which scoring refuses
    made.file(path.join(outDir, "development.freeze-receipt.json"), Buffer.from(stableText(devReceipt)));
    made.file(path.join(outDir, "heldout.freeze-receipt.json"), Buffer.from(stableText(heldReceipt)));
    made.file(path.join(ws.dir, "seal.json"), Buffer.from(stableText(sealDoc)));
  } catch (e) {
    made.rollback();
    throw e;
  }
  return { heldoutFixtures: held.length, developmentFixtures: dev.length, heldoutManifestSha256: heldReceipt.manifestSha256, files: [...made.created] };
}
