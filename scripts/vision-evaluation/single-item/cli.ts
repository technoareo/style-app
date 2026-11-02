import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { EvaluationRefusal } from "../evaluate";
import { inspectImageBytes, sha256Hex } from "../image";
import { toSingleCase, singleRunInfo, validateAnalyzePhotoRecord, type AnalyzePhotoRecord } from "./adapter";
import { validateGoldFile, type GoldFile } from "./gold";
import { integrityProblems, strataProblems, type ImageResolver, type ManifestInput } from "./integrity";
import { validateFreezeReceipt, validateSingleManifest, type FreezeReceipt } from "./manifest";
import { validatePolicy, type LaunchPolicy } from "./policy";
import { validateSinglePredictionReport, type SinglePredictionReport } from "./predictions";
import { evaluateSingle } from "./score";
import { templates } from "./templates";

/**
 * Commands of the single-item launch gate (all start with `single-`). They read
 * the files the operator names and write NEW files only: `--out` must not exist,
 * so evidence is never overwritten. Nothing here runs a model, a network call
 * or the application.
 *
 *   single-template  --kind manifest|gold|policy|record --out NEW
 *   single-freeze    --manifest M --images-dir D --out-manifest NEW --out-receipt NEW [--against M...]
 *   single-validate  --manifest M... --gold G... [--receipt R...] --images-dir D [--policy P]
 *   single-adapt-qwen (--record R | --records-dir DIR) --manifest M... --images-dir D --out NEW
 *   single-score     --manifest M... --gold G... [--receipt R...] --predictions P --images-dir D --policy P --out NEW
 *
 * Exit codes: 0 done, 2 refused (inputs are not trustworthy evidence), 1 usage or other error.
 */

class UsageError extends Error {}
export type CliIo = { log: (line: string) => void; error: (line: string) => void; now: () => Date };
const defaultIo: CliIo = { log: (l) => console.log(l), error: (l) => console.error(l), now: () => new Date() };

type Values = Record<string, string | string[] | boolean | undefined>;

function readBytes(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    throw new UsageError(`cannot read ${file}`);
  }
}

function readJson(file: string): { value: unknown; sha256: string } {
  const bytes = readBytes(file);
  try {
    return { value: JSON.parse(bytes.toString("utf8").replace(/^﻿/, "")) as unknown, sha256: sha256Hex(bytes) };
  } catch {
    throw new EvaluationRefusal([`${file} is not valid JSON (truncated or damaged files are never repaired)`]);
  }
}

function newOutput(out: unknown, flag = "--out"): string {
  if (typeof out !== "string" || !out) throw new UsageError(`${flag} is required`);
  if (existsSync(out)) throw new UsageError(`${out} already exists; evidence is never overwritten, choose a new name`);
  return out;
}

/** Writes new text exclusively and returns its sha256. */
function writeNew(file: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeFileSync(file, text, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new UsageError(`${file} already exists; evidence is never overwritten`);
    throw e;
  }
  return sha256Hex(Buffer.from(text));
}

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function imagesFrom(dir: string): ImageResolver {
  return (fixture) => {
    const file = path.join(dir, fixture.file);
    if (!existsSync(file)) return null;
    try {
      const bytes = readFileSync(file);
      return { sha256: sha256Hex(bytes), dimensions: inspectImageBytes(bytes) };
    } catch {
      return null;
    }
  };
}

function loadManifest(file: string): ManifestInput {
  const { value, sha256 } = readJson(file);
  const { manifest, problems } = validateSingleManifest(value);
  if (!manifest) throw new EvaluationRefusal(problems.map((p) => `${file}: ${p}`));
  return { manifest, fileSha256: sha256 };
}

function loadGold(file: string): { gold: GoldFile; sha256: string } {
  const { value, sha256 } = readJson(file);
  const { file: gold, problems } = validateGoldFile(value);
  if (!gold) throw new EvaluationRefusal(problems.map((p) => `${file}: ${p}`));
  return { gold, sha256 };
}

function loadReceipt(file: string): { receipt: FreezeReceipt; sha256: string } {
  const { value, sha256 } = readJson(file);
  const { receipt, problems } = validateFreezeReceipt(value);
  if (!receipt) throw new EvaluationRefusal(problems.map((p) => `${file}: ${p}`));
  return { receipt, sha256 };
}

function loadPolicy(file: string | undefined): { policy: LaunchPolicy; sha256: string } {
  if (!file) throw new UsageError("--policy is required (create one with single-template --kind policy)");
  const { value, sha256 } = readJson(file);
  const { policy, problems } = validatePolicy(value);
  if (!policy) throw new EvaluationRefusal(problems.map((p) => `${file}: ${p}`));
  return { policy, sha256 };
}

