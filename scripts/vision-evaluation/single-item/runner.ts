import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { SHA256_RE, expectKeys, isIsoTimestamp, isNonEmptyString, isNonNegativeFinite, isRecord } from "../check";
import { EvaluationRefusal, type ImageFacts } from "../evaluate";
import { inspectImageBytes, sha256Hex } from "../image";
import type { Split } from "../types";
import { singleRunInfo, toSingleCase, validateAnalyzePhotoRecord, type AnalyzePhotoOutcome, type AnalyzePhotoRecord } from "./adapter";
import { integrityProblems, type ImageResolver, type ManifestInput } from "./integrity";
import { validateFreezeReceipt, validateSingleManifest, type FreezeReceipt, type SingleFixture } from "./manifest";
import { canonicalJson } from "./policy";
import type { SinglePredictionReport } from "./predictions";
import { UNEXPECTED_PREFIX, casesDigest, type RunBinding, type VerifiedRun } from "./run-binding";

/**
 * The benchmark runner (build 025): runs the app's real single-item analysis
 * over a frozen benchmark and publishes the evidence the scorer can trust.
 *
 *  - It never contains a recognizer. Analysis is the injected `analyze`, which the CLI binds to the
 *    exported `analyzePhoto` of src/server/vision.ts; photos go through the app's `normalizePhoto`.
 *  - Everything that can be checked before inference is checked first. Only when the WHOLE requested run
 *    passes does the first image reach the analysis function.
 *  - Evidence is published with exclusive creates only, one file per fixture, plus a run receipt (written
 *    first) and a completion receipt (written last, only when every fixture has one valid record).
 *
 * Honest limits: this is a log with checks, not a transaction. A crash or power loss can leave a
 * half-written final record file or a run without a completion receipt (both are refused as evidence;
 * the first must be deleted by hand before resuming). Files are created in place with exclusive-create
 * semantics only: no rename and no hard link, because Windows sandboxes refuse both (EPERM). The directory is not signed: anyone who controls the
 * machine can fabricate one. The lock file stops cooperating runners only.
 */

export const RUNNER_ID = "single-item-benchmark-runner-025";
export const RUN_RECEIPT_FILE = "run-receipt.json";
export const COMPLETION_RECEIPT_FILE = "completion-receipt.json";
export const LOCK_FILE = "run.lock";
export const RECORDS_DIR = "records";
export { UNEXPECTED_PREFIX };

// ----------------------------------------------------------------------------- types

export type RunIdentity = {
  /** configuredVisionModel(), the name Ollama is asked for. */
  model: string;
  /** What identifies the exact model bytes (the runtime's own digest). Never typed by hand unless it matches. */
  modelVersion: string;
  /** Exact request identity of the app's single-item path (visionRequestIdentity). */
  promptSha256: string;
  requestSha256: string;
  timeoutMs: number;
};

export type GitState = { commit: string; dirty: boolean };

export type RunReceipt = {
  schemaVersion: 1;
  kind: "single-item-run-receipt";
  runId: string;
  runnerId: string;
  analysisMode: "single";
  benchmarkId: string;
  inputsDigest: string;
  startedAt: string;
  gitCommit: string;
  gitDirty: boolean;
  /** An explicit override made a dirty worktree acceptable: the evidence can never gate a launch. */
  developmentOnly: boolean;
  model: string;
  modelVersion: string;
  promptSha256: string;
  requestSha256: string;
  timeoutMs: number;
  nodeVersion: string;
  manifests: Array<{ split: Split; fileSha256: string }>;
  receipts: Array<{ split: Split; fileSha256: string }>;
  fixtures: Array<{ id: string; split: Split; sha256: string }>;
};

export type CompletionReceipt = {
  schemaVersion: 1;
  kind: "single-item-run-completion";
  runId: string;
  inputsDigest: string;
  runReceiptSha256: string;
  completedAt: string;
  records: Array<{ fixtureId: string; sha256: string }>;
  outcomes: Record<AnalyzePhotoOutcome, number>;
  /** Records the runner wrote for an error it did not expect (counted as failures, never as results). */
  unexpectedErrors: number;
};

export type RunnerDeps = {
  /** The app's analyzePhoto, bound by the CLI. The runner calls it as (normalized, signal, { mode: "single" }). */
  analyze: (normalized: Buffer, signal: AbortSignal | undefined, options: { mode: "single" }) => Promise<{ analysis: unknown }>;
  /** The app's normalizePhoto. */
  normalize: (bytes: Buffer) => Promise<Buffer>;
  /** Maps a thrown error to an outcome (the CLI binds VisionError kinds); null means "not a vision error". */
  classify: (error: unknown) => { outcome: Exclude<AnalyzePhotoOutcome, "ok">; message: string } | null;
  identity: () => Promise<RunIdentity>;
  git: () => GitState;
  now: () => Date;
  /** Monotonic milliseconds, for durations. */
  monotonicMs: () => number;
  readFile: (file: string) => Buffer;
  log: (line: string) => void;
  signal?: AbortSignal;
  /** Test seam: the file operations used to publish records (default: node:fs, exclusive create). */
  recordFs?: ExclusiveFs;
};

export type RunOptions = {
  manifestFiles: string[];
  receiptFiles: string[];
  imagesDir: string;
  runDir: string;
  /** Allow a dirty worktree; the run is then marked developmentOnly. */
  allowDirtyDevelopment: boolean;
  /** Optional assertion of the model version; must equal what the runtime reports. */
  expectedModelVersion?: string;
};

// ----------------------------------------------------------------------------- helpers

