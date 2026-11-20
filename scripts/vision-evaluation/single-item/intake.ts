import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { ID_RE, SHA256_RE, expectKeys, isIsoDateOrTimestamp, isIsoTimestamp, isNonEmptyString, isRecord, oneOf } from "../check";
import { EvaluationRefusal } from "../evaluate";
import { inspectImageBytes, sha256Hex } from "../image";
import { KNOWN_DEVELOPMENT_SHA256 } from "../manifest";
import type { Dimensions } from "../types";
import { Creations, bareNameProblem, readSourceFile, readWorkspaceFile, realFs, type FsOps } from "./fsx";
import {
  BACKGROUNDS,
  CAMERAS,
  LIGHTINGS,
  REJECTION_REASONS,
  RIGHTS_SOURCE_TYPES,
  SCENE_TYPES,
  STRATA,
  licenseProblems,
  type Background,
  type Camera,
  type Lighting,
  type RejectionReason,
  type RightsSourceType,
  type SceneType,
  type SingleStratum,
} from "./vocab";

/**
 * Local-only, rights-cleared photo intake for the single-item benchmark (build 026).
 *
 * The operator supplies JPEG/PNG/WebP files and, per photo, the rights evidence. Nothing is downloaded and no
 * public fashion dataset is read. Everything here fails closed: a photo with missing or unsupported rights
 * evidence, a person without a model release, an executable or oddly built file, a link, a path that escapes
 * the source directory, a file that changed while being read, a duplicate or an undeclared near-duplicate is
 * REFUSED, and a refusal never writes a partial import (the files one import call created are removed).
 *
 * Privacy: the rights holder's name lives only in the private intake record. Manifests, reports and refusal
 * messages carry a pseudonymous reference (rh-...) and counts, never a name or an original file name.
 */

export const INTAKE_TOOL = "single-intake-v1";
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
/** Shortest stored side. Below this a photo cannot honestly be called a usable wardrobe photo. */
export const MIN_SIDE = 224;
const MAX_PIXELS = 80_000_000;
/** Perceptual hash distance (of 64 bits) at or under which two photos are treated as the same picture. */
export const NEAR_DUPLICATE_BITS = 6;

export const PERSON_REF_RE = /^(op|rv)-[a-z0-9]{6,24}$/;
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,63}$/;
const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLIC_DATASETS = /deepfashion|modanet|fashionpedia|polyvore|street2shop|farfetch|zalando/i;
const NOT_A_SOURCE = /^(unknown|public[- ]?web|web|internet|scraped|found|google|pinterest|instagram|other|n\/a|none)$/i;

// ----------------------------------------------------------------------------- types

export type ModelRelease = { reference: string; signedAt: string; coversEvaluation: true };

export type IntakeRights = {
  sourceType: RightsSourceType;
  /** PRIVATE. Real name or organisation. Never copied to a manifest, a report or an error message. */
  rightsHolder: string;
  acquiredAt: string;
  /** Must be true: the holder allows this photo to be used to evaluate a model. */
  evaluationPermission: true;
  /** Whether the photo may be shared outside the project. Recorded, never assumed; held-out photos are not shared either way. */
  redistributionAllowed: boolean;
  /** A person opened THIS photo's evidence and checked it. */
  individuallyVerified: true;
  verifiedBy: string;
  verifiedAt: string;
  /** contributor-consent only */
  consent: { reference: string; signedAt: string } | null;
  /** open-license only */
  openLicense: {
    sourceCollection: "wikimedia-commons" | "open-images";
    sourcePageUrl: string;
    originalUrl: string;
    license: { id: string; version: string; url: string };
    attribution: string;
  } | null;
};

export type CaptureFacts = {
  sceneType: SceneType;
  background: Background;
  lighting: Lighting;
  camera: Camera;
  personsPresent: boolean;
  modelRelease: ModelRelease | null;
};

export type BatchEntry = {
  file: string;
  rights: IntakeRights;
  capture: CaptureFacts;
  sourceShootId: string;
  garmentId: string | null;
  stratum: SingleStratum;
  rejectionReason: RejectionReason | null;
  priorInference: false;
};

export type IntakeBatch = { schemaVersion: 1; kind: "single-item-intake-batch"; benchmarkId: string; entries: BatchEntry[] };

export type ImageSignature = { dhash: string; dhashFlipped: string; tiny: string };

export type IntakeRecord = {
  schemaVersion: 1;
  kind: "single-item-intake-record";
  benchmarkId: string;
  imageId: string;
  file: string;
  format: "jpeg" | "png" | "webp";
  bytes: number;
  sha256: string;
  dimensions: Dimensions;
  signature: ImageSignature;
  importedAt: string;
  importedBy: string;
  rights: IntakeRights;
  /** Pseudonymous reference derived from the holder with this workspace's secret salt. This, not the name, reaches manifests. */
  rightsHolderRef: string;
  capture: CaptureFacts;
  sourceShootId: string;
  garmentId: string | null;
  stratum: SingleStratum;
  rejectionReason: RejectionReason | null;
  priorInference: false;
  receipt: {
    tool: string;
    batchSha256: string;
    sourceSha256: string;
    copiedSha256: string;
    stableRead: true;
    /** Pool images this one looks like and was declared to share a shoot and garment with. */
    nearDuplicateOf: string[];
  };
};

export type Workspace = { dir: string; benchmarkId: string; salt: string; createdAt: string };

// ----------------------------------------------------------------------------- strict parsing

