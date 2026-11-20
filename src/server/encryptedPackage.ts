import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { syncFile, type SyncOutcome } from "./durableFs";

/**
 * Encrypted portable backup package, format version 1 (build 021).
 *
 * WHAT IT PROTECTS. A package is ONE file holding the sanitised database backup
 * and the deletion ledger exported at or after it, encrypted and authenticated
 * with a key derived from an operator passphrase. It protects the copied
 * artifact AT REST (an off-server copy, a stolen disk image, a leaked bucket).
 * It does not protect against someone who holds the passphrase, against a
 * compromised running server, or against loss of the passphrase: without it the
 * data is unrecoverable by design. It is not a signature scheme: anyone with the
 * passphrase can make a valid package.
 *
 * LAYOUT (big-endian, exactly this, nothing optional):
 *
 *   offset size field
 *   0      8    magic "STYLEPKG"
 *   8      2    format version (1)
 *   10     1    KDF id (1 = scrypt)
 *   11     1    flags (must be 0)
 *   12     1    scrypt log2(N)  accepted 15..18
 *   13     1    scrypt r        accepted 8
 *   14     1    scrypt p        accepted 1
 *   15     1    reserved (must be 0)
 *   16     16   random salt
 *   32     12   random GCM nonce
 *   44     8    backupCreatedAt, ms since epoch (when the backup was made)
 *   52     8    databaseLength, bytes
 *   60     4    ledgerLength, bytes
 *   64     databaseLength + ledgerLength   AES-256-GCM ciphertext of
 *                                          database bytes || ledger bytes
 *   end-16 16   GCM authentication tag
 *
 * The 64 header bytes are the GCM additional authenticated data, so the
 * version, KDF settings, salt, nonce, time and both lengths are authenticated:
 * changing any of them, truncating, appending or swapping parts fails
 * authentication. The file size must equal 64 + databaseLength + ledgerLength +
 * 16 EXACTLY. One key, one nonce, one message: a fresh random salt and nonce
 * per package means the nonce is never reused under a key.
 *
 * BOUNDS ARE CHECKED BEFORE ANY EXPENSIVE WORK. magic, version, KDF id, flags,
 * scrypt settings (memory = 128 * N * r is at most 256 MiB), the declared
 * lengths against the limits and against the real file size are all validated
 * from the 64 header bytes and the file size before the key is derived and
 * before any buffer larger than a fixed 1 MiB chunk exists.
 *
 * RESTORE IS TWO PASSES. Pass 1 decrypts to nowhere and checks the tag: a wrong
 * passphrase, any modification or a truncation is refused having written
 * nothing. Only an authenticated package goes to pass 2, which decrypts the
 * database to a caller-supplied owner-only staging file (the tag is verified
 * again at its end).
 *
 * Errors carry a fixed code and fixed text. They never contain the passphrase,
 * a path, or file content.
 */

export const PACKAGE_MAGIC = Buffer.from("STYLEPKG", "ascii");
export const PACKAGE_VERSION = 1;
export const HEADER_BYTES = 64;
export const TAG_BYTES = 16;
const KEY_BYTES = 32;
const CHUNK_BYTES = 1024 * 1024;

export type KdfParams = { logN: number; r: number; p: number };
/** scrypt N=2^17, r=8, p=1: 128 MiB, the usual interactive-to-offline default. */
export const DEFAULT_KDF: KdfParams = { logN: 17, r: 8, p: 1 };
export const KDF_LIMITS = { minLogN: 15, maxLogN: 18, r: 8, p: 1 } as const;

export type PackageLimits = { maxDatabaseBytes: number; maxLedgerBytes: number };
export const DEFAULT_LIMITS: PackageLimits = {
  maxDatabaseBytes: 8 * 1024 * 1024 * 1024,
  // The same ceiling the ledger parser itself enforces.
  maxLedgerBytes: 32 * 1024 * 1024,
};

export type PackageErrorCode =
  | "PASSPHRASE_MISSING"
  | "PASSPHRASE_AMBIGUOUS"
  | "PASSPHRASE_WEAK"
  | "PASSPHRASE_FILE"
  | "FORMAT"
  | "VERSION"
  | "KDF"
  | "TOO_LARGE"
  | "TRUNCATED"
  | "AUTH"
  | "INPUT"
  | "VERIFY";