export function imagesFrom(dir: string, read: (file: string) => Buffer = readFileSync): ImageResolver {
  return (fixture: SingleFixture): ImageFacts | null => {
    const file = path.join(dir, fixture.file);
    try {
      const bytes = read(file);
      return { sha256: sha256Hex(bytes), dimensions: inspectImageBytes(bytes) };
    } catch {
      return null;
    }
  };
}

const sha = (text: string | Buffer) => sha256Hex(typeof text === "string" ? Buffer.from(text) : text);
const stable = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function readJsonFile(file: string, read: (f: string) => Buffer): { value: unknown; sha256: string } {
  let bytes: Buffer;
  try {
    bytes = read(file);
  } catch {
    throw new EvaluationRefusal([`cannot read ${path.basename(file)}`]);
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8").replace(/^﻿/, "")) as unknown, sha256: sha256Hex(bytes) };
  } catch {
    throw new EvaluationRefusal([`${path.basename(file)} is not valid JSON (damaged or truncated files are never repaired)`]);
  }
}

/** The digest every resume must reproduce: everything that decides what the run measures. */
export function inputsDigestOf(r: RunReceipt | Omit<RunReceipt, "inputsDigest" | "runId" | "startedAt">): string {
  return sha(
    canonicalJson({
      analysisMode: r.analysisMode,
      runnerId: r.runnerId,
      benchmarkId: r.benchmarkId,
      gitCommit: r.gitCommit,
      gitDirty: r.gitDirty,
      developmentOnly: r.developmentOnly,
      model: r.model,
      modelVersion: r.modelVersion,
      promptSha256: r.promptSha256,
      requestSha256: r.requestSha256,
      timeoutMs: r.timeoutMs,
      manifests: r.manifests,
      receipts: r.receipts,
      fixtures: r.fixtures,
    }),
  );
}

const promptIdOf = (requestSha256: string) => `app-single-item:sha256:${requestSha256}`;

// ----------------------------------------------------------------------------- preflight (no inference)

export type Preflight = {
  manifests: ManifestInput[];
  manifestFiles: Array<{ split: Split; fileSha256: string }>;
  receiptFiles: Array<{ split: Split; fileSha256: string }>;
  receipts: FreezeReceipt[];
  fixtures: Array<{ fixture: SingleFixture; split: Split }>;
  identity: RunIdentity;
  git: GitState;
  developmentOnly: boolean;
  benchmarkId: string;
};

/**
 * Everything that can be checked before the first image reaches the model. Throws an EvaluationRefusal
 * listing every problem, and never reaches `analyze`. The decodability pass uses `normalize` only.
 */
export async function preflight(options: RunOptions, deps: RunnerDeps): Promise<Preflight> {
  const problems: string[] = [];
  if (options.manifestFiles.length === 0) throw new EvaluationRefusal(["at least one --manifest is required"]);
  const manifests: ManifestInput[] = [];
  const manifestFiles: Preflight["manifestFiles"] = [];
  for (const file of options.manifestFiles) {
    const { value, sha256 } = readJsonFile(file, deps.readFile);
    const { manifest, problems: p } = validateSingleManifest(value);
    if (!manifest) problems.push(...p.map((x) => `${path.basename(file)}: ${x}`));
    else {
      manifests.push({ manifest, fileSha256: sha256 });
      manifestFiles.push({ split: manifest.split, fileSha256: sha256 });
    }
  }
  const receipts: FreezeReceipt[] = [];
  const receiptFiles: Preflight["receiptFiles"] = [];
  for (const file of options.receiptFiles) {
    const { value, sha256 } = readJsonFile(file, deps.readFile);
    const { receipt, problems: p } = validateFreezeReceipt(value);
    if (!receipt) problems.push(...p.map((x) => `${path.basename(file)}: ${x}`));
    else {
      receipts.push(receipt);
      receiptFiles.push({ split: receipt.split, fileSha256: sha256 });
    }
  }
  if (problems.length > 0) throw new EvaluationRefusal(problems);

  // The same integrity code the scorer uses, in the stage that needs no labels or predictions yet.
  problems.push(...integrityProblems({ manifests, gold: [], receipts, predictions: null, images: imagesFrom(options.imagesDir, deps.readFile), stage: "run" }));
  for (const { manifest } of manifests) {
    if (manifest.fixtures.length === 0) problems.push(`the ${manifest.split} manifest lists no fixtures`);
    if (manifest.split === "heldout" && !manifest.frozenAt) problems.push("a held-out fixture needs a frozen manifest");
    // (A held-out split's receipt is required and digest-checked by integrityProblems above; a development receipt is optional but, if given, must match.)
    const receipt = manifest.split === "heldout" ? undefined : receipts.find((r) => r.split === manifest.split);
    const mine = manifests.find((m) => m.manifest.split === manifest.split);
    if (receipt && mine?.fileSha256 !== receipt.manifestSha256) problems.push(`the ${manifest.split} freeze receipt does not match its manifest file's digest`);
  }
  const fixtures = manifests.flatMap(({ manifest }) => manifest.fixtures.map((fixture) => ({ fixture, split: manifest.split })));
  fixtures.sort((a, b) => (a.fixture.id < b.fixture.id ? -1 : a.fixture.id > b.fixture.id ? 1 : 0));
  const benchmarkId = manifests[0]?.manifest.benchmarkId ?? "";

  // Every image must decode with the app's own normalizer BEFORE any inference; an undecodable image
  // would otherwise surface as a half-finished run.
  if (problems.length === 0) {
    for (const { fixture } of fixtures) {
      try {
        await deps.normalize(deps.readFile(path.join(options.imagesDir, fixture.file)));
      } catch {
        problems.push(`fixture "${fixture.id}": the app's normalizePhoto cannot read this image`);
      }
    }
  }

  let identity: RunIdentity | null = null;
  try {
    identity = await deps.identity();
  } catch (e) {
    problems.push(e instanceof EvaluationRefusal ? e.message : "the model identity could not be determined (is the configured model installed and Ollama reachable?)");
  }
  if (identity && options.expectedModelVersion !== undefined && options.expectedModelVersion !== identity.modelVersion)
    problems.push("--model-version does not match what the runtime reports for this model; it cannot be used to relabel a run");
  const git = deps.git();
  if (!/^[0-9a-f]{40}$/.test(git.commit)) problems.push("the app git commit could not be determined");
  if (git.dirty && !options.allowDirtyDevelopment)
    problems.push("the worktree has uncommitted changes; commit them, or pass --allow-dirty-development to make a development-only run (which can never be launch evidence)");
  if (problems.length > 0 || !identity) throw new EvaluationRefusal([...new Set(problems)]);
  return { manifests, manifestFiles, receiptFiles, receipts, fixtures, identity, git, developmentOnly: git.dirty && options.allowDirtyDevelopment, benchmarkId };
}

