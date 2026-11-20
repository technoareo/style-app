import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { EvaluationRefusal } from "../scripts/vision-evaluation/evaluate";
import { sha256Hex } from "../scripts/vision-evaluation/image";
import { runSingleCli, runSingleRunCli } from "../scripts/vision-evaluation/single-item/cli";
import { integrityProblems } from "../scripts/vision-evaluation/single-item/integrity";
import { validateAnalyzePhotoRecord } from "../scripts/vision-evaluation/single-item/adapter";
import { validateSinglePredictionReport } from "../scripts/vision-evaluation/single-item/predictions";
import { casesDigest } from "../scripts/vision-evaluation/single-item/run-binding";
import {
  COMPLETION_RECEIPT_FILE,
  LOCK_FILE,
  RECORDS_DIR,
  RUN_RECEIPT_FILE,
  RunInterrupted,
  preflight,
  readCompleteRun,
  readRunDirectory,
  runBenchmark,
  type ExclusiveFs,
  type RunIdentity,
  type RunOptions,
  type RunnerDeps,
} from "../scripts/vision-evaluation/single-item/runner";
import { makeClassify } from "../scripts/vision-evaluation/single-item/runner-real";
import { runBindingProblems, type SingleReport } from "../scripts/vision-evaluation/single-item/score";
import { PROMPT_SUFFIX, SINGLE_ITEM_PROMPT } from "../src/domain/analysis";
import { VisionError, visionRequestIdentity } from "../src/server/vision";
import { makeTempDir, removeTempDir } from "./helpers/tempDir";

/**
 * Tests of the build 025 benchmark runner. No Ollama, no network: analysis, normalization, time and git are
 * injected fakes; files live in real temp directories. Images are synthetic PNG headers. Nothing here measures
 * a model or claims the app is ready.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const PREFIX = "single-item-025-";
const HEX = (c: string) => c.repeat(64);

// ------------------------------------------------------------------ synthetic benchmark on disk

function pngBytes(salt: string): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(640, 16);
  head.writeUInt32BE(480, 20);
  return Buffer.concat([head, Buffer.from(`salt:${salt}`)]);
}

type Doc = Record<string, any>;
function fixtureDoc(id: string, split: "development" | "heldout", stratum: "in_scope" | "rejection" = "in_scope"): Doc {
  const sha = sha256Hex(pngBytes(id));
  return {
    id,
    file: `${id}.png`,
    sha256: sha,
    dimensions: { width: 640, height: 480, exifOrientation: 1 },
    addedAt: "2026-10-01T00:00:00Z",
    sceneType: "flat_lay",
    stratum,
    rejectionReason: stratum === "rejection" ? "no_garment" : null,
    sourceShootId: `shoot-${id}`,
    garmentId: stratum === "in_scope" ? `garment-${id}` : null,
    priorInference: split === "development",
    priorInferenceNote: split === "development" ? "development image" : null,
    rights: {
      sourceCollection: "wikimedia-commons",
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
    },
    notes: null,
  };
}
const manifestDoc = (split: "development" | "heldout", fixtures: Doc[], frozenAt: string | null): Doc => ({
  schemaVersion: 1,
  kind: "single-item-manifest",
  benchmarkId: "single-item-run-test",
  split,
  frozenAt,
  purpose: `synthetic ${split}`,
  fixtures,
});

const FROZEN_AT = "2026-10-10T00:00:00Z";
const stable = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

type Scenario = {
  dir: string;
  images: string;
  devFile: string;
  heldFile: string;
  receiptFile: string;
  runDir: string;
  docs: { dev: Doc; held: Doc };
  ids: string[];
  options: (over?: Partial<RunOptions>) => RunOptions;
  rewrite: () => void;
};

/** Writes manifests, a matching freeze receipt and the images. `mutate` runs on the documents before they are written. */
function scenario(mutate?: (s: { dev: Doc; held: Doc; receipt: Doc }) => void, only?: "dev" | "held"): Scenario {
  const dir = makeTempDir(PREFIX);
  const images = path.join(dir, "images");
  mkdirSync(images);
  const dev = manifestDoc("development", [fixtureDoc("d1", "development"), fixtureDoc("d2", "development")], null);
  const held = manifestDoc("heldout", [fixtureDoc("h1", "heldout"), fixtureDoc("h2", "heldout"), fixtureDoc("h3", "heldout", "rejection")], FROZEN_AT);
  const receipt: Doc = { schemaVersion: 1, kind: "single-item-freeze-receipt", benchmarkId: "single-item-run-test", split: "heldout", frozenAt: FROZEN_AT, manifestSha256: "", fixtureCount: 3 };
  const s: Scenario = {
    dir,
    images,
    devFile: path.join(dir, "development.manifest.json"),
    heldFile: path.join(dir, "heldout.manifest.json"),
    receiptFile: path.join(dir, "heldout.receipt.json"),
    runDir: path.join(dir, "run"),
    docs: { dev, held },
    ids: [],
    options: (over = {}) => ({
      manifestFiles: only === "dev" ? [s.devFile] : only === "held" ? [s.heldFile] : [s.devFile, s.heldFile],
      receiptFiles: only === "dev" ? [] : [s.receiptFile],
      imagesDir: images,
      runDir: s.runDir,
      allowDirtyDevelopment: false,
      ...over,
    }),
    rewrite: () => undefined,
  };
  mutate?.({ dev, held, receipt });
  s.rewrite = () => {
    writeFileSync(s.devFile, stable(dev));
    writeFileSync(s.heldFile, stable(held));
    if (!receipt.manifestSha256) receipt.manifestSha256 = sha256Hex(Buffer.from(stable(held)));
    writeFileSync(s.receiptFile, stable(receipt));
  };
  s.rewrite();
  for (const f of [...dev.fixtures, ...held.fixtures] as Doc[]) {
    s.ids.push(f.id);
    writeFileSync(path.join(images, f.file), pngBytes(f.id));
  }
  s.ids.sort();
  return s;
}

function withScenario<T>(mutate: Parameters<typeof scenario>[0] | undefined, fn: (s: Scenario) => Promise<T> | T, only?: "dev" | "held"): Promise<T> {
  const s = scenario(mutate, only);
  return Promise.resolve()
    .then(() => fn(s))
    .finally(() => removeTempDir(s.dir, PREFIX));
}

// ------------------------------------------------------------------ fakes

const GOOD_ANALYSIS = {
  items: [
    {
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
    },
  ],
  warning: "",
};

const IDENTITY: RunIdentity = { model: "qwen3-vl:4b-instruct", modelVersion: "ollama-digest:abc123def456", promptSha256: HEX("5"), requestSha256: HEX("6"), timeoutMs: 240000 };

type Calls = { analyze: Array<{ normalized: Buffer; signal: AbortSignal | undefined; options: unknown }>; normalize: Buffer[]; log: string[]; order: string[] };

function fakeDeps(over: Partial<RunnerDeps> = {}, identity: RunIdentity = IDENTITY): { deps: RunnerDeps; calls: Calls } {
  const calls: Calls = { analyze: [], normalize: [], log: [], order: [] };
  let clock = Date.parse("2026-10-12T00:00:00Z");
  let mono = 1000;
  const deps: RunnerDeps = {
    analyze: async (normalized, signal, options) => {
      calls.order.push("analyze");
      calls.analyze.push({ normalized, signal, options });
      return { analysis: structuredClone(GOOD_ANALYSIS) };
    },
    normalize: async (bytes) => {
      calls.order.push("normalize");
      calls.normalize.push(bytes);
      return Buffer.concat([Buffer.from("NORMALIZED:"), bytes]);
    },
    classify: makeClassify(VisionError),
    identity: async () => identity,
    git: () => ({ commit: "c".repeat(40), dirty: false }),
    now: () => new Date((clock += 1000)),
    monotonicMs: () => (mono += 617),
    readFile: (file) => readFileSync(file),
    log: (l) => calls.log.push(l),
    ...over,
  };
  return { deps, calls };
}

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof EvaluationRefusal) return e.message;
    throw e;
  }
  assert.fail("expected the run to be refused");
}

const recordPath = (s: Scenario, id: string) => path.join(s.runDir, RECORDS_DIR, `${id}.json`);
const listRecords = (s: Scenario) => (existsSync(path.join(s.runDir, RECORDS_DIR)) ? readdirSync(path.join(s.runDir, RECORDS_DIR)).sort() : []);

// ================================================================== the contract with the app

test("the runner calls the app's normalizePhoto and analyzePhoto exactly: normalize -> analyze(normalized, signal, {mode:'single'}), once per fixture", async () => {
  await withScenario(undefined, async (s) => {
    const { deps, calls } = fakeDeps();
    const result = await runBenchmark(s.options(), deps);
    assert.equal(result.total, 5);
    assert.equal(result.ran, 5);
    assert.equal(calls.analyze.length, 5);
    for (const call of calls.analyze) {
      assert.deepEqual(call.options, { mode: "single" }, "mode is single and nothing else is passed");
      assert.ok(call.normalized.toString("latin1").startsWith("NORMALIZED:"), "analyze receives the normalizer's output, not the raw bytes");
    }
    // The preflight decode pass normalizes every image once (no analysis); the run normalizes each again inside the timed operation.
    assert.equal(calls.normalize.length, 10);
    assert.deepEqual(calls.order.slice(0, 5), ["normalize", "normalize", "normalize", "normalize", "normalize"], "no analyze before preflight finished");
    assert.deepEqual(calls.order.slice(5), ["normalize", "analyze", "normalize", "analyze", "normalize", "analyze", "normalize", "analyze", "normalize", "analyze"], "inside the run each analysis is preceded by its own normalization");
  });
});

