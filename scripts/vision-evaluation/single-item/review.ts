import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { ID_RE, SHA256_RE, expectKeys, isIsoTimestamp, isNonEmptyString, isRecord, oneOf } from "../check";
import { EvaluationRefusal } from "../evaluate";
import { boxProblems, iou } from "../geometry";
import type { Box } from "../types";
import { Creations, readWorkspaceFile, realFs, type FsOps } from "./fsx";
import { MODEL_LIKE, type GoldFile, type GoldLabel } from "./gold";
import { stableText, type IntakeRecord, type Workspace } from "./intake";
import { canonicalJson } from "./policy";
import {
  FITS,
  GOLD_CATEGORIES,
  GOLD_COLORS,
  GOLD_MATERIALS,
  GOLD_PATTERNS,
  OCCASIONS,
  REJECTION_REASONS,
  SEASONS,
  type Fit,
  type GoldCategory,
  type GoldColor,
  type GoldMaterial,
  type GoldPattern,
  type Occasion,
  type RejectionReason,
  type Season,
} from "./vocab";

/**
 * Human gold-label authoring and verification for the single-item benchmark (build 026).
 *
 * A held-out label needs TWO independent human reviews. Reviewers are pseudonymous (rv-...); a review records,
 * per image, the exact image hash, when the reviewer started and finished, and what they decided: item
 * presence (one item / reject / unsure), category, colour, pattern, a localisation box, readable attributes
 * (fit, material, seasons, occasions) and explicit "unknown" where the photo does not show a value. If the two
 * reviews disagree, a THIRD person adjudicates. The result is an ordinary single-item gold file that
 * validateGoldFile and the scorer accept unchanged.
 *
 * What this can and cannot prove: it refuses one reviewer posing as two, a copied review (identical boxes,
 * notes or timestamps), an adjudicator who is also a reviewer, an adjudication of images the reviewers agreed
 * on, and a label for different bytes. It cannot prove that two pseudonyms are two different people, or that
 * the reviewers did not talk; that rests on the operator's process, which the docs state.
 */

export const REVIEW_TOOL = "single-intake-review-v1";
/** Two boxes agree when their intersection over union is at least this. */
export const BOX_AGREEMENT_IOU = 0.75;
export const REVIEWER_RE = /^rv-[a-z0-9]{6,24}$/;
const SESSION_RE = /^[a-z0-9]{8,32}$/;

export type Unknowable<T extends string> = T | "unknown";
export type ReviewItem = {
  category: Unknowable<GoldCategory>;
  color: Unknowable<GoldColor>;
  pattern: Unknowable<GoldPattern>;
  fit: Fit;
  material: GoldMaterial;
  /** Normalized [x1,y1,x2,y2] in DISPLAY (EXIF-rotated) orientation around the whole item. */
  box: Box;
  seasons: Season[];
  occasions: Occasion[];
};
export type ReviewLabel = {
  imageId: string;
  imageSha256: string;
  startedAt: string;
  completedAt: string;
  /** A person (or part of one) is visible. If true the import record must declare it, with a model release. */
  personVisible: boolean;
  outcome: "single_item" | "reject" | "unsure";
  rejectionReason: RejectionReason | null;
  item: ReviewItem | null;
  notes: string | null;
};
export type ReviewFile = {
  schemaVersion: 1;
  kind: "single-item-gold-review";
  benchmarkId: string;
  role: "reviewer" | "adjudicator";
  reviewerId: string;
  sessionId: string;
  /** adjudicator only: the two reviewers whose disagreements are being resolved */
  adjudicates: [string, string] | null;
  tool: string | null;
  modelAssisted: false;
  labels: ReviewLabel[];
};

const FILE_KEYS = ["schemaVersion", "kind", "benchmarkId", "role", "reviewerId", "sessionId", "adjudicates", "tool", "modelAssisted", "labels"] as const;
const LABEL_KEYS = ["imageId", "imageSha256", "startedAt", "completedAt", "personVisible", "outcome", "rejectionReason", "item", "notes"] as const;
const ITEM_KEYS = ["category", "color", "pattern", "fit", "material", "box", "seasons", "occasions"] as const;