const RIGHTS_KEYS = ["sourceType", "rightsHolder", "acquiredAt", "evaluationPermission", "redistributionAllowed", "individuallyVerified", "verifiedBy", "verifiedAt", "consent", "openLicense"] as const;
const CONSENT_KEYS = ["reference", "signedAt"] as const;
const OPEN_KEYS = ["sourceCollection", "sourcePageUrl", "originalUrl", "license", "attribution"] as const;
const LICENSE_KEYS = ["id", "version", "url"] as const;
const CAPTURE_KEYS = ["sceneType", "background", "lighting", "camera", "personsPresent", "modelRelease"] as const;
const RELEASE_KEYS = ["reference", "signedAt", "coversEvaluation"] as const;
const ENTRY_KEYS = ["file", "rights", "capture", "sourceShootId", "garmentId", "stratum", "rejectionReason", "priorInference"] as const;
const BATCH_KEYS = ["schemaVersion", "kind", "benchmarkId", "entries"] as const;

const EARLIEST = Date.parse("1995-01-01T00:00:00Z");

function dateProblem(v: unknown, at: string, now: Date, out: string[]): void {
  if (!isIsoDateOrTimestamp(v)) return void out.push(`${at}: must be an ISO date or timestamp`);
  const t = Date.parse(v);
  if (t < EARLIEST) out.push(`${at}: is before 1995, which is not a plausible digital-photo date`);
  if (t > now.getTime() + 24 * 3600_000) out.push(`${at}: is in the future`);
}

function httpsUrl(v: unknown, at: string, out: string[]): void {
  let ok = false;
  if (typeof v === "string")
    try {
      const u = new URL(v);
      ok = u.protocol === "https:" && u.hostname !== "";
    } catch {
      ok = false;
    }
  if (!ok) out.push(`${at}: must be an https URL`);
}

/** Rights evidence for one photo. Every gap is a problem; nothing is defaulted and nothing is guessed. */
export function intakeRightsProblems(v: unknown, at: string, now: Date): { rights: IntakeRights | null; problems: string[] } {
  const out: string[] = [];
  if (!isRecord(v)) return { rights: null, problems: [`${at}: rights evidence is required for every photo`] };
  expectKeys(v, RIGHTS_KEYS, at, out);
  const type = oneOf(RIGHTS_SOURCE_TYPES, v.sourceType) ? v.sourceType : null;
  if (!type) {
    const shown = typeof v.sourceType === "string" && NOT_A_SOURCE.test(v.sourceType) ? ` ("${v.sourceType}" is not a rights source: unknown and public-web photos are refused)` : "";
    out.push(`${at}.sourceType: must be one of ${RIGHTS_SOURCE_TYPES.join(", ")}${shown}`);
  }
  if (!isNonEmptyString(v.rightsHolder)) out.push(`${at}.rightsHolder: the author or rights holder must be named (kept private)`);
  dateProblem(v.acquiredAt, `${at}.acquiredAt`, now, out);
  if (v.evaluationPermission !== true) out.push(`${at}.evaluationPermission: must be true; without permission to evaluate a model on this photo it cannot be imported`);
  if (typeof v.redistributionAllowed !== "boolean") out.push(`${at}.redistributionAllowed: must be true or false (it is recorded, never assumed)`);
  if (v.individuallyVerified !== true) out.push(`${at}.individuallyVerified: must be true; bulk or assumed rights are refused`);
  if (typeof v.verifiedBy !== "string" || !PERSON_REF_RE.test(v.verifiedBy)) out.push(`${at}.verifiedBy: must be a pseudonymous operator reference such as op-3k9x2m (letters/digits after "op-" or "rv-")`);
  dateProblem(v.verifiedAt, `${at}.verifiedAt`, now, out);
  for (const key of ["rightsHolder"] as const) {
    const t = v[key];
    if (typeof t === "string" && PUBLIC_DATASETS.test(t)) out.push(`${at}.${key}: public fashion datasets (DeepFashion, ModaNet, Fashionpedia ...) are not rights-cleared sources and must not be used`);
  }

  let consent: IntakeRights["consent"] = null;
  let open: IntakeRights["openLicense"] = null;
  if (type === "contributor-consent") {
    if (!isRecord(v.consent)) out.push(`${at}.consent: a contributor-consent photo needs its consent reference and date`);
    else {
      expectKeys(v.consent, CONSENT_KEYS, `${at}.consent`, out);
      if (typeof v.consent.reference !== "string" || !REFERENCE_RE.test(v.consent.reference)) out.push(`${at}.consent.reference: must be a reference to the consent record (3-64 characters, no spaces)`);
      dateProblem(v.consent.signedAt, `${at}.consent.signedAt`, now, out);
      if (typeof v.consent.reference === "string" && typeof v.consent.signedAt === "string") consent = { reference: v.consent.reference, signedAt: v.consent.signedAt };
    }
  } else if (v.consent !== null) out.push(`${at}.consent: must be null unless the source type is contributor-consent`);

  if (type === "open-license") {
    if (!isRecord(v.openLicense)) out.push(`${at}.openLicense: an open-license photo needs the page, file URL and licence checked for THIS photo`);
    else {
      const o = v.openLicense;
      expectKeys(o, OPEN_KEYS, `${at}.openLicense`, out);
      if (o.sourceCollection !== "wikimedia-commons" && o.sourceCollection !== "open-images") out.push(`${at}.openLicense.sourceCollection: must be wikimedia-commons or open-images`);
      httpsUrl(o.sourcePageUrl, `${at}.openLicense.sourcePageUrl`, out);
      httpsUrl(o.originalUrl, `${at}.openLicense.originalUrl`, out);
      if (!isNonEmptyString(o.attribution)) out.push(`${at}.openLicense.attribution: required`);
      for (const k of ["sourcePageUrl", "originalUrl", "attribution"] as const) if (typeof o[k] === "string" && PUBLIC_DATASETS.test(o[k] as string)) out.push(`${at}.openLicense.${k}: public fashion datasets are not rights-cleared sources`);
      if (!isRecord(o.license)) out.push(`${at}.openLicense.license: must be an object`);
      else {
        expectKeys(o.license, LICENSE_KEYS, `${at}.openLicense.license`, out);
        for (const p of licenseProblems(o.license.id, o.license.version)) out.push(`${at}.openLicense.license: ${p}`);
        httpsUrl(o.license.url, `${at}.openLicense.license.url`, out);
      }
      if (v.redistributionAllowed === false) out.push(`${at}.redistributionAllowed: an allow-listed open licence permits redistribution; false contradicts it`);
      if (out.length === 0) open = o as unknown as NonNullable<IntakeRights["openLicense"]>;
    }
  } else if (v.openLicense !== null) out.push(`${at}.openLicense: must be null unless the source type is open-license`);

  if (out.length > 0 || !type) return { rights: null, problems: out };
  return {
    rights: {
      sourceType: type,
      rightsHolder: (v.rightsHolder as string).trim(),
      acquiredAt: v.acquiredAt as string,
      evaluationPermission: true,
      redistributionAllowed: v.redistributionAllowed as boolean,
      individuallyVerified: true,
      verifiedBy: v.verifiedBy as string,
      verifiedAt: v.verifiedAt as string,
      consent,
      openLicense: open,
    },
    problems: [],
  };
}