test("records keep the ORIGINAL frozen hash, the receipt's model identity, timeout and the measured duration", async () => {
  await withScenario(undefined, async (s) => {
    const { deps } = fakeDeps();
    await runBenchmark(s.options(), deps);
    const rec = JSON.parse(readFileSync(recordPath(s, "h1"), "utf8"));
    assert.equal(rec.imageSha256, sha256Hex(pngBytes("h1")), "the original bytes' hash, never the normalized copy's");
    assert.equal(rec.kind, "analyze-photo-record");
    assert.equal(rec.schemaVersion, 1);
    assert.equal(rec.outcome, "ok");
    assert.equal(rec.error, null);
    assert.equal(rec.model, IDENTITY.model);
    assert.equal(rec.modelVersion, IDENTITY.modelVersion);
    assert.equal(rec.promptId, `app-single-item:sha256:${IDENTITY.requestSha256}`);
    assert.equal(rec.timeoutMs, 240000);
    assert.equal(rec.elapsedMs, 617, "monotonic end minus start around normalization + analysis");
    assert.match(rec.startedAt, /^2026-10-12T/);
    assert.deepEqual(validateAnalyzePhotoRecord(rec).problems, []);
    // No generated image data URL, no raw model text.
    assert.equal(JSON.stringify(rec).includes("data:image"), false);
    assert.deepEqual(Object.keys(rec).sort(), ["analysis", "elapsedMs", "error", "fixtureId", "imageSha256", "kind", "model", "modelVersion", "outcome", "promptId", "schemaVersion", "startedAt", "timeoutMs"]);
  });
});

test("the run receipt binds commit, manifests, receipts, model, prompt/request hashes, mode, timeout and start; the completion receipt vouches for every record", async () => {
  await withScenario(undefined, async (s) => {
    const { deps } = fakeDeps();
    await runBenchmark(s.options(), deps);
    const r = JSON.parse(readFileSync(path.join(s.runDir, RUN_RECEIPT_FILE), "utf8"));
    assert.equal(r.kind, "single-item-run-receipt");
    assert.equal(r.analysisMode, "single");
    assert.equal(r.gitCommit, "c".repeat(40));
    assert.equal(r.gitDirty, false);
    assert.equal(r.developmentOnly, false);
    assert.equal(r.model, IDENTITY.model);
    assert.equal(r.modelVersion, IDENTITY.modelVersion);
    assert.equal(r.promptSha256, IDENTITY.promptSha256);
    assert.equal(r.requestSha256, IDENTITY.requestSha256);
    assert.equal(r.timeoutMs, 240000);
    assert.match(r.startedAt, /^2026-10-12T/);
    assert.deepEqual(r.manifests, [{ split: "development", fileSha256: sha256Hex(readFileSync(s.devFile)) }, { split: "heldout", fileSha256: sha256Hex(readFileSync(s.heldFile)) }]);
    assert.deepEqual(r.receipts, [{ split: "heldout", fileSha256: sha256Hex(readFileSync(s.receiptFile)) }]);
    assert.equal(r.fixtures.length, 5);
    const c = JSON.parse(readFileSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE), "utf8"));
    assert.equal(c.runId, r.runId);
    assert.equal(c.runReceiptSha256, sha256Hex(readFileSync(path.join(s.runDir, RUN_RECEIPT_FILE))));
    assert.equal(c.records.length, 5);
    for (const rec of c.records) assert.equal(rec.sha256, sha256Hex(readFileSync(recordPath(s, rec.fixtureId))));
    assert.deepEqual(c.outcomes, { ok: 5, timeout: 0, unavailable: 0, unverified: 0 });
    assert.equal(readCompleteRun(s.runDir).completion.receipt.runId, r.runId);
    assert.deepEqual(readdirSync(s.runDir).sort(), [COMPLETION_RECEIPT_FILE, RECORDS_DIR, RUN_RECEIPT_FILE].sort(), "no lock or temporary file is left");
  });
});

// ================================================================== fail closed before inference

const preflightCases: Array<[string, Parameters<typeof scenario>[0], (s: Scenario) => void, RegExp, Partial<RunOptions>?]> = [
  ["held-out manifest without a freeze receipt", undefined, () => undefined, /no freeze receipt/, { receiptFiles: [] }],
  ["freeze receipt for another manifest digest", (d) => (d.receipt.manifestSha256 = HEX("9")), () => undefined, /differs from the frozen receipt/],
  ["freeze receipt with another frozenAt", (d) => (d.receipt.frozenAt = "2026-10-09T00:00:00Z"), () => undefined, /receipt time differs/],
  ["held-out manifest that is not frozen", (d) => (d.held.frozenAt = null), () => undefined, /needs frozenAt|not frozen/],
  ["a held-out image a model has already seen", (d) => (d.held.fixtures[0].priorInference = true), () => undefined, /contaminated/],
  ["a fixture added after the freeze", (d) => (d.held.fixtures[1].addedAt = "2026-10-11T00:00:00Z"), () => undefined, /after the freeze|addedAt/],
  ["an image whose bytes differ from the frozen hash", undefined, (s) => writeFileSync(path.join(s.images, "h2.png"), pngBytes("tampered")), /hash mismatch/],
  ["a missing image file", undefined, (s) => rmSync(path.join(s.images, "d1.png")), /absent or unreadable/],
  ["two fixtures with the same id", (d) => (d.held.fixtures[1].id = "h1"), () => undefined, /duplicate|twice/i],
  ["two fixtures with the same file", (d) => (d.held.fixtures[1].file = "h1.png"), () => undefined, /duplicate|twice|file/i],
  ["a held-out photo that shares a shoot with a development photo", (d) => (d.held.fixtures[0].sourceShootId = "shoot-d1"), () => undefined, /leakage: source shoot/],
  ["a held-out photo that shares a garment with a development photo", (d) => (d.held.fixtures[0].garmentId = "garment-d1"), () => undefined, /leakage: garment/],
  ["a held-out photo with the same bytes as a development photo", (d) => Object.assign(d.held.fixtures[0], { sha256: d.dev.fixtures[0].sha256, rights: { ...d.held.fixtures[0].rights, distributedSha256: d.dev.fixtures[0].sha256, originalSha256: d.dev.fixtures[0].sha256 } }), () => undefined, /leakage: image hash|different image|mismatch/],
  ["manifests of different benchmarks", (d) => (d.dev.benchmarkId = "another-benchmark"), () => undefined, /different benchmarks/],
  ["a dirty worktree without the override", undefined, () => undefined, /uncommitted changes/],
];

for (const [name, mutate, after, expected, optionOver] of preflightCases) {
  test(`preflight refuses ${name}: nothing reaches analyzePhoto and nothing is created`, async () => {
    await withScenario(mutate, async (s) => {
      after(s);
      const dirty = name.startsWith("a dirty worktree");
      const { deps, calls } = fakeDeps(dirty ? { git: () => ({ commit: "c".repeat(40), dirty: true }) } : {});
      const message = await refused(runBenchmark(s.options(optionOver), deps));
      assert.match(message, expected);
      assert.equal(calls.analyze.length, 0, "zero inference");
      assert.equal(existsSync(s.runDir), false, "no run directory, receipt or record was created");
    });
  });
}

