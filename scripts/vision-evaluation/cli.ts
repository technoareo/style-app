import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { qwenCompactCornersAdapter, qwenCompactCornersRun } from "./adapters";
import { validateAnnotationFile, type AnnotationFile } from "./annotations";
import {
  DEFAULT_IOU_THRESHOLD,
  EvaluationRefusal,
  evaluate,
  writeNewJson,
  type ImageResolver,
} from "./evaluate";
import { inspectImageBytes, sha256Hex } from "./image";
import { validateManifest, type Manifest } from "./manifest";
import { validatePredictionReport, type PredictionReport } from "./predictions";

/**
 * Command line of the offline recognition evaluation harness. It reads files the
 * operator names and writes one NEW file. It never calls a model, a network or
 * the application, and it never overwrites.
 *
 *   inspect <image>...                       print sha256 and dimensions (read-only)
 *   adapt-qwen --record R --fixture-id ID --manifest M --images-dir D --out NEW
 *   score --manifest M... --annotations A... --predictions P --images-dir D --out NEW [--iou 0.5]
 */

class UsageError extends Error {}

export type CliIo = { log: (line: string) => void; error: (line: string) => void; now: () => Date };

const defaultIo: CliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  now: () => new Date(),
};

function readJsonFile(file: string): { value: unknown; sha256: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new UsageError(`cannot read ${file}`);
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8").replace(/^﻿/, "")) as unknown, sha256: sha256Hex(bytes) };
  } catch {
    throw new EvaluationRefusal([`${file} is not valid JSON (truncated or damaged files are never repaired)`]);
  }
}

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

function loadManifest(file: string): { manifest: Manifest; sha256: string } {
  const { value, sha256 } = readJsonFile(file);
  const { manifest, problems } = validateManifest(value);
  if (!manifest) throw new EvaluationRefusal(problems.map((p) => `${file}: ${p}`));
  return { manifest, sha256 };
}

function requireNewOutput(out: string | undefined): string {
  if (!out) throw new UsageError("--out is required");
  if (existsSync(out)) throw new UsageError(`${out} already exists; reports are never overwritten, choose a new name`);
  return out;
}

function inspect(files: string[], io: CliIo): void {
  if (files.length === 0) throw new UsageError("inspect needs at least one image path");
  const rows = files.map((file) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      throw new UsageError(`cannot read ${file}`);
    }
    return { file: path.basename(file), bytes: bytes.length, sha256: sha256Hex(bytes), dimensions: inspectImageBytes(bytes) };
  });
  io.log(JSON.stringify(rows, null, 2));
}

function adaptQwen(values: Record<string, string | string[] | boolean | undefined>, io: CliIo): void {
  const record = values.record as string | undefined;
  const fixtureId = values["fixture-id"] as string | undefined;
  const manifestFile = values.manifest as string[] | undefined;
  const imagesDir = values["images-dir"] as string | undefined;
  if (!record || !fixtureId || !manifestFile || manifestFile.length !== 1 || !imagesDir)
    throw new UsageError("adapt-qwen needs --record, --fixture-id, one --manifest, --images-dir and --out");
  const out = requireNewOutput(values.out as string | undefined);
  const { manifest } = loadManifest(manifestFile[0]);
  const fixture = manifest.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) throw new EvaluationRefusal([`fixture "${fixtureId}" is not in ${manifestFile[0]}`]);
  const facts = imagesFrom(imagesDir)(fixture);
  if (!facts) throw new EvaluationRefusal([`fixture "${fixtureId}": image file "${fixture.file}" is absent or unreadable`]);
  if (facts.sha256 !== fixture.sha256)
    throw new EvaluationRefusal([`fixture "${fixtureId}": image sha256 differs from the immutable manifest hash`]);
  const saved = readJsonFile(record).value;
  const report: PredictionReport = {
    schemaVersion: 1,
    kind: "predictions",
    run: qwenCompactCornersRun(saved),
    cases: [qwenCompactCornersAdapter.toCase(saved, { fixtureId, imageSha256: fixture.sha256 })],
  };
  writeNewJson(out, report);
  io.log(`wrote ${out}: status ${report.cases[0].status}, raw ${report.cases[0].rawCount}, invalid ${report.cases[0].invalidCount}`);
}

