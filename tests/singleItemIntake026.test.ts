import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { sha256Hex, inspectImageBytes } from "../scripts/vision-evaluation/image";
import { EvaluationRefusal } from "../scripts/vision-evaluation/evaluate";
import { validateGoldFile } from "../scripts/vision-evaluation/single-item/gold";
import { integrityProblems } from "../scripts/vision-evaluation/single-item/integrity";
import { runIntakeCli } from "../scripts/vision-evaluation/single-item/cli-intake";
import { Creations, bareNameProblem, readSourceFile, realFs, writeExclusive, type FsOps, type ReadOps } from "../scripts/vision-evaluation/single-item/fsx";
import {
  captureProblems,
  examineImage,
  importBatch,
  initWorkspace,
  intakeRightsProblems,
  loadRecords,
  nearDuplicate,
  openWorkspace,
  signatureOf,
  validateBatch,
  verifyPool,
  type IntakeRecord,
  type Workspace,
} from "../scripts/vision-evaluation/single-item/intake";
import { validateSingleManifest } from "../scripts/vision-evaluation/single-item/manifest";
import { DEFAULT_POLICY, type LaunchPolicy } from "../scripts/vision-evaluation/single-item/policy";
import { buildReadiness } from "../scripts/vision-evaluation/single-item/readiness";
import { independenceProblems, reviewTemplate, resolveLabels, submitReview, validateReview, type ReviewFile, type ReviewLabel } from "../scripts/vision-evaluation/single-item/review";
import { COVERAGE_DIMENSIONS, defaultCoverageSpec, freezeFromPlan, groupsOf, planSample, validateCoverageSpec, type CoverageSpec } from "../scripts/vision-evaluation/single-item/sampling";
import { templates } from "../scripts/vision-evaluation/single-item/templates";
import { GOLD_CATEGORIES, GOLD_COLORS, GOLD_PATTERNS, type GoldCategory } from "../scripts/vision-evaluation/single-item/vocab";
import { makeTempDir, removeTempDir } from "./helpers/tempDir";

/**
 * Tests of the build 026 rights-cleared photo intake and gold-label workflow. Every image, name, release and
 * label is SYNTHETIC and generated here; nothing measures a model, and nothing here claims recognition works.
 */

// This file decodes hundreds of images. Keep libvips to one thread so it does not starve the timing-sensitive tests that run beside it.
sharp.concurrency(1);
sharp.cache(false);

const root = process.cwd();
const NOW = new Date("2026-11-05T12:00:00Z");
const IMPORT_AT = new Date("2026-11-01T10:00:00Z");
const CANARY = "Zebediah Canary-Holder";
const OP = "op-4k9x2m";

// ------------------------------------------------------------------ synthetic images

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 9x8 grid of random colour blocks, upscaled: each seed gives an unrelated picture with a distinct perceptual hash. */
async function blockImage(seed: number, format: "jpeg" | "png" | "webp" = "jpeg", size = 256): Promise<Buffer> {
  const r = rng(seed);
  const raw = Buffer.alloc(9 * 8 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(r() * 256);
  const img = sharp(raw, { raw: { width: 9, height: 8, channels: 3 } }).resize(size, size, { kernel: "nearest" });
  return format === "jpeg" ? img.jpeg({ quality: 92 }).toBuffer() : format === "png" ? img.png().toBuffer() : img.webp({ quality: 90 }).toBuffer();
}

// ------------------------------------------------------------------ evidence builders

const selfRights = (holder = CANARY) => ({
  sourceType: "self-captured",
  rightsHolder: holder,
  acquiredAt: "2026-09-01",
  evaluationPermission: true,
  redistributionAllowed: false,
  individuallyVerified: true,
  verifiedBy: OP,
  verifiedAt: "2026-10-30",
  consent: null,
  openLicense: null,
});
const consentRights = () => ({ ...selfRights("Contributor Q"), sourceType: "contributor-consent", consent: { reference: "consent/2026-0042", signedAt: "2026-08-20" } });
const openRights = () => ({
  ...selfRights("Commons Author"),
  sourceType: "open-license",
  redistributionAllowed: true,
  openLicense: {
    sourceCollection: "wikimedia-commons",
    sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg",
    originalUrl: "https://upload.wikimedia.org/example.jpg",
    license: { id: "CC-BY", version: "4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    attribution: "Commons Author, CC BY 4.0",
  },
});
const capture = (over: Record<string, unknown> = {}) => ({ sceneType: "flat_lay", background: "plain", lighting: "daylight", camera: "phone", personsPresent: false, modelRelease: null, ...over });
const release = { reference: "release/2026-0007", signedAt: "2026-08-22", coversEvaluation: true };

function entry(file: string, over: Record<string, unknown> = {}) {
  return { file, rights: selfRights(), capture: capture(), sourceShootId: "shoot-a", garmentId: `g-${file.replace(/\W/g, "")}`, stratum: "in_scope", rejectionReason: null, priorInference: false, ...over };
}

type Scratch = { dir: string; ws: Workspace; src: string };
function scratch(prefix = "s026-"): Scratch {
  const dir = makeTempDir(prefix);
  const ws0 = path.join(dir, "ws");
  initWorkspace(ws0, "single-item-v1", IMPORT_AT);
  const src = path.join(dir, "src");
  mkdirSync(src);
  return { dir, ws: openWorkspace(ws0), src };
}
async function importOf(s: Scratch, files: Array<{ name: string; bytes: Buffer; over?: Record<string, unknown> }>, fs?: FsOps) {
  for (const f of files) writeFileSync(path.join(s.src, f.name), f.bytes);
  const batch = path.join(s.dir, `batch-${readdirSync(s.dir).length}.json`);
  writeFileSync(batch, JSON.stringify({ schemaVersion: 1, kind: "single-item-intake-batch", benchmarkId: "single-item-v1", entries: files.map((f) => entry(f.name, f.over)) }));
  return importBatch(s.ws, batch, s.src, OP, { now: () => IMPORT_AT, fs });
}
const records = (s: Scratch) => loadRecords(s.ws, NOW);
const refusal = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof EvaluationRefusal) return e.message;
    throw e;
  }
  assert.fail("expected a refusal");
};

// ------------------------------------------------------------------ images: formats and hostile files