test("preflight also refuses: a held-out run without the development manifest, an undecodable image, an unknown model identity, a relabelled model version, an unknown commit", async () => {
  await withScenario(undefined, async (s) => {
    const heldOnly = s.options({ manifestFiles: [s.heldFile] });
    let f = fakeDeps();
    assert.match(await refused(runBenchmark(heldOnly, f.deps)), /without the development manifest/);
    assert.equal(f.calls.analyze.length, 0);
    f = fakeDeps({ normalize: async (b) => { if (b.toString("latin1").includes("salt:h2")) throw new Error("bad image"); return b; } });
    assert.match(await refused(runBenchmark(s.options(), f.deps)), /fixture "h2": the app's normalizePhoto cannot read this image/);
    assert.equal(f.calls.analyze.length, 0);
    f = fakeDeps({ identity: async () => { throw new EvaluationRefusal(["the configured model is not installed"]); } });
    assert.match(await refused(runBenchmark(s.options(), f.deps)), /not installed/);
    f = fakeDeps({ identity: async () => { throw new Error("socket hang up"); } });
    assert.match(await refused(runBenchmark(s.options(), f.deps)), /model identity could not be determined/);
    f = fakeDeps();
    assert.match(await refused(runBenchmark(s.options({ expectedModelVersion: "ollama-digest:something-else" }), f.deps)), /cannot be used to relabel a run/);
    f = fakeDeps({ git: () => ({ commit: "unknown", dirty: true }) });
    assert.match(await refused(runBenchmark(s.options({ allowDirtyDevelopment: true }), f.deps)), /git commit could not be determined/);
    assert.equal(existsSync(s.runDir), false);
    // The same inputs with an honest version assertion pass preflight.
    const ok = fakeDeps();
    assert.equal((await preflight(s.options({ expectedModelVersion: IDENTITY.modelVersion }), ok.deps)).fixtures.length, 5);
    assert.equal(ok.calls.analyze.length, 0, "preflight itself never calls analyzePhoto");
  });
});

test("a failing preflight on a run directory that does not exist leaves it absent; an existing foreign directory is never adopted", async () => {
  await withScenario(undefined, async (s) => {
    mkdirSync(s.runDir);
    writeFileSync(path.join(s.runDir, "notes.txt"), "mine");
    const { deps, calls } = fakeDeps();
    assert.match(await refused(runBenchmark(s.options(), deps)), /cannot read run-receipt\.json/);
    assert.equal(calls.analyze.length, 0);
    assert.equal(readFileSync(path.join(s.runDir, "notes.txt"), "utf8"), "mine");
    assert.deepEqual(readdirSync(s.runDir), ["notes.txt"]);
  });
});

test("a development-only dirty run needs the explicit override, is marked developmentOnly everywhere, and is never launch evidence", async () => {
  await withScenario(undefined, async (s) => {
    const { deps } = fakeDeps({ git: () => ({ commit: "d".repeat(40), dirty: true }) });
    const result = await runBenchmark(s.options({ allowDirtyDevelopment: true }), deps);
    assert.equal(result.developmentOnly, true);
    const r = JSON.parse(readFileSync(path.join(s.runDir, RUN_RECEIPT_FILE), "utf8"));
    assert.equal(r.gitDirty, true);
    assert.equal(r.developmentOnly, true);
    // The scorer treats it as unusable for a launch.
    const state = readCompleteRun(s.runDir);
    assert.equal(state.receipt.developmentOnly, true);
    assert.match(runBindingProblems({ ...bindingOf(state), developmentOnly: true, gitDirty: true }).join(" | "), /development-only override/);
  });
});

function bindingOf(state: ReturnType<typeof readCompleteRun>) {
  return {
    runId: state.receipt.runId,
    inputsDigest: state.receipt.inputsDigest,
    runReceiptSha256: state.receiptSha256,
    completionReceiptSha256: state.completion.sha256,
    gitCommit: state.receipt.gitCommit,
    gitDirty: state.receipt.gitDirty,
    developmentOnly: state.receipt.developmentOnly,
    runnerId: state.receipt.runnerId,
    model: state.receipt.model,
    modelVersion: state.receipt.modelVersion,
    promptSha256: state.receipt.promptSha256,
    requestSha256: state.receipt.requestSha256,
    manifests: state.receipt.manifests,
    receipts: state.receipt.receipts,
    casesSha256: HEX("0"),
  };
}

// ================================================================== error and timeout mapping

test("VisionError kinds map exactly to timeout / unavailable / unverified; unreadable and unexpected errors are recorded as failures without inventing output", async () => {
  await withScenario(undefined, async (s) => {
    const plan: Record<string, () => unknown> = {
      d1: () => { throw new VisionError("This photo took too long to analyze.", "timeout"); },
      d2: () => { throw new VisionError("Photo analysis is temporarily unavailable.", "unavailable"); },
      h1: () => { throw new VisionError("The analysis could not be verified. Try another photo.", "unverified"); },
      h2: () => { throw new VisionError("This image could not be read.", "unreadable"); },
      h3: () => { throw new TypeError("secret path C:\\Users\\someone\\photo.jpg"); },
    };
    let n = 0;
    const order = ["d1", "d2", "h1", "h2", "h3"];
    const { deps } = fakeDeps({
      analyze: async () => {
        const fn = plan[order[n++]];
        return fn() as never;
      },
    });
    const result = await runBenchmark(s.options(), deps);
    assert.deepEqual(result.outcomes, { ok: 0, timeout: 1, unavailable: 3, unverified: 1 });
    const rec = (id: string) => JSON.parse(readFileSync(recordPath(s, id), "utf8"));
    assert.equal(rec("d1").outcome, "timeout");
    assert.equal(rec("d2").outcome, "unavailable");
    assert.equal(rec("h1").outcome, "unverified");
    assert.equal(rec("h2").outcome, "unavailable", "an unreadable image is a runner problem, not a model outcome");
    assert.equal(rec("h2").error, "runner-unexpected: Error");
    assert.equal(rec("h3").outcome, "unavailable");
    assert.equal(rec("h3").error, "runner-unexpected: TypeError", "the error TYPE only: messages can hold paths");
    for (const id of order) {
      assert.equal(rec(id).analysis, null, "no output is invented for a failure");
      assert.deepEqual(validateAnalyzePhotoRecord(rec(id)).problems, []);
    }
    assert.equal(JSON.stringify(rec("h3")).includes("someone"), false);
    const c = JSON.parse(readFileSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE), "utf8"));
    assert.equal(c.unexpectedErrors, 2);
    assert.deepEqual(c.outcomes, { ok: 0, timeout: 1, unavailable: 3, unverified: 1 });
  });
});

test("makeClassify maps by instanceof, never by name; an object that merely looks like a VisionError is unexpected", () => {
  const classify = makeClassify(VisionError);
  assert.deepEqual(classify(new VisionError("m", "timeout")), { outcome: "timeout", message: "m" });
  assert.deepEqual(classify(new VisionError("m", "unavailable")), { outcome: "unavailable", message: "m" });
  assert.deepEqual(classify(new VisionError("m", "unverified")), { outcome: "unverified", message: "m" });
  assert.equal(classify(new VisionError("m", "unreadable")), null);
  assert.equal(classify(Object.assign(new Error("m"), { kind: "timeout" })), null);
  assert.equal(classify("timeout"), null);
});

test("a record that would not validate is never published (validated before publication), and nothing is left behind", async () => {
  await withScenario(undefined, async (s) => {
    const { deps } = fakeDeps({ analyze: async () => ({ analysis: null }) }); // "ok" without an analysis is not a record
    assert.match(await refused(runBenchmark(s.options(), deps)), /refusing to publish an invalid record/);
    assert.deepEqual(listRecords(s), []);
    assert.equal(existsSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE)), false);
    assert.equal(existsSync(path.join(s.runDir, LOCK_FILE)), false, "the lock is released on failure");
  });
});

// ================================================================== exclusive writes, resume, conflicts

test("evidence is created exclusively: a record that appears while a fixture is analysed is never overwritten", async () => {
  await withScenario(undefined, async (s) => {
    const { deps } = fakeDeps({
      analyze: async () => {
        // Another process wins the race for d1's record while analysis is running.
        writeFileSync(recordPath(s, "d1"), "FOREIGN");
        return { analysis: structuredClone(GOOD_ANALYSIS) };
      },
    });
    assert.match(await refused(runBenchmark(s.options(), deps)), /already exists; evidence is never overwritten/);
    assert.equal(readFileSync(recordPath(s, "d1"), "utf8"), "FOREIGN");
    assert.deepEqual(listRecords(s), ["d1.json"], "no temporary file survives the refusal");
  });
});

test("interrupt and resume: a partial run is distinguishable, resumes only the missing fixtures, and keeps earlier evidence byte for byte", async () => {
  await withScenario(undefined, async (s) => {
    const controller = new AbortController();
    let seen = 0;
    const first = fakeDeps({
      signal: controller.signal,
      analyze: async () => {
        seen++;
        if (seen === 3) {
          controller.abort(); // operator Ctrl-C during the third fixture
          throw new Error("aborted");
        }
        return { analysis: structuredClone(GOOD_ANALYSIS) };
      },
    });
    await assert.rejects(runBenchmark(s.options(), first.deps), RunInterrupted);
    assert.deepEqual(listRecords(s), ["d1.json", "d2.json"], "the interrupted fixture left no record (an interrupt is not model evidence)");
    assert.equal(existsSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE)), false);
    assert.equal(existsSync(path.join(s.runDir, LOCK_FILE)), false);
    const partial = readRunDirectory(s.runDir);
    assert.equal(partial.completion, null);
    assert.equal(partial.records.size, 2);
    assert.match(await refused(Promise.resolve().then(() => readCompleteRun(s.runDir))), /incomplete: 2 of 5/);
    const before = new Map(listRecords(s).map((f) => [f, readFileSync(path.join(s.runDir, RECORDS_DIR, f))]));

    const second = fakeDeps();
    const result = await runBenchmark(s.options(), second.deps);
    assert.equal(result.resumed, true);
    assert.equal(result.alreadyDone, 2);
    assert.equal(result.ran, 3);
    assert.equal(second.calls.analyze.length, 3, "only the missing fixtures reach the model");
    for (const [f, bytes] of before) assert.deepEqual(readFileSync(path.join(s.runDir, RECORDS_DIR, f)), bytes, "earlier evidence is untouched");
    assert.equal(readCompleteRun(s.runDir).records.size, 5);
    // The receipt is the first session's: its start time is preserved.
    assert.match(JSON.parse(readFileSync(path.join(s.runDir, RUN_RECEIPT_FILE), "utf8")).startedAt, /^2026-10-12T00:00:0[1-9]/);
  });
});

test("a completed run is refused (no re-run, no second completion), and nothing changes", async () => {
  await withScenario(undefined, async (s) => {
    await runBenchmark(s.options(), fakeDeps().deps);
    const before = readFileSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE));
    const again = fakeDeps();
    assert.match(await refused(runBenchmark(s.options(), again.deps)), /already complete/);
    assert.equal(again.calls.analyze.length, 0);
    assert.deepEqual(readFileSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE)), before);
  });
});

async function partialRun(s: Scenario, fixtures = 2): Promise<void> {
  const controller = new AbortController();
  let seen = 0;
  const { deps } = fakeDeps({
    signal: controller.signal,
    analyze: async () => {
      if (++seen > fixtures) {
        controller.abort();
        throw new Error("stop");
      }
      return { analysis: structuredClone(GOOD_ANALYSIS) };
    },
  });
  await assert.rejects(runBenchmark(s.options(), deps), RunInterrupted);
}

test("resume refuses when ANY input differs from the run receipt: manifest, receipt, model, version, prompt, timeout, commit, image, mode of use", async () => {
  await withScenario(undefined, async (s) => {
    await partialRun(s);
    const resumeWith = (deps: Partial<RunnerDeps>, identity: RunIdentity = IDENTITY, options: Partial<RunOptions> = {}) => refused(runBenchmark(s.options(options), fakeDeps(deps, identity).deps));
    const different = /different inputs/;
    assert.match(await resumeWith({}, { ...IDENTITY, modelVersion: "ollama-digest:other" }), different);
    assert.match(await resumeWith({}, { ...IDENTITY, model: "qwen3-vl:2b-instruct" }), different);
    assert.match(await resumeWith({}, { ...IDENTITY, requestSha256: HEX("7") }), different);
    assert.match(await resumeWith({}, { ...IDENTITY, promptSha256: HEX("8") }), different);
    assert.match(await resumeWith({}, { ...IDENTITY, timeoutMs: 120000 }), different);
    assert.match(await resumeWith({ git: () => ({ commit: "e".repeat(40), dirty: false }) }), different);
    assert.match(await resumeWith({ git: () => ({ commit: "c".repeat(40), dirty: true }) }, IDENTITY, { allowDirtyDevelopment: true }), different);
    // A changed manifest file (even only whitespace) is a different input.
    const original = readFileSync(s.devFile);
    writeFileSync(s.devFile, `${original.toString("utf8")}\n`);
    assert.match(await resumeWith({}), different);
    writeFileSync(s.devFile, original);
    // A reduced fixture set is a different input too.
    assert.match(await resumeWith({}, IDENTITY, { manifestFiles: [s.devFile, s.heldFile], receiptFiles: [] }), /no freeze receipt/);
    // The honest resume still works after all of those refusals, and none of them wrote or ran anything.
    assert.deepEqual(listRecords(s), ["d1.json", "d2.json"]);
    const ok = fakeDeps();
    assert.equal((await runBenchmark(s.options(), ok.deps)).ran, 3);
  });
});