// ----------------------------------------------------------------------------- receipts

const RUN_RECEIPT_KEYS = [
  "schemaVersion",
  "kind",
  "runId",
  "runnerId",
  "analysisMode",
  "benchmarkId",
  "inputsDigest",
  "startedAt",
  "gitCommit",
  "gitDirty",
  "developmentOnly",
  "model",
  "modelVersion",
  "promptSha256",
  "requestSha256",
  "timeoutMs",
  "nodeVersion",
  "manifests",
  "receipts",
  "fixtures",
] as const;

function digestRows(v: unknown, at: string, out: string[]): Array<{ split: Split; fileSha256: string }> {
  if (!Array.isArray(v)) {
    out.push(`${at}: must be a list`);
    return [];
  }
  return v.flatMap((r: unknown, i: number) => {
    if (!isRecord(r)) {
      out.push(`${at}[${i}]: must be an object`);
      return [];
    }
    expectKeys(r, ["split", "fileSha256"], `${at}[${i}]`, out);
    if (r.split !== "development" && r.split !== "heldout") out.push(`${at}[${i}].split: invalid`);
    if (typeof r.fileSha256 !== "string" || !SHA256_RE.test(r.fileSha256)) out.push(`${at}[${i}].fileSha256: invalid`);
    return [{ split: r.split as Split, fileSha256: String(r.fileSha256).toLowerCase() }];
  });
}

export function validateRunReceipt(doc: unknown): { receipt: RunReceipt | null; problems: string[] } {
  const out: string[] = [];
  if (!isRecord(doc)) return { receipt: null, problems: ["run receipt: must be a JSON object"] };
  expectKeys(doc, RUN_RECEIPT_KEYS, "run receipt", out);
  if (doc.schemaVersion !== 1) out.push("run receipt: schemaVersion must be 1");
  if (doc.kind !== "single-item-run-receipt") out.push('run receipt: kind must be "single-item-run-receipt"');
  if (doc.analysisMode !== "single") out.push('run receipt: analysisMode must be "single"');
  for (const key of ["runId", "runnerId", "benchmarkId", "model", "modelVersion", "nodeVersion"] as const)
    if (!isNonEmptyString(doc[key])) out.push(`run receipt.${key}: must be a non-empty string`);
  for (const key of ["inputsDigest", "promptSha256", "requestSha256"] as const)
    if (typeof doc[key] !== "string" || !SHA256_RE.test(doc[key] as string)) out.push(`run receipt.${key}: must be 64 hex characters`);
  if (typeof doc.gitCommit !== "string" || !/^[0-9a-f]{40}$/.test(doc.gitCommit)) out.push("run receipt.gitCommit: must be a full commit id");
  if (typeof doc.gitDirty !== "boolean" || typeof doc.developmentOnly !== "boolean") out.push("run receipt: gitDirty and developmentOnly must be true or false");
  if (doc.gitDirty === true && doc.developmentOnly !== true) out.push("run receipt: a dirty worktree requires developmentOnly");
  if (!isIsoTimestamp(doc.startedAt)) out.push("run receipt.startedAt: must be an ISO timestamp");
  if (!isNonNegativeFinite(doc.timeoutMs)) out.push("run receipt.timeoutMs: must be a non-negative number");
  const manifests = digestRows(doc.manifests, "run receipt.manifests", out);
  const receipts = digestRows(doc.receipts, "run receipt.receipts", out);
  const fixtures: RunReceipt["fixtures"] = [];
  if (!Array.isArray(doc.fixtures) || doc.fixtures.length === 0) out.push("run receipt.fixtures: must be a non-empty list");
  else
    doc.fixtures.forEach((f: unknown, i: number) => {
      if (!isRecord(f)) return void out.push(`run receipt.fixtures[${i}]: must be an object`);
      expectKeys(f, ["id", "split", "sha256"], `run receipt.fixtures[${i}]`, out);
      if (!isNonEmptyString(f.id) || typeof f.sha256 !== "string" || !SHA256_RE.test(f.sha256) || (f.split !== "development" && f.split !== "heldout"))
        out.push(`run receipt.fixtures[${i}]: invalid`);
      else fixtures.push({ id: f.id, split: f.split, sha256: f.sha256.toLowerCase() });
    });
  if (new Set(fixtures.map((f) => f.id)).size !== fixtures.length) out.push("run receipt.fixtures: a fixture appears twice");
  if (out.length > 0) return { receipt: null, problems: out };
  const receipt = { ...(doc as unknown as RunReceipt), manifests, receipts, fixtures };
  if (inputsDigestOf(receipt) !== String(doc.inputsDigest).toLowerCase()) return { receipt: null, problems: ["run receipt: inputsDigest does not match the receipt's own contents (edited)"] };
  return { receipt, problems: [] };
}