function template(values: Values, io: CliIo): void {
  const kind = text(values.kind);
  const make = kind ? templates[kind as keyof typeof templates] : undefined;
  if (!make) throw new UsageError(`--kind must be one of ${Object.keys(templates).join(", ")}`);
  const out = newOutput(values.out);
  writeNew(out, make());
  io.log(
    kind === "policy"
      ? `wrote ${out}: a PROPOSED policy with no approval record. Change what the owner decides, then add an approval; the gate stays NOT_EVALUATED until then.`
      : `wrote ${out}. It is a template: it fails validation until people fill it in.`,
  );
}

function freeze(values: Values, io: CliIo): void {
  const manifestFile = list(values.manifest).length === 1 ? list(values.manifest)[0] : undefined;
  const imagesDir = text(values["images-dir"]);
  if (!manifestFile || !imagesDir) throw new UsageError("single-freeze needs exactly one --manifest, --images-dir, --out-manifest and --out-receipt");
  const outManifest = newOutput(values["out-manifest"], "--out-manifest");
  const outReceipt = newOutput(values["out-receipt"], "--out-receipt");
  const { value } = readJson(manifestFile);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EvaluationRefusal([`${manifestFile}: must be a JSON object`]);
  const raw = value as Record<string, unknown>;
  if (raw.frozenAt !== null) throw new EvaluationRefusal([`${manifestFile}: already frozen (frozenAt is set); a frozen manifest is never refrozen, create a new benchmark version`]);
  const frozenAt = io.now().toISOString();
  const candidate = { ...raw, frozenAt };
  const { manifest, problems } = validateSingleManifest(candidate);
  if (!manifest) throw new EvaluationRefusal(problems.map((p) => `${manifestFile}: ${p}`));
  const others = list(values.against).map(loadManifest);
  const issues = integrityProblems({
    manifests: [{ manifest, fileSha256: null }, ...others],
    gold: [],
    receipts: [],
    predictions: null,
    images: imagesFrom(imagesDir),
    stage: "freeze",
  });
  if (issues.length > 0) throw new EvaluationRefusal(issues);
  const manifestSha = writeNew(outManifest, manifest);
  const receipt: FreezeReceipt = {
    schemaVersion: 1,
    kind: "single-item-freeze-receipt",
    benchmarkId: manifest.benchmarkId,
    split: manifest.split,
    frozenAt,
    manifestSha256: manifestSha,
    fixtureCount: manifest.fixtures.length,
  };
  writeNew(outReceipt, receipt);
  io.log(`froze ${manifest.fixtures.length} fixture(s) at ${frozenAt}: ${outManifest} (sha256 ${manifestSha}), receipt ${outReceipt}. Run models only after this point.`);
}

type Loaded = { manifests: ManifestInput[]; gold: GoldFile[]; receipts: FreezeReceipt[]; digests: Array<{ role: string; path: string; sha256: string }> };

function loadBenchmark(values: Values): Loaded {
  const digests: Loaded["digests"] = [];
  const manifests = list(values.manifest).map((f) => {
    const m = loadManifest(f);
    digests.push({ role: "manifest", path: path.basename(f), sha256: m.fileSha256 as string });
    return m;
  });
  const gold = list(values.gold).map((f) => {
    const g = loadGold(f);
    digests.push({ role: "gold", path: path.basename(f), sha256: g.sha256 });
    return g.gold;
  });
  const receipts = list(values.receipt).map((f) => {
    const r = loadReceipt(f);
    digests.push({ role: "receipt", path: path.basename(f), sha256: r.sha256 });
    return r.receipt;
  });
  if (manifests.length === 0) throw new UsageError("--manifest is required");
  return { manifests, gold, receipts, digests };
}

function validate(values: Values, io: CliIo): void {
  const imagesDir = text(values["images-dir"]);
  if (!imagesDir) throw new UsageError("single-validate needs --manifest, --gold, --images-dir");
  const b = loadBenchmark(values);
  const problems = integrityProblems({ manifests: b.manifests, gold: b.gold, receipts: b.receipts, predictions: null, images: imagesFrom(imagesDir) });
  const policyFile = text(values.policy);
  const heldout = b.manifests.find((m) => m.manifest.split === "heldout")?.manifest;
  const sizeProblems: string[] = [];
  if (policyFile) sizeProblems.push(...strataProblems(heldout, b.gold.find((g) => g.split === "heldout"), loadPolicy(policyFile).policy));
  const all = [...problems, ...sizeProblems];
  if (all.length > 0) throw new EvaluationRefusal(all);
  io.log(JSON.stringify({ ok: true, manifests: b.manifests.map((m) => ({ split: m.manifest.split, fixtures: m.manifest.fixtures.length })), strataChecked: Boolean(policyFile) }, null, 2));
}