const damage: Array<[string, (s: Scenario) => void, RegExp]> = [
  ["a truncated record", (s) => writeFileSync(recordPath(s, "d1"), readFileSync(recordPath(s, "d1"), "utf8").slice(0, 40)), /not valid JSON/],
  ["foreign JSON in records/", (s) => writeFileSync(path.join(s.runDir, RECORDS_DIR, "zzz.json"), '{"hello":"world"}'), /unknown field|missing field/],
  ["a record for a fixture that is not in the run", (s) => writeFileSync(path.join(s.runDir, RECORDS_DIR, "x1.json"), readFileSync(recordPath(s, "d1"), "utf8").replace('"d1"', '"x1"')), /not a fixture of this run/],
  ["a record named for another fixture", (s) => writeFileSync(path.join(s.runDir, RECORDS_DIR, "d3.json"), readFileSync(recordPath(s, "d1"))), /file name does not match|not a fixture/],
  ["a record holding a different image hash", (s) => writeFileSync(recordPath(s, "d1"), readFileSync(recordPath(s, "d1"), "utf8").replace(sha256Hex(pngBytes("d1")), HEX("f"))), /different image hash/],
  ["a record by another model", (s) => writeFileSync(recordPath(s, "d1"), readFileSync(recordPath(s, "d1"), "utf8").replace('"model": "qwen3-vl:4b-instruct"', '"model": "other-model"')), /different model or version/],
  ["a record with another prompt", (s) => writeFileSync(recordPath(s, "d1"), readFileSync(recordPath(s, "d1"), "utf8").replace("app-single-item:sha256:", "app-single-item:sha256:0")), /different prompt|names a different prompt/],
  ["a record starting before the run", (s) => writeFileSync(recordPath(s, "d1"), readFileSync(recordPath(s, "d1"), "utf8").replace(/"startedAt": "[^"]+"/, '"startedAt": "2020-01-01T00:00:00.000Z"')), /starts before the run/],
  ["a leftover temporary file from a crashed runner", (s) => writeFileSync(`${recordPath(s, "d2")}.partial-1-abcd`, "half"), /unfinished or foreign file/],
  ["a foreign file in the run directory", (s) => writeFileSync(path.join(s.runDir, "extra.txt"), "x"), /foreign file in the run directory: extra\.txt/],
  ["an edited run receipt", (s) => writeFileSync(path.join(s.runDir, RUN_RECEIPT_FILE), readFileSync(path.join(s.runDir, RUN_RECEIPT_FILE), "utf8").replace("single-item-run-test", "edited-benchmark")), /edited/],
  ["a stale lock file", (s) => writeFileSync(path.join(s.runDir, LOCK_FILE), "{}"), /holds run\.lock|another runner holds/],
];

for (const [name, tamper, expected] of damage) {
  test(`resume refuses ${name} and writes nothing`, async () => {
    await withScenario(undefined, async (s) => {
      await partialRun(s);
      tamper(s);
      const before = readdirSync(path.join(s.runDir, RECORDS_DIR)).sort().join(",");
      const { deps, calls } = fakeDeps();
      assert.match(await refused(runBenchmark(s.options(), deps)), expected);
      assert.equal(calls.analyze.length, 0, "no inference on a damaged run");
      assert.equal(readdirSync(path.join(s.runDir, RECORDS_DIR)).sort().join(","), before);
      assert.equal(existsSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE)), false);
    });
  });
}

test("a duplicate record for one fixture is refused (second file with the same fixture id)", async () => {
  await withScenario(undefined, async (s) => {
    await partialRun(s);
    writeFileSync(path.join(s.runDir, RECORDS_DIR, "d1-copy.json"), readFileSync(recordPath(s, "d1")));
    assert.match(await refused(runBenchmark(s.options(), fakeDeps().deps)), /file name does not match|duplicate evidence/);
  });
});

// ================================================================== concurrency

test("two runners started together on a new directory: exactly one wins, evidence is never mixed", async () => {
  await withScenario(undefined, async (s) => {
    const a = fakeDeps();
    const b = fakeDeps();
    const results = await Promise.allSettled([runBenchmark(s.options(), a.deps), runBenchmark(s.options(), b.deps)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.ok(bad[0].reason instanceof EvaluationRefusal);
    assert.equal(a.calls.analyze.length + b.calls.analyze.length, 5, "each fixture was analysed exactly once in total");
    assert.equal(readCompleteRun(s.runDir).records.size, 5);
  });
});

test("a second runner on a directory whose first runner is still working is refused by the lock; the first finishes intact", async () => {
  await withScenario(undefined, async (s) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let first = true;
    const a = fakeDeps({
      analyze: async () => {
        if (first) {
          first = false;
          entered();
          await gate;
        }
        return { analysis: structuredClone(GOOD_ANALYSIS) };
      },
    });
    const running = runBenchmark(s.options(), a.deps);
    await inside;
    const b = fakeDeps();
    assert.match(await refused(runBenchmark(s.options(), b.deps)), /another runner holds run\.lock/);
    assert.equal(b.calls.analyze.length, 0);
    release();
    await running;
    assert.equal(readCompleteRun(s.runDir).records.size, 5);
    assert.equal(existsSync(path.join(s.runDir, LOCK_FILE)), false);
  });
});

// ================================================================== partial versus complete, and the way to launch evidence

async function gold(s: Scenario) {
  const annotation = { status: "single_human", annotators: [{ id: "annotator-one", kind: "human" }], completedAt: "2026-10-05T00:00:00Z", tool: null, modelAssisted: false, notes: null };
  const label = (id: string, rejection: boolean) => ({
    imageId: id,
    imageSha256: sha256Hex(pngBytes(id)),
    outcome: rejection ? "reject" : "single_item",
    rejectionReason: rejection ? "no_garment" : null,
    item: rejection ? null : { category: "top", color: "blue", pattern: "solid", fit: "regular", material: "none_visible", box: [0.2, 0.2, 0.8, 0.8], seasons: [], occasions: [] },
    annotation,
  });
  const dev = { schemaVersion: 1, kind: "single-item-gold", benchmarkId: "single-item-run-test", split: "development", labels: [label("d1", false), label("d2", false)] };
  const held = { schemaVersion: 1, kind: "single-item-gold", benchmarkId: "single-item-run-test", split: "heldout", labels: [label("h1", false), label("h2", false), label("h3", true)] };
  writeFileSync(path.join(s.dir, "dev.gold.json"), stable(dev));
  writeFileSync(path.join(s.dir, "held.gold.json"), stable(held));
}

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l), now: () => new Date("2026-10-21T00:00:00Z") } };
}