const COMPLETION_KEYS = ["schemaVersion", "kind", "runId", "inputsDigest", "runReceiptSha256", "completedAt", "records", "outcomes", "unexpectedErrors"] as const;

export function validateCompletionReceipt(doc: unknown): { receipt: CompletionReceipt | null; problems: string[] } {
  const out: string[] = [];
  if (!isRecord(doc)) return { receipt: null, problems: ["completion receipt: must be a JSON object"] };
  expectKeys(doc, COMPLETION_KEYS, "completion receipt", out);
  if (doc.schemaVersion !== 1) out.push("completion receipt: schemaVersion must be 1");
  if (doc.kind !== "single-item-run-completion") out.push('completion receipt: kind must be "single-item-run-completion"');
  if (!isNonEmptyString(doc.runId)) out.push("completion receipt.runId: invalid");
  for (const key of ["inputsDigest", "runReceiptSha256"] as const)
    if (typeof doc[key] !== "string" || !SHA256_RE.test(doc[key] as string)) out.push(`completion receipt.${key}: invalid`);
  if (!isIsoTimestamp(doc.completedAt)) out.push("completion receipt.completedAt: invalid");
  if (!Number.isInteger(doc.unexpectedErrors) || (doc.unexpectedErrors as number) < 0) out.push("completion receipt.unexpectedErrors: invalid");
  if (!isRecord(doc.outcomes)) out.push("completion receipt.outcomes: must be an object");
  else {
    expectKeys(doc.outcomes, ["ok", "timeout", "unavailable", "unverified"], "completion receipt.outcomes", out);
    for (const v of Object.values(doc.outcomes)) if (!Number.isInteger(v) || (v as number) < 0) out.push("completion receipt.outcomes: counts must be whole numbers");
  }
  const records: CompletionReceipt["records"] = [];
  if (!Array.isArray(doc.records) || doc.records.length === 0) out.push("completion receipt.records: must be a non-empty list");
  else
    doc.records.forEach((r: unknown, i: number) => {
      if (!isRecord(r)) return void out.push(`completion receipt.records[${i}]: must be an object`);
      expectKeys(r, ["fixtureId", "sha256"], `completion receipt.records[${i}]`, out);
      if (!isNonEmptyString(r.fixtureId) || typeof r.sha256 !== "string" || !SHA256_RE.test(r.sha256)) out.push(`completion receipt.records[${i}]: invalid`);
      else records.push({ fixtureId: r.fixtureId, sha256: r.sha256.toLowerCase() });
    });
  if (new Set(records.map((r) => r.fixtureId)).size !== records.length) out.push("completion receipt.records: a fixture appears twice");
  if (out.length > 0) return { receipt: null, problems: out };
  return { receipt: { ...(doc as unknown as CompletionReceipt), records }, problems: [] };
}

// ----------------------------------------------------------------------------- run directory state

export type RunState = {
  receipt: RunReceipt;
  receiptSha256: string;
  /** Valid records already published, by fixture id. */
  records: Map<string, { record: AnalyzePhotoRecord; sha256: string }>;
  completion: { receipt: CompletionReceipt; sha256: string } | null;
};

const recordFile = (dir: string, fixtureId: string) => path.join(dir, RECORDS_DIR, `${fixtureId}.json`);

/** Checks one saved record against the run receipt and the fixture it claims to be. */
export function recordProblems(rec: AnalyzePhotoRecord, receipt: RunReceipt): string[] {
  const out: string[] = [];
  const fixture = receipt.fixtures.find((f) => f.id === rec.fixtureId);
  if (!fixture) return [`record for "${rec.fixtureId}" is not a fixture of this run`];
  if (rec.imageSha256.toLowerCase() !== fixture.sha256) out.push(`record for "${rec.fixtureId}" holds a different image hash than the frozen fixture`);
  if (rec.model !== receipt.model || rec.modelVersion !== receipt.modelVersion) out.push(`record for "${rec.fixtureId}" was made by a different model or version than the run receipt`);
  if (rec.promptId !== promptIdOf(receipt.requestSha256)) out.push(`record for "${rec.fixtureId}" names a different prompt/request than the run receipt`);
  if (rec.timeoutMs !== receipt.timeoutMs) out.push(`record for "${rec.fixtureId}" used a different timeout than the run receipt`);
  if (Date.parse(rec.startedAt) < Date.parse(receipt.startedAt)) out.push(`record for "${rec.fixtureId}" starts before the run does`);
  return out;
}

/**
 * Reads a run directory strictly. Used by resume and by the adapter. Refuses foreign files, temporary
 * files left by a crash, corrupt or conflicting records. Does not require completion.
 */