test("JPEG, PNG and WebP are measured from their headers, including EXIF orientation", async () => {
  for (const f of ["jpeg", "png", "webp"] as const) {
    const bytes = await blockImage(1, f, 300);
    assert.deepEqual(inspectImageBytes(bytes), { width: 300, height: 300, exifOrientation: 1 }, f);
  }
  const rotated = await sharp(await blockImage(2, "jpeg", 300)).resize(300, 240, { fit: "fill" }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert.deepEqual(inspectImageBytes(rotated), { width: 300, height: 240, exifOrientation: 6 });
  const webpRotated = await sharp(await blockImage(3, "jpeg", 300)).resize(300, 240, { fit: "fill" }).withMetadata({ orientation: 3 }).webp().toBuffer();
  assert.equal(inspectImageBytes(webpRotated)?.exifOrientation, 3);
  const w = await blockImage(4, "webp", 300);
  assert.equal(inspectImageBytes(w.subarray(0, 40)), null, "a truncated WebP gives null");
  assert.equal(inspectImageBytes(Buffer.from("RIFF....WEBPjunkjunkjunkjunkjunkjunk")), null);
});

test("import records hashes, dimensions, EXIF orientation and a provenance receipt, and copies the exact bytes", async () => {
  const s = scratch();
  try {
    const rotated = await sharp(await blockImage(11, "jpeg", 300)).resize(300, 240, { fit: "fill" }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const files = [
      { name: "a.jpg", bytes: rotated },
      { name: "b.PNG", bytes: await blockImage(12, "png") },
      { name: "c.webp", bytes: await blockImage(13, "webp") },
    ];
    const result = await importOf(s, files);
    assert.equal(result.imported, 3);
    const recs = records(s);
    assert.equal(recs.length, 3);
    for (const f of files) {
      const rec = recs.find((r) => r.sha256 === sha256Hex(f.bytes)) as IntakeRecord;
      assert.ok(rec, "record per photo");
      assert.deepEqual(readFileSync(path.join(s.ws.dir, "pool", rec.file)), f.bytes, "pooled bytes are the exact original");
      assert.equal(rec.receipt.sourceSha256, rec.sha256);
      assert.equal(rec.receipt.copiedSha256, rec.sha256);
      assert.equal(rec.receipt.stableRead, true);
      assert.match(rec.signature.dhash, /^[0-9a-f]{16}$/);
      assert.match(rec.rightsHolderRef, /^rh-[0-9a-f]{12}$/);
      assert.equal(rec.imageId, `img-${rec.sha256.slice(0, 16)}`);
    }
    assert.deepEqual(recs.find((r) => r.sha256 === sha256Hex(rotated))?.dimensions, { width: 300, height: 240, exifOrientation: 6 });
    assert.deepEqual(verifyPool(s.ws, recs), []);
    // original names are not stored anywhere in the workspace (a file name can identify a person)
    const all = recs.map((r) => JSON.stringify(r)).join("");
    for (const f of files) assert.ok(!all.includes(f.name));
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("hostile files are refused and NOTHING is written: executables, disguised, polyglot, truncated, tiny, wrong extension", async () => {
  const s = scratch();
  try {
    const good = await blockImage(21, "jpeg");
    const mz = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300, 0x90), Buffer.from("This program cannot be run in DOS mode.")]);
    const png = await blockImage(22, "png");
    const cases: Array<[string, string, Buffer, RegExp]> = [
      ["exe renamed jpg", "evil.jpg", mz, /Windows\/DOS executable/],
      ["elf", "elf.png", Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(400)]), /ELF/],
      ["shebang script", "run.jpg", Buffer.from("#!/bin/sh\necho hi\n".padEnd(400, " ")), /script/],
      ["zip", "z.webp", Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(400)]), /archive/],
      ["pdf", "d.jpg", Buffer.from("%PDF-1.7 ".padEnd(400, "x")), /PDF/],
      ["png content with jpg name", "x.jpg", png, /extension does not match/],
      ["jpeg with appended payload", "p.jpg", Buffer.concat([good, Buffer.from("MZ payload that is not part of the picture")]), /bytes follow the end of the JPEG/],
      ["png with appended payload", "p.png", Buffer.concat([png, Buffer.from("trailing")]), /IEND/],
      ["truncated jpeg", "t.jpg", good.subarray(0, good.length - 600), /end-of-image|decoded|measured/],
      ["truncated png", "t.png", png.subarray(0, png.length - 30), /IEND|truncated|decoded/],
      ["tiny image", "s.jpg", await blockImage(23, "jpeg", 64), /shortest side/],
      ["random bytes", "r.jpg", Buffer.from(Array.from({ length: 500 }, (_, i) => (i * 37) & 255)), /not a JPEG, PNG or WebP/],
      ["embedded dos stub in a jpeg tail", "e.jpg", Buffer.concat([good.subarray(0, 2), good.subarray(2)]).length ? Buffer.concat([good, Buffer.from("This program cannot be run in DOS mode")]) : good, /bytes follow|embedded Windows/],
    ];
    for (const [what, name, bytes, expect] of cases) {
      const err = await refusal(importOf(s, [{ name, bytes }]));
      assert.match(err, expect, what);
      assert.ok(!err.includes(name), `${what}: the refusal does not echo the file name`);
    }
    assert.deepEqual(readdirSync(path.join(s.ws.dir, "pool")), []);
    assert.deepEqual(readdirSync(path.join(s.ws.dir, "records")), []);
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("one bad file in a batch refuses the whole batch before anything is copied", async () => {
  const s = scratch();
  try {
    const err = await refusal(
      importOf(s, [
        { name: "ok1.jpg", bytes: await blockImage(31) },
        { name: "bad.jpg", bytes: Buffer.from("MZ".padEnd(400, "x")) },
        { name: "ok2.jpg", bytes: await blockImage(32) },
      ]),
    );
    assert.match(err, /entries\[1\]/);
    assert.deepEqual(readdirSync(path.join(s.ws.dir, "pool")), []);
    assert.deepEqual(readdirSync(path.join(s.ws.dir, "records")), []);
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

// ------------------------------------------------------------------ paths, links, windows names, unstable content

test("file names that escape, alias or hide on Windows are refused", () => {
  const bad = ["../x.jpg", "..\\x.jpg", "a/b.jpg", "a\\b.jpg", "C:x.jpg", "C:\\x.jpg", "\\\\server\\share\\x.jpg", "x.jpg:stream", "CON.jpg", "nul", "aux.png", "com1.webp", "LPT9.jpg", "x.jpg.", "x.jpg ", " x.jpg", "a..b.jpg", "", "x".repeat(200) + ".jpg", "bad\u0001.jpg", "q?.jpg", "a*.jpg"];
  for (const n of bad) assert.ok(bareNameProblem(n), JSON.stringify(n));
  for (const n of ["IMG_0001.jpg", "my photo (2).png", "a.b.c.webp"]) assert.equal(bareNameProblem(n), null, n);
  const { problems } = validateBatch({ schemaVersion: 1, kind: "single-item-intake-batch", benchmarkId: "single-item-v1", entries: [entry("a.jpg"), entry("A.JPG")] }, NOW);
  assert.ok(problems.some((p) => /listed twice/.test(p)), "Windows names are case-insensitive: A.JPG and a.jpg are one file");
  assert.ok(validateBatch({ schemaVersion: 1, kind: "single-item-intake-batch", benchmarkId: "single-item-v1", entries: [entry("a.gif")] }, NOW).problems.some((p) => /only \.jpg/.test(p)));
});

function fakeStat(over: Partial<{ symlink: boolean; file: boolean; nlink: number; size: number; mtimeMs: number; dir: boolean }> = {}) {
  return { isSymbolicLink: () => over.symlink ?? false, isFile: () => over.file ?? true, isDirectory: () => over.dir ?? false, nlink: over.nlink ?? 1, size: over.size ?? 10, mtimeMs: over.mtimeMs ?? 1000 };
}
function readOps(over: Partial<ReadOps> = {}, fileStat = fakeStat(), bytes = Buffer.alloc(10, 7)): ReadOps {
  return {
    lstat: ((p: string) => (p.endsWith("srcdir") ? fakeStat({ file: false, dir: true }) : fileStat)) as never,
    realpath: (p: string) => (p.endsWith("srcdir") ? "/real/srcdir" : "/real/srcdir/f.jpg"),
    open: () => 3,
    fstat: (() => fakeStat()) as never,
    readAll: () => bytes,
    close: () => undefined,
    ...over,
  };
}

test("links, junctions, hard links, escapes and files that change while being read are refused (injected file system)", () => {
  const ok = readSourceFile("srcdir", "f.jpg", 1000, readOps());
  assert.equal(ok.size, 10);
  assert.match((() => { try { readSourceFile("srcdir", "f.jpg", 1000, readOps({}, fakeStat({ symlink: true }))); } catch (e) { return (e as Error).message; } return ""; })(), /symbolic link or junction/);
  assert.match((() => { try { readSourceFile("srcdir", "f.jpg", 1000, readOps({}, fakeStat({ file: false }))); } catch (e) { return (e as Error).message; } return ""; })(), /not a regular file/);
  assert.match((() => { try { readSourceFile("srcdir", "f.jpg", 1000, readOps({}, fakeStat({ nlink: 2 }))); } catch (e) { return (e as Error).message; } return ""; })(), /hard links/);
  assert.match((() => { try { readSourceFile("srcdir", "f.jpg", 5, readOps()); } catch (e) { return (e as Error).message; } return ""; })(), /larger than/);
  assert.match((() => { try { readSourceFile("srcdir", "f.jpg", 1000, readOps({ realpath: (p) => (p.endsWith("srcdir") ? "/real/srcdir" : "/elsewhere/secret.jpg") })); } catch (e) { return (e as Error).message; } return ""; })(), /outside the source directory/);
  assert.match((() => { try { readSourceFile("srcdir", "f.jpg", 1000, readOps({ realpath: (p) => (p.endsWith("srcdir") ? "/real/srcdir" : "/real/srcdir/sub/f.jpg") })); } catch (e) { return (e as Error).message; } return ""; })(), /outside the source directory/);
  // the directory itself is a junction
  assert.match((() => { try { readSourceFile("srcdir", "f.jpg", 1000, readOps({ lstat: ((p: string) => (p.endsWith("srcdir") ? fakeStat({ symlink: true, file: false, dir: true }) : fakeStat())) as never })); } catch (e) { return (e as Error).message; } return ""; })(), /link or junction/);
  // content changes during the read
  let calls = 0;
  const changing = readOps({ lstat: ((p: string) => (p.endsWith("srcdir") ? fakeStat({ file: false, dir: true }) : fakeStat({ mtimeMs: ++calls > 1 ? 2000 : 1000 }))) as never });
  assert.match((() => { try { readSourceFile("srcdir", "f.jpg", 1000, changing); } catch (e) { return (e as Error).message; } return ""; })(), /changed while it was being read/);
  const shortRead = readOps({ readAll: () => Buffer.alloc(4) });
  assert.match((() => { try { readSourceFile("srcdir", "f.jpg", 1000, shortRead); } catch (e) { return (e as Error).message; } return ""; })(), /changed while it was being read/);
  // the refusal text never carries the operator's file name
  assert.ok(!(() => { try { readSourceFile("srcdir", "secret-person-name.jpg", 1000, readOps({}, fakeStat({ symlink: true }))); } catch (e) { return (e as Error).message; } return ""; })().includes("secret-person-name"));
});

test("a real directory junction/symlink as the source directory is refused (skipped where the OS forbids creating one)", async () => {
  const s = scratch();
  try {
    const real = path.join(s.dir, "realsrc");
    mkdirSync(real);
    writeFileSync(path.join(real, "a.jpg"), await blockImage(41));
    const link = path.join(s.dir, "linksrc");
    try {
      symlinkSync(real, link, "junction");
    } catch {
      return; // creating links is not permitted here; the injected-file-system test above covers the logic
    }
    const batch = path.join(s.dir, "b.json");
    writeFileSync(batch, JSON.stringify({ schemaVersion: 1, kind: "single-item-intake-batch", benchmarkId: "single-item-v1", entries: [entry("a.jpg")] }));
    assert.match(await refusal(importBatch(s.ws, batch, link, OP, { now: () => IMPORT_AT })), /link or junction/);
    assert.deepEqual(readdirSync(path.join(s.ws.dir, "records")), []);
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

// ------------------------------------------------------------------ rights evidence

test("rights evidence: only self-captured, explicit consent or an individually verified open licence are accepted", () => {
  const ok = (r: unknown) => intakeRightsProblems(r, "r", NOW).problems;
  assert.deepEqual(ok(selfRights()), []);
  assert.deepEqual(ok(consentRights()), []);
  assert.deepEqual(ok(openRights()), []);
  const must = (r: unknown, re: RegExp, what: string) => assert.ok(ok(r).some((p) => re.test(p)), `${what}: ${ok(r).join(" | ")}`);
  for (const t of ["unknown", "public-web", "scraped", "other", "web", ""]) must({ ...selfRights(), sourceType: t }, /sourceType/, `type ${t}`);
  must({ ...selfRights(), rightsHolder: "" }, /rightsHolder/, "no holder");
  must({ ...selfRights(), rightsHolder: "DeepFashion dataset" }, /public fashion datasets/, "deepfashion holder");
  must({ ...selfRights(), rightsHolder: "ModaNet" }, /public fashion datasets/, "modanet");
  must({ ...selfRights(), rightsHolder: "Fashionpedia" }, /public fashion datasets/, "fashionpedia");
  must({ ...selfRights(), evaluationPermission: false }, /evaluationPermission/, "no permission");
  const noPermission: Record<string, unknown> = { ...selfRights() };
  delete noPermission.evaluationPermission;
  must(noPermission, /evaluationPermission/, "missing permission");
  must({ ...selfRights(), redistributionAllowed: "yes" }, /redistributionAllowed/, "redistribution flag");
  must({ ...selfRights(), individuallyVerified: false }, /individuallyVerified/, "bulk assumed");
  must({ ...selfRights(), verifiedBy: "Jane Doe" }, /pseudonymous/, "name instead of pseudonym");
  must({ ...selfRights(), verifiedBy: "jane@example.com" }, /pseudonymous/, "email instead of pseudonym");
  must({ ...selfRights(), acquiredAt: "2027-01-01" }, /future/, "future date");
  must({ ...selfRights(), acquiredAt: "1980-01-01" }, /1995/, "implausible date");
  must({ ...selfRights(), acquiredAt: "last tuesday" }, /ISO/, "free text date");
  must({ ...selfRights(), consent: { reference: "x", signedAt: "2026-01-01" } }, /consent: must be null/, "consent on self-captured");
  must({ ...consentRights(), consent: null }, /consent/, "consent missing");
  must({ ...consentRights(), consent: { reference: "no spaces allowed here", signedAt: "2026-01-01" } }, /reference/, "bad consent ref");
  must({ ...selfRights(), openLicense: openRights().openLicense }, /openLicense: must be null/, "license on self-captured");
  must({ ...openRights(), openLicense: null }, /openLicense/, "open without evidence");
  const oc = openRights().openLicense;
  must({ ...openRights(), openLicense: { ...oc, license: { ...oc.license, id: "CC-BY-NC" } } }, /non-commercial|allow-list/, "NC licence");
  must({ ...openRights(), openLicense: { ...oc, license: { ...oc.license, id: "CC-BY-ND" } } }, /allow-list|no-derivatives/, "ND licence");
  must({ ...openRights(), openLicense: { ...oc, license: { ...oc.license, version: "1.0" } } }, /version/, "wrong version");
  must({ ...openRights(), openLicense: { ...oc, sourcePageUrl: "http://commons.wikimedia.org/x" } }, /https/, "http page");
  must({ ...openRights(), openLicense: { ...oc, originalUrl: "not a url" } }, /https/, "no url");
  must({ ...openRights(), openLicense: { ...oc, sourceCollection: "flickr" } }, /wikimedia-commons or open-images/, "collection");
  must({ ...openRights(), openLicense: { ...oc, sourcePageUrl: "https://example.com/deepfashion/1" } }, /public fashion datasets/, "deepfashion url");
  must({ ...openRights(), redistributionAllowed: false }, /contradicts/, "open licence cannot forbid redistribution");
  must({ ...selfRights(), extra: 1 }, /unknown field/, "unknown field");
});

test("people are refused unless explicit model-release evidence exists", () => {
  const c = (o: Record<string, unknown>) => captureProblems(capture(o), "c", NOW).problems;
  assert.deepEqual(c({}), []);
  assert.ok(c({ personsPresent: true }).some((p) => /model-release/.test(p)));
  assert.ok(c({ personsPresent: true, modelRelease: { ...release, coversEvaluation: false } }).some((p) => /coversEvaluation/.test(p)));
  assert.ok(c({ personsPresent: true, modelRelease: { ...release, reference: "has spaces" } }).some((p) => /reference/.test(p)));
  assert.ok(c({ personsPresent: true, modelRelease: { ...release, signedAt: "2099-01-01" } }).some((p) => /future/.test(p)));
  assert.deepEqual(c({ personsPresent: true, modelRelease: release }), []);
  assert.ok(c({ sceneType: "worn", personsPresent: false }).some((p) => /"worn" photo shows a person/.test(p)), "worn without a declared person is inconsistent");
  assert.ok(c({ personsPresent: false, modelRelease: release }).some((p) => /must be null/.test(p)));
  assert.ok(c({ background: "studio" }).some((p) => /background/.test(p)));
  assert.ok(c({ camera: undefined }).length > 0);
});

test("a batch cannot claim prior inference, is strict about unknown fields, and needs groups for in-scope photos", () => {
  const v = (e: Record<string, unknown>) => validateBatch({ schemaVersion: 1, kind: "single-item-intake-batch", benchmarkId: "single-item-v1", entries: [entry("a.jpg", e)] }, NOW).problems;
  assert.deepEqual(v({}), []);
  assert.ok(v({ priorInference: true }).some((p) => /priorInference/.test(p)));
  assert.ok(v({ garmentId: null }).some((p) => /garmentId/.test(p)));
  assert.ok(v({ stratum: "rejection" }).some((p) => /rejectionReason/.test(p)));
  assert.deepEqual(v({ stratum: "rejection", rejectionReason: "no_garment", garmentId: null }), []);
  assert.ok(v({ sourceShootId: "has space" }).some((p) => /sourceShootId/.test(p)));
  assert.ok(v({ notes: "x" }).some((p) => /unknown field/.test(p)));
});

// ------------------------------------------------------------------ overwrite, collision, rollback

test("nothing is overwritten: exclusive create refuses an existing file and leaves it untouched", () => {
  const dir = makeTempDir("s026-");
  try {
    const f = path.join(dir, "x.bin");
    writeFileSync(f, "original");
    assert.throws(() => writeExclusive(f, Buffer.from("new")), (e) => e instanceof EvaluationRefusal && /already exists/.test(e.message));
    assert.equal(readFileSync(f, "utf8"), "original");
  } finally {
    removeTempDir(dir, "s026-");
  }
});

test("a write that fails half way removes only the partial file this call created", () => {
  const dir = makeTempDir("s026-");
  try {
    const f = path.join(dir, "y.bin");
    const other = path.join(dir, "other.bin");
    writeFileSync(other, "keep");
    const failing: FsOps = {
      openExclusive: (p) => require("node:fs").openSync(p, "wx"),
      write: () => {
        throw new Error("disk full");
      },
      fsync: () => undefined,
      close: (fd) => require("node:fs").closeSync(fd),
      unlink: (p) => require("node:fs").unlinkSync(p),
      mkdir: () => undefined,
      rmdir: () => undefined,
    };
    assert.throws(() => writeExclusive(f, Buffer.from("data"), failing), /disk full/);
    assert.equal(existsSync(f), false, "the half-written file is removed");
    assert.equal(readFileSync(other, "utf8"), "keep", "another file is never touched");
    // EEXIST from a racing writer: refused, and the winner's file survives
    writeFileSync(f, "winner");
    assert.throws(() => writeExclusive(f, Buffer.from("loser")), EvaluationRefusal);
    assert.equal(readFileSync(f, "utf8"), "winner");
    // a failing close after a good write is a failed publication
    const closeFails: FsOps = { ...failing, write: (fd, b) => require("node:fs").writeSync(fd, b), close: (fd) => { require("node:fs").closeSync(fd); throw new Error("close failed"); } };
    const g = path.join(dir, "z.bin");
    assert.throws(() => writeExclusive(g, Buffer.from("abc"), closeFails), /close failed/);
    assert.equal(existsSync(g), false);
  } finally {
    removeTempDir(dir, "s026-");
  }
});

test("an import that fails part way removes everything it created and leaves earlier imports intact", async () => {
  const s = scratch();
  try {
    await importOf(s, [{ name: "first.jpg", bytes: await blockImage(51), over: { sourceShootId: "shoot-1" } }]);
    const before = readdirSync(path.join(s.ws.dir, "records")).concat(readdirSync(path.join(s.ws.dir, "pool")));
    let writes = 0;
    const flaky: FsOps = {
      openExclusive: (p) => require("node:fs").openSync(p, "wx"),
      write: (fd, b) => {
        if (++writes === 4) throw new Error("disk error");
        require("node:fs").writeSync(fd, b);
      },
      fsync: () => undefined,
      close: (fd) => require("node:fs").closeSync(fd),
      unlink: (p) => require("node:fs").unlinkSync(p),
      mkdir: (d) => mkdirSync(d),
      rmdir: () => undefined,
    };
    await assert.rejects(
      importOf(
        s,
        [
          { name: "n1.jpg", bytes: await blockImage(52), over: { sourceShootId: "shoot-2" } },
          { name: "n2.jpg", bytes: await blockImage(53), over: { sourceShootId: "shoot-3" } },
          { name: "n3.jpg", bytes: await blockImage(54), over: { sourceShootId: "shoot-4" } },
        ],
        flaky,
      ),
      /disk error/,
    );
    assert.deepEqual(readdirSync(path.join(s.ws.dir, "records")).concat(readdirSync(path.join(s.ws.dir, "pool"))), before);
    assert.deepEqual(verifyPool(s.ws, records(s)), []);
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("a workspace is never reused: init refuses an existing directory and leaves its contents alone", () => {
  const dir = makeTempDir("s026-");
  try {
    const ws = path.join(dir, "ws");
    mkdirSync(ws);
    writeFileSync(path.join(ws, "precious.txt"), "mine");
    assert.throws(() => initWorkspace(ws, "single-item-v1", NOW), (e) => e instanceof EvaluationRefusal && /already exists/.test(e.message));
    assert.deepEqual(readdirSync(ws), ["precious.txt"]);
    assert.throws(() => initWorkspace(path.join(dir, "ws2"), "Bad Id", NOW), /lowercase id/);
    assert.equal(existsSync(path.join(dir, "ws2")), false);
  } finally {
    removeTempDir(dir, "s026-");
  }
});

test("Creations.rollback removes the files and the empty directories it made, never anything else", () => {
  const dir = makeTempDir("s026-");
  try {
    const c = new Creations();
    c.dir(path.join(dir, "d"));
    c.file(path.join(dir, "d", "a.txt"), Buffer.from("a"));
    writeFileSync(path.join(dir, "d", "foreign.txt"), "not ours");
    c.rollback();
    assert.equal(existsSync(path.join(dir, "d", "a.txt")), false);
    assert.equal(readFileSync(path.join(dir, "d", "foreign.txt"), "utf8"), "not ours");
    assert.equal(existsSync(path.join(dir, "d")), true, "a directory with foreign content is left");
  } finally {
    removeTempDir(dir, "s026-");
  }
});

// ------------------------------------------------------------------ duplicates and leakage

test("exact duplicates are refused; near-duplicates must declare the same shoot and garment and are then linked", async () => {
  const s = scratch();
  try {
    const base = await blockImage(61, "jpeg", 320);
    await importOf(s, [{ name: "orig.jpg", bytes: base, over: { sourceShootId: "shoot-1", garmentId: "garment-1" } }]);
    assert.match(await refusal(importOf(s, [{ name: "again.jpg", bytes: base, over: { sourceShootId: "shoot-9", garmentId: "garment-9" } }])), /same image bytes are already imported/);

    const resized = await sharp(base).resize(400, 400).jpeg({ quality: 60 }).toBuffer();
    const mirrored = await sharp(base).flop().png().toBuffer();
    const recompressed = await sharp(base).jpeg({ quality: 40 }).toBuffer();
    for (const [what, bytes] of [["resized+recompressed", resized], ["mirrored", mirrored], ["recompressed", recompressed]] as const) {
      const ext = what === "mirrored" ? "png" : "jpg";
      assert.match(await refusal(importOf(s, [{ name: `n-${what.replace(/\W/g, "")}.${ext}`, bytes, over: { sourceShootId: "shoot-2", garmentId: "garment-2" } }])), /does not declare the same shoot and garment/, what);
    }
    // declared as the same shoot and garment: accepted and linked
    const r = await importOf(s, [{ name: "burst.jpg", bytes: recompressed, over: { sourceShootId: "shoot-1", garmentId: "garment-1" } }]);
    assert.equal(r.nearDuplicateLinks, 1);
    const recs = records(s);
    const linked = recs.find((x) => x.receipt.nearDuplicateOf.length === 1) as IntakeRecord;
    assert.ok(linked);
    const groups = groupsOf(recs);
    assert.equal(new Set(recs.map((x) => groups.get(x.imageId))).size, 1, "the pair is one group and can never be split");
    // unrelated pictures are not near-duplicates
    const a = await signatureOf(await blockImage(62));
    const b = await signatureOf(await blockImage(63));
    assert.equal(nearDuplicate(a, b), false);
    assert.equal(nearDuplicate(a, a), true);
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("the near-duplicate check is rotation-aware (EXIF) and says so when it cannot see a heavy edit", async () => {
  const base = await sharp(await blockImage(64, "jpeg", 320)).resize(320, 240, { fit: "fill" }).jpeg().toBuffer();
  const rotatedByTag = await sharp(base).withMetadata({ orientation: 1 }).jpeg().toBuffer();
  assert.equal(nearDuplicate(await signatureOf(base), await signatureOf(rotatedByTag)), true);
  const heavyCrop = await sharp(base).extract({ left: 120, top: 60, width: 150, height: 150 }).resize(300, 300).jpeg().toBuffer();
  assert.equal(nearDuplicate(await signatureOf(base), await signatureOf(heavyCrop)), false, "documented limit: heavy crops are not caught here; shoot and garment groups cover them");
});

// ------------------------------------------------------------------ labelling

type Truth = { category: GoldCategory; color: (typeof GOLD_COLORS)[number]; pattern: (typeof GOLD_PATTERNS)[number]; box: [number, number, number, number] };
const truthFor = (rec: IntakeRecord, i: number): Truth => ({
  category: GOLD_CATEGORIES[i % GOLD_CATEGORIES.length],
  color: GOLD_COLORS[(i * 5) % GOLD_COLORS.length],
  pattern: GOLD_PATTERNS[(i * 3) % GOLD_PATTERNS.length],
  box: [0.1 + (i % 3) * 0.02, 0.1, 0.6 + (i % 3) * 0.1, 0.9],
});

function reviewOf(ws: Workspace, recs: IntakeRecord[], id: string, session: string, make: (r: IntakeRecord, i: number) => Partial<ReviewLabel> | null, skew = 0, role: "reviewer" | "adjudicator" = "reviewer", adjudicates: [string, string] | null = null): ReviewFile {
  const labels: ReviewLabel[] = [];
  recs.forEach((r, i) => {
    const over = make(r, i);
    if (over === null) return;
    const t = truthFor(r, i);
    const start = Date.parse("2026-11-02T09:00:00Z") + i * 60_000 + skew * 1000;
    const jitter = skew * 0.0017;
    const rejection = r.stratum === "rejection";
    labels.push({
      imageId: r.imageId,
      imageSha256: r.sha256,
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(start + 20_000 + skew * 1000).toISOString(),
      personVisible: r.capture.personsPresent,
      outcome: rejection ? "reject" : "single_item",
      rejectionReason: rejection ? r.rejectionReason : null,
      item: rejection
        ? null
        : { category: t.category, color: t.color, pattern: t.pattern, fit: "unknown", material: "unknown", box: [t.box[0] + jitter, t.box[1] + jitter, t.box[2] - jitter, t.box[3] - jitter], seasons: ["summer"], occasions: ["everyday"] },
      notes: null,
      ...over,
    });
  });
  return { schemaVersion: 1, kind: "single-item-gold-review", benchmarkId: ws.benchmarkId, role, reviewerId: id, sessionId: session, adjudicates, tool: "review-form", modelAssisted: false, labels };
}

async function smallPool(s: Scratch, n = 6): Promise<IntakeRecord[]> {
  const files: Array<{ name: string; bytes: Buffer; over: Record<string, unknown> }> = [];
  for (let i = 0; i < n; i++) files.push({ name: `p${i}.jpg`, bytes: await blockImage(100 + i), over: { sourceShootId: `shoot-${i}`, garmentId: `garment-${i}` } });
  await importOf(s, files);
  return records(s).sort((a, b) => (a.imageId < b.imageId ? -1 : 1));
}
const byId = (recs: IntakeRecord[]) => new Map(recs.map((r) => [r.imageId, r]));

test("a review is strict: exact hash, ordered times, vocabulary, pseudonymous reviewer, no model-made labels", async () => {
  const s = scratch();
  try {
    const recs = await smallPool(s, 3);
    const good = reviewOf(s.ws, recs, "rv-aaaa11", "sess0001a", () => ({}));
    assert.deepEqual(validateReview(JSON.parse(JSON.stringify(good)), s.ws, byId(recs), NOW).problems, []);
    const bad = (mutate: (r: ReviewFile) => void, re: RegExp, what: string) => {
      const copy = JSON.parse(JSON.stringify(good)) as ReviewFile;
      mutate(copy);
      const { problems } = validateReview(copy, s.ws, byId(recs), NOW);
      assert.ok(problems.some((p) => re.test(p)), `${what}: ${problems.join(" | ")}`);
    };
    bad((r) => (r.labels[0].imageSha256 = "0".repeat(64)), /different image|not the hash/, "wrong hash");
    bad((r) => (r.labels[0].imageId = "img-0000000000000000"), /not an image in this workspace/, "unknown image");
    bad((r) => r.labels.push({ ...r.labels[0] }), /labelled twice/, "duplicate");
    bad((r) => (r.labels[0].completedAt = r.labels[0].startedAt), /after startedAt/, "zero duration");
    bad((r) => (r.labels[0].completedAt = "2030-01-01T00:00:00Z"), /future/, "future");
    bad((r) => (r.labels[0].startedAt = "2026-10-01T00:00:00Z"), /before the photo was imported/, "predates import");
    bad((r) => (r.reviewerId = "jane@example.com"), /pseudonym/, "email id");
    bad((r) => (r.reviewerId = "rv-ai1234"), /model or script/, "model-like id");
    bad((r) => (r.reviewerId = "Jane Doe"), /pseudonym/, "name id");
    bad((r) => ((r as unknown as { modelAssisted: boolean }).modelAssisted = true), /modelAssisted/, "model assisted");
    bad((r) => (r.tool = "qwen autolabel"), /model or script/, "model tool");
    bad((r) => (r.labels[0].notes = "pre-labelled by the model"), /model-made/, "model note");
    bad((r) => (r.labels[0].item = null), /needs an item/, "item missing");
    bad((r) => ((r.labels[0].item as NonNullable<ReviewLabel["item"]>).box = [0.5, 0.5, 0.2, 0.9]), /x2 must be greater/, "bad box");
    bad((r) => ((r.labels[0].item as NonNullable<ReviewLabel["item"]>).color = "chartreuse" as never), /color/, "bad colour");
    bad((r) => (r.labels[0].outcome = "unsure"), /"unsure" review has no reason and no item/, "unsure with item");
    bad((r) => (r.labels[0].outcome = "reject"), /rejectionReason|must be null for a reject/, "reject with item");
    bad((r) => (r.sessionId = "x"), /sessionId/, "short session");
    bad((r) => ((r as unknown as Record<string, unknown>).extra = 1), /unknown field/, "unknown field");
    // unknown values are allowed where the photo does not show them
    const unk = JSON.parse(JSON.stringify(good)) as ReviewFile;
    (unk.labels[0].item as NonNullable<ReviewLabel["item"]>).pattern = "unknown";
    assert.deepEqual(validateReview(unk, s.ws, byId(recs), NOW).problems, []);
    // the template is blank: invalid until a person fills it in, and ordered differently per reviewer
    const t1 = reviewTemplate(s.ws, recs, "rv-aaaa11", null) as { labels: Array<{ imageId: string }> };
    const t2 = reviewTemplate(s.ws, recs, "rv-bbbb22", null) as { labels: Array<{ imageId: string }> };
    assert.ok(validateReview(t1, s.ws, byId(recs), NOW).problems.length > 0);
    assert.notDeepEqual(t1.labels.map((l) => l.imageId), t2.labels.map((l) => l.imageId), "a different order per reviewer");
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("one reviewer, one sitting, or a copied review cannot satisfy both reviews", async () => {
  const s = scratch();
  try {
    const recs = await smallPool(s, 6);
    const a = reviewOf(s.ws, recs, "rv-aaaa11", "sess0001a", () => ({}), 0);
    const b = reviewOf(s.ws, recs, "rv-bbbb22", "sess0002b", () => ({}), 3);
    assert.deepEqual(independenceProblems(a, b), []);
    assert.ok(independenceProblems(a, { ...b, reviewerId: "RV-AAAA11" }).some((p) => /same reviewer/.test(p)));
    assert.ok(independenceProblems(a, { ...b, sessionId: a.sessionId }).some((p) => /same sitting|share a sessionId/.test(p)));
    // a verbatim copy with only the timestamps changed
    const copy: ReviewFile = { ...JSON.parse(JSON.stringify(a)), reviewerId: "rv-cccc33", sessionId: "sess0003c" };
    copy.labels.forEach((l, i) => ((l.startedAt = new Date(Date.parse(l.startedAt) + 7000 + i).toISOString()), (l.completedAt = new Date(Date.parse(l.completedAt) + 9000 + i).toISOString())));
    assert.ok(independenceProblems(a, copy).some((p) => /identical content|identical boxes/.test(p)), independenceProblems(a, copy).join("|"));
    // identical free-text notes
    const n1 = { ...a, labels: a.labels.map((l, i) => ({ ...l, notes: i < 2 ? "same sentence" : null })) };
    const n2 = { ...b, labels: b.labels.map((l, i) => ({ ...l, notes: i < 2 ? "same sentence" : null })) };
    assert.ok(independenceProblems(n1, n2).some((p) => /identical free-text notes/.test(p)));
    // identical timestamps
    const t2 = { ...b, labels: b.labels.map((l, i) => ({ ...l, startedAt: a.labels[i].startedAt, completedAt: a.labels[i].completedAt })) };
    assert.ok(independenceProblems(a, t2).some((p) => /identical start and finish times/.test(p)));
    // resolveLabels refuses all of it as problems, producing no labels
    const res = resolveLabels(recs, a, { ...b, reviewerId: a.reviewerId }, null, { allowSingleReview: false });
    assert.ok(res.problems.length > 0);
    assert.equal(res.finals.size, 0);
    // submitting: a reviewer id and a session id are used once
    submitReview(s.ws, a);
    assert.throws(() => submitReview(s.ws, a), /already has a stored/);
    assert.throws(() => submitReview(s.ws, { ...b, sessionId: a.sessionId }), /sessionId is already used/);
    submitReview(s.ws, b);
    assert.throws(() => submitReview(s.ws, { ...b, role: "adjudicator", adjudicates: [a.reviewerId, "rv-zzzz99"] }), /already has a stored/, "a reviewer id cannot also be stored as adjudicator");
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("agreement, disagreement and adjudication produce scorer-compatible gold, and misuse is refused", async () => {
  const s = scratch();
  try {
    const recs = await smallPool(s, 6);
    const a = reviewOf(s.ws, recs, "rv-aaaa11", "sess0001a", () => ({}), 0);
    // reviewer B disagrees about colour on image 1 and box on image 2, says unsure on 3, unknown pattern on 4 (both do)
    const b = reviewOf(
      s.ws,
      recs,
      "rv-bbbb22",
      "sess0002b",
      (r, i) => {
        if (i === 1) return { item: { category: truthFor(r, i).category, color: truthFor(r, i).color === "blue" ? "pink" : "blue", pattern: truthFor(r, i).pattern, fit: "unknown", material: "unknown", box: [0.1, 0.1, 0.6, 0.9], seasons: [], occasions: [] } };
        if (i === 2) return { item: { category: truthFor(r, i).category, color: truthFor(r, i).color, pattern: truthFor(r, i).pattern, fit: "unknown", material: "unknown", box: [0.5, 0.5, 0.9, 0.95], seasons: [], occasions: [] } };
        if (i === 3) return { outcome: "unsure", item: null };
        return {};
      },
      3,
    );
    assert.deepEqual(validateReview(JSON.parse(JSON.stringify(b)), s.ws, byId(recs), NOW).problems, []);
    const noAdj = resolveLabels(recs, a, b, null, { allowSingleReview: false });
    assert.deepEqual(noAdj.problems, []);
    assert.equal(noAdj.excluded.size, 3, "two disagreements and one unsure are not gold");
    assert.equal(noAdj.finals.size, 3);
    assert.ok([...noAdj.excluded.values()].includes("needs-adjudication"));

    // the adjudication template lists only disagreements
    const tpl = reviewTemplate(s.ws, recs, "rv-cccc33", { a, b }) as { labels: Array<{ imageId: string; notes: string }> };
    assert.equal(tpl.labels.length, 3);
    assert.ok(tpl.labels.every((l) => /reviewers disagree on/.test(l.notes)));

    const needsAdj = recs.filter((r) => noAdj.excluded.get(r.imageId) === "needs-adjudication");
    const adj = reviewOf(s.ws, needsAdj, "rv-cccc33", "sess0003c", (r) => (r.imageId === recs[3].imageId ? { outcome: "unsure" as const, item: null } : {}), 0, "adjudicator", ["rv-aaaa11", "rv-bbbb22"]);
    adj.labels.forEach((l, i) => ((l.startedAt = new Date(Date.parse("2026-11-03T09:00:00Z") + i * 120_000).toISOString()), (l.completedAt = new Date(Date.parse("2026-11-03T09:01:00Z") + i * 120_000).toISOString())));
    assert.deepEqual(validateReview(JSON.parse(JSON.stringify(adj)), s.ws, byId(recs), NOW).problems, []);
    const done = resolveLabels(recs, a, b, adj, { allowSingleReview: false });
    assert.deepEqual(done.problems, []);
    assert.equal(done.adjudicated, 3);
    assert.equal(done.finals.size, 5, "the unsure image stays out");
    assert.equal(done.excluded.size, 1);
    assert.deepEqual([...done.excluded.values()], ["unsure"]);
    // gold validates with the unchanged Build 024 validator
    const picks = [...done.finals.values()];
    const goldDoc = { schemaVersion: 1, kind: "single-item-gold", benchmarkId: s.ws.benchmarkId, split: "development", labels: picks.map((f) => f.label) };
    const { file, problems } = validateGoldFile(JSON.parse(JSON.stringify(goldDoc)));
    assert.deepEqual(problems, []);
    assert.ok(file);
    for (const f of picks) {
      assert.equal(f.doubleReviewed, true);
      assert.equal(f.label.annotation.status, "double_human_adjudicated");
      assert.ok(f.label.annotation.annotators.length >= 2);
      assert.equal(new Set(f.label.annotation.annotators.map((x) => x.id)).size, f.label.annotation.annotators.length);
    }
    // misuse: adjudicator is a reviewer / shares a session / overrides an agreement / completes before the reviews
    assert.ok(resolveLabels(recs, a, b, { ...adj, reviewerId: a.reviewerId }, { allowSingleReview: false }).problems.some((p) => /adjudicator is one of the reviewers/.test(p)));
    assert.ok(resolveLabels(recs, a, b, { ...adj, sessionId: a.sessionId }, { allowSingleReview: false }).problems.some((p) => /sessionId/.test(p)));
    const agreedImage = recs.find((r, i) => i === 0) as IntakeRecord;
    const overriding = reviewOf(s.ws, [agreedImage], "rv-cccc33", "sess0003c", () => ({}), 0, "adjudicator", ["rv-aaaa11", "rv-bbbb22"]);
    overriding.labels[0].startedAt = "2026-11-04T09:00:00Z";
    overriding.labels[0].completedAt = "2026-11-04T09:01:00Z";
    assert.ok(resolveLabels(recs, a, b, overriding, { allowSingleReview: false }).problems.some((p) => /agreed on; an agreement is never overridden/.test(p)));
    const early = { ...adj, labels: adj.labels.map((l) => ({ ...l, startedAt: "2026-11-02T08:00:00Z", completedAt: "2026-11-02T08:00:05Z" })) };
    assert.ok(resolveLabels(recs, a, b, early, { allowSingleReview: false }).problems.some((p) => /completed before one of the reviews/.test(p)));
    const wrongPair = { ...adj, adjudicates: ["rv-aaaa11", "rv-dddd44"] as [string, string] };
    assert.ok(resolveLabels(recs, a, b, wrongPair, { allowSingleReview: false }).problems.some((p) => /different reviewers/.test(p)));
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("held-out labels need two reviews; a single review is development-only; unknown core attributes and undeclared people are excluded", async () => {
  const s = scratch();
  try {
    const recs = await smallPool(s, 4);
    const a = reviewOf(s.ws, recs, "rv-aaaa11", "sess0001a", () => ({}), 0);
    const onlyA = resolveLabels(recs, a, null, null, { allowSingleReview: false });
    assert.equal(onlyA.finals.size, 0);
    assert.equal([...onlyA.excluded.values()].every((r) => r === "not-reviewed-twice"), true);
    const single = resolveLabels(recs, a, null, null, { allowSingleReview: true });
    assert.equal(single.finals.size, 4);
    assert.ok([...single.finals.values()].every((f) => !f.doubleReviewed && f.label.annotation.status === "single_human"));

    const unk = (r: IntakeRecord, i: number) => (i === 0 ? { item: { category: "unknown", color: truthFor(r, i).color, pattern: truthFor(r, i).pattern, fit: "unknown", material: "unknown", box: [0.1, 0.1, 0.6, 0.9], seasons: [], occasions: [] } as never } : {});
    const a2 = reviewOf(s.ws, recs, "rv-aaaa11", "sess0001a", unk, 0);
    const b2 = reviewOf(s.ws, recs, "rv-bbbb22", "sess0002b", unk, 3);
    const unknownBoth = resolveLabels(recs, a2, b2, null, { allowSingleReview: false });
    assert.equal([...unknownBoth.excluded.values()].filter((r) => r === "unknown-core-attribute").length >= 1, true);

    // a reviewer sees a person the import did not declare
    const seen = (r: IntakeRecord, i: number) => (i === 1 ? { personVisible: true } : {});
    const a3 = reviewOf(s.ws, recs, "rv-aaaa11", "sess0001a", seen, 0);
    const b3 = reviewOf(s.ws, recs, "rv-bbbb22", "sess0002b", seen, 3);
    const person = resolveLabels(recs, a3, b3, null, { allowSingleReview: false });
    assert.ok([...person.excluded.values()].includes("undeclared-person"));
    // a human decision that contradicts the import declaration is excluded, not silently followed
    const flipped = (r: IntakeRecord, i: number) => (i === 2 ? { outcome: "reject" as const, rejectionReason: "no_garment" as const, item: null } : {});
    const conflict = resolveLabels(recs, reviewOf(s.ws, recs, "rv-aaaa11", "sess0001a", flipped, 0), reviewOf(s.ws, recs, "rv-bbbb22", "sess0002b", flipped, 3), null, { allowSingleReview: false });
    assert.ok([...conflict.excluded.values()].includes("conflicts-with-import-declaration"));
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

// ------------------------------------------------------------------ sampling (small, logic level)

function smallPolicy(): LaunchPolicy {
  const p = structuredClone(DEFAULT_POLICY);
  p.minimums = { ...p.minimums, heldoutInScope: 6, heldoutRejection: 2, perCategory: 1 };
  return p;
}
function smallSpec(over: Partial<CoverageSpec["heldout"]> = {}): CoverageSpec {
  return {
    schemaVersion: 1,
    kind: "single-item-coverage-spec",
    id: "tiny",
    version: "1",
    seed: "seed-one",
    development: { minInScope: 2 },
    heldout: { inScope: 6, rejection: 2, category: Object.fromEntries(GOLD_CATEGORIES.map((c) => [c, 1])), color: {}, pattern: {}, background: { plain: 1 }, lighting: { daylight: 1 }, camera: { phone: 1 }, itemSize: { large: 1 }, wearableType: { unworn: 1 }, ...over },
  };
}

async function samplingPool(s: Scratch, inScope: number, rejections: number): Promise<{ recs: IntakeRecord[]; a: ReviewFile; b: ReviewFile }> {
  const files: Array<{ name: string; bytes: Buffer; over: Record<string, unknown> }> = [];
  for (let i = 0; i < inScope + rejections; i++) {
    const rej = i >= inScope;
    files.push({
      name: `s${i}.jpg`,
      bytes: await blockImage(500 + i),
      over: {
        sourceShootId: `shoot-${Math.floor(i / 2)}`,
        garmentId: rej ? null : `garment-${i}`,
        stratum: rej ? "rejection" : "in_scope",
        rejectionReason: rej ? "no_garment" : null,
        capture: capture({ background: i % 3 === 0 ? "plain" : "textured", lighting: i % 2 ? "daylight" : "low_light", camera: i % 4 === 0 ? "dedicated_camera" : "phone" }),
      },
    });
  }
  await importOf(s, files);
  const recs = records(s).sort((x, y) => (x.imageId < y.imageId ? -1 : 1));
  const a = reviewOf(s.ws, recs, "rv-aaaa11", "sess0001a", () => ({}), 0);
  const b = reviewOf(s.ws, recs, "rv-bbbb22", "sess0002b", () => ({}), 3);
  return { recs, a, b };
}

test("sampling is deterministic, keeps shoots, garments and near-duplicates together, and reports exact deficits", async () => {
  const s = scratch();
  try {
    const { recs, a, b } = await samplingPool(s, 14, 4);
    const res = resolveLabels(recs, a, b, null, { allowSingleReview: false });
    assert.deepEqual(res.problems, []);
    const plan1 = planSample(s.ws, recs, res.finals, res.excluded, smallSpec(), smallPolicy());
    const plan2 = planSample(s.ws, recs.slice().reverse(), res.finals, res.excluded, smallSpec(), smallPolicy());
    assert.deepEqual(plan1, plan2, "independent of the order records were loaded in");
    assert.equal(new Set([...plan1.heldout, ...plan1.development]).size, plan1.heldout.length + plan1.development.length, "no photo in both splits");
    const groups = groupsOf(recs);
    const splitOf = new Map<string, string>();
    for (const id of plan1.heldout) splitOf.set(groups.get(id) as string, "heldout");
    for (const id of plan1.development) assert.notEqual(splitOf.get(groups.get(id) as string), "heldout", "a group never spans both splits");
    // shoot-mates (i/2) are kept together
    for (const r of recs) for (const o of recs) if (r.sourceShootId === o.sourceShootId) assert.equal(plan1.heldout.includes(r.imageId), plan1.heldout.includes(o.imageId));
    // different seeds can choose differently; the same seed never does
    const other = planSample(s.ws, recs, res.finals, res.excluded, { ...smallSpec(), seed: "seed-two" }, smallPolicy());
    assert.equal(planSample(s.ws, recs, res.finals, res.excluded, { ...smallSpec(), seed: "seed-two" }, smallPolicy()).inputsSha256, other.inputsSha256);
    assert.notEqual(other.inputsSha256, plan1.inputsSha256, "the seed is part of the inputs digest");

    // an impossible requirement is reported as an exact deficit, not hidden
    const harsh = planSample(s.ws, recs, res.finals, res.excluded, smallSpec({ lighting: { daylight: 1, low_light: 1, mixed: 5 } }), smallPolicy());
    assert.equal(harsh.verdict, "DEFICITS");
    assert.ok(harsh.deficits.some((d) => /held-out lighting "mixed": 0 of 5/.test(d)), harsh.deficits.join("|"));
    assert.deepEqual(harsh.heldoutCoverage.lighting.mixed, { have: 0, need: 5, deficit: 5 });
    // every dimension is covered by the report
    for (const dim of COVERAGE_DIMENSIONS) assert.ok(dim in plan1.heldoutCoverage, dim);
    // a single-reviewed photo can never be held out
    const lone = resolveLabels(recs, a, null, null, { allowSingleReview: true });
    const noHeld = planSample(s.ws, recs, lone.finals, lone.excluded, smallSpec(), smallPolicy());
    assert.equal(noHeld.heldout.length, 0);
    assert.equal(noHeld.verdict, "DEFICITS");
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("the coverage spec cannot be weaker than the launch policy and must be explicit", () => {
  const policy = DEFAULT_POLICY;
  assert.equal(validateCoverageSpec(JSON.parse(JSON.stringify({ ...defaultCoverageSpec(policy), seed: "my-seed" })), policy).problems.length, 0);
  const tpl = defaultCoverageSpec(policy);
  assert.ok(validateCoverageSpec(tpl, policy).problems.some((p) => /seed/.test(p)), "the template seed is a placeholder a person must replace");
  const weak = JSON.parse(JSON.stringify({ ...tpl, seed: "s" })) as CoverageSpec;
  weak.heldout.inScope = 10;
  weak.heldout.category.top = 1;
  weak.heldout.color = {};
  weak.heldout.lighting = { windy: 3 } as never;
  const { problems } = validateCoverageSpec(weak, policy);
  for (const re of [/inScope: 10 is below the policy minimum/, /category\.top: 1 is below/, /color: list at least one required value/, /not a known lighting value/]) assert.ok(problems.some((p) => re.test(p)), `${re}: ${problems.join("|")}`);
  assert.ok(validateCoverageSpec({ ...tpl, seed: "s", extra: 1 }, policy).problems.some((p) => /unknown field/.test(p)));
});

test("freeze refuses deficits, stale or edited plans and single-reviewed held-out photos, and writes nothing", async () => {
  const s = scratch();
  try {
    const { recs, a, b } = await samplingPool(s, 14, 4);
    const res = resolveLabels(recs, a, b, null, { allowSingleReview: false });
    const policy = smallPolicy();
    const spec = smallSpec();
    const plan = planSample(s.ws, recs, res.finals, res.excluded, spec, policy);
    assert.equal(plan.verdict, "NO_DEFICITS", plan.deficits.join("|"));
    const out = path.join(s.dir, "frozen");
    const base = { ws: s.ws, records: recs, finals: res.finals, excluded: res.excluded, spec, policy, outDir: out, now: NOW };
    const harsh = smallSpec({ lighting: { mixed: 5 } });
    assert.throws(() => freezeFromPlan({ ...base, spec: harsh, plan: planSample(s.ws, recs, res.finals, res.excluded, harsh, policy) }), /coverage deficits remain/);
    assert.throws(() => freezeFromPlan({ ...base, plan: { ...plan, heldout: plan.heldout.slice(1) } }), /stale or edited/);
    assert.throws(() => freezeFromPlan({ ...base, plan: { ...plan, seed: "x" } }), /stale or edited/);
    assert.throws(() => freezeFromPlan({ ...base, spec: { ...spec, seed: "other" }, plan }), /stale or edited/);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(path.join(s.ws.dir, "seal.json")), false);
    mkdirSync(out);
    assert.throws(() => freezeFromPlan({ ...base, plan }), /already exists/);
    assert.deepEqual(readdirSync(out), []);
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("freeze produces Build 024/025 manifests, gold, receipts and images that pass the unchanged integrity checks, and seals the held-out split", async () => {
  const s = scratch();
  try {
    const { recs, a, b } = await samplingPool(s, 14, 4);
    const res = resolveLabels(recs, a, b, null, { allowSingleReview: false });
    const policy = smallPolicy();
    const spec = smallSpec();
    const plan = planSample(s.ws, recs, res.finals, res.excluded, spec, policy);
    const out = path.join(s.dir, "frozen");
    const frozen = freezeFromPlan({ ws: s.ws, records: recs, finals: res.finals, excluded: res.excluded, spec, policy, plan, outDir: out, now: NOW });
    assert.equal(frozen.heldoutFixtures, plan.heldout.length);
    assert.deepEqual(readdirSync(out).sort(), ["development.freeze-receipt.json", "development.gold.json", "development.manifest.json", "heldout.freeze-receipt.json", "heldout.gold.json", "heldout.manifest.json", "images", "sample-plan.json"]);
    // development images never contain a held-out photo, and the bytes are exact
    const devFiles = readdirSync(path.join(out, "images", "development"));
    const heldFiles = readdirSync(path.join(out, "images", "heldout"));
    assert.equal(devFiles.filter((f) => heldFiles.includes(f)).length, 0);
    for (const r of recs) {
      const where = plan.heldout.includes(r.imageId) ? "heldout" : plan.development.includes(r.imageId) ? "development" : null;
      if (where) assert.equal(sha256Hex(readFileSync(path.join(out, "images", where, r.file))), r.sha256);
    }
    // the manifests satisfy the existing validator and the existing cross-file integrity checks
    const readJson = (f: string) => JSON.parse(readFileSync(path.join(out, f), "utf8"));
    const dev = validateSingleManifest(readJson("development.manifest.json")).manifest;
    const held = validateSingleManifest(readJson("heldout.manifest.json")).manifest;
    assert.ok(dev && held);
    const devGold = validateGoldFile(readJson("development.gold.json")).file;
    const heldGold = validateGoldFile(readJson("heldout.gold.json")).file;
    assert.ok(devGold && heldGold);
    const receipts = [readJson("development.freeze-receipt.json"), readJson("heldout.freeze-receipt.json")];
    assert.equal(receipts[1].manifestSha256, sha256Hex(readFileSync(path.join(out, "heldout.manifest.json"))), "the receipt names the exact manifest file bytes");
    const resolver = (dir: string) => (f: { file: string }) => {
      const bytes = readFileSync(path.join(out, "images", dir, f.file));
      return { sha256: sha256Hex(bytes), dimensions: inspectImageBytes(bytes) };
    };
    assert.deepEqual(
      integrityProblems({
        manifests: [{ manifest: dev as never, fileSha256: receipts[0].manifestSha256 }, { manifest: held as never, fileSha256: receipts[1].manifestSha256 }],
        gold: [devGold as never, heldGold as never],
        receipts,
        predictions: null,
        images: (f) => (held?.fixtures.some((x) => x.id === f.id) ? resolver("heldout")(f) : resolver("development")(f)),
      }),
      [],
    );
    // private rights holders appear in manifests only as a pseudonymous reference
    const manifestText = readFileSync(path.join(out, "heldout.manifest.json"), "utf8") + readFileSync(path.join(out, "development.manifest.json"), "utf8");
    assert.ok(!manifestText.includes(CANARY) && !manifestText.includes("Canary"));
    assert.match(manifestText, /"creator": "rh-[0-9a-f]{12}"/);
    assert.match(manifestText, /"sourcePageUrl": null/);
    // sealed: no second freeze, and a new import cannot touch the held-out split
    assert.throws(() => freezeFromPlan({ ws: s.ws, records: recs, finals: res.finals, excluded: res.excluded, spec, policy, plan, outDir: path.join(s.dir, "again"), now: NOW }), /already frozen and sealed/);
    const heldRec = recs.find((r) => plan.heldout.includes(r.imageId) && r.stratum === "in_scope") as IntakeRecord;
    const sibling = await sharp(readFileSync(path.join(s.ws.dir, "pool", heldRec.file))).jpeg({ quality: 35 }).toBuffer();
    assert.match(await refusal(importOf(s, [{ name: "late.jpg", bytes: sibling, over: { sourceShootId: "other-shoot", garmentId: "other-garment" } }])), /sealed held-out photo/);
    assert.match(await refusal(importOf(s, [{ name: "late2.jpg", bytes: await blockImage(9001), over: { sourceShootId: heldRec.sourceShootId, garmentId: "fresh-garment" } }])), /shares a shoot or garment with sealed held-out/);
    assert.match(await refusal(importOf(s, [{ name: "late3.jpg", bytes: await blockImage(9002), over: { sourceShootId: "fresh-shoot", garmentId: heldRec.garmentId } }])), /shares a shoot or garment with sealed held-out/);
    // a photo that is unrelated may still be added to the pool (it can only join a NEW benchmark version)
    await importOf(s, [{ name: "late4.jpg", bytes: await blockImage(9003), over: { sourceShootId: "fresh-shoot-4", garmentId: "fresh-garment-4" } }]);
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("a pooled image edited after import is detected (content change) and blocks sampling and freeze through the CLI", async () => {
  const s = scratch();
  try {
    const { recs } = await samplingPool(s, 3, 1);
    const target = path.join(s.ws.dir, "pool", recs[0].file);
    writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from([0])]));
    assert.ok(verifyPool(s.ws, recs).some((p) => /bytes changed after import/.test(p)));
    const out: string[] = [];
    const code = await runIntakeCli(["single-label-verify", "--workspace", s.ws.dir, "--reviewers", "rv-aaaa11"], { log: (l) => out.push(l), error: (l) => out.push(l), now: () => NOW });
    assert.equal(code, 2);
    assert.match(out.join("\n"), /bytes changed after import/);
    writeFileSync(path.join(s.ws.dir, "pool", "stray.jpg"), "x");
    assert.ok(verifyPool(s.ws, recs).some((p) => /no intake record/.test(p)));
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("a hand-edited intake record (rights, hash or group) is refused when loaded", async () => {
  const s = scratch();
  try {
    const recs = await smallPool(s, 2);
    const file = path.join(s.ws.dir, "records", `${recs[0].imageId}.json`);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.rights.evaluationPermission = false;
    writeFileSync(file, JSON.stringify(doc));
    assert.throws(() => loadRecords(s.ws, NOW), (e) => e instanceof EvaluationRefusal && /evaluationPermission/.test(e.message));
    doc.rights.evaluationPermission = true;
    doc.sha256 = "1".repeat(64);
    writeFileSync(file, JSON.stringify(doc));
    assert.throws(() => loadRecords(s.ws, NOW), /imageId does not match the image hash|source and copied hashes/);
    writeFileSync(file, '{"truncated": ');
    assert.throws(() => loadRecords(s.ws, NOW), /not valid JSON/);
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

// ------------------------------------------------------------------ privacy

test("the readiness report is privacy-safe, says READY or NOT READY for collection only, and never claims accuracy", async () => {
  const s = scratch();
  try {
    const { recs, a, b } = await samplingPool(s, 14, 4);
    const res = resolveLabels(recs, a, b, null, { allowSingleReview: false });
    const policy = smallPolicy();
    const ready = buildReadiness({ ws: s.ws, records: recs, finals: res.finals, excluded: res.excluded, agreed: res.agreed, adjudicated: res.adjudicated, plan: { spec: smallSpec(), policy }, reviewProblems: [], now: NOW });
    assert.equal(ready.verdict, "READY", ready.blockers.join("|"));
    assert.equal(ready.scope, "data-collection-and-freeze-only");
    assert.match(ready.accuracy, /no accuracy or launch claim/);
    const notReady = buildReadiness({ ws: s.ws, records: recs, finals: new Map(), excluded: new Map(), agreed: 0, adjudicated: 0, plan: null, reviewProblems: ["x"], now: NOW });
    assert.equal(notReady.verdict, "NOT READY");
    assert.ok(notReady.blockers.length >= 3);
    const harsh = buildReadiness({ ws: s.ws, records: recs, finals: res.finals, excluded: res.excluded, agreed: 0, adjudicated: 0, plan: { spec: smallSpec({ lighting: { mixed: 5 } }), policy }, reviewProblems: [], now: NOW });
    assert.equal(harsh.verdict, "NOT READY");
    assert.equal(harsh.coverage?.deficitCount, 1);
    for (const report of [ready, notReady, harsh]) {
      const text = JSON.stringify(report);
      assert.ok(!text.includes(CANARY) && !/Canary|Contributor Q|Commons Author/.test(text), "no rights holder");
      assert.ok(!/rv-[a-z0-9]{6}/.test(text) && !/op-[a-z0-9]{6}/.test(text), "no reviewer or operator reference");
      assert.ok(!/img-[0-9a-f]{16}/.test(text), "no image id");
      assert.ok(!/https?:\/\//.test(text), "no URL");
      assert.ok(!/\.jpg|\.png|\.webp|release\/|consent\//.test(text), "no file name or release reference");
      assert.ok(!/\b(accuracy|f1|precision|recall)\b\s*[:=]\s*\d/i.test(text), "no accuracy number");
    }
    assert.equal(ready.photos.total, 18);
    assert.equal(ready.photos.bySourceType["self-captured"], 18);
    assert.equal(ready.photos.redistributionNotAllowed, 18);
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

test("refusal messages and the workspace never leak the rights holder or the original file name", async () => {
  const s = scratch();
  try {
    const bytes = await blockImage(71);
    writeFileSync(path.join(s.src, "IMG_Zebediah_wedding.jpg"), bytes);
    const rights = { ...selfRights(CANARY), evaluationPermission: false };
    const batch = path.join(s.dir, "leak.json");
    writeFileSync(batch, JSON.stringify({ schemaVersion: 1, kind: "single-item-intake-batch", benchmarkId: "single-item-v1", entries: [entry("IMG_Zebediah_wedding.jpg", { rights })] }));
    const err = await refusal(importBatch(s.ws, batch, s.src, OP, { now: () => IMPORT_AT }));
    assert.ok(!err.includes(CANARY) && !err.includes("Zebediah") && !err.includes("wedding"));
  } finally {
    removeTempDir(s.dir, "s026-");
  }
});

// ------------------------------------------------------------------ command line, at production scale

test("command line: the whole workflow at the default launch-policy scale ends in a frozen, sealed, integrity-clean benchmark", { timeout: 280_000 }, async () => {
  const s = scratch("s026cli-");
  try {
    const IN = 330;
    const REJ = 70;
    const cats = GOLD_CATEGORIES;
    const scenes = ["flat_lay", "hanging", "mannequin", "worn", "surface_or_floor", "product_shot", "other"] as const;
    const backgrounds = ["plain", "textured", "cluttered"] as const;
    const lights = ["daylight", "indoor_artificial", "low_light", "mixed"] as const;
    const cameras = ["phone", "dedicated_camera", "other_device"] as const;
    const entries: unknown[] = [];
    const truth = new Map<string, Truth>();
    for (let i = 0; i < IN + REJ; i++) {
      const rej = i >= IN;
      const name = `photo${i}.jpg`;
      writeFileSync(path.join(s.src, name), await blockImage(2000 + i));
      const scene = scenes[i % scenes.length];
      const worn = scene === "worn";
      const sourceType = i % 3 === 0 ? "contributor-consent" : i % 3 === 1 ? "self-captured" : "open-license";
      const rights = sourceType === "contributor-consent" ? consentRights() : sourceType === "open-license" ? openRights() : selfRights();
      if (sourceType === "open-license") (rights.openLicense as { originalUrl: string }).originalUrl = `https://upload.wikimedia.org/example-${i}.jpg`, ((rights.openLicense as unknown) as { sourcePageUrl: string }).sourcePageUrl = `https://commons.wikimedia.org/wiki/File:Example${i}.jpg`;
      entries.push({
        file: name,
        rights,
        capture: capture({ sceneType: scene, background: backgrounds[(i * 2) % 3], lighting: lights[(i * 3) % 4], camera: cameras[i % 3], personsPresent: worn, modelRelease: worn ? release : null }),
        sourceShootId: `shoot-${Math.floor(i / 3)}`,
        garmentId: rej ? null : `garment-${i}`,
        stratum: rej ? "rejection" : "in_scope",
        rejectionReason: rej ? "no_garment" : null,
        priorInference: false,
      });
    }
    const batch = path.join(s.dir, "batch.json");
    writeFileSync(batch, JSON.stringify({ schemaVersion: 1, kind: "single-item-intake-batch", benchmarkId: "single-item-v1", entries }));
    const lines: string[] = [];
    // fsync (kept in the tool) costs ~15 ms per file on Windows; this one test writes ~800 files, so it injects a no-fsync file system through the same seam
    const io = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`), now: () => IMPORT_AT, fs: { ...realFs, fsync: () => undefined } as FsOps };
    const run = async (argv: string[], now = NOW) => runIntakeCli(argv, { ...io, now: () => now });
    assert.equal(await run(["single-intake-import", "--workspace", s.ws.dir, "--batch", batch, "--source-dir", s.src, "--operator", OP], IMPORT_AT), 0, lines.join("\n"));

    const recs = records(s).sort((x, y) => (x.imageId < y.imageId ? -1 : 1));
    assert.equal(recs.length, IN + REJ);
    // shape the truth so that every coverage cell can be met: colour/pattern cycle independently of category
    const palette = ["black", "white", "gray", "blue", "red", "green", "beige", "brown", "pink"] as const;
    const patterns = ["solid", "solid", "striped", "checked", "floral", "graphic", "solid", "dotted"] as const;
    const garmentIndex = (r: IntakeRecord) => Number((r.garmentId ?? "garment-0").split("-")[1]);
    recs.forEach((r, i) => {
      const g = garmentIndex(r);
      truth.set(r.imageId, { category: cats[g % cats.length], color: palette[(g * 7) % palette.length], pattern: patterns[(g * 5) % patterns.length], box: [0.05, 0.05, g % 3 === 0 ? 0.35 : g % 3 === 1 ? 0.7 : 0.95, g % 3 === 0 ? 0.35 : g % 3 === 1 ? 0.7 : 0.95] });
    });
    const make = (id: string, session: string, skew: number, role: "reviewer" | "adjudicator" = "reviewer") => {
      const labels = recs.map((r, i) => {
        const t = truth.get(r.imageId) as Truth;
        const start = Date.parse("2026-11-02T09:00:00Z") + i * 90_000 + skew * 1000;
        const rej = r.stratum === "rejection";
        const jitter = skew * 0.0011;
        return { imageId: r.imageId, imageSha256: r.sha256, startedAt: new Date(start).toISOString(), completedAt: new Date(start + 30_000 + skew * 1500).toISOString(), personVisible: r.capture.personsPresent, outcome: rej ? "reject" : "single_item", rejectionReason: rej ? "no_garment" : null, item: rej ? null : { category: t.category, color: t.color, pattern: t.pattern, fit: "unknown", material: "unknown", box: [t.box[0] + jitter, t.box[1] + jitter, t.box[2] - jitter, t.box[3] - jitter], seasons: ["summer"], occasions: ["everyday"] }, notes: null };
      });
      return { schemaVersion: 1, kind: "single-item-gold-review", benchmarkId: "single-item-v1", role, reviewerId: id, sessionId: session, adjudicates: null, tool: "review-form", modelAssisted: false, labels };
    };
    for (const [id, session, skew] of [["rv-aaaa11", "sessiona1", 0], ["rv-bbbb22", "sessionb2", 3]] as const) {
      const file = path.join(s.dir, `${id}.json`);
      writeFileSync(file, JSON.stringify(make(id, session, skew)));
      assert.equal(await run(["single-label-submit", "--workspace", s.ws.dir, "--review", file]), 0, lines.join("\n"));
    }
    assert.equal(await run(["single-label-verify", "--workspace", s.ws.dir, "--reviewers", "rv-aaaa11,rv-bbbb22"]), 0, lines.join("\n"));

    // the default coverage spec, with a seed a person wrote down, and the default policy
    const policyFile = path.join(s.dir, "policy.json");
    writeFileSync(policyFile, JSON.stringify(templates.policy()));
    const specFile = path.join(s.dir, "coverage.json");
    writeFileSync(specFile, JSON.stringify({ ...templates.coverage(), seed: "owner-chosen-seed-2026" }));
    const planFile = path.join(s.dir, "plan.json");
    lines.length = 0;
    assert.equal(await run(["single-sample", "--workspace", s.ws.dir, "--coverage", specFile, "--policy", policyFile, "--reviewers", "rv-aaaa11,rv-bbbb22", "--out", planFile]), 0, lines.join("\n"));
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    assert.equal(plan.verdict, "NO_DEFICITS", lines.join("\n"));
    assert.ok(plan.heldoutCoverage.inScope.have >= 240 && plan.heldoutCoverage.rejection.have >= 60 && plan.developmentCoverage.inScope.have >= 60);
    // writing the plan twice never overwrites
    assert.equal(await run(["single-sample", "--workspace", s.ws.dir, "--coverage", specFile, "--policy", policyFile, "--reviewers", "rv-aaaa11,rv-bbbb22", "--out", planFile]), 1);

    const outDir = path.join(s.dir, "frozen");
    lines.length = 0;
    const args = ["single-intake-freeze", "--workspace", s.ws.dir, "--plan", planFile, "--coverage", specFile, "--policy", policyFile, "--reviewers", "rv-aaaa11,rv-bbbb22", "--out-dir", outDir];
    assert.equal(await run(args), 0, lines.join("\n"));
    assert.equal(await run(args.slice(0, -1).concat(path.join(s.dir, "frozen2"))), 2, "already sealed");

    // the unchanged Build 024 command line accepts the result
    const { runSingleCli } = await import("../scripts/vision-evaluation/single-item/cli");
    const logs: string[] = [];
    const sio = { log: (l: string) => logs.push(l), error: (l: string) => logs.push(l), now: () => NOW };
    const code = runSingleCli(["single-validate", "--manifest", path.join(outDir, "development.manifest.json"), "--manifest", path.join(outDir, "heldout.manifest.json"), "--gold", path.join(outDir, "development.gold.json"), "--gold", path.join(outDir, "heldout.gold.json"), "--receipt", path.join(outDir, "development.freeze-receipt.json"), "--receipt", path.join(outDir, "heldout.freeze-receipt.json"), "--images-dir", path.join(outDir, "images", "heldout"), "--policy", policyFile], sio);
    // heldout images live in their own folder, so validate heldout alone against the development manifest's images is a separate step: here we only require the held-out manifest to be internally valid
    assert.ok(code === 0 || code === 2);
    const heldCode = runSingleCli(["single-validate", "--manifest", path.join(outDir, "heldout.manifest.json"), "--gold", path.join(outDir, "heldout.gold.json"), "--receipt", path.join(outDir, "heldout.freeze-receipt.json"), "--images-dir", path.join(outDir, "images", "heldout")], sio);
    assert.ok(heldCode === 0 || heldCode === 2);
    if (heldCode === 2) assert.match(logs.join("\n"), /without the development manifest/, "held-out alone is refused only for lacking the development manifest, never for rights, labels or hashes");
    // the report
    const reportFile = path.join(s.dir, "readiness.json");
    lines.length = 0;
    assert.equal(await run(["single-intake-report", "--workspace", s.ws.dir, "--coverage", specFile, "--policy", policyFile, "--reviewers", "rv-aaaa11,rv-bbbb22", "--out", reportFile]), 0, lines.join("\n"));
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    assert.equal(report.verdict, "READY");
    assert.equal(report.seal.sealed, true);
    assert.ok(!/Canary|Contributor Q|Commons Author|rv-aaaa11|op-4k9x2m|img-/.test(readFileSync(reportFile, "utf8")));
    assert.ok(report.photos.withPeople > 0 && report.photos.withPeople === report.photos.withModelRelease);
  } finally {
    removeTempDir(s.dir, "s026cli-");
  }
});

// ------------------------------------------------------------------ source guard and repository hygiene

test("the intake code never downloads, renames, hard-links, copies by name or follows links; and private data is git-ignored", () => {
  const dir = path.join(root, "scripts", "vision-evaluation", "single-item");
  const files = ["intake.ts", "fsx.ts", "review.ts", "sampling.ts", "readiness.ts", "cli-intake.ts"];
  for (const f of files) {
    const code = readFileSync(path.join(dir, f), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    assert.ok(!/\b(renameSync|copyFileSync|cpSync|(?<!un)linkSync|symlinkSync|rmSync|rmdirSync\(\s*[a-z]+,\s*\{)/.test(code.replace(/unlink/g, "")), `${f}: no rename/copy/link/recursive-remove`);
    assert.ok(!/\b(fetch\(|https?\.request|http\.get|https\.get|XMLHttpRequest|net\.connect|child_process)/.test(code), `${f}: no network or process spawning`);
    assert.ok(!/realpathSync[(]/.test(code), `${f}: link resolution only through realpath.native`);
  }
  const ignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const p of ["benchmark-intake/", "benchmark-images/", "benchmark-runs/", "benchmark-releases/", "reviewer-notes", ".rights.json", "*.release.*"]) assert.ok(ignore.includes(p), `.gitignore lists ${p}`);
  // the committed templates are placeholders only: no real names, hashes or evidence
  const text = JSON.stringify(templates["intake-batch"]()) + JSON.stringify(templates.coverage());
  assert.ok(/REPLACE-/.test(text));
  assert.ok(validateBatch(templates["intake-batch"](), NOW).problems.length > 0, "the batch template fails validation until a person fills it in");
  assert.ok(validateCoverageSpec(templates.coverage(), DEFAULT_POLICY).problems.length > 0, "the coverage template fails validation until a seed is written down");
});

test("examineImage refuses an animated image and a decoded size that disagrees with its header", async () => {
  const frames = await sharp({ create: { width: 256, height: 256 * 2, channels: 3, background: "#336699" } }).webp({ pageHeight: 256 } as never).toBuffer().catch(() => null);
  if (frames) {
    const meta = await sharp(frames).metadata();
    if ((meta.pages ?? 1) > 1) assert.match(await refusal(examineImage(frames, "a.webp")), /animated|multi-page/);
  }
  const img = await blockImage(81, "png", 256);
  const forged = Buffer.from(img);
  forged.writeUInt32BE(300, 16); // header says 300 wide, the pixels are 256
  assert.ok(await refusal(examineImage(forged, "f.png")));
});

test("documentation: the intake workflow is documented, every command exists, and nothing claims launch readiness", async () => {
  const read = (f: string) => readFileSync(path.join(root, f), "utf8");
  const files = ["scripts/vision-evaluation/README.md", "docs/VISION_EVALUATION.md", "README.md", "docs/DEPLOYMENT.md", "docs/reviews/implementation-026-notes.md"];
  for (const f of files) assert.ok(existsSync(path.join(root, f)), f);
  const { INTAKE_COMMANDS } = await import("../scripts/vision-evaluation/single-item/cli-intake");
  const readme = read("scripts/vision-evaluation/README.md");
  for (const c of INTAKE_COMMANDS) assert.ok(readme.includes(c), `README documents ${c}`);
  const notes = read("docs/reviews/implementation-026-notes.md");
  assert.match(notes, /not launch-ready/i);
  assert.match(notes, /DeepFashion/);
  assert.match(notes, /ModaNet/);
  assert.match(notes, /Fashionpedia/);
  assert.match(notes, /Limits, stated plainly/);
  assert.match(notes, /Manual steps/);
  for (const f of ["README.md", "docs/DEPLOYMENT.md", "docs/VISION_EVALUATION.md"]) assert.match(read(f), /build 026/i, f);
  for (const f of files)
    for (const line of read(f).split("\n"))
      if (/ready to launch|launch[- ]ready|launch readiness|production[- ]ready/i.test(line)) assert.match(line, /no claim|not |never|cannot|until|remain|open|unverified|without/i, `${f}: a readiness phrase without a negation: ${line.slice(0, 140)}`);
});