export class PackageError extends Error {
  constructor(
    readonly code: PackageErrorCode,
    text: string,
  ) {
    super(text);
    this.name = "PackageError";
  }
}
const fail = (code: PackageErrorCode, text: string) => new PackageError(code, text);

export type PackageInfo = {
  version: number;
  kdf: KdfParams;
  /** When the packaged backup was made, ms since epoch. */
  backupCreatedAt: number;
  databaseBytes: number;
  ledgerBytes: number;
};

export type PackageStage = "header-written" | "encrypted" | "synced";

const DAY_MS = 86_400_000;

function kdfMaxmem(kdf: KdfParams): number {
  // 128 * N * r bytes are needed; allow exactly that plus a small margin.
  return 128 * 2 ** kdf.logN * kdf.r + 4 * 1024 * 1024;
}

function checkKdf(kdf: KdfParams): void {
  if (
    !Number.isInteger(kdf.logN) ||
    kdf.logN < KDF_LIMITS.minLogN ||
    kdf.logN > KDF_LIMITS.maxLogN ||
    kdf.r !== KDF_LIMITS.r ||
    kdf.p !== KDF_LIMITS.p
  )
    throw fail("KDF", "The package's key-derivation settings are outside the accepted bounds.");
}

export function deriveKey(passphrase: Buffer, salt: Buffer, kdf: KdfParams): Buffer {
  checkKdf(kdf);
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: 2 ** kdf.logN,
    r: kdf.r,
    p: kdf.p,
    maxmem: kdfMaxmem(kdf),
  });
}

type Header = PackageInfo & { salt: Buffer; nonce: Buffer; raw: Buffer };

function buildHeader(h: {
  kdf: KdfParams;
  salt: Buffer;
  nonce: Buffer;
  backupCreatedAt: number;
  databaseBytes: number;
  ledgerBytes: number;
}): Buffer {
  const b = Buffer.alloc(HEADER_BYTES);
  PACKAGE_MAGIC.copy(b, 0);
  b.writeUInt16BE(PACKAGE_VERSION, 8);
  b[10] = 1;
  b[11] = 0;
  b[12] = h.kdf.logN;
  b[13] = h.kdf.r;
  b[14] = h.kdf.p;
  b[15] = 0;
  h.salt.copy(b, 16);
  h.nonce.copy(b, 32);
  b.writeBigUInt64BE(BigInt(h.backupCreatedAt), 44);
  b.writeBigUInt64BE(BigInt(h.databaseBytes), 52);
  b.writeUInt32BE(h.ledgerBytes, 60);
  return b;
}

/**
 * Validates 64 header bytes and the real file size. Pure: no key, no
 * allocation beyond the returned object. Throws PackageError.
 */