export function readRunDirectory(dir: string, read: (f: string) => Buffer = readFileSync): RunState {
  const problems: string[] = [];
  const receiptJson = readJsonFile(path.join(dir, RUN_RECEIPT_FILE), read);
  const { receipt, problems: rp } = validateRunReceipt(receiptJson.value);
  if (!receipt) throw new EvaluationRefusal(rp);
  const allowedTop = new Set([RUN_RECEIPT_FILE, COMPLETION_RECEIPT_FILE, LOCK_FILE, RECORDS_DIR]);
  for (const name of readdirSync(dir)) if (!allowedTop.has(name)) problems.push(`foreign file in the run directory: ${name}`);
  const records = new Map<string, { record: AnalyzePhotoRecord; sha256: string }>();
  const recDir = path.join(dir, RECORDS_DIR);
  if (existsSync(recDir)) {
    for (const name of readdirSync(recDir).sort()) {
      if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) {
        problems.push(`unfinished or foreign file in records/: ${name} (never evidence; check no runner is active, delete it and resume)`);
        continue;
      }
      let json: { value: unknown; sha256: string };
      try {
        json = readJsonFile(path.join(recDir, name), read);
      } catch (e) {
        problems.push(`records/${name}: ${(e as Error).message}`);
        continue;
      }
      const { record, problems: vp } = validateAnalyzePhotoRecord(json.value);
      if (!record) {
        problems.push(...vp.map((x) => `records/${name}: ${x}`));
        continue;
      }
      if (`${record.fixtureId}.json` !== name) problems.push(`records/${name}: the file name does not match its fixture "${record.fixtureId}"`);
      problems.push(...recordProblems(record, receipt).map((x) => `records/${name}: ${x}`));
      if (records.has(record.fixtureId)) problems.push(`duplicate evidence for fixture "${record.fixtureId}"`);
      records.set(record.fixtureId, { record, sha256: json.sha256 });
    }
  }
  let completion: RunState["completion"] = null;
  const completionPath = path.join(dir, COMPLETION_RECEIPT_FILE);
  if (existsSync(completionPath)) {
    const c = readJsonFile(completionPath, read);
    const parsed = validateCompletionReceipt(c.value);
    if (!parsed.receipt) problems.push(...parsed.problems);
    else completion = { receipt: parsed.receipt, sha256: c.sha256 };
  }
  if (problems.length > 0) throw new EvaluationRefusal(problems);
  return { receipt, receiptSha256: receiptJson.sha256, records, completion };
}

/**
 * A directory whose completion receipt vouches for every record. Throws unless the run is COMPLETE and
 * every part agrees; this is the only door to launch evidence.
 */
export function readCompleteRun(dir: string, read: (f: string) => Buffer = readFileSync): RunState & { completion: NonNullable<RunState["completion"]> } {
  const state = readRunDirectory(dir, read);
  const problems: string[] = [];
  if (!state.completion) {
    throw new EvaluationRefusal([`the run is incomplete: ${state.records.size} of ${state.receipt.fixtures.length} fixture(s) have a record and there is no completion receipt; resume it with single-run-qwen before adapting`]);
  }
  const c = state.completion.receipt;
  if (c.runId !== state.receipt.runId || c.inputsDigest !== state.receipt.inputsDigest) problems.push("the completion receipt belongs to a different run");
  if (c.runReceiptSha256 !== state.receiptSha256) problems.push("the run receipt changed after the run completed");
  const listed = new Map(c.records.map((r) => [r.fixtureId, r.sha256]));
  for (const f of state.receipt.fixtures) {
    const have = state.records.get(f.id);
    if (!have) problems.push(`fixture "${f.id}" has no record although the run claims completion`);
    else if (listed.get(f.id) !== have.sha256) problems.push(`record for "${f.id}" differs from what the completion receipt vouched for (changed after completion)`);
  }
  for (const id of listed.keys()) if (!state.receipt.fixtures.some((f) => f.id === id)) problems.push(`the completion receipt lists "${id}", which is not a fixture of this run`);
  if (c.records.length !== state.receipt.fixtures.length) problems.push("the completion receipt does not list exactly the run's fixtures");
  // Everything the completion receipt states about the records is re-derived from the records themselves.
  const derived = outcomeTally([...state.records.values()].map((r) => r.record));
  for (const key of Object.keys(derived.outcomes) as AnalyzePhotoOutcome[])
    if (c.outcomes[key] !== derived.outcomes[key]) problems.push(`the completion receipt says ${c.outcomes[key]} "${key}" outcome(s) but the records hold ${derived.outcomes[key]} (edited)`);
  if (c.unexpectedErrors !== derived.unexpectedErrors) problems.push(`the completion receipt says ${c.unexpectedErrors} unexpected runner error(s) but the records hold ${derived.unexpectedErrors} (edited)`);
  const completedAt = Date.parse(c.completedAt);
  if (completedAt < Date.parse(state.receipt.startedAt)) problems.push("the completion time is before the run started (edited)");
  const lastStart = Math.max(...[...state.records.values()].map((r) => Date.parse(r.record.startedAt)));
  if (completedAt < lastStart) problems.push("the completion time is before the last record started (edited)");
  if (problems.length > 0) throw new EvaluationRefusal(problems);
  return state as RunState & { completion: NonNullable<RunState["completion"]> };
}

/** Outcome counts and the number of unexpected-runner-error records, derived from the records. */
export function outcomeTally(records: readonly AnalyzePhotoRecord[]): { outcomes: Record<AnalyzePhotoOutcome, number>; unexpectedErrors: number } {
  const outcomes: Record<AnalyzePhotoOutcome, number> = { ok: 0, timeout: 0, unavailable: 0, unverified: 0 };
  let unexpectedErrors = 0;
  for (const r of records) {
    outcomes[r.outcome]++;
    if (r.error?.startsWith(UNEXPECTED_PREFIX)) unexpectedErrors++;
  }
  return { outcomes, unexpectedErrors };
}

/** Builds the binding the scorer cross-checks. `cases` are the adapted prediction cases. */
export function bindingFor(state: ReturnType<typeof readCompleteRun>, cases: ReadonlyArray<{ fixtureId: string }>): RunBinding {
  const r = state.receipt;
  return {
    runId: r.runId,
    inputsDigest: r.inputsDigest,
    runReceiptSha256: state.receiptSha256,
    completionReceiptSha256: state.completion.sha256,
    gitCommit: r.gitCommit,
    gitDirty: r.gitDirty,
    developmentOnly: r.developmentOnly,
    runnerId: r.runnerId,
    model: r.model,
    modelVersion: r.modelVersion,
    promptSha256: r.promptSha256,
    requestSha256: r.requestSha256,
    manifests: r.manifests,
    receipts: r.receipts,
    casesSha256: casesDigest(cases),
  };
}

