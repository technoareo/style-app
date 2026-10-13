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
} from "./check";
import { SPLITS, STRATA, type Dimensions, type Split, type Stratum } from "./types";

/**
 * SHA-256 of images that some model has ALREADY been run on (public record in
 * docs/verification). They are development-only forever; a held-out manifest
 * that lists one is refused. Add any later fixture the moment a model has seen
 * it. This list and the manifest's priorInference / splitFrozenAt values are
 * SELF-REPORTED provenance: the harness cannot independently prove an image was
 * never inferred or when a split was fixed, only refuse inconsistencies.
 */
export const KNOWN_DEVELOPMENT_SHA256: ReadonlySet<string> = new Set(
  [
    "71E077AB678B3B692E579D8CD9423D03967816E5F62919F071C0554F8B0F05D0", // natural-closet.jpg
    "A77EDBE5C3DF0C4A0D220376AA9EE886F4EE7460556C52BEFB0CA20CFA482D0F", // handmade-shoes.jpg
    "96813508705454BC3454298C03D5C2FCFFDA1899EFFCF92E810CC27D06BD7AF7", // handbag.jpg
    // Measured by root (build 014) for the earlier public smoke fixtures:
    "533022322A8A986840CCC0B12F7CF3C18C216A824A4232B927558EE02F7C5A39", // public-shirt.jpg
    "7BF2BDCF116AE5E22517F3165A576F156204794CA83E6C200779AD624019967B", // public-hoodie.jpg
    "2A74DC6022DE2AC8739A58395D450558207CE4CAA3F114759DB2198C46076FC9", // two-garments.jpg
  ].map((h) => h.toLowerCase()),
);

export type FixtureSource = {
  url: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  retrievedAt: string;
};

export type Fixture = {
  id: string;
  file: string;
  /** Lowercase hex. The fixture is IMMUTABLE: a changed image is a new fixture with a new id. */
  sha256: string;
  /** null until measured with `inspect`; scoring refuses a null. */
  originalDimensions: Dimensions | null;
  source: FixtureSource;
  /** null until a human decides; scoring refuses a null. */
  stratum: Stratum | null;
  /** True when any model has already been run on this image. */
  priorInference: boolean;
  notes: string | null;
};

export type Manifest = {
  schemaVersion: 1;
  kind: "fixture-manifest";
  split: Split;
  /** When the split was fixed. Required for a held-out manifest that lists fixtures. */
  splitFrozenAt: string | null;
  purpose: string;
  fixtures: Fixture[];
};

const MANIFEST_KEYS = ["schemaVersion", "kind", "split", "splitFrozenAt", "purpose", "fixtures"] as const;
const FIXTURE_KEYS = [
  "id",
  "file",
  "sha256",
  "originalDimensions",
  "source",
  "stratum",
  "priorInference",
  "notes",
] as const;
const SOURCE_KEYS = ["url", "author", "license", "licenseUrl", "retrievedAt"] as const;
const DIMENSION_KEYS = ["width", "height", "exifOrientation"] as const;

function dimensionProblems(v: unknown, at: string, out: string[]): Dimensions | null {
  if (v === null) return null;
  if (!isRecord(v)) {
    out.push(`${at}: must be null or an object`);
    return null;
  }
  expectKeys(v, DIMENSION_KEYS, at, out);
  const { width, height, exifOrientation } = v;
  const dim = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 100000;
  if (!dim(width)) out.push(`${at}.width: must be a positive integer`);
  if (!dim(height)) out.push(`${at}.height: must be a positive integer`);
  if (!(typeof exifOrientation === "number" && Number.isInteger(exifOrientation) && exifOrientation >= 1 && exifOrientation <= 8))
    out.push(`${at}.exifOrientation: must be an integer 1..8`);
  return dim(width) && dim(height) && typeof exifOrientation === "number"
    ? { width: width as number, height: height as number, exifOrientation }
    : null;
}