function adaptQwen(values: Values, io: CliIo): void {
  const imagesDir = text(values["images-dir"]);
  const recordFile = text(values.record);
  const recordsDir = text(values["records-dir"]);
  if ((recordFile ? 1 : 0) + (recordsDir ? 1 : 0) !== 1 || !imagesDir) throw new UsageError("single-adapt-qwen needs exactly one of --record / --records-dir, plus --manifest, --images-dir and --out");
  const out = newOutput(values.out);
  const manifests = list(values.manifest).map(loadManifest);
  if (manifests.length === 0) throw new UsageError("--manifest is required");
  const files = recordFile ? [recordFile] : readdirSync(recordsDir as string).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(recordsDir as string, f));
  if (files.length === 0) throw new UsageError("no record files found");
  const records: AnalyzePhotoRecord[] = [];
  const problems: string[] = [];
  const fixtures = new Map(manifests.flatMap((m) => m.manifest.fixtures.map((f) => [f.id, f] as const)));
  const resolver = imagesFrom(imagesDir);
  for (const file of files) {
    const { record, problems: p } = validateAnalyzePhotoRecord(readJson(file).value);
    if (!record) {
      problems.push(...p.map((x) => `${file}: ${x}`));
      continue;
    }
    const fixture = fixtures.get(record.fixtureId);
    if (!fixture) problems.push(`${file}: fixture "${record.fixtureId}" is not in the manifest(s)`);
    else {
      const facts = resolver(fixture);
      if (!facts || facts.sha256 !== fixture.sha256) problems.push(`${file}: image for "${record.fixtureId}" is absent or differs from the immutable manifest hash`);
      if (record.imageSha256.toLowerCase() !== fixture.sha256) problems.push(`${file}: the run analysed different bytes than the manifest lists for "${record.fixtureId}"`);
    }
    records.push(record);
  }
  const ids = records.map((r) => r.fixtureId);
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(`two records for fixture "${id}"`);
  if (problems.length > 0) throw new EvaluationRefusal(problems);
  const { run, problems: runProblems } = singleRunInfo(records);
  if (!run) throw new EvaluationRefusal(runProblems);
  const report: SinglePredictionReport = { schemaVersion: 1, kind: "single-item-predictions", run, cases: records.map(toSingleCase).sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : 1)) };
  writeNew(out, report);
  const bad = report.cases.filter((c) => c.status !== "completed").length;
  io.log(`wrote ${out}: ${report.cases.length} case(s), ${bad} not completed. The model's confidence is not used as correctness.`);
}

function score(values: Values, io: CliIo): void {
  const imagesDir = text(values["images-dir"]);
  const predictionsFile = text(values.predictions);
  if (!imagesDir || !predictionsFile) throw new UsageError("single-score needs --manifest, --gold, --predictions, --images-dir, --policy and --out");
  const out = newOutput(values.out);
  const policy = loadPolicy(text(values.policy));
  const b = loadBenchmark(values);
  const { value, sha256 } = readJson(predictionsFile);
  const { report: predictions, problems } = validateSinglePredictionReport(value);
  if (!predictions) throw new EvaluationRefusal(problems.map((p) => `${predictionsFile}: ${p}`));
  const report = evaluateSingle({
    manifests: b.manifests,
    gold: b.gold,
    receipts: b.receipts,
    predictions,
    images: imagesFrom(imagesDir),
    policy: policy.policy,
    createdAt: io.now().toISOString(),
    inputDigests: [...b.digests, { role: "predictions", path: path.basename(predictionsFile), sha256 }, { role: "policy", path: path.basename(text(values.policy) as string), sha256: policy.sha256 }],
  });
  writeNew(out, report);
  io.log(`wrote ${out}: ${report.cases.length} case(s). Launch gate: ${report.gate.verdict}${report.gate.preconditions.length ? ` (${report.gate.preconditions.length} precondition(s) unmet)` : ""}. This is not a launch-readiness claim.`);
}

export const SINGLE_COMMANDS = ["single-template", "single-freeze", "single-validate", "single-adapt-qwen", "single-score"] as const;

/** Returns the exit code: 0 done, 2 refused, 1 usage or other error. */
export function runSingleCli(argv: string[], io: CliIo = defaultIo): number {
  try {
    const command = argv[0];
    const { values } = parseArgs({
      args: argv.slice(1),
      allowPositionals: false,
      strict: true,
      options: {
        kind: { type: "string" },
        manifest: { type: "string", multiple: true },
        against: { type: "string", multiple: true },
        gold: { type: "string", multiple: true },
        receipt: { type: "string", multiple: true },
        predictions: { type: "string" },
        policy: { type: "string" },
        record: { type: "string" },
        "records-dir": { type: "string" },
        "images-dir": { type: "string" },
        out: { type: "string" },
        "out-manifest": { type: "string" },
        "out-receipt": { type: "string" },
      },
    });
    const v: Values = values;
    if (command === "single-template") template(v, io);
    else if (command === "single-freeze") freeze(v, io);
    else if (command === "single-validate") validate(v, io);
    else if (command === "single-adapt-qwen") adaptQwen(v, io);
    else if (command === "single-score") score(v, io);
    else throw new UsageError(`usage: ${SINGLE_COMMANDS.join(" | ")} (see scripts/vision-evaluation/README.md)`);
    return 0;
  } catch (e) {
    if (e instanceof EvaluationRefusal) {
      io.error(e.message);
      return 2;
    }
    io.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
