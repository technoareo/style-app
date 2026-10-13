import { writeFileSync } from "node:fs";
import { annotationProblemsForManifest, validateAnnotationFile, type AnnotationFile } from "./annotations";
import { crossManifestProblems, validateManifest, type Fixture, type Manifest } from "./manifest";
import { validatePredictionReport, type PredictionReport, type RunInfo } from "./predictions";
import { aggregateSections, scoreCase, type CaseScore, type Section } from "./scoring";
import type { Dimensions, Split } from "./types";

export const DEFAULT_IOU_THRESHOLD = 0.5;

/** Scoring was refused. Nothing is scored, nothing is written. */
export class EvaluationRefusal extends Error {
  constructor(readonly problems: string[]) {
    super(`Refusing to score (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n- ${problems.join("\n- ")}`);
    this.name = "EvaluationRefusal";
  }
}

/** What the runner found on disk for a fixture; null = absent or unreadable. */
export type ImageFacts = { sha256: string; dimensions: Dimensions | null };
export type ImageResolver = (fixture: Fixture) => ImageFacts | null;

export type EvaluationInput = {
  manifests: readonly Manifest[];
  annotationFiles: readonly AnnotationFile[];
  predictions: PredictionReport;
  images: ImageResolver;
  iouThreshold: number;
  /** Supplied by the caller so the report is reproducible. */
  createdAt: string;
  /** SHA-256 of each input file's bytes, recorded in the report. */
  inputDigests: ReadonlyArray<{ role: string; path: string; sha256: string }>;
};

export type EvaluationReport = {
  reportVersion: 1;
  kind: "recognition-evaluation-report";
  createdAt: string;
  parameters: { iouThreshold: number; matching: string };
  inputs: EvaluationInput["inputDigests"];
  run: RunInfo;
  statements: string[];
  results: Record<Split, Section | null>;
  cases: CaseScore[];
};

const dimsEqual = (a: Dimensions, b: Dimensions) =>
  a.width === b.width && a.height === b.height && a.exifOrientation === b.exifOrientation;

/** Every reason scoring must be refused; empty means the inputs are consistent. */
export function refusalProblems(input: EvaluationInput): string[] {
  const out: string[] = [];
  // The public boundary revalidates every typed input, so a direct call cannot
  // bypass the schema, contamination or split safeguards that file loading applies.
  input.manifests.forEach((m, i) => out.push(...validateManifest(m).problems.map((p) => `manifests[${i}]: ${p}`)));
  input.annotationFiles.forEach((a, i) =>
    out.push(...validateAnnotationFile(a).problems.map((p) => `annotationFiles[${i}]: ${p}`)),
  );
  out.push(...validatePredictionReport(input.predictions).problems.map((p) => `predictions: ${p}`));
  if (out.length > 0) return out;
  const { iouThreshold } = input;
  if (!(Number.isFinite(iouThreshold) && iouThreshold > 0 && iouThreshold <= 1))
    out.push("IoU threshold must be a number above 0 and at most 1");
  if (input.manifests.length === 0) out.push("no manifest was supplied");
  out.push(...crossManifestProblems(input.manifests));

  const fixtureById = new Map<string, { fixture: Fixture; manifest: Manifest }>();
  for (const manifest of input.manifests) {
    const files = input.annotationFiles.filter((f) => f.split === manifest.split);
    if (files.length !== 1) {
      if (manifest.fixtures.length > 0 || files.length > 1)
        out.push(`need exactly one ${manifest.split} annotation file, got ${files.length}`);
    } else out.push(...annotationProblemsForManifest(files[0], manifest));
    for (const fixture of manifest.fixtures) {
      fixtureById.set(fixture.id, { fixture, manifest });
      const facts = input.images(fixture);
      if (!facts) {
        out.push(`fixture "${fixture.id}": image file "${fixture.file}" is absent or unreadable`);
        continue;
      }
      if (facts.sha256.toLowerCase() !== fixture.sha256)
        out.push(`fixture "${fixture.id}": image sha256 ${facts.sha256.toLowerCase()} differs from the immutable manifest hash`);
      if (fixture.originalDimensions === null)
        out.push(`fixture "${fixture.id}": originalDimensions not recorded in the manifest (measure with the inspect command)`);
      else if (!facts.dimensions) out.push(`fixture "${fixture.id}": cannot read the image dimensions`);
      else if (!dimsEqual(fixture.originalDimensions, facts.dimensions))
        out.push(`fixture "${fixture.id}": image dimensions differ from originalDimensions in the manifest`);
    }
  }
  if (fixtureById.size === 0) out.push("the manifests list no fixtures: there is nothing to score");
  for (const file of input.annotationFiles)
    if (!input.manifests.some((m) => m.split === file.split))
      out.push(`an annotation file for the ${file.split} split was supplied without its manifest`);

  const { run, cases } = input.predictions;
  for (const c of cases) {
    const known = fixtureById.get(c.fixtureId);
    if (!known) {
      out.push(`prediction for unknown fixture "${c.fixtureId}"`);
      continue;
    }
    if (c.imageSha256 !== known.fixture.sha256)
      out.push(`fixture "${c.fixtureId}": the prediction was made on a different image (sha256 mismatch)`);
  }
  // A held-out fixture is only valid evidence if the split was fixed before this run began.
  for (const manifest of input.manifests) {
    if (manifest.split !== "heldout" || manifest.fixtures.length === 0) continue;
    const predictedHeldout = cases.some((c) => manifest.fixtures.some((f) => f.id === c.fixtureId));
    if (!predictedHeldout) continue;
    if (run.startedAt === null)
      out.push("held-out predictions need run.startedAt, to prove the run began after the split was fixed");
    else if (manifest.splitFrozenAt !== null && Date.parse(run.startedAt) < Date.parse(manifest.splitFrozenAt))
      out.push(`contamination: the run started (${run.startedAt}) before the held-out split was fixed (${manifest.splitFrozenAt})`);
  }
  return out;
}