test("an incomplete run cannot be adapted; a complete run adapts to bound predictions; loose records adapt to UNBOUND predictions that the gate will not accept as launch evidence", async () => {
  await withScenario(undefined, async (s) => {
    await gold(s);
    await partialRun(s);
    const adaptArgs = (out: string) => ["single-adapt-qwen", "--run-dir", s.runDir, "--manifest", s.devFile, "--manifest", s.heldFile, "--images-dir", s.images, "--out", out];
    const c1 = cli();
    assert.equal(runSingleCli(adaptArgs(path.join(s.dir, "p1.json")), c1.io), 2);
    assert.match(c1.err.join(" "), /incomplete: 2 of 5/);
    assert.equal(existsSync(path.join(s.dir, "p1.json")), false);

    await runBenchmark(s.options(), fakeDeps().deps);
    const bound = path.join(s.dir, "bound.predictions.json");
    const c2 = cli();
    assert.equal(runSingleCli(adaptArgs(bound), c2.io), 0, c2.err.join("\n"));
    const report = JSON.parse(readFileSync(bound, "utf8"));
    assert.deepEqual(validateSinglePredictionReport(report).problems, []);
    assert.equal(report.run.runBinding.developmentOnly, false);
    assert.equal(report.run.runBinding.gitCommit, "c".repeat(40));
    assert.equal(report.run.runBinding.casesSha256, casesDigest(report.cases));
    assert.equal(report.run.prompt.sha256, IDENTITY.promptSha256);
    assert.equal(report.run.imageHashSource, "recorded-by-run");
    assert.equal(report.cases.length, 5);

    // Loose records (an operator's own wrapper) adapt, but unbound.
    const loose = path.join(s.dir, "loose-records");
    mkdirSync(loose);
    for (const f of listRecords(s)) writeFileSync(path.join(loose, f), readFileSync(path.join(s.runDir, RECORDS_DIR, f)));
    const unbound = path.join(s.dir, "unbound.predictions.json");
    const c3 = cli();
    assert.equal(runSingleCli(["single-adapt-qwen", "--records-dir", loose, "--manifest", s.devFile, "--manifest", s.heldFile, "--images-dir", s.images, "--out", unbound], c3.io), 0, c3.err.join("\n"));
    assert.equal(JSON.parse(readFileSync(unbound, "utf8")).run.runBinding, undefined);
    assert.match(c3.out.join(" "), /NOT bound to a benchmark-runner run/);

    // Scoring: the bound report has no run-binding precondition; the unbound one does.
    const policy = path.join(s.dir, "policy.json");
    assert.equal(runSingleCli(["single-template", "--kind", "policy", "--out", policy], cli().io), 0);
    const devFrozen = s.devFile; // a development manifest needs no freeze
    const score = (predictions: string, out: string, runDir: string | null = null) => {
      const c = cli();
      const code = runSingleCli([...(runDir ? ["single-score", "--run-dir", runDir] : ["single-score"]), "--manifest", devFrozen, "--manifest", s.heldFile, "--gold", path.join(s.dir, "dev.gold.json"), "--gold", path.join(s.dir, "held.gold.json"), "--receipt", s.receiptFile, "--predictions", predictions, "--images-dir", s.images, "--policy", policy, "--out", out], c.io);
      return { code, err: c.err.join(" "), report: code === 0 ? (JSON.parse(readFileSync(out, "utf8")) as SingleReport) : null };
    };
    const good = score(bound, path.join(s.dir, "report.bound.json"), s.runDir);
    assert.equal(good.code, 0, good.err);
    assert.equal(good.report!.gate.preconditions.some((p) => /not bound to a complete benchmark-runner run/.test(p)), false);
    assert.equal(good.report!.run.runBinding?.runId, report.run.runBinding.runId);
    const bad = score(unbound, path.join(s.dir, "report.unbound.json"));
    assert.equal(bad.code, 0, bad.err);
    assert.equal(bad.report!.gate.verdict, "NOT_EVALUATED");
    assert.ok(bad.report!.gate.preconditions.some((p) => /not bound to a complete benchmark-runner run/.test(p)));

    // Editing the adapted predictions afterwards is caught.
    const edited = JSON.parse(readFileSync(bound, "utf8"));
    edited.cases[0].elapsedMs = 1;
    writeFileSync(path.join(s.dir, "edited.predictions.json"), stable(edited));
    const e = score(path.join(s.dir, "edited.predictions.json"), path.join(s.dir, "report.edited.json"), s.runDir);
    assert.equal(e.code, 2);
    assert.match(e.err, /cases differ from the cases re-derived from the run directory/);
    // Predictions bound to different manifests than the ones supplied are caught.
    const wrongManifest = JSON.parse(readFileSync(bound, "utf8"));
    wrongManifest.run.runBinding.manifests[1].fileSha256 = HEX("b");
    writeFileSync(path.join(s.dir, "wrong.predictions.json"), stable(wrongManifest));
    const w = score(path.join(s.dir, "wrong.predictions.json"), path.join(s.dir, "report.wrong.json"), s.runDir);
    assert.equal(w.code, 2);
    assert.match(w.err, /run binding differs from the one derived from the run directory/);
  });
});

test("adapting a run directory refuses edited records, an edited receipt, a swapped manifest, a changed image and a run for other manifests", async () => {
  await withScenario(undefined, async (s) => {
    await runBenchmark(s.options(), fakeDeps().deps);
    const args = (out: string, manifests = [s.devFile, s.heldFile]) => ["single-adapt-qwen", "--run-dir", s.runDir, ...manifests.flatMap((m) => ["--manifest", m]), "--images-dir", s.images, "--out", path.join(s.dir, out)];
    const attempt = (out: string, manifests?: string[]) => {
      const c = cli();
      return { code: runSingleCli(args(out, manifests), c.io), err: c.err.join(" ") };
    };
    assert.equal(attempt("only-dev.json", [s.devFile]).code, 2, "the held-out manifest the run used must be supplied");
    assert.match(attempt("only-dev2.json", [s.devFile]).err, /heldout manifest the run was made against was not supplied/);
    // Edit one record after completion.
    const original = readFileSync(recordPath(s, "h1"));
    writeFileSync(recordPath(s, "h1"), original.toString("utf8").replace('"elapsedMs": 617', '"elapsedMs": 1'));
    assert.match(attempt("edited-record.json").err, /changed after completion/);
    writeFileSync(recordPath(s, "h1"), original);
    // Delete one record.
    const h2Original = readFileSync(recordPath(s, "h2"));
    rmSync(recordPath(s, "h2"));
    assert.match(attempt("missing-record.json").err, /no record although the run claims completion/);
    writeFileSync(recordPath(s, "h2"), readFileSync(recordPath(s, "h1")).toString("utf8").replace('"h1"', '"h2"'));
    assert.equal(attempt("replaced-record.json").code, 2);
    writeFileSync(recordPath(s, "h2"), h2Original);
    // A changed image: scoring and adapting need the exact frozen bytes.
    const image = readFileSync(path.join(s.images, "h3.png"));
    writeFileSync(path.join(s.images, "h3.png"), pngBytes("tampered"));
    assert.match(attempt("changed-image.json").err, /differs from the immutable manifest hash/);
    writeFileSync(path.join(s.images, "h3.png"), image);
    // A different manifest file than the run used.
    const other = path.join(s.dir, "other.manifest.json");
    writeFileSync(other, `${readFileSync(s.devFile, "utf8")}\n`);
    assert.match(attempt("other-manifest.json", [other, s.heldFile]).err, /differs from the one the run was made against/);
  });
});

test("the gate refuses launch evidence from missing, development-only or dirty bindings (and accepts a clean complete one)", () => {
  assert.match(runBindingProblems(null).join(" "), /not bound to a complete benchmark-runner run/);
  const clean = { runId: "r", inputsDigest: HEX("1"), runReceiptSha256: HEX("2"), completionReceiptSha256: HEX("3"), gitCommit: "a".repeat(40), gitDirty: false, developmentOnly: false, runnerId: "x", model: "m", modelVersion: "v", promptSha256: HEX("5"), requestSha256: HEX("6"), manifests: [], receipts: [], casesSha256: HEX("4") };
  assert.deepEqual(runBindingProblems(clean), []);
  assert.match(runBindingProblems({ ...clean, developmentOnly: true }).join(" "), /development-only override/);
  assert.match(runBindingProblems({ ...clean, gitDirty: true, developmentOnly: true }).join(" "), /uncommitted changes/);
  // The prediction schema refuses a dirty binding without the override and a malformed commit.
  const base = { schemaVersion: 1, kind: "single-item-predictions", cases: [], run: { model: "m", modelVersion: "v", adapter: "a", analysisMode: "single", prompt: { id: "p", sha256: null }, startedAt: null, timeoutMs: null, imageHashSource: "recorded-by-run", notes: "n" } };
  const withBinding = (b: unknown) => validateSinglePredictionReport({ ...base, run: { ...base.run, runBinding: b } }).problems.join(" | ");
  const good = { ...clean, manifests: [{ split: "heldout", fileSha256: HEX("a") }] };
  assert.equal(withBinding(good), "");
  assert.match(withBinding({ ...good, gitDirty: true }), /dirty worktree is only possible together with the development-only override/);
  assert.match(withBinding({ ...good, gitCommit: "abc" }), /full 40-character commit id/);
  assert.match(withBinding({ ...good, extra: 1 }), /unknown field "extra"/);
  assert.match(withBinding({ ...good, manifests: [] }), /at least one manifest/);
  assert.equal(validateSinglePredictionReport(base).problems.filter((p) => /runBinding/.test(p)).length, 0, "a report without a binding is valid (it is just unbound)");
  // Integrity: a binding that names a manifest that was not supplied.
  const w = integrityProblems({ manifests: [], gold: [], receipts: [], predictions: { ...base, run: { ...base.run, runBinding: good } } as never, images: () => null });
  assert.match(w.join(" | "), /binding names a heldout manifest that was not supplied/);
});

// ================================================================== CLI

test("single-run-qwen CLI: usage errors, refusal exit code, success exit code, and an injected-deps end-to-end run", async () => {
  await withScenario(undefined, async (s) => {
    const noDeps = async () => {
      throw new Error("deps must not be built for a usage error");
    };
    const c0 = cli();
    assert.equal(await runSingleRunCli(["single-run-qwen"], c0.io, noDeps), 1);
    assert.match(c0.err.join(" "), /usage: single-run-qwen/);
    assert.equal(await runSingleRunCli(["single-run-qwen", "--bogus"], cli().io, noDeps), 1);
    // The synchronous CLI does not run it.
    const sync = cli();
    assert.equal(runSingleCli(["single-run-qwen", "--manifest", s.devFile, "--images-dir", s.images, "--run-dir", s.runDir], sync.io), 1);
    assert.match(sync.err.join(" "), /asynchronous/);
    // Refusal: exit 2, zero inference.
    const f = fakeDeps();
    const refusedRun = cli();
    assert.equal(await runSingleRunCli(["single-run-qwen", "--manifest", s.devFile, "--manifest", s.heldFile, "--images-dir", s.images, "--run-dir", s.runDir], refusedRun.io, async () => f.deps), 2);
    assert.match(refusedRun.err.join(" "), /no freeze receipt/);
    assert.equal(f.calls.analyze.length, 0);
    // Success.
    const ok = cli();
    const g = fakeDeps();
    const code = await runSingleRunCli(["single-run-qwen", "--manifest", s.devFile, "--manifest", s.heldFile, "--receipt", s.receiptFile, "--images-dir", s.images, "--run-dir", s.runDir], ok.io, async () => g.deps);
    assert.equal(code, 0, ok.err.join("\n"));
    assert.match(ok.out.join(" "), /evidence plumbing, not a launch-readiness claim/);
    assert.equal(g.calls.analyze.length, 5);
    // Logs name fixtures and counts only: no source paths, image data, model answers or secrets.
    const logs = [...ok.out, ...g.calls.log].join("\n");
    assert.equal(logs.includes(s.dir), false);
    assert.equal(logs.includes("images"), false);
    assert.equal(/base64|data:image|Blue shirt|navy blue/.test(logs), false);
    assert.match(logs, /recorded h1: ok in 617 ms/);
    // Re-running the finished directory is refused with exit 2.
    const again = cli();
    assert.equal(await runSingleRunCli(["single-run-qwen", "--manifest", s.devFile, "--manifest", s.heldFile, "--receipt", s.receiptFile, "--images-dir", s.images, "--run-dir", s.runDir], again.io, async () => fakeDeps().deps), 2);
    assert.match(again.err.join(" "), /already complete/);
  });
});

