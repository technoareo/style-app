import {
  FILE_RE,
  ID_RE,
  SHA256_RE,
  expectKeys,
  isIsoDateOrTimestamp,
  isIsoTimestamp,
  isNonEmptyString,
  isRecord,
  oneOf,
} from "../check";
import { SPLITS, type Dimensions, type Split } from "../types";
import {
  REJECTION_REASONS,
  SCENE_TYPES,
  SOURCE_COLLECTIONS,
  STRATA,
  licenseProblems,
  type RejectionReason,
  type SceneType,
  type SingleStratum,
  type SourceCollection,
} from "./vocab";

/**
 * Versioned single-item benchmark manifest (build 024). It is a NEW schema
 * ("single-item-manifest"); the build 014 "fixture-manifest" is untouched and
 * keeps scoring the crowded harness. The manifest is what gets frozen BEFORE any
 * model sees an image: it fixes the bytes (hash, dimensions), the split, the
 * leakage groups and the rights evidence. Human labels live in a separate gold
 * file and may never be produced by a model.
 */

export type LicenseEvidence = { id: string; version: string; url: string };

export type RightsEvidence = {
  sourceCollection: SourceCollection;
  /** The page a person opened to check the file and its licence. */
  sourcePageUrl: string;
  /** The file URL the bytes were downloaded from. */
  originalUrl: string;
  creator: string;
  license: LicenseEvidence;
  retrievedAt: string;
  attribution: string;
  /** What was done to the downloaded file. An empty list means the bytes are exactly the original. */
  modifications: string[];
  originalSha256: string;
  distributedSha256: string;
  /** Who opened the source page and read the licence for THIS file. A name, not proof; the harness does not fetch the page. */
  verifiedBy: string;
  verifiedAt: string;
};

export type SingleFixture = {
  id: string;
  file: string;
  /** Lowercase hex of the exact bytes scored. Immutable: a changed image is a new fixture. */
  sha256: string;
  dimensions: Dimensions;
  /** CLAIM: when the fixture was added to this manifest. Checked not to be after the freeze; not independently provable. */
  addedAt: string;
  sceneType: SceneType;
  stratum: SingleStratum;
  /** Required for a rejection fixture, null for an in-scope one. Human-decided, never a model's answer. */
  rejectionReason: RejectionReason | null;
  /** Same photo shoot / uploader session. A shoot must never span splits. */
  sourceShootId: string;
  /** Same physical garment or product. A garment must never span splits (null only when no garment is shown). */
  garmentId: string | null;
  /**
   * CLAIM by the person who built the manifest: no model has ever been run on
   * these bytes (or a near copy). The harness checks it is false for held-out and
   * that the hash is not a known development image; it cannot prove it.
   */
  priorInference: boolean;
  priorInferenceNote: string | null;
  rights: RightsEvidence;
  notes: string | null;
};

export type SingleManifest = {
  schemaVersion: 1;
  kind: "single-item-manifest";
  benchmarkId: string;
  split: Split;
  /** Set by single-freeze at the moment it runs (the operator never types it). Required for a held-out manifest that lists fixtures. The freeze receipt, not this field, proves the file has not changed since. */
  frozenAt: string | null;
  purpose: string;
  fixtures: SingleFixture[];
};

const MANIFEST_KEYS = ["schemaVersion", "kind", "benchmarkId", "split", "frozenAt", "purpose", "fixtures"] as const;
const FIXTURE_KEYS = [
  "id",
  "file",
  "sha256",
  "dimensions",
  "addedAt",
  "sceneType",
  "stratum",
  "rejectionReason",
  "sourceShootId",
  "garmentId",
  "priorInference",
  "priorInferenceNote",
  "rights",
  "notes",
] as const;
const RIGHTS_KEYS = [
  "sourceCollection",
  "sourcePageUrl",
  "originalUrl",
  "creator",
  "license",
  "retrievedAt",
  "attribution",
  "modifications",
  "originalSha256",
  "distributedSha256",
  "verifiedBy",
  "verifiedAt",
] as const;
const LICENSE_KEYS = ["id", "version", "url"] as const;
const DIMENSION_KEYS = ["width", "height", "exifOrientation"] as const;

const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BLOCKED_SOURCE = /deepfashion/i;

function httpsUrlProblem(v: unknown, at: string, out: string[]): void {
  if (typeof v !== "string") return void out.push(`${at}: must be an https URL`);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return void out.push(`${at}: must be an https URL`);
  }
  if (url.protocol !== "https:" || url.hostname === "") out.push(`${at}: must be an https URL`);
}

