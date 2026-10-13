import {
  ID_RE,
  SHA256_RE,
  expectKeys,
  isIsoTimestamp,
  isNonEmptyString,
  isRecord,
  oneOf,
} from "./check";
import { boxProblems } from "./geometry";
import type { Fixture, Manifest } from "./manifest";
import { CATEGORIES, SPLITS, MAX_ITEMS_PER_CASE, type Box, type Category, type Split } from "./types";

/**
 * Human gold labels. This module only validates labels that a person wrote; it
 * never creates, guesses or completes one. Brand, size and material are not
 * fields: nothing here, and nothing a model returns, can score them.
 */

export const VISIBILITY = ["fully_visible", "partially_occluded", "heavily_occluded"] as const;
export type Visibility = (typeof VISIBILITY)[number];

/** Only the last two statuses are gold. "draft" is for work in progress; model-made labels are never gold. */
export const LABEL_STATUS = ["unlabeled", "draft", "single_human", "double_human_adjudicated"] as const;
export type LabelStatus = (typeof LABEL_STATUS)[number];
const GOLD_STATUS: readonly LabelStatus[] = ["single_human", "double_human_adjudicated"];

export type Annotator = { id: string; kind: "human" | "model" };
export type GoldAttributes = { color: string | null; pattern: string | null };

export type GoldGarment = {
  id: string;
  category: Category;
  box: Box;
  visibility: Visibility;
  /** True when the garment continues past the photo edge. */
  truncatedByFrame: boolean;
  /** null = no human labelled attributes for this garment; it is then never scored on them. */
  attributes: GoldAttributes | null;
};

export type FixtureAnnotation = {
  fixtureId: string;
  sha256: string;
  split: Split;
  labelStatus: LabelStatus;
  annotators: Annotator[];
  completedAt: string | null;
  /** true: a human states no garment is visible. false: garments follow. null: not labelled yet. */
  emptyTruth: boolean | null;
  garments: GoldGarment[];
  notes: string | null;
};

export type AnnotationFile = {
  schemaVersion: 1;
  kind: "annotations";
  split: Split;
  annotations: FixtureAnnotation[];
};

const FILE_KEYS = ["schemaVersion", "kind", "split", "annotations"] as const;
const RECORD_KEYS = [
  "fixtureId",
  "sha256",
  "split",
  "labelStatus",
  "annotators",
  "completedAt",
  "emptyTruth",
  "garments",
  "notes",
] as const;
const GARMENT_KEYS = ["id", "category", "box", "visibility", "truncatedByFrame", "attributes"] as const;