test("a development-only manifest set (no held-out split) runs without a freeze receipt", async () => {
  await withScenario(undefined, async (s) => {
    const { deps } = fakeDeps();
    const result = await runBenchmark(s.options({ manifestFiles: [s.devFile], receiptFiles: [] }), deps);
    assert.equal(result.total, 2);
    assert.equal(readCompleteRun(s.runDir).receipt.fixtures.length, 2);
  });
});

// ================================================================== the app's request identity

test("visionRequestIdentity is derived from the app's own prompt and schema, is stable, and differs by mode", () => {
  const a = visionRequestIdentity("single");
  const b = visionRequestIdentity("single");
  assert.deepEqual(a, b);
  assert.match(a.promptSha256, /^[0-9a-f]{64}$/);
  assert.match(a.requestSha256, /^[0-9a-f]{64}$/);
  assert.equal(a.promptSha256, sha256Hex(Buffer.from(SINGLE_ITEM_PROMPT + PROMPT_SUFFIX)), "the hash is of the exact text analyzePhoto sends");
  assert.notEqual(visionRequestIdentity("multi").requestSha256, a.requestSha256);
  assert.notEqual(visionRequestIdentity("multi").promptSha256, a.promptSha256);
  assert.equal(a.options.temperature, 0);
  assert.equal(a.imageProcessing.normalize.maxSide, 1600);
  assert.equal(JSON.stringify(a).includes("OLLAMA"), false, "no environment value is part of the identity");
});

// ================================================================== repository hygiene and documentation

test("repository: benchmark images and run evidence are git-ignored; the runner has no recognizer of its own", () => {
  const ignore = read(".gitignore");
  for (const entry of ["benchmark-images/", "benchmark-runs/"]) assert.ok(ignore.split(/\r?\n/).includes(entry), `.gitignore lists ${entry}`);
  const runner = read("scripts/vision-evaluation/single-item/runner.ts");
  assert.doesNotMatch(runner, /fetch\(|api\/chat|from "[^"]*\/vision"/, "the runner module itself makes no model call");
  const real = read("scripts/vision-evaluation/single-item/runner-real.ts");
  assert.match(real, /vision\.analyzePhoto\(normalized, signal, options\)/);
  assert.match(real, /vision\.normalizePhoto\(bytes\)/);
  assert.match(real, /loadLocalEnvFiles/);
  assert.match(read("package.json"), /"vision:single"/);
});

test("documentation: the runner is documented, and no document claims launch readiness", () => {
  const files = ["scripts/vision-evaluation/README.md", "docs/VISION_EVALUATION.md", "README.md", "docs/DEPLOYMENT.md", "docs/reviews/implementation-025-notes.md"];
  for (const f of files) assert.ok(existsSync(path.join(root, f)), f);
  const notes = read("docs/reviews/implementation-025-notes.md");
  assert.match(notes, /not launch-ready|not ready to launch/i);
  assert.match(notes, /representative/i);
  assert.match(notes, /single-run-qwen/);
  assert.match(notes, /crash|power loss/i);
  assert.match(read("scripts/vision-evaluation/README.md"), /single-run-qwen/);
  assert.match(read("docs/VISION_EVALUATION.md"), /single-run-qwen/);
  assert.match(read("README.md"), /single-run-qwen/);
  for (const f of files)
    for (const line of read(f).split("\n"))
      if (/ready to launch|launch[- ]ready|launch readiness|production[- ]ready/i.test(line)) assert.match(line, /no claim|not |never|cannot|until|remain|open|unverified|without/i, `${f}: a readiness phrase without a negation: ${line.slice(0, 140)}`);
});

// ================================================================== Windows-portable publication (no rename, no hard link)

/** Real node:fs operations with spies, so a test can watch or break exactly one step. */
function spyFs(over: Partial<ExclusiveFs> = {}): { ops: ExclusiveFs; log: string[] } {
  const log: string[] = [];
  const ops: ExclusiveFs = {
    open: (file) => {
      log.push(`open ${path.basename(file)}`);
      return openSync(file, "wx");
    },
    write: (fd, text) => {
      log.push("write");
      writeSync(fd, text);
    },
    fsync: (fd) => {
      log.push("fsync");
      fsyncSync(fd);
    },
    close: (fd) => {
      log.push("close");
      closeSync(fd);
    },
    unlink: (file) => {
      log.push(`unlink ${path.basename(file)}`);
      unlinkSync(file);
    },
    ...over,
  };
  return { ops, log };
}

test("records are created exclusively AT THEIR FINAL PATH: open(final, wx) -> write -> fsync -> close, nothing else", async () => {
  await withScenario(undefined, async (s) => {
    const { ops, log } = spyFs();
    const { deps } = fakeDeps({ recordFs: ops });
    await runBenchmark(s.options({ manifestFiles: [s.devFile], receiptFiles: [] }), deps);
    assert.deepEqual(log, ["open d1.json", "write", "fsync", "close", "open d2.json", "write", "fsync", "close"], "no temporary name, no rename, no unlink on success");
    assert.deepEqual(listRecords(s), ["d1.json", "d2.json"]);
  });
});

test("a write that fails half way removes only that partial final file; earlier evidence is untouched and the run resumes cleanly", async () => {
  await withScenario(undefined, async (s) => {
    let records = 0;
    const { ops, log } = spyFs({
      write: (fd, text) => {
        if (++records === 2) {
          writeSync(fd, text.slice(0, 40)); // half a record reaches the disk ...
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); // ... then the write fails
        }
        writeSync(fd, text);
      },
    });
    const first = fakeDeps({ recordFs: ops });
    await assert.rejects(runBenchmark(s.options({ manifestFiles: [s.devFile], receiptFiles: [] }), first.deps), /no space left/);
    assert.deepEqual(listRecords(s), ["d1.json"], "the half-written d2.json was removed");
    assert.ok(log.includes("unlink d2.json"), "the file this process created is the one removed");
    assert.equal(log.filter((l) => l.startsWith("unlink")).length, 1, "nothing else was removed");
    assert.equal(existsSync(path.join(s.runDir, LOCK_FILE)), false);
    assert.equal(existsSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE)), false);
    const d1 = readFileSync(recordPath(s, "d1"));
    // The run resumes: d1 is kept byte for byte, only d2 is analysed again.
    const second = fakeDeps();
    const result = await runBenchmark(s.options({ manifestFiles: [s.devFile], receiptFiles: [] }), second.deps);
    assert.equal(result.ran, 1);
    assert.equal(second.calls.analyze.length, 1);
    assert.deepEqual(readFileSync(recordPath(s, "d1")), d1);
    assert.equal(readCompleteRun(s.runDir).records.size, 2);
  });
});

test("a failing fsync or close also rolls back the file this process created", async () => {
  for (const step of ["fsync", "close"] as const) {
    await withScenario(undefined, async (s) => {
      const { ops, log } = spyFs({
        [step]: () => {
          throw Object.assign(new Error(`${step} failed`), { code: "EIO" });
        },
      } as Partial<ExclusiveFs>);
      await assert.rejects(runBenchmark(s.options({ manifestFiles: [s.devFile], receiptFiles: [] }), fakeDeps({ recordFs: ops }).deps), new RegExp(`${step} failed`));
      assert.deepEqual(listRecords(s), [], `${step}: no partial file is left`);
      assert.ok(log.includes("unlink d1.json"));
    });
  }
});

test("when another writer wins the name (EEXIST) its file is never removed, verified-and-adopted or mixed in: the publication is refused", async () => {
  await withScenario(undefined, async (s) => {
    const unlinked: string[] = [];
    let opens = 0;
    const { ops } = spyFs({
      open: (file) => {
        if (++opens === 1) {
          writeFileSync(file, "ANOTHER-WRITER"); // the other process created it a moment earlier
        }
        return openSync(file, "wx"); // real exclusive create: EEXIST
      },
      unlink: (file) => {
        unlinked.push(file);
        unlinkSync(file);
      },
    });
    const { deps, calls } = fakeDeps({ recordFs: ops });
    assert.match(await refused(runBenchmark(s.options({ manifestFiles: [s.devFile], receiptFiles: [] }), deps)), /already exists; evidence is never overwritten/);
    assert.equal(readFileSync(recordPath(s, "d1"), "utf8"), "ANOTHER-WRITER", "the other writer's bytes are exactly as it left them");
    assert.deepEqual(unlinked, [], "a file this process did not create is never removed");
    assert.equal(calls.analyze.length, 1, "stopped at the first conflict, no further evidence written");
    assert.deepEqual(listRecords(s), ["d1.json"]);
    // And resume refuses the foreign bytes as corrupt rather than trusting them.
    assert.match(await refused(runBenchmark(s.options({ manifestFiles: [s.devFile], receiptFiles: [] }), fakeDeps().deps)), /not valid JSON/);
  });
});

test("a crash that leaves a partial FINAL record file is refused on resume, never trusted, and nothing is written", async () => {
  await withScenario(undefined, async (s) => {
    await partialRun(s);
    const original = readFileSync(recordPath(s, "d2"), "utf8");
    writeFileSync(recordPath(s, "d2"), original.slice(0, Math.floor(original.length / 2))); // power loss mid-write
    const { deps, calls } = fakeDeps();
    assert.match(await refused(runBenchmark(s.options(), deps)), /d2\.json[\s\S]*not valid JSON/);
    assert.equal(calls.analyze.length, 0);
    assert.equal(existsSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE)), false);
    // The documented recovery: delete the partial file by hand and resume.
    rmSync(recordPath(s, "d2"));
    const ok = fakeDeps();
    assert.equal((await runBenchmark(s.options(), ok.deps)).ran, 4);
  });
});