function dimensionsOf(v: unknown, at: string, out: string[]): Dimensions | null {
  if (!isRecord(v)) {
    out.push(`${at}: measured dimensions are required (use the inspect command); null is refused`);
    return null;
  }
  expectKeys(v, DIMENSION_KEYS, at, out);
  const dim = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 100000;
  const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 8;
  if (!dim(v.width)) out.push(`${at}.width: must be a positive integer`);
  if (!dim(v.height)) out.push(`${at}.height: must be a positive integer`);
  if (!ok(v.exifOrientation)) out.push(`${at}.exifOrientation: must be an integer 1..8`);
  return dim(v.width) && dim(v.height) && ok(v.exifOrientation)
    ? { width: v.width as number, height: v.height as number, exifOrientation: v.exifOrientation as number }
    : null;
}

/** Rights evidence is checked field by field and fails closed: any gap or unsupported licence is a problem. */
export function rightsProblems(v: unknown, at: string, sha256: string | null): { rights: RightsEvidence | null; problems: string[] } {
  const out: string[] = [];
  if (!isRecord(v)) return { rights: null, problems: [`${at}: rights evidence is required`] };
  expectKeys(v, RIGHTS_KEYS, at, out);
  if (!oneOf(SOURCE_COLLECTIONS, v.sourceCollection))
    out.push(`${at}.sourceCollection: must be one of ${SOURCE_COLLECTIONS.join(", ")}`);
  httpsUrlProblem(v.sourcePageUrl, `${at}.sourcePageUrl`, out);
  httpsUrlProblem(v.originalUrl, `${at}.originalUrl`, out);
  for (const key of ["sourceCollection", "sourcePageUrl", "originalUrl", "creator", "attribution"] as const) {
    const value = v[key];
    if (typeof value === "string" && BLOCKED_SOURCE.test(value))
      out.push(`${at}.${key}: DeepFashion is non-commercial and must not be used`);
  }
  if (!isNonEmptyString(v.creator)) out.push(`${at}.creator: must be a non-empty string`);
  if (!isNonEmptyString(v.attribution)) out.push(`${at}.attribution: must be a non-empty string`);
  if (!isNonEmptyString(v.verifiedBy)) out.push(`${at}.verifiedBy: the person who checked the rights must be named`);
  if (!isIsoDateOrTimestamp(v.retrievedAt)) out.push(`${at}.retrievedAt: must be an ISO date or timestamp`);
  if (!isIsoDateOrTimestamp(v.verifiedAt)) out.push(`${at}.verifiedAt: must be an ISO date or timestamp`);
  let license: LicenseEvidence | null = null;
  if (!isRecord(v.license)) out.push(`${at}.license: must be an object`);
  else {
    expectKeys(v.license, LICENSE_KEYS, `${at}.license`, out);
    for (const p of licenseProblems(v.license.id, v.license.version)) out.push(`${at}.license: ${p}`);
    httpsUrlProblem(v.license.url, `${at}.license.url`, out);
    if (typeof v.license.id === "string" && BLOCKED_SOURCE.test(v.license.id)) out.push(`${at}.license: DeepFashion is non-commercial and must not be used`);
    if (typeof v.license.id === "string" && typeof v.license.version === "string" && typeof v.license.url === "string")
      license = { id: v.license.id, version: v.license.version, url: v.license.url };
  }
  let modifications: string[] | null = null;
  if (!Array.isArray(v.modifications) || !v.modifications.every(isNonEmptyString))
    out.push(`${at}.modifications: must be a list of non-empty strings (an empty list means the bytes are the original)`);
  else modifications = v.modifications as string[];
  if (typeof v.originalSha256 !== "string" || !SHA256_RE.test(v.originalSha256))
    out.push(`${at}.originalSha256: must be 64 hex characters`);
  if (typeof v.distributedSha256 !== "string" || !SHA256_RE.test(v.distributedSha256))
    out.push(`${at}.distributedSha256: must be 64 hex characters`);
  if (typeof v.distributedSha256 === "string" && sha256 && v.distributedSha256.toLowerCase() !== sha256)
    out.push(`${at}.distributedSha256: differs from the fixture sha256`);
  if (
    modifications &&
    modifications.length === 0 &&
    typeof v.originalSha256 === "string" &&
    sha256 &&
    v.originalSha256.toLowerCase() !== sha256
  )
    out.push(`${at}.originalSha256: no modification is declared, so the original must have the fixture sha256`);
  if (out.length > 0) return { rights: null, problems: out };
  return {
    rights: {
      sourceCollection: v.sourceCollection as SourceCollection,
      sourcePageUrl: v.sourcePageUrl as string,
      originalUrl: v.originalUrl as string,
      creator: v.creator as string,
      license: license as LicenseEvidence,
      retrievedAt: v.retrievedAt as string,
      attribution: v.attribution as string,
      modifications: modifications as string[],
      originalSha256: (v.originalSha256 as string).toLowerCase(),
      distributedSha256: (v.distributedSha256 as string).toLowerCase(),
      verifiedBy: v.verifiedBy as string,
      verifiedAt: v.verifiedAt as string,
    },
    problems: [],
  };
}