export function parseHeader(
  raw: Buffer,
  fileSize: number,
  limits: PackageLimits = DEFAULT_LIMITS,
  now: number = Date.now(),
): Header {
  if (raw.length !== HEADER_BYTES || !raw.subarray(0, 8).equals(PACKAGE_MAGIC))
    throw fail("FORMAT", "This is not a Style Studio backup package.");
  if (raw.readUInt16BE(8) !== PACKAGE_VERSION)
    throw fail("VERSION", "This package was made by an unsupported format version.");
  if (raw[10] !== 1 || raw[11] !== 0 || raw[15] !== 0)
    throw fail("FORMAT", "The package header is not valid.");
  const kdf: KdfParams = { logN: raw[12], r: raw[13], p: raw[14] };
  checkKdf(kdf);
  const created = raw.readBigUInt64BE(44);
  const dbLen = raw.readBigUInt64BE(52);
  const ledgerLen = raw.readUInt32BE(60);
  if (created <= BigInt(0) || created > BigInt(now + DAY_MS))
    throw fail("FORMAT", "The package header is not valid.");
  if (dbLen < BigInt(1) || ledgerLen < 1)
    throw fail("FORMAT", "The package header is not valid.");
  if (dbLen > BigInt(limits.maxDatabaseBytes) || ledgerLen > limits.maxLedgerBytes)
    throw fail("TOO_LARGE", "The package declares more data than this restore accepts.");
  const expected = HEADER_BYTES + Number(dbLen) + ledgerLen + TAG_BYTES;
  if (fileSize < expected)
    throw fail("TRUNCATED", "The package file is shorter than its header says: it is truncated or incomplete.");
  if (fileSize > expected)
    throw fail("FORMAT", "The package file is longer than its header says.");
  return {
    version: PACKAGE_VERSION,
    kdf,
    backupCreatedAt: Number(created),
    databaseBytes: Number(dbLen),
    ledgerBytes: ledgerLen,
    salt: Buffer.from(raw.subarray(16, 32)),
    nonce: Buffer.from(raw.subarray(32, 44)),
    raw: Buffer.from(raw),
  };
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** Opens a regular file for reading without following a final link. */
function openRegular(file: string): { fd: number; size: number } {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch {
    throw fail("INPUT", "The file cannot be opened as a plain file.");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw fail("INPUT", "The file cannot be opened as a plain file.");
    return { fd, size: info.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function eachChunk(
  fd: number,
  start: number,
  length: number,
  buffer: Buffer,
  fn: (chunk: Buffer) => void,
): void {
  let done = 0;
  while (done < length) {
    const want = Math.min(buffer.length, length - done);
    const n = readSync(fd, buffer, 0, want, start + done);
    if (n <= 0) throw fail("TRUNCATED", "The file ended before its declared length.");
    fn(buffer.subarray(0, n));
    done += n;
  }
}

function writeAll(fd: number, chunk: Buffer): void {
  let off = 0;
  while (off < chunk.length) off += writeSync(fd, chunk, off, chunk.length - off);
}

export type WritePackageOptions = {
  /** The sanitised database backup (a plain file). */
  databaseFile: string;
  /** The validated ledger text to embed (canonical, from serializeLedger). */
  ledgerText: string;
  backupCreatedAt: number;
  passphrase: Buffer;
  /** Created exclusively with owner-only permissions; must not exist. */
  destination: string;
  kdf?: KdfParams;
  limits?: PackageLimits;
  /** A throw aborts like a real failure at that point (failure-injection tests). */
  onStage?: (stage: PackageStage) => void | Promise<void>;
  syncFile?: (file: string) => SyncOutcome;
};

/**
 * Writes a package to `destination` and flushes it. The caller owns the file
 * (it is a partial until published) and removes it if this throws.
 */
export async function writePackage(options: WritePackageOptions): Promise<PackageInfo> {
  const kdf = options.kdf ?? DEFAULT_KDF;
  const limits = options.limits ?? DEFAULT_LIMITS;
  checkKdf(kdf);
  const ledger = Buffer.from(options.ledgerText, "utf8");
  if (ledger.length < 1 || ledger.length > limits.maxLedgerBytes)
    throw fail("TOO_LARGE", "The ledger is empty or larger than a package accepts.");
  if (!Number.isSafeInteger(options.backupCreatedAt) || options.backupCreatedAt <= 0)
    throw fail("FORMAT", "The backup time is not valid.");

  const source = openRegular(options.databaseFile);
  let out = -1;
  let key: Buffer | null = null;
  try {
    if (source.size < 1 || source.size > limits.maxDatabaseBytes)
      throw fail("TOO_LARGE", "The database backup is empty or larger than a package accepts.");
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const header = buildHeader({
      kdf,
      salt,
      nonce,
      backupCreatedAt: options.backupCreatedAt,
      databaseBytes: source.size,
      ledgerBytes: ledger.length,
    });
    key = deriveKey(options.passphrase, salt, kdf);
    out = openSync(options.destination, "wx", 0o600);
    writeAll(out, header);
    await options.onStage?.("header-written");

    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let read = 0;
    eachChunk(source.fd, 0, source.size, buffer, (chunk) => {
      read += chunk.length;
      writeAll(out, cipher.update(chunk));
    });
    if (read !== source.size) throw fail("INPUT", "The database backup changed while it was read.");
    writeAll(out, cipher.update(ledger));
    writeAll(out, cipher.final());
    writeAll(out, cipher.getAuthTag());
    await options.onStage?.("encrypted");
    closeSync(out);
    out = -1;
    (options.syncFile ?? syncFile)(options.destination);
    await options.onStage?.("synced");
    return {
      version: PACKAGE_VERSION,
      kdf,
      backupCreatedAt: options.backupCreatedAt,
      databaseBytes: source.size,
      ledgerBytes: ledger.length,
    };
  } finally {
    key?.fill(0);
    if (out >= 0) closeSync(out);
    closeSync(source.fd);
  }
}

export type Authenticated = { info: PackageInfo; header: Buffer; key: Buffer };

type Sink = (part: "database" | "ledger", chunk: Buffer) => void;

function decryptRun(file: string, header: Header, key: Buffer, sink: Sink): void {
  const { fd, size } = openRegular(file);
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    if (readSync(fd, head, 0, HEADER_BYTES, 0) !== HEADER_BYTES || !head.equals(header.raw))
      throw fail("AUTH", "The package could not be authenticated.");
    const tag = Buffer.alloc(TAG_BYTES);
    if (readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES) !== TAG_BYTES)
      throw fail("TRUNCATED", "The file ended before its declared length.");
    const decipher = createDecipheriv("aes-256-gcm", key, header.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(header.raw);
    decipher.setAuthTag(tag);
    let position = 0;
    const route = (plain: Buffer) => {
      let chunk = plain;
      while (chunk.length) {
        const inDatabase = position < header.databaseBytes;
        const room = inDatabase ? header.databaseBytes - position : Infinity;
        const take = Math.min(chunk.length, room);
        sink(inDatabase ? "database" : "ledger", chunk.subarray(0, take));
        position += take;
        chunk = chunk.subarray(take);
      }
    };
    eachChunk(
      fd,
      HEADER_BYTES,
      header.databaseBytes + header.ledgerBytes,
      Buffer.allocUnsafe(CHUNK_BYTES),
      (cipherText) => route(decipher.update(cipherText)),
    );
    try {
      route(decipher.final());
    } catch {
      throw fail(
        "AUTH",
        "The package could not be authenticated: the passphrase is wrong, or the file was altered or damaged.",
      );
    }
  } finally {
    closeSync(fd);
  }
}

function readHeader(file: string, limits: PackageLimits): Header {
  const { fd, size } = openRegular(file);
  try {
    if (size < HEADER_BYTES + TAG_BYTES + 2)
      throw fail("TRUNCATED", "The package file is too short to be a package.");
    const raw = Buffer.alloc(HEADER_BYTES);
    if (readSync(fd, raw, 0, HEADER_BYTES, 0) !== HEADER_BYTES)
      throw fail("TRUNCATED", "The package file is too short to be a package.");
    return parseHeader(raw, size, limits);
  } finally {
    closeSync(fd);
  }
}

/**
 * Pass 1. Validates format and bounds from the header and the file size, THEN
 * derives the key and authenticates the whole file without writing anything.
 * Returns what pass 2 needs; the caller must `key.fill(0)` when done.
 */
export function authenticatePackage(
  file: string,
  passphrase: Buffer,
  limits: PackageLimits = DEFAULT_LIMITS,
): Authenticated {
  const header = readHeader(file, limits);
  const key = deriveKey(passphrase, header.salt, header.kdf);
  try {
    decryptRun(file, header, key, () => undefined);
  } catch (error) {
    key.fill(0);
    throw error;
  }
  const { salt: _salt, nonce: _nonce, raw, ...info } = header;
  void _salt;
  void _nonce;
  return { info, header: raw, key };
}

/**
 * Pass 2 for an authenticated package: writes the decrypted database to
 * `databaseDestination` (created exclusively, owner-only) and returns the
 * ledger text. The tag is verified again at the end. On failure the caller
 * removes the destination.
 */
export function extractPackage(
  file: string,
  authenticated: Authenticated,
  databaseDestination: string,
  limits: PackageLimits = DEFAULT_LIMITS,
): string {
  const header = readHeader(file, limits);
  if (!header.raw.equals(authenticated.header))
    throw fail("AUTH", "The package could not be authenticated.");
  const out = openSync(databaseDestination, "wx", 0o600);
  const ledger: Buffer[] = [];
  try {
    decryptRun(file, header, authenticated.key, (part, chunk) => {
      if (part === "database") writeAll(out, chunk);
      else ledger.push(Buffer.from(chunk));
    });
  } finally {
    closeSync(out);
  }
  return Buffer.concat(ledger).toString("utf8");
}

/** Authenticates a package without extracting anything (used to verify a fresh one). */
export function verifyPackage(
  file: string,
  passphrase: Buffer,
  limits: PackageLimits = DEFAULT_LIMITS,
): PackageInfo {
  const authenticated = authenticatePackage(file, passphrase, limits);
  authenticated.key.fill(0);
  return authenticated.info;
}
