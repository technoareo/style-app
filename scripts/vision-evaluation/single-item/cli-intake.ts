import { parseArgs } from "node:util";
import { EvaluationRefusal } from "../evaluate";
import { sha256Hex } from "../image";
import { Creations, readWorkspaceFile, realFs, type FsOps } from "./fsx";
import { importBatch, initWorkspace, loadRecords, openWorkspace, stableText, verifyPool, type IntakeRecord, type Workspace } from "./intake";
import { validatePolicy, type LaunchPolicy } from "./policy";
import { buildReadiness } from "./readiness";
import { REVIEWER_RE, loadReview, resolveLabels, reviewTemplate, submitReview, validateReview, type ReviewFile } from "./review";
import { freezeFromPlan, planSample, validateCoverageSpec, type CoverageSpec, type SamplePlan } from "./sampling";

/**
 * Commands of the rights-cleared photo intake and gold-label workflow (build 026), all `single-intake-*`,
 * `single-label-*` and `single-sample`. They read the files the operator names, write NEW files only, never
 * download anything, never run a model and never measure accuracy.
 *
 *   single-intake-init     --workspace NEW --benchmark-id ID
 *   single-intake-import   --workspace W --batch FILE --source-dir DIR --operator op-xxxxxx
 *   single-label-template  --workspace W --reviewer rv-xxxxxx [--adjudicates rv-a,rv-b] --out NEW
 *   single-label-submit    --workspace W --review FILE
 *   single-label-verify    --workspace W --reviewers rv-a,rv-b [--adjudicator rv-c] [--development-single-review]
 *   single-sample          --workspace W --coverage FILE --policy FILE --reviewers rv-a,rv-b [--adjudicator rv-c] [--development-single-review] --out NEW
 *   single-intake-freeze   --workspace W --plan FILE --coverage FILE --policy FILE --reviewers ... --out-dir NEW
 *   single-intake-report   --workspace W [--coverage FILE --policy FILE --reviewers ...] --out NEW
 *
 * Exit codes: 0 done, 2 refused (inputs are not trustworthy evidence), 1 usage or other error.
 */

export const INTAKE_COMMANDS = ["single-intake-init", "single-intake-import", "single-label-template", "single-label-submit", "single-label-verify", "single-sample", "single-intake-freeze", "single-intake-report"] as const;

class UsageError extends Error {}
export type IntakeIo = { log: (line: string) => void; error: (line: string) => void; now: () => Date; fs?: FsOps };
const defaultIo: IntakeIo = { log: (l) => console.log(l), error: (l) => console.error(l), now: () => new Date() };

type Values = Record<string, string | string[] | boolean | undefined>;
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const need = (v: Values, key: string): string => {
  const t = text(v[key]);
  if (!t) throw new UsageError(`--${key} is required`);
  return t;
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(readWorkspaceFile(file).toString("utf8").replace(/^﻿/, ""));
  } catch (e) {
    if (e instanceof EvaluationRefusal) throw e;
    throw new EvaluationRefusal([`${file.split(/[\\/]/).pop()} is not valid JSON (damaged files are never repaired)`]);
  }
}

/** Writes one NEW file exclusively; an existing path is a usage error, never overwritten. */
function writeNew(file: string, value: unknown, io: IntakeIo): string {
  const body = Buffer.from(stableText(value));
  const made = new Creations(io.fs ?? realFs);
  try {
    made.file(file, body);
  } catch (e) {
    made.rollback();
    if (e instanceof EvaluationRefusal) throw new UsageError(e.message);
    throw e;
  }
  return sha256Hex(body);
}

function loadPolicy(file: string): LaunchPolicy {
  const { policy, problems } = validatePolicy(readJson(file));
  if (!policy) throw new EvaluationRefusal(problems.map((p) => `policy: ${p}`));
  return policy;
}

function loadSpec(file: string, policy: LaunchPolicy): CoverageSpec {
  const { spec, problems } = validateCoverageSpec(readJson(file), policy);
  if (!spec) throw new EvaluationRefusal(problems);
  return spec;
}