function subset<T extends string>(list: readonly T[], v: unknown, at: string, max: number, out: string[]): T[] {
  if (!Array.isArray(v)) {
    out.push(`${at}: must be a list`);
    return [];
  }
  const seen = new Set<string>();
  for (const x of v) {
    if (!oneOf(list, x)) out.push(`${at}: "${String(x)}" is not one of ${list.join(", ")}`);
    else if (seen.has(x)) out.push(`${at}: "${x}" is listed twice`);
    else seen.add(x);
  }
  if (v.length > max) out.push(`${at}: at most ${max} entries`);
  return [...seen] as T[];
}

/** Strict reader of a review or adjudication file against the workspace's records. Nothing is defaulted. */
export function validateReview(doc: unknown, ws: Workspace, records: ReadonlyMap<string, IntakeRecord>, now: Date): { review: ReviewFile | null; problems: string[] } {
  const out: string[] = [];
  if (!isRecord(doc)) return { review: null, problems: ["review: must be a JSON object"] };
  expectKeys(doc, FILE_KEYS, "review", out);
  if (doc.schemaVersion !== 1 || doc.kind !== "single-item-gold-review") out.push('review: schemaVersion must be 1 and kind "single-item-gold-review"');
  if (doc.benchmarkId !== ws.benchmarkId) out.push(`review: benchmarkId must be "${ws.benchmarkId}"`);
  const role = doc.role === "reviewer" || doc.role === "adjudicator" ? doc.role : null;
  if (!role) out.push('review: role must be "reviewer" or "adjudicator"');
  if (typeof doc.reviewerId !== "string" || !REVIEWER_RE.test(doc.reviewerId)) out.push("review: reviewerId must be a pseudonym such as rv-4h7q2z (never a name or an email)");
  else if (MODEL_LIKE.test(doc.reviewerId)) out.push("review: reviewerId looks like a model or script; labels are made by people");
  if (typeof doc.sessionId !== "string" || !SESSION_RE.test(doc.sessionId)) out.push("review: sessionId must be 8-32 lowercase letters/digits, unique to this person's labelling session");
  if (role === "adjudicator") {
    const a = doc.adjudicates;
    if (!Array.isArray(a) || a.length !== 2 || !a.every((x) => typeof x === "string" && REVIEWER_RE.test(x)) || new Set(a).size !== 2) out.push("review: an adjudicator names the two different reviewers whose disagreements it resolves (adjudicates)");
    else if (a.includes(doc.reviewerId as string)) out.push("review: an adjudicator cannot be one of the reviewers it adjudicates");
  } else if (doc.adjudicates !== null) out.push("review: adjudicates must be null for a reviewer");
  if (doc.modelAssisted !== false) out.push("review: modelAssisted must be false; a model-assisted label is not gold");
  if (doc.tool !== null && !isNonEmptyString(doc.tool)) out.push("review: tool must be null or text");
  else if (typeof doc.tool === "string" && MODEL_LIKE.test(doc.tool)) out.push("review: tool looks like a model or script");
  if (!Array.isArray(doc.labels)) {
    out.push("review: labels must be an array");
    return { review: null, problems: out };
  }
  const seen = new Set<string>();
  const labels: ReviewLabel[] = [];
  doc.labels.forEach((raw: unknown, i: number) => {
    const at = `labels[${i}]`;
    const before = out.length;
    if (!isRecord(raw)) return void out.push(`${at}: must be an object`);
    expectKeys(raw, LABEL_KEYS, at, out);
    const rec = typeof raw.imageId === "string" ? records.get(raw.imageId) : undefined;
    if (typeof raw.imageId !== "string" || !ID_RE.test(raw.imageId)) out.push(`${at}.imageId: invalid`);
    else if (!rec) out.push(`${at}.imageId: not an image in this workspace`);
    else if (seen.has(raw.imageId)) out.push(`${at}.imageId: labelled twice`);
    else seen.add(raw.imageId);
    if (typeof raw.imageSha256 !== "string" || !SHA256_RE.test(raw.imageSha256)) out.push(`${at}.imageSha256: must be 64 hex characters`);
    else if (rec && raw.imageSha256.toLowerCase() !== rec.sha256) out.push(`${at}.imageSha256: is not the hash of the imported bytes (labelled a different image)`);
    if (!isIsoTimestamp(raw.startedAt)) out.push(`${at}.startedAt: must be an ISO timestamp with a time zone`);
    if (!isIsoTimestamp(raw.completedAt)) out.push(`${at}.completedAt: must be an ISO timestamp with a time zone`);
    if (isIsoTimestamp(raw.startedAt) && isIsoTimestamp(raw.completedAt)) {
      const s = Date.parse(raw.startedAt);
      const c = Date.parse(raw.completedAt);
      if (!(c > s)) out.push(`${at}: completedAt must be after startedAt`);
      if (c > now.getTime() + 60_000) out.push(`${at}.completedAt: is in the future`);
      if (rec && s < Date.parse(rec.importedAt)) out.push(`${at}.startedAt: is before the photo was imported`);
    }
    if (typeof raw.personVisible !== "boolean") out.push(`${at}.personVisible: must be true or false`);
    if (raw.outcome !== "single_item" && raw.outcome !== "reject" && raw.outcome !== "unsure") out.push(`${at}.outcome: must be "single_item", "reject" or "unsure"`);
    let item: ReviewItem | null = null;
    if (raw.outcome === "single_item") {
      if (raw.rejectionReason !== null) out.push(`${at}.rejectionReason: must be null for single_item`);
      if (!isRecord(raw.item)) out.push(`${at}.item: a single_item review needs an item`);
      else {
        const it = raw.item;
        const ib = out.length;
        expectKeys(it, ITEM_KEYS, `${at}.item`, out);
        if (!oneOf([...GOLD_CATEGORIES, "unknown"] as const, it.category)) out.push(`${at}.item.category: one of ${GOLD_CATEGORIES.join(", ")}, unknown`);
        if (!oneOf([...GOLD_COLORS, "unknown"] as const, it.color)) out.push(`${at}.item.color: one of ${GOLD_COLORS.join(", ")}, unknown`);
        if (!oneOf([...GOLD_PATTERNS, "unknown"] as const, it.pattern)) out.push(`${at}.item.pattern: one of ${GOLD_PATTERNS.join(", ")}, unknown`);
        if (!oneOf(FITS, it.fit)) out.push(`${at}.item.fit: one of ${FITS.join(", ")}`);
        if (!oneOf(GOLD_MATERIALS, it.material)) out.push(`${at}.item.material: one of ${GOLD_MATERIALS.join(", ")}`);
        for (const p of boxProblems(it.box)) out.push(`${at}.item.box: ${p}`);
        const seasons = subset(SEASONS, it.seasons, `${at}.item.seasons`, 4, out);
        const occasions = subset(OCCASIONS, it.occasions, `${at}.item.occasions`, 6, out);
        if (out.length === ib) item = { category: it.category as ReviewItem["category"], color: it.color as ReviewItem["color"], pattern: it.pattern as ReviewItem["pattern"], fit: it.fit as Fit, material: it.material as GoldMaterial, box: it.box as unknown as Box, seasons, occasions };
      }
    } else if (raw.outcome === "reject") {
      if (!oneOf(REJECTION_REASONS, raw.rejectionReason)) out.push(`${at}.rejectionReason: one of ${REJECTION_REASONS.join(", ")}`);
      if (raw.item !== null) out.push(`${at}.item: must be null for a reject`);
    } else if (raw.outcome === "unsure") {
      if (raw.rejectionReason !== null || raw.item !== null) out.push(`${at}: an "unsure" review has no reason and no item`);
    }
    if (raw.notes !== null && (typeof raw.notes !== "string" || raw.notes.length > 500)) out.push(`${at}.notes: must be null or text up to 500 characters`);
    else if (typeof raw.notes === "string" && /model[- ]?(made|generated|proposed)|pre-?labell?ed by/i.test(raw.notes)) out.push(`${at}.notes: mentions a model-made label; gold labels are made by people`);
    if (out.length === before) {
      labels.push({
        imageId: raw.imageId as string,
        imageSha256: (raw.imageSha256 as string).toLowerCase(),
        startedAt: raw.startedAt as string,
        completedAt: raw.completedAt as string,
        personVisible: raw.personVisible as boolean,
        outcome: raw.outcome as ReviewLabel["outcome"],
        rejectionReason: (raw.rejectionReason as RejectionReason | null) ?? null,
        item,
        notes: (raw.notes as string | null) ?? null,
      });
    }
  });
  if (out.length > 0 || !role) return { review: null, problems: out };
  return {
    review: {
      schemaVersion: 1,
      kind: "single-item-gold-review",
      benchmarkId: ws.benchmarkId,
      role,
      reviewerId: doc.reviewerId as string,
      sessionId: doc.sessionId as string,
      adjudicates: role === "adjudicator" ? ((doc.adjudicates as string[]).slice().sort() as [string, string]) : null,
      tool: (doc.tool as string | null) ?? null,
      modelAssisted: false,
      labels,
    },
    problems: [],
  };
}