test("regression guard: the runner and its CLI never use renameSync or linkSync (Windows sandboxes refuse them)", () => {
  for (const file of ["scripts/vision-evaluation/single-item/runner.ts", "scripts/vision-evaluation/single-item/runner-real.ts", "scripts/vision-evaluation/single-item/cli.ts"]) {
    const code = read(file)
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(code, /\brenameSync\b|\brename\(|(?<!un)\blinkSync\b|\bcopyFileSync\b/, `${file}: publication must use open(wx)/write/close only`);
  }
  const runner = read("scripts/vision-evaluation/single-item/runner.ts");
  assert.match(runner, /openSync\(file, "wx"\)/, "the default operation is an exclusive create");
  assert.doesNotMatch(runner, /\.partial-/, "no temporary-name publication scheme");
});

// ================================================================== review 2: launch evidence needs the real run directory

const adaptArgs = (s: Scenario, runDir: string, out: string) => ["single-adapt-qwen", "--run-dir", runDir, "--manifest", s.devFile, "--manifest", s.heldFile, "--images-dir", s.images, "--out", out];

function adapt(s: Scenario, runDir: string, name: string): { code: number; err: string; file: string } {
  const c = cli();
  const file = path.join(s.dir, name);
  return { code: runSingleCli(adaptArgs(s, runDir, file), c.io), err: c.err.join(" "), file };
}

function scoreCli(s: Scenario, predictions: string, name: string, runDir: string | null) {
  const policy = path.join(s.dir, "policy.json");
  if (!existsSync(policy)) assert.equal(runSingleCli(["single-template", "--kind", "policy", "--out", policy], cli().io), 0);
  const c = cli();
  const out = path.join(s.dir, name);
  const code = runSingleCli(
    ["single-score", ...(runDir ? ["--run-dir", runDir] : []), "--manifest", s.devFile, "--manifest", s.heldFile, "--gold", path.join(s.dir, "dev.gold.json"), "--gold", path.join(s.dir, "held.gold.json"), "--receipt", s.receiptFile, "--predictions", predictions, "--images-dir", s.images, "--policy", policy, "--out", out],
    c.io,
  );
  return { code, err: c.err.join(" "), report: code === 0 ? (JSON.parse(readFileSync(out, "utf8")) as SingleReport) : null, out };
}

test("B1: a hand-written runBinding with no matching completed run directory is refused", async () => {
  await withScenario(undefined, async (s) => {
    await gold(s);
    await runBenchmark(s.options(), fakeDeps().deps);
    const real = adapt(s, s.runDir, "real.predictions.json");
    assert.equal(real.code, 0, real.err);
    const realReport = JSON.parse(readFileSync(real.file, "utf8"));

    // (a) The honest predictions, scored WITHOUT the run directory: the binding is only a claim.
    const noDir = scoreCli(s, real.file, "r-nodir.json", null);
    assert.equal(noDir.code, 2);
    assert.match(noDir.err, /--run-dir .* is required to verify it/);
    assert.equal(existsSync(noDir.out), false, "no report is written");

    // (b) A fully hand-written binding (every field plausible, digests invented) with no run directory.
    const forged = structuredClone(realReport);
    forged.run.runBinding = { ...forged.run.runBinding, runId: "forged-run", inputsDigest: HEX("a"), runReceiptSha256: HEX("b"), completionReceiptSha256: HEX("c") };
    writeFileSync(path.join(s.dir, "forged.predictions.json"), stable(forged));
    assert.equal(scoreCli(s, path.join(s.dir, "forged.predictions.json"), "r-forged-nodir.json", null).code, 2);

    // (c) The same forged file with the real run directory supplied: the re-derived binding differs.
    const withDir = scoreCli(s, path.join(s.dir, "forged.predictions.json"), "r-forged.json", s.runDir);
    assert.equal(withDir.code, 2);
    assert.match(withDir.err, /run binding differs from the one derived from the run directory \(hand-written or from another run\)/);

    // (d) A binding that is a perfect copy of another run's, scored against a different completed run.
    const other = path.join(s.dir, "run-other");
    await runBenchmark({ ...s.options({ runDir: other }) }, fakeDeps({}, { ...IDENTITY, modelVersion: "ollama-digest:another-model-build" }).deps);
    const crossed = scoreCli(s, real.file, "r-crossed.json", other);
    assert.equal(crossed.code, 2);
    assert.match(crossed.err, /binding differs|run information differs|cases differ/);

    // (e) Predictions with no binding cannot be "verified" by naming a directory.
    const loose = path.join(s.dir, "loose-records");
    mkdirSync(loose);
    for (const f of listRecords(s)) writeFileSync(path.join(loose, f), readFileSync(path.join(s.runDir, RECORDS_DIR, f)));
    const unbound = path.join(s.dir, "unbound.predictions.json");
    assert.equal(runSingleCli(["single-adapt-qwen", "--records-dir", loose, "--manifest", s.devFile, "--manifest", s.heldFile, "--images-dir", s.images, "--out", unbound], cli().io), 0);
    const named = scoreCli(s, unbound, "r-unbound-dir.json", s.runDir);
    assert.equal(named.code, 2);
    assert.match(named.err, /carry no run binding/);

    // (f) The honest path still works, and the report says it was verified.
    const ok = scoreCli(s, real.file, "r-ok.json", s.runDir);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.report!.runVerification?.verified, true);
    assert.equal(ok.report!.runVerification?.runId, realReport.run.runBinding.runId);
    assert.equal(ok.report!.runVerification?.requestSha256, IDENTITY.requestSha256);
    assert.equal(ok.report!.gate.preconditions.some((p) => /not bound|not verified/.test(p)), false);
    // Loose records keep working for development: unbound, unverified, never launch evidence.
    const dev = scoreCli(s, unbound, "r-dev.json", null);
    assert.equal(dev.code, 0, dev.err);
    assert.equal(dev.report!.runVerification, null);
    assert.ok(dev.report!.gate.preconditions.some((p) => /not bound to a complete benchmark-runner run/.test(p)));
  });
});

test("B1: in-process scoring also refuses an unverified binding, and the directory's own receipt decides development-only/dirty", async () => {
  await withScenario(undefined, async (s) => {
    await gold(s);
    // A clean run: programmatic evaluation without a verified run is refused.
    await runBenchmark(s.options(), fakeDeps().deps);
    const a = adapt(s, s.runDir, "clean.predictions.json");
    const predictions = JSON.parse(readFileSync(a.file, "utf8"));
    const w = integrityProblems({
      manifests: [],
      gold: [],
      receipts: [],
      predictions,
      images: () => null,
    });
    assert.match(w.join(" | "), /binding that was not verified against a completed run directory/);

    // A development-only run (dirty override): it adapts, but it can never be verified for scoring.
    const dirtyDir = path.join(s.dir, "run-dirty");
    await runBenchmark(s.options({ runDir: dirtyDir, allowDirtyDevelopment: true }), fakeDeps({ git: () => ({ commit: "c".repeat(40), dirty: true }) }).deps);
    const d = adapt(s, dirtyDir, "dirty.predictions.json");
    assert.equal(d.code, 0, d.err);
    assert.equal(JSON.parse(readFileSync(d.file, "utf8")).run.runBinding.developmentOnly, true);
    const scored = scoreCli(s, d.file, "r-dirty.json", dirtyDir);
    assert.equal(scored.code, 2);
    assert.match(scored.err, /development-only or dirty worktree; it can never be launch evidence/);
    // Editing the directory's receipt to hide it breaks the receipt's own digest.
    const receiptPath = path.join(dirtyDir, RUN_RECEIPT_FILE);
    writeFileSync(receiptPath, readFileSync(receiptPath, "utf8").replace('"developmentOnly": true', '"developmentOnly": false').replace('"gitDirty": true', '"gitDirty": false'));
    const hidden = scoreCli(s, d.file, "r-dirty-hidden.json", dirtyDir);
    assert.equal(hidden.code, 2);
    assert.match(hidden.err, /edited/);
  });
});