export function validateAnnotationFile(doc: unknown): { file: AnnotationFile | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { file: null, problems: ["annotations: must be a JSON object"] };
  expectKeys(doc, FILE_KEYS, "annotations", problems);
  if (doc.schemaVersion !== 1) problems.push("annotations: schemaVersion must be 1");
  if (doc.kind !== "annotations") problems.push('annotations: kind must be "annotations"');
  const rawSplit = doc.split;
  const split = oneOf(SPLITS, rawSplit) ? rawSplit : null;
  if (!split) problems.push('annotations: split must be "development" or "heldout"');
  const rawList = doc.annotations;
  if (!Array.isArray(rawList)) {
    problems.push("annotations: annotations must be an array");
    return { file: null, problems };
  }

  const records: FixtureAnnotation[] = [];
  rawList.forEach((raw: unknown, index: number) => {
    const at = `annotations[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${at}: must be an object`);
      return;
    }
    expectKeys(raw, RECORD_KEYS, at, problems);
    if (typeof raw.fixtureId !== "string" || !ID_RE.test(raw.fixtureId)) problems.push(`${at}.fixtureId: invalid id`);
    const sha = typeof raw.sha256 === "string" && SHA256_RE.test(raw.sha256) ? raw.sha256.toLowerCase() : null;
    if (!sha) problems.push(`${at}.sha256: must be 64 hex characters`);
    const recSplit = oneOf(SPLITS, raw.split) ? raw.split : null;
    if (!recSplit) problems.push(`${at}.split: must be "development" or "heldout"`);
    else if (split && recSplit !== split) problems.push(`${at}.split: "${recSplit}" differs from the file split "${split}"`);
    const status = oneOf(LABEL_STATUS, raw.labelStatus) ? raw.labelStatus : null;
    if (!status) problems.push(`${at}.labelStatus: must be one of ${LABEL_STATUS.join(", ")}`);

    const annotators: Annotator[] = [];
    if (!Array.isArray(raw.annotators)) problems.push(`${at}.annotators: must be an array`);
    else
      raw.annotators.forEach((a: unknown, i: number) => {
        const aAt = `${at}.annotators[${i}]`;
        if (!isRecord(a)) return void problems.push(`${aAt}: must be an object`);
        expectKeys(a, ["id", "kind"], aAt, problems);
        if (!isNonEmptyString(a.id)) problems.push(`${aAt}.id: required`);
        const kind = a.kind;
        if (kind !== "human" && kind !== "model") problems.push(`${aAt}.kind: "human" or "model"`);
        else if (isNonEmptyString(a.id)) annotators.push({ id: a.id, kind });
      });
    if (new Set(annotators.map((a) => a.id)).size !== annotators.length)
      problems.push(`${at}.annotators: duplicate annotator id`);

    if (raw.completedAt !== null && !isIsoTimestamp(raw.completedAt))
      problems.push(`${at}.completedAt: must be null or an ISO timestamp`);
    if (raw.emptyTruth !== null && typeof raw.emptyTruth !== "boolean")
      problems.push(`${at}.emptyTruth: must be true, false or null`);
    if (raw.notes !== null && !isNonEmptyString(raw.notes)) problems.push(`${at}.notes: must be null or text`);

    const garments: GoldGarment[] = [];
    if (!Array.isArray(raw.garments)) problems.push(`${at}.garments: must be an array`);
    else {
      if (raw.garments.length > MAX_ITEMS_PER_CASE) problems.push(`${at}.garments: more than ${MAX_ITEMS_PER_CASE}`);
      const gIds = new Set<string>();
      raw.garments.forEach((g: unknown, i: number) => {
        const gAt = `${at}.garments[${i}]`;
        if (!isRecord(g)) return void problems.push(`${gAt}: must be an object`);
        expectKeys(g, GARMENT_KEYS, gAt, problems);
        if (typeof g.id !== "string" || !ID_RE.test(g.id)) problems.push(`${gAt}.id: invalid id`);
        else if (gIds.has(g.id)) problems.push(`${gAt}.id: duplicate garment id "${g.id}"`);
        else gIds.add(g.id);
        if (!oneOf(CATEGORIES, g.category)) problems.push(`${gAt}.category: must be one of ${CATEGORIES.join(", ")}`);
        for (const p of boxProblems(g.box)) problems.push(`${gAt}.${p}`);
        if (!oneOf(VISIBILITY, g.visibility)) problems.push(`${gAt}.visibility: must be one of ${VISIBILITY.join(", ")}`);
        if (typeof g.truncatedByFrame !== "boolean") problems.push(`${gAt}.truncatedByFrame: must be true or false`);
        let attributes: GoldAttributes | null = null;
        if (g.attributes !== null) {
          if (!isRecord(g.attributes)) problems.push(`${gAt}.attributes: must be null or an object`);
          else {
            expectKeys(g.attributes, ["color", "pattern"], `${gAt}.attributes`, problems);
            for (const k of ["color", "pattern"] as const)
              if (g.attributes[k] !== null && !isNonEmptyString(g.attributes[k]))
                problems.push(`${gAt}.attributes.${k}: must be null or text`);
            attributes = {
              color: isNonEmptyString(g.attributes.color) ? g.attributes.color : null,
              pattern: isNonEmptyString(g.attributes.pattern) ? g.attributes.pattern : null,
            };
          }
        }
        if (oneOf(CATEGORIES, g.category) && oneOf(VISIBILITY, g.visibility) && typeof g.id === "string")
          garments.push({
            id: g.id,
            category: g.category,
            box: g.box as Box,
            visibility: g.visibility,
            truncatedByFrame: g.truncatedByFrame === true,
            attributes,
          });
      });
    }

    // Internal consistency of the label itself.
    const isGold = status !== null && GOLD_STATUS.includes(status);
    if (raw.emptyTruth === true && garments.length > 0)
      problems.push(`${at}: emptyTruth is true but garments are listed`);
    if (raw.emptyTruth === false && garments.length === 0)
      problems.push(`${at}: emptyTruth is false but no garment is listed`);
    if (status === "unlabeled" && (garments.length > 0 || raw.emptyTruth !== null))
      problems.push(`${at}: an unlabeled record must have emptyTruth null and no garments`);
    if (isGold) {
      if (raw.emptyTruth === null) problems.push(`${at}: gold status needs an explicit emptyTruth (true or false)`);
      if (raw.completedAt === null) problems.push(`${at}: gold status needs completedAt`);
      const needed = status === "double_human_adjudicated" ? 2 : 1;
      if (annotators.length < needed) problems.push(`${at}: ${status} needs at least ${needed} annotator(s)`);
    }

    records.push({
      fixtureId: String(raw.fixtureId),
      sha256: sha ?? "",
      split: recSplit ?? "development",
      labelStatus: status ?? "unlabeled",
      annotators,
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
      emptyTruth: typeof raw.emptyTruth === "boolean" ? raw.emptyTruth : null,
      garments,
      notes: typeof raw.notes === "string" ? raw.notes : null,
    });
  });

  if (problems.length > 0 || !split) return { file: null, problems };
  return { file: { schemaVersion: 1, kind: "annotations", split, annotations: records }, problems };
}