export function captureProblems(v: unknown, at: string, now: Date): { capture: CaptureFacts | null; problems: string[] } {
  const out: string[] = [];
  if (!isRecord(v)) return { capture: null, problems: [`${at}: capture facts are required`] };
  expectKeys(v, CAPTURE_KEYS, at, out);
  if (!oneOf(SCENE_TYPES, v.sceneType)) out.push(`${at}.sceneType: must be one of ${SCENE_TYPES.join(", ")}`);
  if (!oneOf(BACKGROUNDS, v.background)) out.push(`${at}.background: must be one of ${BACKGROUNDS.join(", ")}`);
  if (!oneOf(LIGHTINGS, v.lighting)) out.push(`${at}.lighting: must be one of ${LIGHTINGS.join(", ")}`);
  if (!oneOf(CAMERAS, v.camera)) out.push(`${at}.camera: must be one of ${CAMERAS.join(", ")}`);
  if (typeof v.personsPresent !== "boolean") out.push(`${at}.personsPresent: must be true or false (a person, or part of one, is visible)`);
  let release: ModelRelease | null = null;
  if (v.personsPresent === true) {
    if (!isRecord(v.modelRelease)) out.push(`${at}.modelRelease: a photo with a person needs explicit model-release evidence; people are refused without it`);
    else {
      expectKeys(v.modelRelease, RELEASE_KEYS, `${at}.modelRelease`, out);
      if (typeof v.modelRelease.reference !== "string" || !REFERENCE_RE.test(v.modelRelease.reference)) out.push(`${at}.modelRelease.reference: must be a reference to the signed release (3-64 characters, no spaces)`);
      dateProblem(v.modelRelease.signedAt, `${at}.modelRelease.signedAt`, now, out);
      if (v.modelRelease.coversEvaluation !== true) out.push(`${at}.modelRelease.coversEvaluation: must be true; the release must cover use in model evaluation`);
      if (typeof v.modelRelease.reference === "string" && typeof v.modelRelease.signedAt === "string") release = { reference: v.modelRelease.reference, signedAt: v.modelRelease.signedAt, coversEvaluation: true };
    }
  } else if (v.modelRelease !== null && v.personsPresent === false) out.push(`${at}.modelRelease: must be null when no person is visible`);
  if (v.sceneType === "worn" && v.personsPresent === false) out.push(`${at}.personsPresent: a "worn" photo shows a person; declare it and attach the model release`);
  if (out.length > 0) return { capture: null, problems: out };
  return {
    capture: {
      sceneType: v.sceneType as SceneType,
      background: v.background as Background,
      lighting: v.lighting as Lighting,
      camera: v.camera as Camera,
      personsPresent: v.personsPresent as boolean,
      modelRelease: release,
    },
    problems: [],
  };
}

