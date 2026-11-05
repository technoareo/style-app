import type { ImageFacts } from "../evaluate";
import { KNOWN_DEVELOPMENT_SHA256 } from "../manifest";
import type { Split } from "../types";
import type { GoldFile, GoldLabel } from "./gold";
import type { FreezeReceipt, SingleFixture, SingleManifest } from "./manifest";
import type { LaunchPolicy } from "./policy";
import type { SinglePredictionReport } from "./predictions";
import { casesDigest, type VerifiedRun } from "./run-binding";
import { GOLD_CATEGORIES } from "./vocab";

/**
 * Cross-file integrity of a single-item benchmark. Everything here FAILS CLOSED:
 * a problem means the inputs are not trustworthy evidence and nothing is scored.
 * (Strata that are merely too small are a different matter: they make the launch
 * gate NOT EVALUATED, see `strataProblems`.)
 */

export type ManifestInput = {
  manifest: SingleManifest;
  /** SHA-256 of the manifest FILE bytes, for the freeze receipt. null when the caller has none. */
  fileSha256: string | null;
};

export type ImageResolver = (fixture: SingleFixture) => ImageFacts | null;

export type IntegrityInput = {
  manifests: ManifestInput[];
  gold: GoldFile[];
  receipts: FreezeReceipt[];
  predictions: SinglePredictionReport | null;
  /**
   * Set only by verifyPredictionsAgainstRun: the predictions were re-derived from a complete, clean runner
   * directory re-opened at scoring time. A runBinding without it is a claim nobody checked and is refused.
   */
  verifiedRun?: VerifiedRun | null;
  images: ImageResolver;
  /**
   * "freeze": the manifests and cross-split leakage only. "run": the same plus the freeze receipts, i.e.
   * everything that must hold BEFORE any model sees an image (no labels or predictions yet).
   * "score" (default): everything.
   */
  stage?: "freeze" | "run" | "score";
};

/** What is compared across splits. Reported so a reader can see what was and was not checked. */
export const LEAKAGE_KEYS = ["image hash", "fixture id", "file name", "source shoot", "garment", "source page", "original URL", "original file hash"] as const;

const same = (a: string | null, b: string | null) => a !== null && b !== null && a === b;