/**
 * The prediction report for a COMPLETE run, derived only from the run directory: the one function both the
 * adapter and the scoring-time verifier use, so what is written and what is re-derived cannot differ.
 */
export function predictionsFromRun(state: ReturnType<typeof readCompleteRun>): SinglePredictionReport {
  const records = state.receipt.fixtures.map((f) => (state.records.get(f.id) as { record: AnalyzePhotoRecord }).record);
  const cases = records.map(toSingleCase).sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : 1));
  const { run, problems } = singleRunInfo(records);
  if (!run) throw new EvaluationRefusal(problems);
  return {
    schemaVersion: 1,
    kind: "single-item-predictions",
    run: {
      ...run,
      prompt: { id: run.prompt.id, sha256: state.receipt.promptSha256 },
      startedAt: state.receipt.startedAt,
      notes: `Adapted from a complete ${RUNNER_ID} run (${state.receipt.runId}). Image hashes and timing were recorded by the runner around the app analyzePhoto.`,
      runBinding: bindingFor(state, cases),
    },
    cases,
  };
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(JSON.parse(JSON.stringify(a))) === canonicalJson(JSON.parse(JSON.stringify(b)));

/**
 * Scoring-time proof for launch evidence. Re-opens the run DIRECTORY, requires it complete and internally
 * consistent (readCompleteRun), refuses a development-only or dirty run on the directory's own receipt,
 * re-adapts its records and requires the supplied predictions (run block, binding and every case) to be
 * exactly equal. A runBinding typed into a predictions file by hand therefore verifies nothing.
 */
export function verifyPredictionsAgainstRun(
  runDir: string,
  supplied: SinglePredictionReport,
  manifests: ReadonlyArray<{ manifest: { split: Split }; fileSha256: string | null }>,
  read: (f: string) => Buffer = readFileSync,
): VerifiedRun {
  const state = readCompleteRun(runDir, read);
  const r = state.receipt;
  const problems: string[] = [];
  if (r.developmentOnly || r.gitDirty) problems.push("the run directory's own receipt says development-only or dirty worktree; it can never be launch evidence");
  for (const bound of r.manifests) {
    const given = manifests.find((m) => m.manifest.split === bound.split);
    if (!given || given.fileSha256 === null) problems.push(`the ${bound.split} manifest file the run used was not supplied (or its digest is unknown)`);
    else if (given.fileSha256 !== bound.fileSha256) problems.push(`the ${bound.split} manifest file differs from the one the run used`);
  }
  for (const m of manifests) if (!r.manifests.some((b) => b.split === m.manifest.split)) problems.push(`a ${m.manifest.split} manifest was supplied that the run did not use`);
  if (problems.length > 0) throw new EvaluationRefusal(problems);
  const expected = predictionsFromRun(state);
  const { runBinding: expectedBinding, ...expectedRun } = expected.run;
  const { runBinding: suppliedBinding, ...suppliedRun } = supplied.run;
  if (!suppliedBinding) problems.push("the supplied predictions carry no run binding, so they do not come from this run");
  else if (!sameJson(suppliedBinding, expectedBinding)) problems.push("the supplied predictions' run binding differs from the one derived from the run directory (hand-written or from another run)");
  if (!sameJson(suppliedRun, expectedRun)) problems.push("the supplied predictions' run information differs from the one derived from the run directory");
  if (!sameJson(supplied.cases, expected.cases)) problems.push("the supplied predictions' cases differ from the cases re-derived from the run directory's records");
  if (problems.length > 0) throw new EvaluationRefusal(problems);
  return { runId: r.runId, inputsDigest: r.inputsDigest, completionReceiptSha256: state.completion.sha256, requestSha256: r.requestSha256, modelVersion: r.modelVersion };
}

// ----------------------------------------------------------------------------- writing (exclusive creates only)

/**
 * The file operations createExclusive uses, as a seam so tests can make a write fail half way. The default
 * is plain node:fs. Only open/write/fsync/close/unlink are used: no rename and no hard link, which Windows
 * sandboxes refuse (EPERM) on some volumes.
 */
export type ExclusiveFs = {
  open: (file: string) => number;
  write: (fd: number, text: string) => void;
  fsync: (fd: number) => void;
  close: (fd: number) => void;
  unlink: (file: string) => void;
};
const realFs: ExclusiveFs = {
  open: (file) => openSync(file, "wx"),
  write: (fd, text) => void writeSync(fd, text),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  unlink: (file) => unlinkSync(file),
};

/**
 * Creates `file` exclusively (flag "wx": fails with EEXIST if the name exists, so nothing is ever
 * overwritten) and writes `text` to it. If the open fails, nothing of ours exists and nothing is removed
 * (in particular not the other writer's file). Once the open has succeeded the file is ours, and if the
 * write or flush then fails that partial file, and only that one, is removed.
 */
function createExclusive(file: string, text: string, ops: ExclusiveFs = realFs): void {
  const fd = ops.open(file);
  let ok = false;
  let closeError: unknown = null;
  try {
    ops.write(fd, text);
    ops.fsync(fd);
    ok = true;
  } finally {
    try {
      ops.close(fd);
    } catch (e) {
      ok = false;
      closeError = e;
    }
    if (!ok) {
      try {
        ops.unlink(file);
      } catch {
        /* the half-written file is ours; best effort (a crash right here leaves it, and resume refuses it as corrupt) */
      }
    }
  }
  // A failed close after a good write is still a failed publication: rolled back above, reported here.
  if (closeError !== null) throw closeError;
}