type Reviews = { a: ReviewFile | null; b: ReviewFile | null; adj: ReviewFile | null };
function loadReviews(ws: Workspace, records: IntakeRecord[], v: Values, now: Date): Reviews {
  const ids = (text(v.reviewers) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { a: null, b: null, adj: null };
  if (ids.length > 2 || ids.some((x) => !REVIEWER_RE.test(x))) throw new UsageError("--reviewers takes one or two reviewer pseudonyms such as rv-4h7q2z,rv-9m2k5d");
  const byId = new Map(records.map((r) => [r.imageId, r]));
  const a = loadReview(ws, "reviewer", ids[0], byId, now);
  const b = ids[1] ? loadReview(ws, "reviewer", ids[1], byId, now) : null;
  const adjId = text(v.adjudicator);
  const adj = adjId ? loadReview(ws, "adjudicator", adjId, byId, now) : null;
  return { a, b, adj };
}

function resolve(records: IntakeRecord[], rv: Reviews, v: Values) {
  const allowSingle = v["development-single-review"] === true;
  const res = resolveLabels(records, rv.a, rv.b, rv.adj, { allowSingleReview: allowSingle });
  if (res.problems.length > 0) throw new EvaluationRefusal(res.problems);
  return res;
}

async function dispatch(command: string, v: Values, io: IntakeIo): Promise<void> {
  const now = io.now();
  if (command === "single-intake-init") {
    initWorkspace(need(v, "workspace"), need(v, "benchmark-id"), now, io.fs);
    io.log("created an empty intake workspace. It will hold private photos, rights evidence and reviews: it is git-ignored by default under benchmark-intake/; keep it out of git, backups you share and any public report.");
    return;
  }
  const ws = openWorkspace(need(v, "workspace"));
  const records = loadRecords(ws, now);
  if (command === "single-intake-import") {
    const result = await importBatch(ws, need(v, "batch"), need(v, "source-dir"), need(v, "operator"), { fs: io.fs, now: io.now });
    io.log(`imported ${result.imported} photo(s) (${result.nearDuplicateLinks} declared near-duplicate link(s)). Rights evidence stays in the private records; nothing was uploaded or sent anywhere.`);
    return;
  }
  const poolProblems = verifyPool(ws, records);
  if (command !== "single-intake-report" && poolProblems.length > 0) throw new EvaluationRefusal(poolProblems);
  const byId = new Map(records.map((r) => [r.imageId, r]));

  if (command === "single-label-template") {
    const reviewer = need(v, "reviewer");
    if (!REVIEWER_RE.test(reviewer)) throw new UsageError("--reviewer must be a pseudonym such as rv-4h7q2z");
    const adjudicates = text(v.adjudicates);
    let pair: { a: ReviewFile; b: ReviewFile } | null = null;
    if (adjudicates) {
      const ids = adjudicates.split(",").map((s) => s.trim());
      if (ids.length !== 2) throw new UsageError("--adjudicates takes the two reviewer pseudonyms");
      pair = { a: loadReview(ws, "reviewer", ids[0], byId, now), b: loadReview(ws, "reviewer", ids[1], byId, now) };
      if (ids.includes(reviewer)) throw new EvaluationRefusal(["an adjudicator cannot be one of the reviewers"]);
    }
    writeNew(need(v, "out"), reviewTemplate(ws, records, reviewer, pair), io);
    io.log("wrote a blank review. It fails validation until a person fills in every decision; boxes are normalized [x1,y1,x2,y2] in the photo as displayed (EXIF-rotated). Do not look at another reviewer's file before finishing yours.");
    return;
  }
  if (command === "single-label-submit") {
    const { review, problems } = validateReview(readJson(need(v, "review")), ws, byId, now);
    if (!review) throw new EvaluationRefusal(problems);
    submitReview(ws, review, io.fs);
    io.log(`stored ${review.role} ${review.reviewerId}: ${review.labels.length} label(s). A stored review is never replaced.`);
    return;
  }
  if (command === "single-label-verify") {
    const rv = loadReviews(ws, records, v, now);
    const res = resolve(records, rv, v);
    io.log(JSON.stringify({ ok: true, finalLabels: res.finals.size, labelledTwice: [...res.finals.values()].filter((f) => f.doubleReviewed).length, agreed: res.agreed, adjudicated: res.adjudicated, excluded: Object.fromEntries([...new Set(res.excluded.values())].sort().map((r) => [r, [...res.excluded.values()].filter((x) => x === r).length])) }, null, 2));
    return;
  }
  if (command === "single-sample" || command === "single-intake-freeze") {
    const policy = loadPolicy(need(v, "policy"));
    const spec = loadSpec(need(v, "coverage"), policy);
    const rv = loadReviews(ws, records, v, now);
    const res = resolve(records, rv, v);
    if (command === "single-sample") {
      const plan = planSample(ws, records, res.finals, res.excluded, spec, policy);
      writeNew(need(v, "out"), plan, io);
      io.log(`${plan.verdict}: ${plan.heldout.length} held-out and ${plan.development.length} development photo(s), ${plan.deficits.length} coverage deficit(s)${plan.deficits.length ? `:\n- ${plan.deficits.join("\n- ")}` : ""}\nThis is a data-collection plan. It says nothing about model accuracy.`);
      return;
    }
    const plan = readJson(need(v, "plan")) as SamplePlan;
    const out = freezeFromPlan({ ws, records, finals: res.finals, excluded: res.excluded, spec, policy, plan, outDir: need(v, "out-dir"), now, fs: io.fs });
    io.log(`froze ${out.heldoutFixtures} held-out and ${out.developmentFixtures} development photo(s). Held-out manifest sha256 ${out.heldoutManifestSha256}. The held-out split is now sealed: do not tune, prompt or inspect results against it. Run models only after this point (single-run-qwen).`);
    return;
  }
  if (command === "single-intake-report") {
    let plan: { spec: CoverageSpec; policy: LaunchPolicy } | null = null;
    let rv: Reviews = { a: null, b: null, adj: null };
    let finals = new Map<string, import("./review").FinalLabel>();
    let excluded = new Map<string, import("./review").FinalReason>();
    let agreed = 0;
    let adjudicated = 0;
    const reviewProblems: string[] = [];
    if (text(v.reviewers)) {
      rv = loadReviews(ws, records, v, now);
      const res = resolveLabels(records, rv.a, rv.b, rv.adj, { allowSingleReview: v["development-single-review"] === true });
      reviewProblems.push(...res.problems);
      if (res.problems.length === 0) ({ finals, excluded, agreed, adjudicated } = res);
    }
    if (text(v.coverage) && text(v.policy)) {
      const policy = loadPolicy(text(v.policy) as string);
      plan = { spec: loadSpec(text(v.coverage) as string, policy), policy };
    }
    const report = buildReadiness({ ws, records, finals, excluded, agreed, adjudicated, plan, reviewProblems, now });
    writeNew(need(v, "out"), report, io);
    io.log(`${report.verdict} for data collection and freeze (${report.blockers.length} blocker(s)). No accuracy is claimed.${report.blockers.length ? `\n- ${report.blockers.join("\n- ")}` : ""}`);
    return;
  }
  throw new UsageError(`usage: ${INTAKE_COMMANDS.join(" | ")}`);
}

/** Returns the exit code: 0 done, 2 refused, 1 usage or other error. Async because image examination decodes pixels. */
export async function runIntakeCli(argv: string[], io: IntakeIo = defaultIo): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv.slice(1),
      allowPositionals: false,
      strict: true,
      options: {
        workspace: { type: "string" },
        "benchmark-id": { type: "string" },
        batch: { type: "string" },
        "source-dir": { type: "string" },
        operator: { type: "string" },
        reviewer: { type: "string" },
        reviewers: { type: "string" },
        adjudicator: { type: "string" },
        adjudicates: { type: "string" },
        review: { type: "string" },
        coverage: { type: "string" },
        policy: { type: "string" },
        plan: { type: "string" },
        out: { type: "string" },
        "out-dir": { type: "string" },
        "development-single-review": { type: "boolean" },
      },
    });
    if (!(INTAKE_COMMANDS as readonly string[]).includes(argv[0] ?? "")) throw new UsageError(`usage: ${INTAKE_COMMANDS.join(" | ")} (see scripts/vision-evaluation/README.md)`);
    await dispatch(argv[0], values as Values, io);
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