export function integrityProblems(input: IntegrityInput): string[] {
  const out: string[] = [];
  const bySplit = new Map<Split, ManifestInput>();
  for (const m of input.manifests) {
    if (bySplit.has(m.manifest.split)) out.push(`two manifests for the ${m.manifest.split} split; pass at most one per split`);
    bySplit.set(m.manifest.split, m);
  }
  const ids = new Set(input.manifests.map((m) => m.manifest.benchmarkId));
  if (ids.size > 1) out.push(`manifests belong to different benchmarks: ${[...ids].sort().join(", ")}`);
  const benchmarkId = input.manifests[0]?.manifest.benchmarkId ?? null;

  // --- a held-out split is only trustworthy next to the development split it was checked against
  const developmentInput = bySplit.get("development");
  if (bySplit.has("heldout") && !developmentInput)
    out.push("a held-out split was supplied without the development manifest; cross-split leakage (shoot, garment, source page, original file, bytes) cannot be checked, so held-out evidence is refused. Pass the development manifest too");
  else if (developmentInput && bySplit.has("heldout") && developmentInput.manifest.fixtures.length === 0)
    out.push("the development manifest lists no fixtures, so cross-split leakage checking would be empty; held-out evidence is refused");

  // --- images: present, exact bytes, measured dimensions
  for (const { manifest } of input.manifests) {
    for (const f of manifest.fixtures) {
      const facts = input.images(f);
      if (!facts) {
        out.push(`fixture "${f.id}": image file "${f.file}" is absent or unreadable`);
        continue;
      }
      if (facts.sha256 !== f.sha256) out.push(`fixture "${f.id}": image bytes differ from the immutable manifest hash (hash mismatch)`);
      if (!facts.dimensions) out.push(`fixture "${f.id}": image dimensions could not be measured (JPEG or PNG headers only)`);
      else if (
        facts.dimensions.width !== f.dimensions.width ||
        facts.dimensions.height !== f.dimensions.height ||
        facts.dimensions.exifOrientation !== f.dimensions.exifOrientation
      )
        out.push(`fixture "${f.id}": measured dimensions differ from the manifest`);
    }
  }

  // --- uniqueness and leakage across splits (shoot, garment, source page, original file, bytes)
  type Owner = { split: Split; id: string };
  const seen = new Map<string, Owner>();
  const note = (kind: string, key: string | null, owner: Owner, crossOnly: boolean) => {
    if (key === null) return;
    const slot = `${kind}:${key}`;
    const prior = seen.get(slot);
    if (!prior) return void seen.set(slot, owner);
    if (prior.split !== owner.split) out.push(`leakage: ${kind} "${key}" is in the ${prior.split} split ("${prior.id}") and the ${owner.split} split ("${owner.id}")`);
    else if (!crossOnly && prior.id !== owner.id) out.push(`duplicate ${kind} "${key}" in "${prior.id}" and "${owner.id}"`);
  };
  for (const { manifest } of input.manifests) {
    for (const f of manifest.fixtures) {
      const owner = { split: manifest.split, id: f.id };
      note("image hash", f.sha256, owner, false);
      note("fixture id", f.id, owner, false);
      note("file name", f.file, owner, false);
      note("source shoot", f.sourceShootId, owner, true);
      note("garment", f.garmentId, owner, true);
      note("source page", f.rights.sourcePageUrl, owner, true);
      note("original URL", f.rights.originalUrl, owner, true);
      note("original file hash", f.rights.originalSha256, owner, true);
    }
  }

  // --- held-out contamination
  const heldout = bySplit.get("heldout");
  const freezing = input.stage === "freeze";
  const beforeLabels = input.stage === "freeze" || input.stage === "run";
  if (heldout) {
    for (const f of heldout.manifest.fixtures) {
      if (f.priorInference) out.push(`fixture "${f.id}": a held-out image that a model has already seen`);
      if (KNOWN_DEVELOPMENT_SHA256.has(f.sha256)) out.push(`fixture "${f.id}": is a known development image (a model has seen it)`);
    }
    if (heldout.manifest.fixtures.length > 0 && !freezing) {
      const frozenAt = heldout.manifest.frozenAt;
      const receipt = input.receipts.find((r) => r.split === "heldout") ?? null;
      if (!frozenAt) out.push("held-out manifest is not frozen");
      if (!receipt) out.push("held-out split has no freeze receipt; freeze the manifest before inference");
      else {
        if (benchmarkId && receipt.benchmarkId !== benchmarkId) out.push("freeze receipt belongs to another benchmark");
        if (frozenAt && receipt.frozenAt !== frozenAt) out.push("freeze receipt time differs from the manifest's frozenAt");
        if (receipt.fixtureCount !== heldout.manifest.fixtures.length) out.push("freeze receipt counts a different number of fixtures than the manifest holds (post-freeze change)");
        if (!same(receipt.manifestSha256, heldout.fileSha256)) out.push("held-out manifest file differs from the frozen receipt (changed after the freeze)");
      }
    }
  }
  for (const r of input.receipts) if (!bySplit.has(r.split)) out.push(`freeze receipt for the ${r.split} split has no manifest`);

  // --- gold: one label per fixture, same bytes, same decision, completed
  const goldBySplit = new Map<Split, GoldFile>();
  if (beforeLabels) return [...new Set(out)];
  for (const g of input.gold) {
    if (goldBySplit.has(g.split)) out.push(`two gold files for the ${g.split} split`);
    goldBySplit.set(g.split, g);
    if (benchmarkId && g.benchmarkId !== benchmarkId) out.push(`gold file for the ${g.split} split belongs to another benchmark`);
    if (!bySplit.has(g.split)) out.push(`gold file for the ${g.split} split has no manifest`);
  }
  for (const { manifest } of input.manifests) {
    const gold = goldBySplit.get(manifest.split);
    if (manifest.fixtures.length > 0 && !gold) {
      out.push(`${manifest.split} split: no gold labels`);
      continue;
    }
    if (!gold) continue;
    const labels = new Map<string, GoldLabel>(gold.labels.map((l) => [l.imageId, l]));
    const fixtureIds = new Set(manifest.fixtures.map((f) => f.id));
    for (const l of gold.labels) if (!fixtureIds.has(l.imageId)) out.push(`gold label "${l.imageId}" has no fixture in the ${manifest.split} manifest`);
    for (const f of manifest.fixtures) {
      const l = labels.get(f.id);
      if (!l) {
        out.push(`fixture "${f.id}": no gold label (incomplete labels)`);
        continue;
      }
      if (l.imageSha256 !== f.sha256) out.push(`fixture "${f.id}": gold label was made for different bytes (hash mismatch)`);
      if ((f.stratum === "in_scope") !== (l.outcome === "single_item")) out.push(`fixture "${f.id}": stratum "${f.stratum}" disagrees with the gold outcome "${l.outcome}"`);
      if (f.stratum === "rejection" && l.rejectionReason !== f.rejectionReason) out.push(`fixture "${f.id}": gold rejection reason differs from the manifest's`);
    }
  }

  // --- predictions: known fixtures, same bytes, honest timing relative to the freeze and the labels
  const preds = input.predictions;
  if (preds) {
    const fixtures = new Map<string, { f: SingleFixture; split: Split }>();
    for (const { manifest } of input.manifests) for (const f of manifest.fixtures) fixtures.set(f.id, { f, split: manifest.split });
    const scored = new Set<Split>();
    for (const c of preds.cases) {
      const hit = fixtures.get(c.fixtureId);
      if (!hit) {
        out.push(`prediction for unknown fixture "${c.fixtureId}"`);
        continue;
      }
      scored.add(hit.split);
      if (c.imageSha256.toLowerCase() !== hit.f.sha256) out.push(`prediction for "${c.fixtureId}" was made for a different image (hash mismatch)`);
    }
    const binding = preds.run.runBinding ?? null;
    const verified = input.verifiedRun ?? null;
    if (!binding && verified) out.push("a verified run was supplied but the predictions carry no run binding");
    if (binding) {
      if (!verified) out.push("the predictions carry a run binding that was not verified against a completed run directory (pass --run-dir); a binding written into the file proves nothing");
      else if (
        verified.runId !== binding.runId ||
        verified.inputsDigest !== binding.inputsDigest ||
        verified.completionReceiptSha256 !== binding.completionReceiptSha256 ||
        verified.requestSha256 !== binding.requestSha256 ||
        verified.modelVersion !== binding.modelVersion
      )
        out.push("the verified run is not the run the predictions' binding names");
      for (const { manifest, fileSha256 } of input.manifests) {
        const bound = binding.manifests.find((m) => m.split === manifest.split);
        if (!bound) out.push(`the run binding does not name the ${manifest.split} manifest that is being scored`);
        else if (fileSha256 === null) out.push(`the ${manifest.split} manifest file digest is unknown, so the run binding cannot be checked`);
        else if (bound.fileSha256 !== fileSha256) out.push(`the run was made against a different ${manifest.split} manifest file than the one supplied`);
      }
      for (const b of binding.manifests) if (!bySplit.has(b.split)) out.push(`the run binding names a ${b.split} manifest that was not supplied`);
      if (binding.casesSha256 !== casesDigest(preds.cases)) out.push("the predictions differ from what was adapted from the run (edited or replaced after the run)");
    }
    if (scored.has("heldout")) {
      const run = preds.run;
      const frozenAt = heldout?.manifest.frozenAt ?? null;
      if (run.startedAt === null) out.push("held-out scoring needs run.startedAt (when inference started)");
      else if (frozenAt && Date.parse(run.startedAt) < Date.parse(frozenAt)) out.push("the run started before the held-out split was frozen");
      if (run.imageHashSource !== "recorded-by-run") out.push("held-out scoring needs image hashes recorded by the run, not asserted by an operator");
    }
    for (const split of scored) {
      const gold = goldBySplit.get(split);
      const startedAt = preds.run.startedAt;
      if (gold && startedAt !== null)
        for (const l of gold.labels)
          if (Date.parse(l.annotation.completedAt) > Date.parse(startedAt))
            out.push(`gold label "${l.imageId}" was completed after the run started; labels must exist before any model output`);
    }
  }
  return [...new Set(out)];
}