/**
 * Publishes a record at its FINAL path with exclusive-create semantics: validated first, then written in
 * place. There is no temporary file and no rename. If another writer already holds the name (EEXIST) the
 * publication is refused and that writer's file is left exactly as it is (never verified-and-adopted,
 * never mixed in). A crash while writing can leave a partial final file; a reader never trusts it
 * because resume and adaptation parse every record strictly and refuse a truncated one until it is
 * deleted by hand.
 */
function publishRecord(dir: string, rec: AnalyzePhotoRecord, ops: ExclusiveFs = realFs): string {
  const text = stable(rec);
  // Validate before publication: what is written must be exactly what the reader will accept.
  const check = validateAnalyzePhotoRecord(JSON.parse(text));
  if (!check.record) throw new EvaluationRefusal(check.problems.map((p) => `refusing to publish an invalid record: ${p}`));
  try {
    createExclusive(recordFile(dir, rec.fixtureId), text, ops);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new EvaluationRefusal([`evidence for "${rec.fixtureId}" already exists; evidence is never overwritten (another runner?)`]);
    throw e;
  }
  return sha(text);
}

// ----------------------------------------------------------------------------- the run

export type RunResult = {
  runDir: string;
  runId: string;
  resumed: boolean;
  total: number;
  alreadyDone: number;
  ran: number;
  outcomes: Record<AnalyzePhotoOutcome, number>;
  developmentOnly: boolean;
};

class RunInterrupted extends Error {}