export function validateBatch(doc: unknown, now: Date): { batch: IntakeBatch | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { batch: null, problems: ["batch: must be a JSON object"] };
  expectKeys(doc, BATCH_KEYS, "batch", problems);
  if (doc.schemaVersion !== 1) problems.push("batch: schemaVersion must be 1");
  if (doc.kind !== "single-item-intake-batch") problems.push('batch: kind must be "single-item-intake-batch"');
  if (typeof doc.benchmarkId !== "string" || !ID_RE.test(doc.benchmarkId)) problems.push("batch: benchmarkId must be a lowercase id");
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
    problems.push("batch: entries must be a non-empty array");
    return { batch: null, problems };
  }
  const entries: BatchEntry[] = [];
  const files = new Set<string>();
  doc.entries.forEach((raw: unknown, i: number) => {
    const at = `entries[${i}]`;
    const before = problems.length;
    if (!isRecord(raw)) return void problems.push(`${at}: must be an object`);
    expectKeys(raw, ENTRY_KEYS, at, problems);
    const nameProblem = bareNameProblem(raw.file);
    if (nameProblem) problems.push(`${at}.file: ${nameProblem}`);
    else {
      const key = (raw.file as string).toLowerCase();
      if (!/\.(jpe?g|png|webp)$/i.test(raw.file as string)) problems.push(`${at}.file: only .jpg/.jpeg/.png/.webp files are imported`);
      if (files.has(key)) problems.push(`${at}.file: listed twice`);
      files.add(key);
    }
    const r = intakeRightsProblems(raw.rights, `${at}.rights`, now);
    problems.push(...r.problems);
    const c = captureProblems(raw.capture, `${at}.capture`, now);
    problems.push(...c.problems);
    if (typeof raw.sourceShootId !== "string" || !GROUP_RE.test(raw.sourceShootId)) problems.push(`${at}.sourceShootId: required (the shoot or session), so shoot leakage across splits can be prevented`);
    if (raw.garmentId !== null && (typeof raw.garmentId !== "string" || !GROUP_RE.test(raw.garmentId))) problems.push(`${at}.garmentId: must be null or an id`);
    const stratum = oneOf(STRATA, raw.stratum) ? raw.stratum : null;
    if (!stratum) problems.push(`${at}.stratum: must be "in_scope" or "rejection"`);
    if (stratum === "in_scope" && raw.garmentId === null) problems.push(`${at}.garmentId: required for an in-scope photo (the physical garment)`);
    if (stratum === "in_scope" && raw.rejectionReason !== null) problems.push(`${at}.rejectionReason: must be null for an in-scope photo`);
    if (stratum === "rejection" && !oneOf(REJECTION_REASONS, raw.rejectionReason)) problems.push(`${at}.rejectionReason: a rejection photo needs one of ${REJECTION_REASONS.join(", ")}`);
    if (raw.priorInference !== false) problems.push(`${at}.priorInference: must be false; a photo a model has already seen cannot enter the benchmark`);
    if (problems.length === before && r.rights && c.capture && stratum) {
      entries.push({
        file: raw.file as string,
        rights: r.rights,
        capture: c.capture,
        sourceShootId: raw.sourceShootId as string,
        garmentId: (raw.garmentId as string | null) ?? null,
        stratum,
        rejectionReason: (raw.rejectionReason as RejectionReason | null) ?? null,
        priorInference: false,
      });
    }
  });
  if (problems.length > 0) return { batch: null, problems };
  return { batch: { schemaVersion: 1, kind: "single-item-intake-batch", benchmarkId: doc.benchmarkId as string, entries }, problems: [] };
}

// ----------------------------------------------------------------------------- image safety

type Format = "jpeg" | "png" | "webp";
const EXTENSIONS: Record<Format, RegExp> = { jpeg: /\.jpe?g$/i, png: /\.png$/i, webp: /\.webp$/i };

const startsWith = (b: Buffer, sig: number[]) => sig.every((v, i) => b[i] === v);
function sniff(b: Buffer): Format | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

const EXECUTABLE_SIGNATURES: Array<{ name: string; sig: number[] }> = [
  { name: "a Windows/DOS executable", sig: [0x4d, 0x5a] },
  { name: "an ELF executable", sig: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "a script (shebang)", sig: [0x23, 0x21] },
  { name: "a zip/jar/office archive", sig: [0x50, 0x4b, 0x03, 0x04] },
  { name: "a Mach-O executable", sig: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: "a Mach-O executable", sig: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: "a Java class or universal binary", sig: [0xca, 0xfe, 0xba, 0xbe] },
  { name: "a WebAssembly module", sig: [0x00, 0x61, 0x73, 0x6d] },
  { name: "a PDF document", sig: [0x25, 0x50, 0x44, 0x46] },
  { name: "a GIF image", sig: [0x47, 0x49, 0x46, 0x38] },
];

function trailingProblem(b: Buffer, format: Format): string | null {
  const zeros = (from: number) => b.subarray(from).every((v) => v === 0);
  if (format === "jpeg") {
    const end = b.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (end < 0) return "the JPEG has no end-of-image marker (truncated)";
    return zeros(end + 2) ? null : "bytes follow the end of the JPEG (a hidden payload or a damaged file)";
  }
  if (format === "png") {
    let i = 8;
    while (i + 12 <= b.length) {
      const len = b.readUInt32BE(i);
      const type = b.toString("latin1", i + 4, i + 8);
      i += 12 + len;
      if (type === "IEND") return i <= b.length && zeros(i) ? null : "bytes follow the PNG IEND chunk (a hidden payload)";
      if (i > b.length) break;
    }
    return "the PNG has no IEND chunk (truncated)";
  }
  const riffEnd = 8 + b.readUInt32LE(4);
  if (riffEnd > b.length) return "the WebP is shorter than its header says (truncated)";
  return zeros(riffEnd) ? null : "bytes follow the end of the WebP (a hidden payload)";
}

export type ImageFacts = { format: Format; dimensions: Dimensions; signature: ImageSignature };