/** The strata of one split, counted from the manifest. */
export function strataCounts(manifest: SingleManifest, gold: GoldFile | undefined) {
  const labels = new Map((gold?.labels ?? []).map((l) => [l.imageId, l]));
  const inScope = manifest.fixtures.filter((f) => f.stratum === "in_scope");
  const rejection = manifest.fixtures.filter((f) => f.stratum === "rejection");
  const tally = <T extends string>(list: readonly T[], values: readonly T[]) => Object.fromEntries(list.map((k) => [k, values.filter((v) => v === k).length])) as Record<T, number>;
  const categories = inScope.map((f) => labels.get(f.id)?.item?.category).filter((c): c is NonNullable<typeof c> => !!c);
  return {
    inScope: inScope.length,
    rejection: rejection.length,
    byCategory: tally(GOLD_CATEGORIES, categories),
    byScene: Object.fromEntries([...new Set(inScope.map((f) => f.sceneType))].sort().map((s) => [s, inScope.filter((f) => f.sceneType === s).length])),
    byRejectionReason: Object.fromEntries([...new Set(rejection.map((f) => f.rejectionReason ?? "none"))].sort().map((s) => [s, rejection.filter((f) => (f.rejectionReason ?? "none") === s).length])),
  };
}

/** Reasons the HELD-OUT strata are too small for a launch gate. An empty list means the sample is large enough. */
export function strataProblems(heldout: SingleManifest | undefined, gold: GoldFile | undefined, policy: LaunchPolicy): string[] {
  if (!heldout || heldout.fixtures.length === 0) return ["no held-out fixtures"];
  const c = strataCounts(heldout, gold);
  const m = policy.minimums;
  const out: string[] = [];
  if (c.inScope < m.heldoutInScope) out.push(`held-out in-scope images: ${c.inScope} (policy minimum ${m.heldoutInScope})`);
  if (c.rejection < m.heldoutRejection) out.push(`held-out rejection images: ${c.rejection} (policy minimum ${m.heldoutRejection})`);
  for (const cat of GOLD_CATEGORIES) if (c.byCategory[cat] < m.perCategory) out.push(`held-out category "${cat}": ${c.byCategory[cat]} (policy minimum ${m.perCategory})`);
  for (const s of m.requiredScenes) {
    const n = (c.byScene as Record<string, number>)[s] ?? 0;
    if (n < m.perRequiredScene) out.push(`held-out scene "${s}": ${n} (policy minimum ${m.perRequiredScene})`);
  }
  for (const r of m.requiredRejectionReasons) {
    const n = (c.byRejectionReason as Record<string, number>)[r] ?? 0;
    if (n < m.perRejectionReason) out.push(`held-out rejection reason "${r}": ${n} (policy minimum ${m.perRejectionReason})`);
  }
  return out;
}