export function validateSingleManifest(doc: unknown): { manifest: SingleManifest | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { manifest: null, problems: ["manifest: must be a JSON object"] };
  expectKeys(doc, MANIFEST_KEYS, "manifest", problems);
  if (doc.schemaVersion !== 1) problems.push("manifest: schemaVersion must be 1");
  if (doc.kind !== "single-item-manifest") problems.push('manifest: kind must be "single-item-manifest"');
  if (typeof doc.benchmarkId !== "string" || !ID_RE.test(doc.benchmarkId))
    problems.push("manifest: benchmarkId must be a lowercase id such as single-item-v1");
  const split = oneOf(SPLITS, doc.split) ? doc.split : null;
  if (!split) problems.push('manifest: split must be "development" or "heldout"');
  const frozen = doc.frozenAt;
  if (frozen !== null && !isIsoTimestamp(frozen)) problems.push("manifest: frozenAt must be null or an ISO timestamp with a time zone");
  if (!isNonEmptyString(doc.purpose)) problems.push("manifest: purpose must be a non-empty string");
  if (!Array.isArray(doc.fixtures)) {
    problems.push("manifest: fixtures must be an array");
    return { manifest: null, problems };
  }
  if (split === "heldout" && doc.fixtures.length > 0 && frozen === null)
    problems.push("manifest: a held-out manifest with fixtures needs frozenAt (freeze it before any inference)");

  const fixtures: SingleFixture[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const seenHashes = new Set<string>();
  doc.fixtures.forEach((raw: unknown, index: number) => {
    const at = `fixtures[${index}]`;
    const before = problems.length;
    if (!isRecord(raw)) return void problems.push(`${at}: must be an object`);
    expectKeys(raw, FIXTURE_KEYS, at, problems);
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) problems.push(`${at}.id: must match ${ID_RE}`);
    else if (seenIds.has(raw.id)) problems.push(`${at}.id: duplicate id "${raw.id}"`);
    else seenIds.add(raw.id);
    if (typeof raw.file !== "string" || !FILE_RE.test(raw.file)) problems.push(`${at}.file: must be a bare file name`);
    else if (seenFiles.has(raw.file)) problems.push(`${at}.file: duplicate file "${raw.file}"`);
    else seenFiles.add(raw.file);
    let sha: string | null = null;
    if (typeof raw.sha256 !== "string" || !SHA256_RE.test(raw.sha256)) problems.push(`${at}.sha256: must be 64 hex characters`);
    else {
      sha = raw.sha256.toLowerCase();
      if (seenHashes.has(sha)) problems.push(`${at}.sha256: the same image appears twice in this manifest`);
      seenHashes.add(sha);
    }
    const dims = dimensionsOf(raw.dimensions, `${at}.dimensions`, problems);
    if (!isIsoTimestamp(raw.addedAt)) problems.push(`${at}.addedAt: must be an ISO timestamp with a time zone`);
    else if (typeof frozen === "string" && isIsoTimestamp(frozen) && Date.parse(raw.addedAt) > Date.parse(frozen))
      problems.push(`${at}.addedAt: added after the freeze; a post-freeze image is contamination, make a new benchmark version`);
    if (!oneOf(SCENE_TYPES, raw.sceneType)) problems.push(`${at}.sceneType: must be one of ${SCENE_TYPES.join(", ")}`);
    const stratum = oneOf(STRATA, raw.stratum) ? raw.stratum : null;
    if (!stratum) problems.push(`${at}.stratum: must be "in_scope" or "rejection" (a person decides; null is refused)`);
    if (stratum === "rejection") {
      if (!oneOf(REJECTION_REASONS, raw.rejectionReason))
        problems.push(`${at}.rejectionReason: a rejection fixture needs one of ${REJECTION_REASONS.join(", ")}`);
    } else if (stratum === "in_scope" && raw.rejectionReason !== null) problems.push(`${at}.rejectionReason: must be null for an in-scope fixture`);
    if (typeof raw.sourceShootId !== "string" || !GROUP_RE.test(raw.sourceShootId))
      problems.push(`${at}.sourceShootId: required, so shoot leakage across splits can be detected`);
    if (raw.garmentId === null) {
      if (stratum === "in_scope") problems.push(`${at}.garmentId: required for an in-scope fixture (the physical garment or product)`);
    } else if (typeof raw.garmentId !== "string" || !GROUP_RE.test(raw.garmentId)) problems.push(`${at}.garmentId: must be null or an id`);
    if (typeof raw.priorInference !== "boolean") problems.push(`${at}.priorInference: must be true or false`);
    else if (raw.priorInference && split === "heldout") problems.push(`${at}.priorInference: a held-out fixture that a model has seen is contaminated`);
    if (raw.priorInferenceNote !== null && !isNonEmptyString(raw.priorInferenceNote)) problems.push(`${at}.priorInferenceNote: must be null or text`);
    const { rights, problems: rp } = rightsProblems(raw.rights, `${at}.rights`, sha);
    problems.push(...rp);
    if (raw.notes !== null && typeof raw.notes !== "string") problems.push(`${at}.notes: must be null or text`);
    if (problems.length === before && sha && dims && rights && stratum) {
      fixtures.push({
        id: raw.id as string,
        file: raw.file as string,
        sha256: sha,
        dimensions: dims,
        addedAt: raw.addedAt as string,
        sceneType: raw.sceneType as SceneType,
        stratum,
        rejectionReason: (raw.rejectionReason as RejectionReason | null) ?? null,
        sourceShootId: raw.sourceShootId as string,
        garmentId: (raw.garmentId as string | null) ?? null,
        priorInference: raw.priorInference as boolean,
        priorInferenceNote: (raw.priorInferenceNote as string | null) ?? null,
        rights,
        notes: (raw.notes as string | null) ?? null,
      });
    }
  });
  if (problems.length > 0 || !split) return { manifest: null, problems };
  return {
    manifest: {
      schemaVersion: 1,
      kind: "single-item-manifest",
      benchmarkId: doc.benchmarkId as string,
      split: split as Split,
      frozenAt: (frozen as string | null) ?? null,
      purpose: doc.purpose as string,
      fixtures,
    },
    problems: [],
  };
}