function score(values: Record<string, string | string[] | boolean | undefined>, io: CliIo): void {
  const manifestFiles = (values.manifest as string[] | undefined) ?? [];
  const annotationFiles = (values.annotations as string[] | undefined) ?? [];
  const predictionsFile = values.predictions as string | undefined;
  const imagesDir = values["images-dir"] as string | undefined;
  if (manifestFiles.length === 0 || annotationFiles.length === 0 || !predictionsFile || !imagesDir)
    throw new UsageError("score needs --manifest, --annotations, --predictions, --images-dir and --out");
  const out = requireNewOutput(values.out as string | undefined);
  const iouText = values.iou as string | undefined;
  const iouThreshold = iouText === undefined ? DEFAULT_IOU_THRESHOLD : Number(iouText);
  // Contract: text that is not a plain decimal is a usage error (exit 1); a number
  // outside (0, 1] is a scoring refusal (exit 2). Neither writes any output.
  if (iouText !== undefined && !/^(\d+(\.\d+)?|\.\d+)$/.test(iouText))
    throw new UsageError("--iou must be a plain decimal number such as 0.5");
  if (!(Number.isFinite(iouThreshold) && iouThreshold > 0 && iouThreshold <= 1))
    throw new EvaluationRefusal([`--iou ${iouText} is outside the allowed range: above 0 and at most 1`]);

  const digests: Array<{ role: string; path: string; sha256: string }> = [];
  const manifests: Manifest[] = [];
  for (const file of manifestFiles) {
    const loaded = loadManifest(file);
    manifests.push(loaded.manifest);
    digests.push({ role: "manifest", path: path.basename(file), sha256: loaded.sha256 });
  }
  const annotations: AnnotationFile[] = [];
  for (const file of annotationFiles) {
    const { value, sha256 } = readJsonFile(file);
    const { file: parsed, problems } = validateAnnotationFile(value);
    if (!parsed) throw new EvaluationRefusal(problems.map((p) => `${file}: ${p}`));
    annotations.push(parsed);
    digests.push({ role: "annotations", path: path.basename(file), sha256 });
  }
  const { value: predValue, sha256: predSha } = readJsonFile(predictionsFile);
  const { report: predictions, problems: predProblems } = validatePredictionReport(predValue);
  if (!predictions) throw new EvaluationRefusal(predProblems.map((p) => `${predictionsFile}: ${p}`));
  digests.push({ role: "predictions", path: path.basename(predictionsFile), sha256: predSha });

  const report = evaluate({
    manifests,
    annotationFiles: annotations,
    predictions,
    images: imagesFrom(imagesDir),
    iouThreshold,
    createdAt: io.now().toISOString(),
    inputDigests: digests,
  });
  writeNewJson(out, report);
  const failed = report.cases.filter((c) => c.outcome === "failed").length;
  io.log(`wrote ${out}: ${report.cases.length} case(s), ${failed} failed. No readiness threshold is applied.`);
}

/** Returns the process exit code: 0 done, 2 scoring refused, 1 usage or other error. */
export function runCli(argv: string[], io: CliIo = defaultIo): number {
  try {
    const command = argv[0];
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      strict: true,
      options: {
        record: { type: "string" },
        "fixture-id": { type: "string" },
        manifest: { type: "string", multiple: true },
        annotations: { type: "string", multiple: true },
        predictions: { type: "string" },
        "images-dir": { type: "string" },
        out: { type: "string" },
        iou: { type: "string" },
      },
    });
    if (command === "inspect") inspect(positionals, io);
    else if (command === "adapt-qwen") adaptQwen(values, io);
    else if (command === "score") score(values, io);
    else throw new UsageError("usage: inspect | adapt-qwen | score (see scripts/vision-evaluation/README.md)");
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