/** Throws an EvaluationRefusal (never echoing the file name) unless the bytes are one plain, still, decodable image. */
export async function examineImage(bytes: Buffer, fileName: string): Promise<ImageFacts> {
  const refuse = (why: string): never => {
    throw new EvaluationRefusal([`a listed source file was refused: ${why}`]);
  };
  const exe = EXECUTABLE_SIGNATURES.find((e) => startsWith(bytes, e.sig));
  if (exe) refuse(`it is ${exe.name}, not a JPEG, PNG or WebP image`);
  const format = sniff(bytes);
  if (!format) return refuse("it is not a JPEG, PNG or WebP image (the content, not the name, decides)");
  if (!EXTENSIONS[format].test(fileName)) refuse(`its extension does not match its content (${format})`);
  if (bytes.includes(Buffer.from("This program cannot be run in DOS mode"))) refuse("it contains an embedded Windows executable");
  const trailing = trailingProblem(bytes, format);
  if (trailing) refuse(trailing);
  const dimensions = inspectImageBytes(bytes);
  if (!dimensions) return refuse("its header could not be measured (damaged or unsupported)");
  if (Math.min(dimensions.width, dimensions.height) < MIN_SIDE) refuse(`its shortest side is under ${MIN_SIDE} px`);
  if (dimensions.width * dimensions.height > MAX_PIXELS) refuse("it has more than 80 megapixels");
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    return refuse("it could not be decoded as an image");
  }
  if ((meta.pages ?? 1) > 1) refuse("it is animated or multi-page");
  if (meta.format !== format) refuse("its decoded format differs from its header");
  if (meta.width !== dimensions.width || meta.height !== dimensions.height) refuse("its decoded size differs from its header");
  let signature: ImageSignature;
  try {
    signature = await signatureOf(bytes);
  } catch {
    return refuse("its pixel data is damaged and could not be decoded");
  }
  return { format, dimensions, signature };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** 64-bit difference hash (EXIF-oriented, so a rotated copy matches), its mirror image, and a 3x3 colour grid. */