// ----------------------------------------------------------------------------- storage

const dirFor = (ws: Workspace, role: ReviewFile["role"]) => path.join(ws.dir, role === "reviewer" ? "reviews" : "adjudications");
export const reviewPath = (ws: Workspace, role: ReviewFile["role"], reviewerId: string) => path.join(dirFor(ws, role), `${reviewerId}.json`);

export function loadReview(ws: Workspace, role: ReviewFile["role"], reviewerId: string, records: ReadonlyMap<string, IntakeRecord>, now: Date): ReviewFile {
  if (!REVIEWER_RE.test(reviewerId)) throw new EvaluationRefusal([`"${reviewerId.slice(0, 30)}" is not a reviewer pseudonym (rv-...)`]);
  const file = reviewPath(ws, role, reviewerId);
  if (!existsSync(file)) throw new EvaluationRefusal([`no ${role} file is stored for ${reviewerId}`]);
  let doc: unknown;
  try {
    doc = JSON.parse(readWorkspaceFile(file).toString("utf8"));
  } catch (e) {
    throw e instanceof EvaluationRefusal ? e : new EvaluationRefusal([`${reviewerId}: stored review is not valid JSON`]);
  }
  const { review, problems } = validateReview(doc, ws, records, now);
  if (!review) throw new EvaluationRefusal(problems.map((p) => `${reviewerId}: ${p}`));
  if (review.reviewerId !== reviewerId || review.role !== role) throw new EvaluationRefusal([`${reviewerId}: the stored file names another reviewer or role`]);
  return review;
}