test("B1: the programmatic fileSha256=null case fails closed where a binding depends on it", () => {
  const binding = { runId: "r", inputsDigest: HEX("1"), runReceiptSha256: HEX("2"), completionReceiptSha256: HEX("3"), gitCommit: "a".repeat(40), gitDirty: false, developmentOnly: false, runnerId: "x", model: "m", modelVersion: "v", promptSha256: HEX("5"), requestSha256: HEX("6"), manifests: [{ split: "heldout" as const, fileSha256: HEX("a") }], receipts: [], casesSha256: casesDigest([]) };
  const manifest = { schemaVersion: 1, kind: "single-item-manifest", benchmarkId: "b", split: "heldout", frozenAt: FROZEN_AT, purpose: "p", fixtures: [] } as never;
  const preds = { schemaVersion: 1, kind: "single-item-predictions", cases: [], run: { model: "m", modelVersion: "v", adapter: "a", analysisMode: "single", prompt: { id: "p", sha256: null }, startedAt: null, timeoutMs: null, imageHashSource: "recorded-by-run", notes: "n", runBinding: binding } } as never;
  const verified = { runId: "r", inputsDigest: HEX("1"), completionReceiptSha256: HEX("3"), requestSha256: HEX("6"), modelVersion: "v" };
  const problems = integrityProblems({ manifests: [{ manifest, fileSha256: null }], gold: [], receipts: [], predictions: preds, verifiedRun: verified, images: () => null });
  assert.match(problems.join(" | "), /manifest file digest is unknown, so the run binding cannot be checked/);
  // A verified run that is not the one the binding names is refused too.
  const other = integrityProblems({ manifests: [{ manifest, fileSha256: HEX("a") }], gold: [], receipts: [], predictions: preds, verifiedRun: { ...verified, runId: "someone-else" }, images: () => null });
  assert.match(other.join(" | "), /verified run is not the run the predictions' binding names/);
});

// ---- M1: identity drift before completion

function driftDeps(change: { git?: (n: number) => { commit: string; dirty: boolean }; identity?: (n: number) => RunIdentity | "fail" }) {
  let gitCalls = 0;
  let identityCalls = 0;
  return fakeDeps({
    git: () => (change.git ? change.git(++gitCalls) : { commit: "c".repeat(40), dirty: false }),
    identity: async () => {
      const r = change.identity ? change.identity(++identityCalls) : IDENTITY;
      if (r === "fail") throw new Error("ollama went away");
      return r;
    },
  });
}

const driftCases: Array<[string, Parameters<typeof driftDeps>[0], RegExp]> = [
  ["the app git commit changes mid-run", { git: (n) => ({ commit: n === 1 ? "c".repeat(40) : "e".repeat(40), dirty: false }) }, /the app git commit changed/],
  ["the worktree becomes dirty mid-run (source edited while running)", { git: (n) => ({ commit: "c".repeat(40), dirty: n > 1 }) }, /the worktree became dirty/],
  ["the installed model digest changes mid-run", { identity: (n) => ({ ...IDENTITY, modelVersion: n === 1 ? IDENTITY.modelVersion : "ollama-digest:replaced-weights" }) }, /the installed model digest changed/],
  ["the configured model changes mid-run", { identity: (n) => ({ ...IDENTITY, model: n === 1 ? IDENTITY.model : "qwen3-vl:2b-instruct" }) }, /the configured model changed/],
  ["the app's request identity changes mid-run", { identity: (n) => ({ ...IDENTITY, requestSha256: n === 1 ? IDENTITY.requestSha256 : HEX("7") }) }, /request identity .* changed/],
  ["the prompt hash changes mid-run", { identity: (n) => ({ ...IDENTITY, promptSha256: n === 1 ? IDENTITY.promptSha256 : HEX("8") }) }, /request identity .* changed/],
  ["the inference timeout changes mid-run", { identity: (n) => ({ ...IDENTITY, timeoutMs: n === 1 ? IDENTITY.timeoutMs : 120000 }) }, /the inference timeout changed/],
  ["the model cannot be re-checked at completion", { identity: (n) => (n === 1 ? IDENTITY : "fail") }, /model identity could not be re-checked/],
];

for (const [name, change, expected] of driftCases) {
  test(`M1: ${name}: no completion receipt is written, the records are kept, and the run is never launch evidence`, async () => {
    await withScenario(undefined, async (s) => {
      const { deps, calls } = driftDeps(change);
      const message = await refused(runBenchmark(s.options(), deps));
      assert.match(message, /the run's identity changed while it ran/);
      assert.match(message, expected);
      assert.equal(calls.analyze.length, 5, "the work itself ran");
      assert.deepEqual(listRecords(s).length, 5, "the records are kept");
      assert.equal(existsSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE)), false);
      assert.equal(existsSync(path.join(s.runDir, LOCK_FILE)), false);
      assert.match(await refused(Promise.resolve().then(() => readCompleteRun(s.runDir))), /incomplete/);
      const a = adapt(s, s.runDir, "drift.predictions.json");
      assert.equal(a.code, 2);
      assert.match(a.err, /incomplete/);
      // It cannot be "completed" later under the new identity: resuming is refused (inputs differ), and under the old one only the drift check decides.
      const later = fakeDeps({ git: () => ({ commit: "e".repeat(40), dirty: false }) });
      assert.equal(later.calls.analyze.length, 0);
      assert.match(await refused(runBenchmark(s.options(), later.deps)), /different inputs/);
    });
  });
}

test("M1: requestSha256, model and version are explicit in the binding and the verified report", async () => {
  await withScenario(undefined, async (s) => {
    await gold(s);
    await runBenchmark(s.options(), fakeDeps().deps);
    const a = adapt(s, s.runDir, "p.json");
    const b = JSON.parse(readFileSync(a.file, "utf8")).run.runBinding;
    assert.equal(b.requestSha256, IDENTITY.requestSha256);
    assert.equal(b.promptSha256, IDENTITY.promptSha256);
    assert.equal(b.model, IDENTITY.model);
    assert.equal(b.modelVersion, IDENTITY.modelVersion);
    const r = scoreCli(s, a.file, "r.json", s.runDir);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.report!.run.runBinding?.requestSha256, IDENTITY.requestSha256);
    assert.equal(r.report!.runVerification?.modelVersion, IDENTITY.modelVersion);
    // Changing the request identity in the file (to make a different prompt look like the run's) is refused.
    const tampered = JSON.parse(readFileSync(a.file, "utf8"));
    tampered.run.runBinding.requestSha256 = HEX("9");
    writeFileSync(path.join(s.dir, "t.json"), stable(tampered));
    const t = scoreCli(s, path.join(s.dir, "t.json"), "rt.json", s.runDir);
    assert.equal(t.code, 2);
    assert.match(t.err, /binding differs from the one derived from the run directory/);
  });
});

// ---- M2: the completion receipt is derived, not trusted

async function tamperCompletion(s: Scenario, mutate: (c: Record<string, any>) => void): Promise<string> {
  const file = path.join(s.runDir, COMPLETION_RECEIPT_FILE);
  const c = JSON.parse(readFileSync(file, "utf8"));
  mutate(c);
  writeFileSync(file, stable(c));
  return refused(Promise.resolve().then(() => readCompleteRun(s.runDir)));
}

test("M2: outcomes, unexpectedErrors and completedAt in the completion receipt are re-derived from the records; edits are refused", async () => {
  await withScenario(undefined, async (s) => {
    let n = 0;
    const { deps } = fakeDeps({
      analyze: async () => {
        if (++n === 2) throw new VisionError("slow", "timeout");
        if (n === 4) throw new TypeError("boom");
        return { analysis: structuredClone(GOOD_ANALYSIS) };
      },
    });
    await runBenchmark(s.options(), deps);
    const original = readFileSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE), "utf8");
    const c = JSON.parse(original);
    assert.deepEqual(c.outcomes, { ok: 3, timeout: 1, unavailable: 1, unverified: 0 }, "the honest receipt agrees with the records");
    assert.equal(c.unexpectedErrors, 1);
    assert.equal(readCompleteRun(s.runDir).records.size, 5);
    const restore = () => writeFileSync(path.join(s.runDir, COMPLETION_RECEIPT_FILE), original);

    assert.match(await tamperCompletion(s, (x) => ((x.outcomes.ok = 5), (x.outcomes.timeout = 0), (x.outcomes.unavailable = 0))), /says 5 "ok" outcome\(s\) but the records hold 3 \(edited\)/);
    restore();
    assert.match(await tamperCompletion(s, (x) => (x.outcomes.timeout = 0)), /says 0 "timeout" outcome\(s\) but the records hold 1/);
    restore();
    assert.match(await tamperCompletion(s, (x) => (x.unexpectedErrors = 0)), /says 0 unexpected runner error\(s\) but the records hold 1 \(edited\)/);
    restore();
    assert.match(await tamperCompletion(s, (x) => (x.unexpectedErrors = 3)), /says 3 unexpected runner error\(s\) but the records hold 1/);
    restore();
    assert.match(await tamperCompletion(s, (x) => (x.completedAt = "2020-01-01T00:00:00.000Z")), /completion time is before the run started/);
    restore();
    const lastStart = Math.max(...listRecords(s).map((f) => Date.parse(JSON.parse(readFileSync(path.join(s.runDir, RECORDS_DIR, f), "utf8")).startedAt)));
    assert.match(await tamperCompletion(s, (x) => (x.completedAt = new Date(lastStart - 1).toISOString())), /completion time is before the last record started/);
    restore();
    assert.match(await tamperCompletion(s, (x) => (x.records = x.records.slice(1))), /does not list exactly the run's fixtures|no record|vouched/);
    restore();
    assert.match(await tamperCompletion(s, (x) => (x.runReceiptSha256 = HEX("1"))), /run receipt changed after the run completed/);
    restore();
    assert.match(await tamperCompletion(s, (x) => (x.runId = "another-run")), /belongs to a different run/);
    restore();
    assert.equal(readCompleteRun(s.runDir).records.size, 5, "restored, it verifies again");
  });
});

// ---- low: unexpected runner errors are visible, without detail

test("low: unexpected runner errors are counted separately in the report and stop a launch verdict, without leaking details", async () => {
  await withScenario(undefined, async (s) => {
    await gold(s);
    let n = 0;
    await runBenchmark(
      s.options(),
      fakeDeps({
        analyze: async () => {
          if (++n === 4) throw new TypeError("secret path C:\\Users\\someone\\photo.jpg");
          return { analysis: structuredClone(GOOD_ANALYSIS) };
        },
      }).deps,
    );
    const a = adapt(s, s.runDir, "p.json");
    assert.equal(a.code, 0, a.err);
    const r = scoreCli(s, a.file, "r.json", s.runDir);
    assert.equal(r.code, 0, r.err);
    const held = r.report!.splits.heldout!;
    assert.equal(held.reliability.runnerUnexpected, 1);
    assert.equal(r.report!.cases.filter((c) => c.runnerUnexpected).length, 1);
    assert.ok(r.report!.gate.preconditions.some((p) => /1 held-out case\(s\) were recorded for an unexpected runner or environment fault/.test(p)));
    assert.equal(r.report!.gate.verdict, "NOT_EVALUATED");
    const text = readFileSync(r.out, "utf8");
    assert.equal(/someone|secret path|photo\.jpg/.test(text), false, "only the error TYPE ever reaches the report");
  });
});