/** A record may be scored only if a human wrote it: gold status, no model annotator. */
export function goldProblems(a: FixtureAnnotation): string[] {
  const out: string[] = [];
  if (!GOLD_STATUS.includes(a.labelStatus))
    out.push(`fixture "${a.fixtureId}": labelStatus "${a.labelStatus}" is not gold (needs single_human or double_human_adjudicated)`);
  if (a.annotators.some((x) => x.kind !== "human"))
    out.push(`fixture "${a.fixtureId}": model-made labels cannot be gold; every annotator must be human`);
  if (a.emptyTruth === null) out.push(`fixture "${a.fixtureId}": emptyTruth is not set`);
  return out;
}

/** Everything that must hold between one manifest and its annotation file before scoring. */
export function annotationProblemsForManifest(file: AnnotationFile, manifest: Manifest): string[] {
  const out: string[] = [];
  if (file.split !== manifest.split)
    out.push(`annotation file split "${file.split}" does not match manifest split "${manifest.split}"`);
  const byId = new Map<string, FixtureAnnotation>();
  for (const a of file.annotations) {
    if (byId.has(a.fixtureId)) out.push(`fixture "${a.fixtureId}": annotated twice`);
    byId.set(a.fixtureId, a);
  }
  const known = new Set(manifest.fixtures.map((f) => f.id));
  for (const id of byId.keys())
    if (!known.has(id)) out.push(`annotation for "${id}" has no fixture in the ${manifest.split} manifest`);
  for (const f of manifest.fixtures) {
    const a = byId.get(f.id);
    if (!a) {
      out.push(`fixture "${f.id}": no gold annotation (${manifest.split})`);
      continue;
    }
    if (a.sha256 !== f.sha256) out.push(`fixture "${f.id}": annotation sha256 differs from the manifest's immutable hash`);
    out.push(...goldProblems(a));
    out.push(...stratumProblems(f, a));
  }
  return out;
}

function stratumProblems(f: Fixture, a: FixtureAnnotation): string[] {
  if (f.stratum === null) return [`fixture "${f.id}": stratum is not set in the manifest`];
  if (f.stratum === "single_item" && a.garments.length !== 1)
    return [`fixture "${f.id}": stratum single_item but ${a.garments.length} gold garments`];
  if (f.stratum === "crowded" && a.garments.length < 2)
    return [`fixture "${f.id}": stratum crowded but ${a.garments.length} gold garment(s)`];
  if (f.stratum === "no_garment" && a.emptyTruth !== true)
    return [`fixture "${f.id}": stratum no_garment but emptyTruth is not true`];
  return [];
}