/** Stores a validated review exclusively. A reviewer id (in any role) is used once; a stored review is never replaced. */
export function submitReview(ws: Workspace, review: ReviewFile, ops: FsOps = realFs): void {
  const clash = (["reviewer", "adjudicator"] as const).find((r) => existsSync(reviewPath(ws, r, review.reviewerId)));
  if (clash) throw new EvaluationRefusal([`${review.reviewerId} already has a stored ${clash} file; a review is never replaced (use a new reviewer pseudonym for a re-review)`]);
  const sessions = new Set<string>();
  for (const role of ["reviewer", "adjudicator"] as const)
    for (const name of readdirSync(dirFor(ws, role)))
      if (name.endsWith(".json")) {
        try {
          const d = JSON.parse(readWorkspaceFile(path.join(dirFor(ws, role), name)).toString("utf8")) as { sessionId?: unknown };
          if (typeof d.sessionId === "string") sessions.add(d.sessionId);
        } catch {
          /* a damaged file is caught when it is verified */
        }
      }
  if (sessions.has(review.sessionId)) throw new EvaluationRefusal(["this sessionId is already used by another stored review; every person and sitting needs its own"]);
  const made = new Creations(ops);
  try {
    made.file(reviewPath(ws, review.role, review.reviewerId), Buffer.from(stableText(review)));
  } catch (e) {
    made.rollback();
    throw e;
  }
}

// ----------------------------------------------------------------------------- comparison

export type FieldName = "personVisible" | "outcome" | "rejectionReason" | "category" | "color" | "pattern" | "fit" | "material" | "box";