export async function signatureOf(bytes: Buffer): Promise<ImageSignature> {
  const gray = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate().resize(9, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  const rowBits = (flip: boolean) => {
    const out = Buffer.alloc(8);
    for (let y = 0; y < 8; y++) {
      let byte = 0;
      for (let x = 0; x < 8; x++) {
        const a = gray[y * 9 + (flip ? 8 - x : x)];
        const b = gray[y * 9 + (flip ? 7 - x : x + 1)];
        byte = (byte << 1) | (a < b ? 1 : 0);
      }
      out[y] = byte;
    }
    return out;
  };
  const tiny = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate().resize(3, 3, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
  return { dhash: hex(rowBits(false)), dhashFlipped: hex(rowBits(true)), tiny: hex(tiny) };
}

const popcount = (n: number) => {
  let c = 0;
  for (let v = n; v; v &= v - 1) c++;
  return c;
};
function hamming(a: string, b: string): number {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  let d = 0;
  for (let i = 0; i < x.length; i++) d += popcount(x[i] ^ y[i]);
  return d;
}

/**
 * Practical near-duplicate test: close perceptual hash (also against the mirror image) AND a similar colour grid.
 * It catches re-encodes, resizes, small crops, rotations by EXIF and mirroring. It does NOT catch heavy crops,
 * different photos of the same garment, or deliberate edits; the shoot/garment groups cover those.
 */
export function nearDuplicate(a: ImageSignature, b: ImageSignature): boolean {
  const plain = hamming(a.dhash, b.dhash) <= NEAR_DUPLICATE_BITS;
  const mirrored = hamming(a.dhash, b.dhashFlipped) <= NEAR_DUPLICATE_BITS;
  if (!plain && !mirrored) return false;
  const ta = Buffer.from(a.tiny, "hex");
  const grid = (hex: string, flip: boolean) => {
    const g = Buffer.from(hex, "hex");
    if (!flip) return g;
    const out = Buffer.alloc(g.length);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) for (let c = 0; c < 3; c++) out[(y * 3 + x) * 3 + c] = g[(y * 3 + (2 - x)) * 3 + c];
    return out;
  };
  const worst = (tb: Buffer) => ta.reduce((m, v, i) => Math.max(m, Math.abs(v - tb[i])), 0);
  return (plain && worst(grid(b.tiny, false)) <= 28) || (mirrored && worst(grid(b.tiny, true)) <= 28);
}

// ----------------------------------------------------------------------------- workspace

const WORKSPACE_FILE = "workspace.json";
export const SUBDIRS = ["pool", "records", "reviews", "adjudications"] as const;
export const stableText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha = (t: string | Buffer) => sha256Hex(typeof t === "string" ? Buffer.from(t) : t);

export function initWorkspace(dir: string, benchmarkId: string, now: Date, ops: FsOps = realFs): void {
  if (!ID_RE.test(benchmarkId)) throw new EvaluationRefusal(["--benchmark-id must be a lowercase id such as single-item-v1"]);
  const made = new Creations(ops);
  try {
    made.dir(dir);
    for (const s of SUBDIRS) made.dir(path.join(dir, s));
    made.file(path.join(dir, WORKSPACE_FILE), Buffer.from(stableText({ schemaVersion: 1, kind: "single-item-intake-workspace", benchmarkId, createdAt: now.toISOString(), salt: randomBytes(32).toString("hex"), tool: INTAKE_TOOL })));
  } catch (e) {
    made.rollback();
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new EvaluationRefusal(["the workspace directory already exists; a workspace is never reused or overwritten"]);
    throw e;
  }
}

export function openWorkspace(dir: string): Workspace {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new EvaluationRefusal(["the intake workspace does not exist (create it with single-intake-init)"]);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new EvaluationRefusal(["the intake workspace is not a plain directory (links and junctions are refused)"]);
  let doc: unknown;
  try {
    doc = JSON.parse(readWorkspaceFile(path.join(dir, WORKSPACE_FILE)).toString("utf8"));
  } catch (e) {
    if (e instanceof EvaluationRefusal) throw e;
    throw new EvaluationRefusal(["workspace.json is not valid JSON"]);
  }
  if (!isRecord(doc) || doc.kind !== "single-item-intake-workspace" || typeof doc.benchmarkId !== "string" || typeof doc.salt !== "string" || !/^[0-9a-f]{64}$/.test(doc.salt) || typeof doc.createdAt !== "string")
    throw new EvaluationRefusal(["workspace.json is not an intake workspace file"]);
  for (const s of SUBDIRS) {
    let sub;
    try {
      sub = lstatSync(path.join(dir, s));
    } catch {
      throw new EvaluationRefusal([`the workspace is missing its ${s} directory`]);
    }
    if (sub.isSymbolicLink() || !sub.isDirectory()) throw new EvaluationRefusal([`the workspace ${s} entry is not a plain directory (links are refused)`]);
  }
  return { dir, benchmarkId: doc.benchmarkId, salt: doc.salt, createdAt: doc.createdAt };
}

export const rightsHolderRef = (ws: Workspace, holder: string) => `rh-${createHash("sha256").update(`${ws.salt}:${ws.benchmarkId}:${holder.trim().toLowerCase()}`).digest("hex").slice(0, 12)}`;
export const imageIdFor = (sha256: string) => `img-${sha256.slice(0, 16)}`;
export const poolFileFor = (id: string, format: Format) => `${id}.${format === "jpeg" ? "jpg" : format}`;

const RECORD_KEYS = ["schemaVersion", "kind", "benchmarkId", "imageId", "file", "format", "bytes", "sha256", "dimensions", "signature", "importedAt", "importedBy", "rights", "rightsHolderRef", "capture", "sourceShootId", "garmentId", "stratum", "rejectionReason", "priorInference", "receipt"] as const;
const RECEIPT_KEYS = ["tool", "batchSha256", "sourceSha256", "copiedSha256", "stableRead", "nearDuplicateOf"] as const;
const SIG_RE = /^[0-9a-f]{16}$/;

/** Strict reader of a stored intake record: unknown fields, edited rights and impossible values are refused. */
export function validateIntakeRecord(doc: unknown, now: Date): { record: IntakeRecord | null; problems: string[] } {
  const out: string[] = [];
  if (!isRecord(doc)) return { record: null, problems: ["record: must be an object"] };
  expectKeys(doc, RECORD_KEYS, "record", out);
  if (doc.schemaVersion !== 1 || doc.kind !== "single-item-intake-record") out.push("record: wrong schemaVersion or kind");
  if (typeof doc.benchmarkId !== "string" || !ID_RE.test(doc.benchmarkId)) out.push("record: benchmarkId is invalid");
  if (typeof doc.imageId !== "string" || !ID_RE.test(doc.imageId)) out.push("record: imageId is invalid");
  if (!oneOf(["jpeg", "png", "webp"] as const, doc.format)) out.push("record: format is invalid");
  if (typeof doc.sha256 !== "string" || !SHA256_RE.test(doc.sha256)) out.push("record: sha256 is invalid");
  else if (doc.imageId !== imageIdFor(doc.sha256.toLowerCase())) out.push("record: imageId does not match the image hash");
  if (typeof doc.file !== "string" || (doc.format && typeof doc.imageId === "string" && doc.file !== poolFileFor(doc.imageId, doc.format as Format))) out.push("record: file does not match the image id and format");
  if (!(typeof doc.bytes === "number" && Number.isInteger(doc.bytes) && doc.bytes > 0)) out.push("record: bytes is invalid");
  const dims = doc.dimensions;
  if (!isRecord(dims) || !Number.isInteger(dims.width) || !Number.isInteger(dims.height) || !Number.isInteger(dims.exifOrientation) || (dims.exifOrientation as number) < 1 || (dims.exifOrientation as number) > 8) out.push("record: dimensions are invalid");
  const sig = doc.signature;
  if (!isRecord(sig) || typeof sig.dhash !== "string" || !SIG_RE.test(sig.dhash) || typeof sig.dhashFlipped !== "string" || !SIG_RE.test(sig.dhashFlipped) || typeof sig.tiny !== "string" || !/^[0-9a-f]{54}$/.test(sig.tiny)) out.push("record: signature is invalid");
  if (!isIsoTimestamp(doc.importedAt)) out.push("record: importedAt is invalid");
  if (typeof doc.importedBy !== "string" || !PERSON_REF_RE.test(doc.importedBy)) out.push("record: importedBy is invalid");
  const r = intakeRightsProblems(doc.rights, "record.rights", now);
  out.push(...r.problems);
  const c = captureProblems(doc.capture, "record.capture", now);
  out.push(...c.problems);
  if (typeof doc.rightsHolderRef !== "string" || !/^rh-[a-f0-9]{12}$/.test(doc.rightsHolderRef)) out.push("record: rightsHolderRef is invalid");
  if (typeof doc.sourceShootId !== "string" || !GROUP_RE.test(doc.sourceShootId)) out.push("record: sourceShootId is invalid");
  if (doc.garmentId !== null && (typeof doc.garmentId !== "string" || !GROUP_RE.test(doc.garmentId))) out.push("record: garmentId is invalid");
  if (!oneOf(STRATA, doc.stratum)) out.push("record: stratum is invalid");
  if (doc.stratum === "rejection" ? !oneOf(REJECTION_REASONS, doc.rejectionReason) : doc.rejectionReason !== null) out.push("record: rejectionReason does not match the stratum");
  if (doc.stratum === "in_scope" && doc.garmentId === null) out.push("record: an in-scope photo needs a garmentId");
  if (doc.priorInference !== false) out.push("record: priorInference must be false");
  const rc = doc.receipt;
  if (!isRecord(rc)) out.push("record: receipt is missing");
  else {
    expectKeys(rc, RECEIPT_KEYS, "record.receipt", out);
    if (rc.tool !== INTAKE_TOOL) out.push("record.receipt: unknown tool");
    for (const k of ["batchSha256", "sourceSha256", "copiedSha256"] as const) if (typeof rc[k] !== "string" || !SHA256_RE.test(rc[k] as string)) out.push(`record.receipt.${k}: invalid`);
    if (rc.stableRead !== true) out.push("record.receipt.stableRead: must be true");
    if (rc.sourceSha256 !== doc.sha256 || rc.copiedSha256 !== doc.sha256) out.push("record.receipt: source and copied hashes must equal the image hash");
    if (!Array.isArray(rc.nearDuplicateOf) || !rc.nearDuplicateOf.every((x) => typeof x === "string" && ID_RE.test(x))) out.push("record.receipt.nearDuplicateOf: invalid");
  }
  if (out.length > 0) return { record: null, problems: out };
  return { record: doc as unknown as IntakeRecord, problems: [] };
}

export const recordPath = (ws: Workspace, id: string) => path.join(ws.dir, "records", `${id}.json`);
export const poolPath = (ws: Workspace, file: string) => path.join(ws.dir, "pool", file);

/** Loads every record, strictly. A damaged or hand-edited record is a refusal, not a skipped photo. */
export function loadRecords(ws: Workspace, now: Date): IntakeRecord[] {
  const names = readdirSync(path.join(ws.dir, "records")).sort();
  const out: IntakeRecord[] = [];
  const problems: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      problems.push(`records contains an unexpected file "${name.slice(0, 40)}"`);
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(readWorkspaceFile(path.join(ws.dir, "records", name)).toString("utf8"));
    } catch (e) {
      problems.push(e instanceof EvaluationRefusal ? e.message : `${name}: not valid JSON (a truncated record is never repaired)`);
      continue;
    }
    const { record, problems: p } = validateIntakeRecord(doc, now);
    if (!record) problems.push(...p.map((x) => `${name}: ${x}`));
    else if (record.benchmarkId !== ws.benchmarkId) problems.push(`${name}: belongs to another benchmark`);
    else if (`${record.imageId}.json` !== name) problems.push(`${name}: file name does not match its image id`);
    else out.push(record);
  }
  if (problems.length > 0) throw new EvaluationRefusal(problems);
  return out;
}