export const REPORT_STATEMENTS: readonly string[] = [
  "No launch or readiness threshold is applied. These are measurements, not an approval.",
  "Failed, timed-out, truncated, partly invalid and missing cases stay in every denominator and contribute no detections.",
  "Matching is one-to-one and geometric; category agreement is reported separately among geometry matches.",
  "Attributes are scored only where a human independently labelled them; brand, size and material are never scored.",
  "The development split was seen by models during development and is not held-out evidence.",
  "categoryAccuracyGivenGeometryMatch and attribute correct/wrong are CONDITIONAL on a geometry match; categoryCorrectOfAllGold and attributes.goldLabelledTotal show the unconditional denominators. Read them with the failure and missing counts.",
  "Split timestamps, priorInference flags and the known-development hash list are self-reported provenance. This harness refuses inconsistencies but cannot independently prove split history or that an image was never inferred.",
  "Precision is null where no scored prediction exists; a failed case never yields perfect precision.",
];

export function evaluate(input: EvaluationInput): EvaluationReport {
  const problems = refusalProblems(input);
  if (problems.length > 0) throw new EvaluationRefusal(problems);

  const predictionById = new Map(input.predictions.cases.map((c) => [c.fixtureId, c]));
  const scores: CaseScore[] = [];
  for (const manifest of input.manifests) {
    const annotationFile = input.annotationFiles.find((f) => f.split === manifest.split);
    for (const fixture of manifest.fixtures) {
      const annotation = annotationFile?.annotations.find((a) => a.fixtureId === fixture.id);
      if (!annotation || fixture.stratum === null) throw new EvaluationRefusal([`fixture "${fixture.id}": incomplete labels`]);
      scores.push(
        scoreCase({
          fixtureId: fixture.id,
          split: manifest.split,
          stratum: fixture.stratum,
          annotation,
          prediction: predictionById.get(fixture.id),
          iouThreshold: input.iouThreshold,
        }),
      );
    }
  }

  const results = aggregateSections(scores);
  const statements = [...REPORT_STATEMENTS];
  if (results.heldout === null) statements.push("No held-out fixture was scored: nothing in this report is held-out evidence.");
  return {
    reportVersion: 1,
    kind: "recognition-evaluation-report",
    createdAt: input.createdAt,
    parameters: {
      iouThreshold: input.iouThreshold,
      matching: "maximum cardinality, then maximum total IoU (Hungarian), geometry only",
    },
    inputs: input.inputDigests,
    run: input.predictions.run,
    statements,
    results,
    cases: scores,
  };
}

/** Writes a NEW file. An existing file is never replaced (flag "wx" fails with EEXIST). */
export function writeNewJson(path: string, value: unknown): void {
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Refusing to overwrite existing file: ${path}. Choose a new output name.`);
    throw e;
  }
}