export function disagreements(a: ReviewLabel, b: ReviewLabel): FieldName[] {
  const out: FieldName[] = [];
  if (a.personVisible !== b.personVisible) out.push("personVisible");
  if (a.outcome !== b.outcome) out.push("outcome");
  if (a.rejectionReason !== b.rejectionReason) out.push("rejectionReason");
  if (a.item && b.item) {
    for (const f of ["category", "color", "pattern", "fit", "material"] as const) if (a.item[f] !== b.item[f]) out.push(f);
    if (iou(a.item.box, b.item.box) < BOX_AGREEMENT_IOU) out.push("box");
  }
  return out;
}

const boxIsCoarse = (b: Box) => b.every((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9);

/** Reasons two reviews cannot be treated as independent. Empty means nothing suspicious was found (not a proof). */
export function independenceProblems(a: ReviewFile, b: ReviewFile): string[] {
  const out: string[] = [];
  if (a.reviewerId.toLowerCase() === b.reviewerId.toLowerCase()) out.push("the two reviews are by the same reviewer; one person cannot satisfy both");
  if (a.sessionId === b.sessionId) out.push("the two reviews share a sessionId; they are one sitting");
  if (canonicalJson(a.labels.map(({ startedAt: _s, completedAt: _c, ...rest }) => rest)) === canonicalJson(b.labels.map(({ startedAt: _s, completedAt: _c, ...rest }) => rest)) && a.labels.length > 0)
    out.push("the two reviews have identical content in every field (a copied review)");
  const bById = new Map(b.labels.map((l) => [l.imageId, l]));
  let pairs = 0;
  let sameBox = 0;
  let sameNotes = 0;
  let sameTimes = 0;
  for (const la of a.labels) {
    const lb = bById.get(la.imageId);
    if (!lb) continue;
    pairs++;
    if (la.item && lb.item && !boxIsCoarse(la.item.box) && la.item.box.every((n, i) => n === (lb.item as ReviewItem).box[i])) sameBox++;
    if (la.notes !== null && la.notes === lb.notes) sameNotes++;
    if (la.startedAt === lb.startedAt && la.completedAt === lb.completedAt) sameTimes++;
  }
  if (pairs >= 3 && sameBox / pairs > 0.1) out.push(`${sameBox} of ${pairs} jointly reviewed images have exactly identical boxes to full precision (independent boxes are never identical): suspected copying`);
  if (sameNotes >= 2) out.push(`${sameNotes} images carry identical free-text notes in both reviews: suspected copying`);
  if (pairs >= 3 && sameTimes / pairs > 0.1) out.push(`${sameTimes} of ${pairs} images have identical start and finish times in both reviews: suspected copying`);
  return out;
}

// ----------------------------------------------------------------------------- resolution

export type FinalReason =
  | "needs-adjudication"
  | "unsure"
  | "unknown-core-attribute"
  | "undeclared-person"
  | "conflicts-with-import-declaration"
  | "not-reviewed-twice";

export type FinalLabel = {
  imageId: string;
  label: GoldLabel;
  /** Two independent human reviews (agreed or adjudicated), versus a single review. */
  doubleReviewed: boolean;
};
export type Resolution = { finals: Map<string, FinalLabel>; excluded: Map<string, FinalReason>; adjudicated: number; agreed: number; problems: string[] };

const mean = (a: Box, b: Box): Box => a.map((n, i) => Math.round(((n + b[i]) / 2) * 1e6) / 1e6) as unknown as Box;
const intersect = <T extends string>(a: readonly T[], b: readonly T[]) => a.filter((x) => b.includes(x));

function goldFrom(imageId: string, rec: IntakeRecord, r: ReviewLabel, item: ReviewItem | null, annotators: string[], completedAt: string, status: GoldLabel["annotation"]["status"], notes: string): GoldLabel {
  return {
    imageId,
    imageSha256: rec.sha256,
    outcome: r.outcome === "single_item" ? "single_item" : "reject",
    rejectionReason: r.outcome === "reject" ? r.rejectionReason : null,
    item:
      r.outcome === "single_item" && item
        ? { category: item.category as GoldCategory, color: item.color as GoldColor, pattern: item.pattern as GoldPattern, fit: item.fit, material: item.material, box: item.box, seasons: item.seasons, occasions: item.occasions }
        : null,
    annotation: { status, annotators: annotators.map((id) => ({ id, kind: "human" as const })), completedAt, tool: REVIEW_TOOL, modelAssisted: false, notes },
  };
}

/**
 * Turns the stored reviews into final gold labels. With `allowSingleReview` an image with one review becomes a
 * single_human label (development only; the caller must never use those for held-out). Every refusal that is
 * about the files themselves (not about one image) is returned in `problems` and must stop the build.
 */
export function resolveLabels(records: IntakeRecord[], a: ReviewFile | null, b: ReviewFile | null, adj: ReviewFile | null, opts: { allowSingleReview: boolean }): Resolution {
  const problems: string[] = [];
  const finals = new Map<string, FinalLabel>();
  const excluded = new Map<string, FinalReason>();
  let adjudicated = 0;
  let agreed = 0;
  if (a && b) problems.push(...independenceProblems(a, b));
  if (adj) {
    if (!a || !b) problems.push("an adjudication needs both reviews");
    else {
      if (adj.reviewerId === a.reviewerId || adj.reviewerId === b.reviewerId) problems.push("the adjudicator is one of the reviewers");
      if (adj.sessionId === a.sessionId || adj.sessionId === b.sessionId) problems.push("the adjudicator shares a sessionId with a reviewer");
      const named = new Set(adj.adjudicates ?? []);
      if (!named.has(a.reviewerId) || !named.has(b.reviewerId)) problems.push("the adjudication names different reviewers than the two reviews supplied");
    }
  }
  if (problems.length > 0) return { finals, excluded, adjudicated, agreed, problems };
  const byA = new Map((a?.labels ?? []).map((l) => [l.imageId, l]));
  const byB = new Map((b?.labels ?? []).map((l) => [l.imageId, l]));
  const byAdj = new Map((adj?.labels ?? []).map((l) => [l.imageId, l]));
  for (const rec of records) {
    const la = byA.get(rec.imageId);
    const lb = byB.get(rec.imageId);
    const lj = byAdj.get(rec.imageId);
    const single = la && !lb ? la : lb && !la ? lb : null;
    if (!la && !lb) continue;
    let chosen: ReviewLabel;
    let item: ReviewItem | null;
    let annotators: string[];
    let completedAt: string;
    let notes: string;
    let double = false;
    if (single) {
      if (lj) problems.push(`${rec.imageId}: adjudicated although only one reviewer labelled it`);
      if (!opts.allowSingleReview) {
        excluded.set(rec.imageId, "not-reviewed-twice");
        continue;
      }
      chosen = single;
      item = single.item;
      annotators = [(la ? a : b)?.reviewerId as string];
      completedAt = single.completedAt;
      notes = "single review (development only)";
    } else {
      const x = la as ReviewLabel;
      const y = lb as ReviewLabel;
      double = true;
      const diff = disagreements(x, y);
      if (diff.length === 0) {
        if (lj) problems.push(`${rec.imageId}: the adjudicator labelled an image the reviewers agreed on; an agreement is never overridden`);
        agreed++;
        chosen = x;
        item = x.item && y.item ? { ...x.item, box: mean(x.item.box, y.item.box), seasons: intersect(x.item.seasons, y.item.seasons), occasions: intersect(x.item.occasions, y.item.occasions) } : null;
        annotators = [a?.reviewerId as string, b?.reviewerId as string];
        completedAt = x.completedAt > y.completedAt ? x.completedAt : y.completedAt;
        notes = "two independent reviews agreed";
      } else {
        if (!lj) {
          excluded.set(rec.imageId, "needs-adjudication");
          continue;
        }
        if (Date.parse(lj.completedAt) < Math.max(Date.parse(x.completedAt), Date.parse(y.completedAt))) problems.push(`${rec.imageId}: the adjudication was completed before one of the reviews`);
        adjudicated++;
        chosen = lj;
        item = lj.item;
        annotators = [a?.reviewerId as string, b?.reviewerId as string, adj?.reviewerId as string];
        completedAt = lj.completedAt;
        notes = `two independent reviews disagreed on ${diff.join(", ")}; resolved by a third person`;
      }
    }
    // the reviewer's own sight of a person must match what the import declared
    const sawPerson = [la, lb, lj].some((l) => l?.personVisible);
    if (sawPerson && !rec.capture.personsPresent) {
      excluded.set(rec.imageId, "undeclared-person");
      continue;
    }
    if (chosen.outcome === "unsure") {
      excluded.set(rec.imageId, "unsure");
      continue;
    }
    if (chosen.outcome === "single_item" && item && (item.category === "unknown" || item.color === "unknown" || item.pattern === "unknown")) {
      excluded.set(rec.imageId, "unknown-core-attribute");
      continue;
    }
    if ((chosen.outcome === "single_item") !== (rec.stratum === "in_scope") || (rec.stratum === "rejection" && chosen.rejectionReason !== rec.rejectionReason)) {
      excluded.set(rec.imageId, "conflicts-with-import-declaration");
      continue;
    }
    finals.set(rec.imageId, { imageId: rec.imageId, label: goldFrom(rec.imageId, rec, chosen, item, annotators, completedAt, double ? "double_human_adjudicated" : "single_human", notes), doubleReviewed: double });
  }
  return { finals, excluded, adjudicated, agreed, problems };
}

/** The gold file for one split, built from final labels and validated by the caller with validateGoldFile. */
export function goldFile(benchmarkId: string, split: "development" | "heldout", labels: GoldLabel[]): GoldFile {
  return { schemaVersion: 1, kind: "single-item-gold", benchmarkId, split, labels: labels.slice().sort((p, q) => (p.imageId < q.imageId ? -1 : 1)) };
}

// ----------------------------------------------------------------------------- templates

const orderKey = (reviewerId: string, imageId: string) => createHash("sha256").update(`${reviewerId}:${imageId}`).digest("hex");

/**
 * A blank review for one reviewer: image ids and exact hashes, in an order that differs per reviewer, with every
 * decision left as a placeholder so the file fails validation until a person fills it in. For an adjudicator only
 * the images the two reviews disagree on are listed, with the disagreeing fields in the notes.
 */
export function reviewTemplate(ws: Workspace, records: IntakeRecord[], reviewerId: string, adjudication: { a: ReviewFile; b: ReviewFile } | null): unknown {
  const TODO = (w: string) => `REPLACE-${w}`;
  const wanted = adjudication
    ? records.filter((r) => {
        const x = adjudication.a.labels.find((l) => l.imageId === r.imageId);
        const y = adjudication.b.labels.find((l) => l.imageId === r.imageId);
        return x && y && disagreements(x, y).length > 0;
      })
    : records;
  return {
    schemaVersion: 1,
    kind: "single-item-gold-review",
    benchmarkId: ws.benchmarkId,
    role: adjudication ? "adjudicator" : "reviewer",
    reviewerId,
    sessionId: TODO("8-32-lowercase-letters-or-digits-unique-to-this-sitting"),
    adjudicates: adjudication ? [adjudication.a.reviewerId, adjudication.b.reviewerId].sort() : null,
    tool: null,
    modelAssisted: false,
    labels: wanted
      .slice()
      .sort((p, q) => (orderKey(reviewerId, p.imageId) < orderKey(reviewerId, q.imageId) ? -1 : 1))
      .map((r) => {
        const x = adjudication?.a.labels.find((l) => l.imageId === r.imageId);
        const y = adjudication?.b.labels.find((l) => l.imageId === r.imageId);
        return {
          imageId: r.imageId,
          imageSha256: r.sha256,
          startedAt: TODO("iso-timestamp-when-you-opened-the-photo"),
          completedAt: TODO("iso-timestamp-when-you-finished"),
          personVisible: TODO("true-or-false"),
          outcome: TODO("single_item|reject|unsure"),
          rejectionReason: null,
          item: null,
          notes: x && y ? `reviewers disagree on: ${disagreements(x, y).join(", ")}` : null,
        };
      }),
  };
}
