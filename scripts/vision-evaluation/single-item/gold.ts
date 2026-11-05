import { ID_RE, SHA256_RE, expectKeys, isIsoTimestamp, isNonEmptyString, isRecord, oneOf } from "../check";
import { boxProblems } from "../geometry";
import { SPLITS, type Box, type Split } from "../types";
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
 * Human gold labels for the single-item benchmark. A label is either exactly ONE
 * prominent item or an explicit rejection/retake case. Labels are written by
 * people: an annotator that is not a human, a model-assisted label, an unknown
 * field or a missing value is refused, never defaulted.
 */

export type GoldItem = {
  category: GoldCategory;
  color: GoldColor;
  pattern: GoldPattern;
  /** "unknown" is allowed and means the photo does not show the fit; it is not scored, only checked for overclaiming. */
  fit: Fit;
  /** A visible texture, "none_visible", or "unknown" (not scored, overclaim-checked). */
  material: GoldMaterial;
  /** Box around the whole item: normalized corners [x1,y1,x2,y2] in DISPLAY (EXIF-rotated) orientation. */
  box: Box;
  /** Suggestions only: what a person would reasonably suggest. Never visible objective truth. */
  seasons: Season[];
  occasions: Occasion[];
};

export type Annotator = { id: string; kind: "human" };

export type Annotation = {
  status: "single_human" | "double_human_adjudicated";
  annotators: Annotator[];
  completedAt: string;
  /** The tool a person drew the box in (free text), or null. */
  tool: string | null;
  /** Must be false. A label a model proposed, even if a person approved it, is not gold. */
  modelAssisted: false;
  notes: string | null;
};

export type GoldLabel = {
  imageId: string;
  imageSha256: string;
  outcome: "single_item" | "reject";
  rejectionReason: RejectionReason | null;
  item: GoldItem | null;
  annotation: Annotation;
};

export type GoldFile = {
  schemaVersion: 1;
  kind: "single-item-gold";
  benchmarkId: string;
  split: Split;
  labels: GoldLabel[];
};

const FILE_KEYS = ["schemaVersion", "kind", "benchmarkId", "split", "labels"] as const;
const LABEL_KEYS = ["imageId", "imageSha256", "outcome", "rejectionReason", "item", "annotation"] as const;
const ITEM_KEYS = ["category", "color", "pattern", "fit", "material", "box", "seasons", "occasions"] as const;
const ANNOTATION_KEYS = ["status", "annotators", "completedAt", "tool", "modelAssisted", "notes"] as const;
const ANNOTATOR_KEYS = ["id", "kind"] as const;
const STATUSES = ["single_human", "double_human_adjudicated"] as const;

/** Text that suggests a model or a script produced the label. Conservative on purpose: a person can rename. */
export const MODEL_LIKE = /(^|[^a-z])(qwen|llm|gpt|claude|gemini|llama|ollama|model|ai|bot|auto|script|vlm)([^a-z]|$)/i;

function subsetProblems<T extends string>(list: readonly T[], value: unknown, at: string, max: number, out: string[]): T[] {
  if (!Array.isArray(value)) {
    out.push(`${at}: must be a list`);
    return [];
  }
  const seen = new Set<string>();
  for (const v of value) {
    if (!oneOf(list, v)) out.push(`${at}: "${String(v)}" is not one of ${list.join(", ")}`);
    else if (seen.has(v)) out.push(`${at}: "${v}" is listed twice`);
    else seen.add(v);
  }
  if (value.length > max) out.push(`${at}: at most ${max} entries`);
  return [...seen] as T[];
}

function itemOf(raw: unknown, at: string, out: string[]): GoldItem | null {
  if (!isRecord(raw)) {
    out.push(`${at}: a single_item label needs an item object`);
    return null;
  }
  const before = out.length;
  expectKeys(raw, ITEM_KEYS, at, out);
  if (!oneOf(GOLD_CATEGORIES, raw.category)) out.push(`${at}.category: must be one of ${GOLD_CATEGORIES.join(", ")}`);
  if (!oneOf(GOLD_COLORS, raw.color)) out.push(`${at}.color: must be one of ${GOLD_COLORS.join(", ")}`);
  if (!oneOf(GOLD_PATTERNS, raw.pattern)) out.push(`${at}.pattern: must be one of ${GOLD_PATTERNS.join(", ")}`);
  if (!oneOf(FITS, raw.fit)) out.push(`${at}.fit: must be one of ${FITS.join(", ")} ("unknown" is allowed)`);
  if (!oneOf(GOLD_MATERIALS, raw.material)) out.push(`${at}.material: must be one of ${GOLD_MATERIALS.join(", ")}`);
  for (const p of boxProblems(raw.box)) out.push(`${at}.box: ${p}`);
  const seasons = subsetProblems(SEASONS, raw.seasons, `${at}.seasons`, 4, out);
  const occasions = subsetProblems(OCCASIONS, raw.occasions, `${at}.occasions`, 6, out);
  if (out.length > before) return null;
  return {
    category: raw.category as GoldCategory,
    color: raw.color as GoldColor,
    pattern: raw.pattern as GoldPattern,
    fit: raw.fit as Fit,
    material: raw.material as GoldMaterial,
    box: raw.box as unknown as Box,
    seasons,
    occasions,
  };
}

