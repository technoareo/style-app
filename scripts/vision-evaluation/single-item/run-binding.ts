import { createHash } from "node:crypto";
import { SHA256_RE, expectKeys, isNonEmptyString, isRecord, oneOf } from "../check";
import { SPLITS, type Split } from "../types";
import { canonicalJson } from "./policy";

/**
 * What ties a prediction report to the benchmark runner (build 025). Predictions
 * adapted from a COMPLETE runner directory carry this block; predictions adapted
 * from loose records an operator wrote themselves do not, and so can never be
 * launch evidence. The scorer cross-checks it against the manifests it is given
 * and against the cases it holds (see integrity.ts).
 *
 * It proves the report agrees with what the runner published; it cannot prove who
 * ran it, and anyone who controls the whole machine can fabricate a directory.
 */

export type RunBinding = {
  runId: string;
  /** sha256 of the canonical run inputs (benchmark, files, model, prompt, mode, commit...). Resume requires it to be equal. */
  inputsDigest: string;
  runReceiptSha256: string;
  completionReceiptSha256: string;
  /** App commit the run used. */
  gitCommit: string;
  /** The worktree had uncommitted changes. Only allowed together with developmentOnly. */
  gitDirty: boolean;
  /** An explicit development override was used; the evidence can never gate a launch. */
  developmentOnly: boolean;
  runnerId: string;
  /** What the run measured, from the run receipt: model name and version (the runtime digest), prompt and request identity of the app path. */
  model: string;
  modelVersion: string;
  promptSha256: string;
  requestSha256: string;
  manifests: Array<{ split: Split; fileSha256: string }>;
  receipts: Array<{ split: Split; fileSha256: string }>;
  /** sha256 of the canonical prediction cases as adapted, so edits made afterwards are visible. */
  casesSha256: string;
};

/**
 * Proof that a prediction report was re-derived, byte for byte, from a COMPLETE, clean runner directory that
 * was re-opened at scoring time. Only the verifier (runner.ts verifyPredictionsAgainstRun) produces one; a
 * runBinding written into a predictions file by hand is never enough on its own. In-process callers are
 * trusted code (a program can build this object); the command line cannot.
 */
export type VerifiedRun = {
  runId: string;
  inputsDigest: string;
  completionReceiptSha256: string;
  requestSha256: string;
  modelVersion: string;
};

const BINDING_KEYS = [
  "runId",
  "inputsDigest",
  "runReceiptSha256",
  "completionReceiptSha256",
  "gitCommit",
  "gitDirty",
  "developmentOnly",
  "runnerId",
  "model",
  "modelVersion",
  "promptSha256",
  "requestSha256",
  "manifests",
  "receipts",
  "casesSha256",
] as const;
const FILE_DIGEST_KEYS = ["split", "fileSha256"] as const;
/** Error text of a case the runner recorded for a failure that was not a model outcome (type only, no message). */
export const UNEXPECTED_PREFIX = "runner-unexpected:";

const COMMIT_RE = /^[0-9a-f]{40}$/;

/** Digest of prediction cases, independent of their order. */
export function casesDigest(cases: ReadonlyArray<{ fixtureId: string }>): string {
  const sorted = [...cases].sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0));
  return createHash("sha256").update(canonicalJson(sorted)).digest("hex");
}

function digestList(v: unknown, at: string, out: string[]): Array<{ split: Split; fileSha256: string }> {
  if (!Array.isArray(v)) {
    out.push(`${at}: must be a list`);
    return [];
  }
  const rows: Array<{ split: Split; fileSha256: string }> = [];
  v.forEach((row: unknown, i: number) => {
    if (!isRecord(row)) return void out.push(`${at}[${i}]: must be an object`);
    expectKeys(row, FILE_DIGEST_KEYS, `${at}[${i}]`, out);
    if (!oneOf(SPLITS, row.split)) out.push(`${at}[${i}].split: invalid`);
    if (typeof row.fileSha256 !== "string" || !SHA256_RE.test(row.fileSha256)) out.push(`${at}[${i}].fileSha256: must be 64 hex characters`);
    else if (oneOf(SPLITS, row.split)) rows.push({ split: row.split, fileSha256: row.fileSha256.toLowerCase() });
  });
  if (new Set(rows.map((r) => r.split)).size !== rows.length) out.push(`${at}: a split appears twice`);
  return rows;
}

export function validateRunBinding(v: unknown, at: string, out: string[]): RunBinding | null {
  if (!isRecord(v)) {
    out.push(`${at}: must be an object`);
    return null;
  }
  const before = out.length;
  expectKeys(v, BINDING_KEYS, at, out);
  for (const key of ["runId", "runnerId", "model", "modelVersion"] as const) if (!isNonEmptyString(v[key])) out.push(`${at}.${key}: must be a non-empty string`);
  for (const key of ["inputsDigest", "runReceiptSha256", "completionReceiptSha256", "casesSha256", "promptSha256", "requestSha256"] as const)
    if (typeof v[key] !== "string" || !SHA256_RE.test(v[key] as string)) out.push(`${at}.${key}: must be 64 hex characters`);
  if (typeof v.gitCommit !== "string" || !COMMIT_RE.test(v.gitCommit)) out.push(`${at}.gitCommit: must be a full 40-character commit id`);
  if (typeof v.gitDirty !== "boolean") out.push(`${at}.gitDirty: must be true or false`);
  if (typeof v.developmentOnly !== "boolean") out.push(`${at}.developmentOnly: must be true or false`);
  if (v.gitDirty === true && v.developmentOnly !== true) out.push(`${at}: a dirty worktree is only possible together with the development-only override`);
  const manifests = digestList(v.manifests, `${at}.manifests`, out);
  const receipts = digestList(v.receipts, `${at}.receipts`, out);
  if (manifests.length === 0) out.push(`${at}.manifests: must name at least one manifest`);
  return out.length > before
    ? null
    : {
        runId: v.runId as string,
        inputsDigest: (v.inputsDigest as string).toLowerCase(),
        runReceiptSha256: (v.runReceiptSha256 as string).toLowerCase(),
        completionReceiptSha256: (v.completionReceiptSha256 as string).toLowerCase(),
        gitCommit: v.gitCommit as string,
        gitDirty: v.gitDirty as boolean,
        developmentOnly: v.developmentOnly as boolean,
        runnerId: v.runnerId as string,
        model: v.model as string,
        modelVersion: v.modelVersion as string,
        promptSha256: (v.promptSha256 as string).toLowerCase(),
        requestSha256: (v.requestSha256 as string).toLowerCase(),
        manifests,
        receipts,
        casesSha256: (v.casesSha256 as string).toLowerCase(),
      };
}