/** Re-hashes the pooled bytes: an image edited after import (content change) no longer matches its record. */
export function verifyPool(ws: Workspace, records: IntakeRecord[]): string[] {
  const problems: string[] = [];
  const known = new Set(records.map((r) => r.file));
  for (const name of readdirSync(path.join(ws.dir, "pool"))) if (!known.has(name)) problems.push(`pool holds "${name.slice(0, 40)}", which has no intake record (an interrupted import? delete it by hand)`);
  for (const r of records) {
    let bytes: Buffer;
    try {
      bytes = readWorkspaceFile(poolPath(ws, r.file));
    } catch {
      problems.push(`${r.imageId}: pooled image is missing or is a link`);
      continue;
    }
    if (sha256Hex(bytes) !== r.sha256) problems.push(`${r.imageId}: pooled image bytes changed after import (hash mismatch)`);
  }
  return problems;
}

// ----------------------------------------------------------------------------- seal

export type Seal = { schemaVersion: 1; kind: "single-item-intake-seal"; benchmarkId: string; sealedAt: string; planSha256: string; heldoutImageIds: string[]; developmentImageIds: string[]; heldoutManifestSha256: string };

export function readSeal(ws: Workspace): Seal | null {
  const file = path.join(ws.dir, "seal.json");
  if (!existsSync(file)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(readWorkspaceFile(file).toString("utf8"));
  } catch {
    throw new EvaluationRefusal(["seal.json is damaged; the held-out split cannot be proven sealed"]);
  }
  if (!isRecord(doc) || doc.kind !== "single-item-intake-seal" || !Array.isArray(doc.heldoutImageIds) || !Array.isArray(doc.developmentImageIds) || typeof doc.sealedAt !== "string" || typeof doc.planSha256 !== "string" || typeof doc.heldoutManifestSha256 !== "string")
    throw new EvaluationRefusal(["seal.json is not a valid seal"]);
  return doc as unknown as Seal;
}

// ----------------------------------------------------------------------------- import

export type ImportDeps = { fs?: FsOps; now: () => Date };
export type ImportResult = { imported: number; imageIds: string[]; nearDuplicateLinks: number };

function sameGroup(a: { sourceShootId: string; garmentId: string | null }, b: { sourceShootId: string; garmentId: string | null }) {
  return a.sourceShootId === b.sourceShootId && a.garmentId !== null && a.garmentId === b.garmentId;
}

/**
 * Imports one validated batch, all or nothing. Reads and examines every file first (nothing is written if any
 * is refused), then creates the pool files and records exclusively; if a write fails, everything this call
 * created is removed. The record is written last for each photo and is the commit point: a pool file without
 * a record is reported by verifyPool, never silently trusted.
 */