export function validateManifest(doc: unknown): { manifest: Manifest | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { manifest: null, problems: ["manifest: must be a JSON object"] };
  expectKeys(doc, MANIFEST_KEYS, "manifest", problems);
  if (doc.schemaVersion !== 1) problems.push("manifest: schemaVersion must be 1");
  if (doc.kind !== "fixture-manifest") problems.push('manifest: kind must be "fixture-manifest"');
  const rawSplit = doc.split;
  const split = oneOf(SPLITS, rawSplit) ? rawSplit : null;
  if (!split) problems.push('manifest: split must be "development" or "heldout"');
  const frozen = doc.splitFrozenAt;
  if (frozen !== null && !isIsoTimestamp(frozen))
    problems.push("manifest: splitFrozenAt must be null or an ISO timestamp with a time zone");
  if (!isNonEmptyString(doc.purpose)) problems.push("manifest: purpose must be a non-empty string");
  const rawFixtures = doc.fixtures;
  if (!Array.isArray(rawFixtures)) {
    problems.push("manifest: fixtures must be an array");
    return { manifest: null, problems };
  }
  if (split === "heldout" && rawFixtures.length > 0 && frozen === null)
    problems.push("manifest: a held-out manifest with fixtures needs splitFrozenAt (when the split was fixed, before inference)");

  const fixtures: Fixture[] = [];
  const ids = new Set<string>();
  const files = new Set<string>();
  const hashes = new Set<string>();
  rawFixtures.forEach((raw: unknown, index: number) => {
    const at = `fixtures[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${at}: must be an object`);
      return;
    }
    expectKeys(raw, FIXTURE_KEYS, at, problems);
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id))
      problems.push(`${at}.id: must match ${ID_RE}`);
    else if (ids.has(raw.id)) problems.push(`${at}.id: duplicate fixture id "${raw.id}"`);
    else ids.add(raw.id);
    if (typeof raw.file !== "string" || !FILE_RE.test(raw.file))
      problems.push(`${at}.file: must be a bare file name`);
    else if (files.has(raw.file)) problems.push(`${at}.file: duplicate file "${raw.file}"`);
    else files.add(raw.file);
    const sha = typeof raw.sha256 === "string" && SHA256_RE.test(raw.sha256) ? raw.sha256.toLowerCase() : null;
    if (!sha) problems.push(`${at}.sha256: must be 64 hex characters`);
    else if (hashes.has(sha)) problems.push(`${at}.sha256: the same image is listed twice`);
    else hashes.add(sha);
    const dims = dimensionProblems(raw.originalDimensions, `${at}.originalDimensions`, problems);

    const src = raw.source;
    let source: FixtureSource = { url: "", author: "", license: "", licenseUrl: null, retrievedAt: "" };
    if (!isRecord(src)) problems.push(`${at}.source: must be an object`);
    else {
      expectKeys(src, SOURCE_KEYS, `${at}.source`, problems);
      if (typeof src.url !== "string" || !/^https:\/\/\S+$/.test(src.url))
        problems.push(`${at}.source.url: must be an https URL`);
      if (!isNonEmptyString(src.author)) problems.push(`${at}.source.author: required`);
      if (!isNonEmptyString(src.license)) problems.push(`${at}.source.license: required`);
      if (src.licenseUrl !== null && !(typeof src.licenseUrl === "string" && /^https:\/\/\S+$/.test(src.licenseUrl)))
        problems.push(`${at}.source.licenseUrl: must be null or an https URL`);
      if (!isIsoDateOrTimestamp(src.retrievedAt)) problems.push(`${at}.source.retrievedAt: must be an ISO date`);
      source = {
        url: String(src.url),
        author: String(src.author),
        license: String(src.license),
        licenseUrl: typeof src.licenseUrl === "string" ? src.licenseUrl : null,
        retrievedAt: String(src.retrievedAt),
      };
    }

    const rawStratum = raw.stratum;
    if (rawStratum !== null && !oneOf(STRATA, rawStratum))
      problems.push(`${at}.stratum: must be null or one of ${STRATA.join(", ")}`);
    if (typeof raw.priorInference !== "boolean") problems.push(`${at}.priorInference: must be true or false`);
    if (raw.notes !== null && !isNonEmptyString(raw.notes)) problems.push(`${at}.notes: must be null or text`);

    if (split === "heldout") {
      if (raw.priorInference === true)
        problems.push(`${at}: a held-out fixture cannot have priorInference true (it was already seen by a model)`);
      if (sha && KNOWN_DEVELOPMENT_SHA256.has(sha))
        problems.push(`${at}: sha256 is a known development image and cannot be held-out`);
    }

    fixtures.push({
      id: String(raw.id),
      file: String(raw.file),
      sha256: sha ?? "",
      originalDimensions: dims,
      source,
      stratum: oneOf(STRATA, rawStratum) ? rawStratum : null,
      priorInference: raw.priorInference === true,
      notes: typeof raw.notes === "string" ? raw.notes : null,
    });
  });

  if (problems.length > 0 || !split) return { manifest: null, problems };
  return {
    manifest: {
      schemaVersion: 1,
      kind: "fixture-manifest",
      split,
      splitFrozenAt: typeof frozen === "string" ? frozen : null,
      purpose: String(doc.purpose),
      fixtures,
    },
    problems,
  };
}

/** Problems that only appear when several manifests are used together. */
export function crossManifestProblems(manifests: readonly Manifest[]): string[] {
  const out: string[] = [];
  const seenSplit = new Set<Split>();
  const idOwner = new Map<string, Split>();
  const hashOwner = new Map<string, Split>();
  for (const m of manifests) {
    if (seenSplit.has(m.split)) out.push(`two ${m.split} manifests were supplied; give at most one per split`);
    seenSplit.add(m.split);
    for (const f of m.fixtures) {
      const idSeen = idOwner.get(f.id);
      if (idSeen) out.push(`fixture id "${f.id}" appears in both the ${idSeen} and ${m.split} manifests`);
      else idOwner.set(f.id, m.split);
      const hashSeen = hashOwner.get(f.sha256);
      if (hashSeen)
        out.push(
          `fixture "${f.id}": the same image (sha256) is listed in the ${hashSeen} manifest too; ${hashSeen === m.split ? "duplicate" : "development and held-out are contaminated"}`,
        );
      else hashOwner.set(f.sha256, m.split);
    }
  }
  return out;
}