function annotationOf(raw: unknown, at: string, out: string[]): Annotation | null {
  if (!isRecord(raw)) {
    out.push(`${at}: annotator provenance is required`);
    return null;
  }
  const before = out.length;
  expectKeys(raw, ANNOTATION_KEYS, at, out);
  if (!oneOf(STATUSES, raw.status)) out.push(`${at}.status: must be single_human or double_human_adjudicated (draft/unlabeled labels are refused)`);
  if (!isIsoTimestamp(raw.completedAt)) out.push(`${at}.completedAt: must be an ISO timestamp with a time zone`);
  if (raw.modelAssisted !== false) out.push(`${at}.modelAssisted: must be false; a model-assisted or model-made label cannot be gold`);
  if (raw.tool !== null && !isNonEmptyString(raw.tool)) out.push(`${at}.tool: must be null or text`);
  else if (typeof raw.tool === "string" && MODEL_LIKE.test(raw.tool)) out.push(`${at}.tool: "${raw.tool}" looks like a model or script; gold labels are made by people`);
  if (raw.notes !== null && typeof raw.notes !== "string") out.push(`${at}.notes: must be null or text`);
  else if (typeof raw.notes === "string" && /model[- ]?(made|generated|proposed)|pre-?labell?ed by/i.test(raw.notes))
    out.push(`${at}.notes: mentions a model-made label; gold labels are made by people`);
  const annotators: Annotator[] = [];
  if (!Array.isArray(raw.annotators) || raw.annotators.length === 0) out.push(`${at}.annotators: at least one human annotator is required`);
  else {
    const ids = new Set<string>();
    raw.annotators.forEach((a: unknown, i: number) => {
      const where = `${at}.annotators[${i}]`;
      if (!isRecord(a)) return void out.push(`${where}: must be an object`);
      expectKeys(a, ANNOTATOR_KEYS, where, out);
      if (a.kind !== "human") out.push(`${where}.kind: must be "human"; a model cannot be an annotator`);
      if (!isNonEmptyString(a.id)) out.push(`${where}.id: must name the person`);
      else if (MODEL_LIKE.test(a.id)) out.push(`${where}.id: "${a.id}" looks like a model or script`);
      else if (ids.has(a.id)) out.push(`${where}.id: "${a.id}" is listed twice`);
      else ids.add(a.id);
      if (a.kind === "human" && isNonEmptyString(a.id)) annotators.push({ id: a.id, kind: "human" });
    });
    if (raw.status === "double_human_adjudicated" && annotators.length < 2)
      out.push(`${at}.annotators: double_human_adjudicated needs at least two human annotators`);
  }
  if (out.length > before) return null;
  return {
    status: raw.status as Annotation["status"],
    annotators,
    completedAt: raw.completedAt as string,
    tool: (raw.tool as string | null) ?? null,
    modelAssisted: false,
    notes: (raw.notes as string | null) ?? null,
  };
}

export function validateGoldFile(doc: unknown): { file: GoldFile | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { file: null, problems: ["gold: must be a JSON object"] };
  expectKeys(doc, FILE_KEYS, "gold", problems);
  if (doc.schemaVersion !== 1) problems.push("gold: schemaVersion must be 1");
  if (doc.kind !== "single-item-gold") problems.push('gold: kind must be "single-item-gold"');
  if (typeof doc.benchmarkId !== "string" || !ID_RE.test(doc.benchmarkId)) problems.push("gold: benchmarkId is invalid");
  const split = oneOf(SPLITS, doc.split) ? doc.split : null;
  if (!split) problems.push('gold: split must be "development" or "heldout"');
  if (!Array.isArray(doc.labels)) {
    problems.push("gold: labels must be an array");
    return { file: null, problems };
  }
  const labels: GoldLabel[] = [];
  const seen = new Set<string>();
  doc.labels.forEach((raw: unknown, index: number) => {
    const at = `labels[${index}]`;
    const before = problems.length;
    if (!isRecord(raw)) return void problems.push(`${at}: must be an object`);
    expectKeys(raw, LABEL_KEYS, at, problems);
    if (typeof raw.imageId !== "string" || !ID_RE.test(raw.imageId)) problems.push(`${at}.imageId: invalid`);
    else if (seen.has(raw.imageId)) problems.push(`${at}.imageId: "${raw.imageId}" is labelled twice`);
    else seen.add(raw.imageId);
    if (typeof raw.imageSha256 !== "string" || !SHA256_RE.test(raw.imageSha256)) problems.push(`${at}.imageSha256: must be 64 hex characters`);
    if (raw.outcome !== "single_item" && raw.outcome !== "reject")
      problems.push(`${at}.outcome: must be "single_item" or "reject" (exactly one prominent item, or an explicit rejection)`);
    let item: GoldItem | null = null;
    if (raw.outcome === "single_item") {
      if (raw.rejectionReason !== null) problems.push(`${at}.rejectionReason: must be null for a single_item label`);
      item = itemOf(raw.item, `${at}.item`, problems);
    } else if (raw.outcome === "reject") {
      if (!oneOf(REJECTION_REASONS, raw.rejectionReason)) problems.push(`${at}.rejectionReason: a rejection needs one of ${REJECTION_REASONS.join(", ")}`);
      if (raw.item !== null) problems.push(`${at}.item: must be null for a rejection (no item is labelled)`);
    }
    const annotation = annotationOf(raw.annotation, `${at}.annotation`, problems);
    if (problems.length === before && annotation) {
      labels.push({
        imageId: raw.imageId as string,
        imageSha256: (raw.imageSha256 as string).toLowerCase(),
        outcome: raw.outcome as GoldLabel["outcome"],
        rejectionReason: (raw.rejectionReason as RejectionReason | null) ?? null,
        item,
        annotation,
      });
    }
  });
  if (problems.length > 0 || !split) return { file: null, problems };
  return {
    file: { schemaVersion: 1, kind: "single-item-gold", benchmarkId: doc.benchmarkId as string, split: split as Split, labels },
    problems: [],
  };
}