export async function importBatch(ws: Workspace, batchFile: string, sourceDir: string, operator: string, deps: ImportDeps): Promise<ImportResult> {
  if (!PERSON_REF_RE.test(operator) || !operator.startsWith("op-")) throw new EvaluationRefusal(["--operator must be a pseudonymous operator reference such as op-3k9x2m"]);
  const now = deps.now();
  const batchBytes = readWorkspaceFile(batchFile);
  let doc: unknown;
  try {
    doc = JSON.parse(batchBytes.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new EvaluationRefusal(["the batch file is not valid JSON"]);
  }
  const { batch, problems } = validateBatch(doc, now);
  if (!batch) throw new EvaluationRefusal(problems);
  if (batch.benchmarkId !== ws.benchmarkId) throw new EvaluationRefusal([`the batch is for benchmark "${batch.benchmarkId}", this workspace is for "${ws.benchmarkId}"`]);
  const batchSha = sha(batchBytes);

  const existing = loadRecords(ws, now);
  const poolProblems = verifyPool(ws, existing);
  if (poolProblems.length > 0) throw new EvaluationRefusal(poolProblems);
  const seal = readSeal(ws);
  const heldout = new Set(seal?.heldoutImageIds ?? []);

  type Prepared = { entry: BatchEntry; bytes: Buffer; facts: ImageFacts; sha256: string; id: string; links: string[] };
  const prepared: Prepared[] = [];
  const refusals: string[] = [];
  for (const [i, entry] of batch.entries.entries()) {
    try {
      const { bytes } = readSourceFile(sourceDir, entry.file, MAX_IMAGE_BYTES);
      const facts = await examineImage(bytes, entry.file);
      const digest = sha256Hex(bytes);
      if (KNOWN_DEVELOPMENT_SHA256.has(digest)) throw new EvaluationRefusal(["a listed source file is a known development image (a model has seen it)"]);
      prepared.push({ entry, bytes, facts, sha256: digest, id: imageIdFor(digest), links: [] });
    } catch (e) {
      if (!(e instanceof EvaluationRefusal)) throw e;
      refusals.push(...e.message.split("\n").map((m) => `entries[${i}]: ${m}`));
    }
  }
  if (refusals.length > 0) throw new EvaluationRefusal(refusals);

  // --- duplicates: exact (anywhere), near (must be a declared same shoot+garment), and never against a sealed held-out photo
  type Seen = { id: string; sha256: string; signature: ImageSignature; sourceShootId: string; garmentId: string | null; sealedHeldout: boolean };
  const seen: Seen[] = existing.map((r) => ({ id: r.imageId, sha256: r.sha256, signature: r.signature, sourceShootId: r.sourceShootId, garmentId: r.garmentId, sealedHeldout: heldout.has(r.imageId) }));
  const dupes: string[] = [];
  prepared.forEach((p, i) => {
    for (const s of seen) {
      if (s.sha256 === p.sha256) dupes.push(`entries[${i}]: the same image bytes are already imported as ${s.id}`);
      else if (nearDuplicate(p.facts.signature, s.signature)) {
        if (s.sealedHeldout) dupes.push(`entries[${i}]: looks like sealed held-out photo ${s.id} (cross-split near-duplicate)`);
        else if (!sameGroup(p.entry, s)) dupes.push(`entries[${i}]: looks like ${s.id} but does not declare the same shoot and garment; a near-duplicate must share both so the pair can never be split across development and held-out`);
        else p.links.push(s.id);
      }
      if (s.sealedHeldout && (s.sourceShootId === p.entry.sourceShootId || (p.entry.garmentId !== null && s.garmentId === p.entry.garmentId)))
        dupes.push(`entries[${i}]: shares a shoot or garment with sealed held-out photo ${s.id} (cross-split leakage); use a new benchmark version`);
    }
    seen.push({ id: p.id, sha256: p.sha256, signature: p.facts.signature, sourceShootId: p.entry.sourceShootId, garmentId: p.entry.garmentId, sealedHeldout: false });
  });
  if (dupes.length > 0) throw new EvaluationRefusal([...new Set(dupes)]);

  // --- write: pool image, then re-hash the copy, then the record (commit point)
  const made = new Creations(deps.fs ?? realFs);
  const imageIds: string[] = [];
  let links = 0;
  try {
    for (const p of prepared) {
      const file = poolFileFor(p.id, p.facts.format);
      made.file(poolPath(ws, file), p.bytes);
      const copied = sha256Hex(readWorkspaceFile(poolPath(ws, file)));
      if (copied !== p.sha256) throw new EvaluationRefusal(["a pooled copy differs from the bytes read (disk error); nothing was kept"]);
      const record: IntakeRecord = {
        schemaVersion: 1,
        kind: "single-item-intake-record",
        benchmarkId: ws.benchmarkId,
        imageId: p.id,
        file,
        format: p.facts.format,
        bytes: p.bytes.length,
        sha256: p.sha256,
        dimensions: p.facts.dimensions,
        signature: p.facts.signature,
        importedAt: now.toISOString(),
        importedBy: operator,
        rights: p.entry.rights,
        rightsHolderRef: rightsHolderRef(ws, p.entry.rights.rightsHolder),
        capture: p.entry.capture,
        sourceShootId: p.entry.sourceShootId,
        garmentId: p.entry.garmentId,
        stratum: p.entry.stratum,
        rejectionReason: p.entry.rejectionReason,
        priorInference: false,
        receipt: { tool: INTAKE_TOOL, batchSha256: batchSha, sourceSha256: p.sha256, copiedSha256: copied, stableRead: true, nearDuplicateOf: p.links.sort() },
      };
      const check = validateIntakeRecord(JSON.parse(JSON.stringify(record)), now);
      if (!check.record) throw new EvaluationRefusal(check.problems.map((x) => `refusing to store an invalid record: ${x}`));
      made.file(recordPath(ws, p.id), Buffer.from(stableText(record)));
      imageIds.push(p.id);
      links += p.links.length;
    }
  } catch (e) {
    made.rollback();
    throw e;
  }
  return { imported: imageIds.length, imageIds, nearDuplicateLinks: links };
}