function takeLock(dir: string, deps: RunnerDeps): () => void {
  const lock = path.join(dir, LOCK_FILE);
  try {
    createExclusive(lock, stable({ pid: process.pid, at: deps.now().toISOString() }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new EvaluationRefusal([`another runner holds ${LOCK_FILE} in this run directory (or one crashed). Check no runner is active, then delete ${LOCK_FILE} by hand and resume`]);
    throw e;
  }
  return () => {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  };
}

export async function runBenchmark(options: RunOptions, deps: RunnerDeps): Promise<RunResult> {
  const dir = options.runDir;
  const resuming = existsSync(dir);
  // 1. Preflight: nothing is created and nothing reaches the model unless this passes completely.
  const pf = await preflight(options, deps);
  const base: Omit<RunReceipt, "inputsDigest" | "runId" | "startedAt"> = {
    schemaVersion: 1,
    kind: "single-item-run-receipt",
    runnerId: RUNNER_ID,
    analysisMode: "single",
    benchmarkId: pf.benchmarkId,
    gitCommit: pf.git.commit,
    gitDirty: pf.git.dirty,
    developmentOnly: pf.developmentOnly,
    model: pf.identity.model,
    modelVersion: pf.identity.modelVersion,
    promptSha256: pf.identity.promptSha256,
    requestSha256: pf.identity.requestSha256,
    timeoutMs: pf.identity.timeoutMs,
    nodeVersion: process.version,
    manifests: [...pf.manifestFiles].sort((a, b) => (a.split < b.split ? -1 : 1)),
    receipts: [...pf.receiptFiles].sort((a, b) => (a.split < b.split ? -1 : 1)),
    fixtures: pf.fixtures.map(({ fixture, split }) => ({ id: fixture.id, split, sha256: fixture.sha256 })),
  };
  const inputsDigest = inputsDigestOf(base);

  // 2. New directory (exclusive mkdir: only one creator can win) or a matching existing one.
  let receipt: RunReceipt;
  let receiptSha256: string;
  if (!resuming) {
    try {
      mkdirSync(dir, { recursive: false });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new EvaluationRefusal(["the run directory appeared while starting (another runner?)"]);
      throw new EvaluationRefusal([`cannot create the run directory (does its parent exist?)`]);
    }
    mkdirSync(path.join(dir, RECORDS_DIR));
    receipt = { ...base, inputsDigest, runId: randomUUID(), startedAt: deps.now().toISOString() };
    createExclusive(path.join(dir, RUN_RECEIPT_FILE), stable(receipt));
    receiptSha256 = sha(stable(receipt));
  } else {
    if (!statSync(dir).isDirectory()) throw new EvaluationRefusal(["the run path exists and is not a directory"]);
    const state = readRunDirectory(dir, deps.readFile);
    if (state.completion) throw new EvaluationRefusal(["this run is already complete; start a new run directory instead of re-running"]);
    if (state.receipt.inputsDigest !== inputsDigest)
      throw new EvaluationRefusal(["the run receipt in this directory was made with different inputs (manifest, receipt, image, model, prompt, timeout, commit or mode); it cannot be resumed with these. Start a new run directory"]);
    receipt = state.receipt;
    receiptSha256 = state.receiptSha256;
  }

  // 3. Lock, then run every fixture that has no valid record yet.
  const release = takeLock(dir, deps);
  try {
    const state = readRunDirectory(dir, deps.readFile); // re-read under the lock: what we see is what we extend
    const done = state.records;
    const todo = pf.fixtures.filter(({ fixture }) => !done.has(fixture.id));
    const outcomes: Record<AnalyzePhotoOutcome, number> = { ok: 0, timeout: 0, unavailable: 0, unverified: 0 };
    let ran = 0;
    deps.log(`${resuming ? "resuming" : "starting"} run ${receipt.runId}: ${pf.fixtures.length} fixture(s), ${done.size} already recorded, mode single, model ${receipt.model}${receipt.developmentOnly ? " (DEVELOPMENT ONLY: not launch evidence)" : ""}`);
    for (const { fixture } of todo) {
      if (deps.signal?.aborted) throw new RunInterrupted();
      const rec = await runOne(fixture, receipt, options, deps);
      if (rec === "interrupted") throw new RunInterrupted();
      publishRecord(dir, rec, deps.recordFs);
      outcomes[rec.outcome]++;
      ran++;
      deps.log(`recorded ${fixture.id}: ${rec.outcome} in ${Math.round(rec.elapsedMs)} ms`);
    }

    // 4. Completion: only when every requested fixture has exactly one valid record.
    const final = readRunDirectory(dir, deps.readFile);
    const missing = receipt.fixtures.filter((f) => !final.records.has(f.id));
    if (missing.length > 0) throw new EvaluationRefusal([`not completing: ${missing.length} fixture(s) have no valid record`]);
    // The run is only as good as the thing that ran. Re-check, now, what was sampled at the start: if the
    // code, its cleanliness, the model bytes or the request identity moved, the records stay on disk (they are
    // real evidence of what happened) but NO completion receipt is written, so this run can never be adapted
    // for launch evidence, and resuming it is refused (its inputs no longer match).
    const drift = await identityDrift(receipt, deps);
    if (drift.length > 0)
      throw new EvaluationRefusal([`not completing: the run's identity changed while it ran (${drift.join("; ")}). The records are kept but the run is not launch evidence; start a new run directory.`]);
    const { outcomes: allOutcomes, unexpectedErrors: allUnexpected } = outcomeTally([...final.records.values()].map((r) => r.record));
    const completion: CompletionReceipt = {
      schemaVersion: 1,
      kind: "single-item-run-completion",
      runId: receipt.runId,
      inputsDigest: receipt.inputsDigest,
      runReceiptSha256: receiptSha256,
      completedAt: deps.now().toISOString(),
      records: receipt.fixtures.map((f) => ({ fixtureId: f.id, sha256: (final.records.get(f.id) as { sha256: string }).sha256 })),
      outcomes: allOutcomes,
      unexpectedErrors: allUnexpected,
    };
    createExclusive(path.join(dir, COMPLETION_RECEIPT_FILE), stable(completion));
    return { runDir: dir, runId: receipt.runId, resumed: resuming, total: pf.fixtures.length, alreadyDone: done.size, ran, outcomes: allOutcomes, developmentOnly: receipt.developmentOnly };
  } finally {
    release();
  }
}

/** Differences between what the run receipt recorded at the start and what is true now (empty = unchanged). */
async function identityDrift(receipt: RunReceipt, deps: RunnerDeps): Promise<string[]> {
  const drift: string[] = [];
  const git = deps.git();
  if (git.commit !== receipt.gitCommit) drift.push("the app git commit changed");
  if (git.dirty !== receipt.gitDirty) drift.push(git.dirty ? "the worktree became dirty" : "the worktree is no longer dirty");
  let now: RunIdentity | null = null;
  try {
    now = await deps.identity();
  } catch {
    drift.push("the model identity could not be re-checked");
  }
  if (now) {
    if (now.model !== receipt.model) drift.push("the configured model changed");
    if (now.modelVersion !== receipt.modelVersion) drift.push("the installed model digest changed");
    if (now.promptSha256 !== receipt.promptSha256 || now.requestSha256 !== receipt.requestSha256) drift.push("the app's request identity (prompt, schema, options) changed");
    if (now.timeoutMs !== receipt.timeoutMs) drift.push("the inference timeout changed");
  }
  return drift;
}

/** One fixture: hash, normalize, analyze (timed together), classify. Returns the record to publish. */
async function runOne(
  fixture: SingleFixture,
  receipt: RunReceipt,
  options: RunOptions,
  deps: RunnerDeps,
): Promise<AnalyzePhotoRecord | "interrupted"> {
  const bytes = deps.readFile(path.join(options.imagesDir, fixture.file));
  // The frozen hash is what the record keeps; bytes that changed since preflight stop the run.
  if (sha256Hex(bytes) !== fixture.sha256) throw new EvaluationRefusal([`fixture "${fixture.id}": the image changed after preflight (hash mismatch); stopping before any more evidence is written`]);
  const startedAt = deps.now().toISOString();
  const t0 = deps.monotonicMs();
  let outcome: AnalyzePhotoOutcome = "ok";
  let error: string | null = null;
  let analysis: unknown = null;
  try {
    const normalized = await deps.normalize(bytes);
    const result = await deps.analyze(normalized, deps.signal, { mode: "single" });
    analysis = result.analysis;
  } catch (e) {
    if (deps.signal?.aborted) return "interrupted"; // an operator interrupt is not model evidence
    const mapped = deps.classify(e);
    if (mapped) {
      outcome = mapped.outcome;
      error = mapped.message;
    } else {
      // Not a vision error: a failure of the runner or the environment. Recorded as a failed case with no
      // output invented, the error TYPE only (messages can hold paths).
      outcome = "unavailable";
      error = `${UNEXPECTED_PREFIX} ${e instanceof Error ? e.name : "non-error value thrown"}`;
    }
    analysis = null;
  }
  const elapsedMs = Math.max(0, Math.round((deps.monotonicMs() - t0) * 1000) / 1000);
  return {
    schemaVersion: 1,
    kind: "analyze-photo-record",
    fixtureId: fixture.id,
    imageSha256: fixture.sha256,
    model: receipt.model,
    modelVersion: receipt.modelVersion,
    promptId: promptIdOf(receipt.requestSha256),
    startedAt,
    elapsedMs,
    timeoutMs: receipt.timeoutMs,
    outcome,
    error,
    analysis,
  };
}

export { RunInterrupted };