/** Receipt written by the freeze command: the hash of the frozen manifest file. */
export type FreezeReceipt = {
  schemaVersion: 1;
  kind: "single-item-freeze-receipt";
  benchmarkId: string;
  split: Split;
  frozenAt: string;
  manifestSha256: string;
  fixtureCount: number;
};
const RECEIPT_KEYS = ["schemaVersion", "kind", "benchmarkId", "split", "frozenAt", "manifestSha256", "fixtureCount"] as const;

export function validateFreezeReceipt(doc: unknown): { receipt: FreezeReceipt | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { receipt: null, problems: ["receipt: must be a JSON object"] };
  expectKeys(doc, RECEIPT_KEYS, "receipt", problems);
  if (doc.schemaVersion !== 1) problems.push("receipt: schemaVersion must be 1");
  if (doc.kind !== "single-item-freeze-receipt") problems.push('receipt: kind must be "single-item-freeze-receipt"');
  if (typeof doc.benchmarkId !== "string" || !ID_RE.test(doc.benchmarkId)) problems.push("receipt: benchmarkId is invalid");
  if (!oneOf(SPLITS, doc.split)) problems.push("receipt: split is invalid");
  if (!isIsoTimestamp(doc.frozenAt)) problems.push("receipt: frozenAt must be an ISO timestamp");
  if (typeof doc.manifestSha256 !== "string" || !SHA256_RE.test(doc.manifestSha256)) problems.push("receipt: manifestSha256 must be 64 hex characters");
  if (!(typeof doc.fixtureCount === "number" && Number.isInteger(doc.fixtureCount) && doc.fixtureCount >= 0)) problems.push("receipt: fixtureCount is invalid");
  if (problems.length > 0) return { receipt: null, problems };
  return {
    receipt: {
      schemaVersion: 1,
      kind: "single-item-freeze-receipt",
      benchmarkId: doc.benchmarkId as string,
      split: doc.split as Split,
      frozenAt: doc.frozenAt as string,
      manifestSha256: (doc.manifestSha256 as string).toLowerCase(),
      fixtureCount: doc.fixtureCount as number,
    },
    problems: [],
  };
}
