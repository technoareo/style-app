import type { IntakeRecord, Workspace } from "./intake";
import { readSeal, verifyPool } from "./intake";
import type { LaunchPolicy } from "./policy";
import type { FinalLabel, FinalReason } from "./review";
import { planSample, type CoverageSpec } from "./sampling";

/**
 * A privacy-safe READY / NOT READY report for DATA COLLECTION AND FREEZE only (build 026).
 *
 * It contains counts and generic blocker lines. It never contains a rights holder, a reviewer, an original
 * file name, a path, a URL, a release reference or an image id, and it says nothing about how accurate any
 * model is: no model has been run when this is produced. READY means "the collected data satisfies the
 * collection and freeze requirements as written"; it is not a statement that the app may launch.
 */

export type ReadinessReport = {
  schemaVersion: 1;
  kind: "single-item-intake-readiness";
  benchmarkId: string;
  createdAt: string;
  scope: "data-collection-and-freeze-only";
  accuracy: "not measured: no model has been run, and this report makes no accuracy or launch claim";
  verdict: "READY" | "NOT READY";
  photos: {
    total: number;
    bySourceType: Record<string, number>;
    byStratum: Record<string, number>;
    withPeople: number;
    withModelRelease: number;
    redistributionAllowed: number;
    redistributionNotAllowed: number;
    nearDuplicateLinks: number;
  };
  integrity: { poolMismatches: number };
  labelling: {
    notLabelled: number;
    labelledTwice: number;
    labelledOnce: number;
    agreed: number;
    adjudicated: number;
    needsAdjudication: number;
    excluded: Record<string, number>;
  };
  coverage: null | { planned: boolean; deficitCount: number; deficits: string[]; heldoutInScope: number; heldoutRejection: number; developmentInScope: number };
  seal: { sealed: boolean; heldoutCount: number; developmentCount: number };
  blockers: string[];
};

const tally = <T>(items: T[], key: (t: T) => string) => {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

export type ReadinessInput = {
  ws: Workspace;
  records: IntakeRecord[];
  finals: ReadonlyMap<string, FinalLabel>;
  excluded: ReadonlyMap<string, FinalReason>;
  agreed: number;
  adjudicated: number;
  /** null when no coverage spec and policy were supplied: coverage then cannot be judged and the verdict is NOT READY. */
  plan: { spec: CoverageSpec; policy: LaunchPolicy } | null;
  reviewProblems: string[];
  now: Date;
};

export function buildReadiness(input: ReadinessInput): ReadinessReport {
  const { ws, records, finals, excluded } = input;
  const seal = readSeal(ws);
  const poolMismatches = verifyPool(ws, records).length;
  const people = records.filter((r) => r.capture.personsPresent);
  const labelled = [...finals.values()];
  const plan = input.plan ? planSample(ws, records, finals, excluded, input.plan.spec, input.plan.policy) : null;
  const blockers: string[] = [];
  if (records.length === 0) blockers.push("no photos have been imported");
  if (poolMismatches > 0) blockers.push(`${poolMismatches} pooled image(s) do not match their records (changed, missing or unrecorded)`);
  if (input.reviewProblems.length > 0) blockers.push(`${input.reviewProblems.length} labelling problem(s) (reviewers not independent, adjudication misuse or similar); run single-label-verify`);
  const notLabelled = records.length - finals.size - excluded.size;
  if (notLabelled > 0) blockers.push(`${notLabelled} photo(s) have no review`);
  const needs = [...excluded.values()].filter((r) => r === "needs-adjudication").length;
  if (needs > 0) blockers.push(`${needs} photo(s) await adjudication of a reviewer disagreement`);
  if (!plan) blockers.push("coverage was not assessed (supply --coverage and --policy)");
  else if (plan.deficits.length > 0) blockers.push(`${plan.deficits.length} coverage deficit(s) against the coverage spec`);
  const ready = blockers.length === 0;
  return {
    schemaVersion: 1,
    kind: "single-item-intake-readiness",
    benchmarkId: ws.benchmarkId,
    createdAt: input.now.toISOString(),
    scope: "data-collection-and-freeze-only",
    accuracy: "not measured: no model has been run, and this report makes no accuracy or launch claim",
    verdict: ready ? "READY" : "NOT READY",
    photos: {
      total: records.length,
      bySourceType: tally(records, (r) => r.rights.sourceType),
      byStratum: tally(records, (r) => r.stratum),
      withPeople: people.length,
      withModelRelease: people.filter((r) => r.capture.modelRelease !== null).length,
      redistributionAllowed: records.filter((r) => r.rights.redistributionAllowed).length,
      redistributionNotAllowed: records.filter((r) => !r.rights.redistributionAllowed).length,
      nearDuplicateLinks: records.reduce((n, r) => n + r.receipt.nearDuplicateOf.length, 0),
    },
    integrity: { poolMismatches },
    labelling: {
      notLabelled: Math.max(0, notLabelled),
      labelledTwice: labelled.filter((l) => l.doubleReviewed).length,
      labelledOnce: labelled.filter((l) => !l.doubleReviewed).length,
      agreed: input.agreed,
      adjudicated: input.adjudicated,
      needsAdjudication: needs,
      excluded: tally([...excluded.values()], (r) => r),
    },
    coverage: plan
      ? { planned: true, deficitCount: plan.deficits.length, deficits: plan.deficits, heldoutInScope: plan.heldoutCoverage.inScope.have, heldoutRejection: plan.heldoutCoverage.rejection.have, developmentInScope: plan.developmentCoverage.inScope.have }
      : null,
    seal: { sealed: seal !== null, heldoutCount: seal?.heldoutImageIds.length ?? 0, developmentCount: seal?.developmentImageIds.length ?? 0 },
    blockers,
  };
}
