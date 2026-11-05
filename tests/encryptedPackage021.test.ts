import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadPassphrase, validatePassphrase } from "../src/server/backupPassphrase";
import {
  authenticatePackage,
  extractPackage,
  HEADER_BYTES,
  PackageError,
  parseHeader,
  TAG_BYTES,
  verifyPackage,
  writePackage,
  type KdfParams,
  type PackageErrorCode,
} from "../src/server/encryptedPackage";
import { serializeLedger } from "../src/server/deletionLedger";
import { makeTempDir, removeTempDir } from "./helpers/tempDir";

/**
 * Build 021: the encrypted package format and the passphrase loader. Pure file
 * tests: no database, no child process. The key-derivation cost is lowered to
 * its accepted minimum (2^15) here only; the commands use the default (2^17)
 * and tests/encryptedBackup021.test.ts runs them for real.
 */

const PREFIX = "style-pkg021-";
const root = makeTempDir(PREFIX);
after(() => removeTempDir(root, PREFIX));

const FAST: KdfParams = { logN: 15, r: 8, p: 1 };
const PASS = Buffer.from("correct horse battery staple 2026!", "utf8");
const OTHER = Buffer.from("a different passphrase entirely 77", "utf8");
const MARKER = "PLAINTEXT-MARKER-must-not-appear";
const created = Date.parse("2026-05-01T10:00:00.000Z");
const ledgerText = serializeLedger({
  generation: 3,
  exportedAt: created + 1000,
  entries: [{ userId: "deleted-user-1", deletedAt: created - 5000 }],
});

let counter = 0;
const next = (name: string) => path.join(root, `${++counter}-${name}`);

/** A stand-in "database": SQLite magic, then random bytes, with a readable marker inside. */
function fakeDatabase(size = 300_000): string {
  const file = next("db");
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from("SQLite format 3\0", "latin1"),
      Buffer.from(MARKER),
      randomBytes(size),
    ]),
  );
  return file;
}

async function makePackage(
  options: { passphrase?: Buffer; limits?: { maxDatabaseBytes: number; maxLedgerBytes: number } } = {},
) {
  const databaseFile = fakeDatabase();
  const destination = next("pkg");
  const info = await writePackage({
    databaseFile,
    ledgerText,
    backupCreatedAt: created,
    passphrase: options.passphrase ?? PASS,
    destination,
    kdf: FAST,
    limits: options.limits,
  });
  return { databaseFile, destination, info };
}

function codeOf(fn: () => unknown): PackageErrorCode {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof PackageError, `a PackageError, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected a PackageError");
}

const copyAs = (file: string, edit: (bytes: Buffer) => Buffer): string => {
  const out = next("variant");
  writeFileSync(out, edit(readFileSync(file)));
  return out;
};

test("round trip: the database and ledger come back byte for byte, the package holds no plaintext and has the exact documented size", async () => {
  const { databaseFile, destination, info } = await makePackage();
  const bytes = readFileSync(destination);
  assert.equal(
    bytes.length,
    HEADER_BYTES + info.databaseBytes + info.ledgerBytes + TAG_BYTES,
    "size is exactly header + database + ledger + tag",
  );
  assert.equal(bytes.subarray(0, 8).toString("ascii"), "STYLEPKG");
  assert.equal(bytes.readUInt16BE(8), 1, "format version");
  assert.ok(!bytes.includes(MARKER), "no database plaintext");
  assert.ok(!bytes.includes("SQLite format 3"), "no SQLite header");
  assert.ok(!bytes.includes("style-deletion-ledger"), "no ledger plaintext");
  assert.ok(!bytes.includes("deleted-user-1"), "no user id");
  assert.ok(!bytes.includes(PASS), "no passphrase");

  const authenticated = authenticatePackage(destination, PASS);
  assert.equal(authenticated.info.backupCreatedAt, created);
  assert.deepEqual(authenticated.info.kdf, FAST);
  const staged = next("staged");
  const ledger = extractPackage(destination, authenticated, staged);
  authenticated.key.fill(0);
  assert.ok(readFileSync(staged).equals(readFileSync(databaseFile)));
  assert.equal(ledger, ledgerText);
  assert.equal(verifyPackage(destination, PASS).databaseBytes, info.databaseBytes);
});

test("every package has a fresh random salt and nonce, so the same input never encrypts the same way", async () => {
  const databaseFile = fakeDatabase(50_000);
  const make = async () => {
    const destination = next("same");
    await writePackage({
      databaseFile,
      ledgerText,
      backupCreatedAt: created,
      passphrase: PASS,
      destination,
      kdf: FAST,
    });
    return readFileSync(destination);
  };
  const a = await make();
  const b = await make();
  assert.ok(!a.subarray(16, 32).equals(b.subarray(16, 32)), "salt differs");
  assert.ok(!a.subarray(32, 44).equals(b.subarray(32, 44)), "nonce differs");
  assert.ok(!a.subarray(HEADER_BYTES).equals(b.subarray(HEADER_BYTES)), "ciphertext differs");
});

test("a wrong passphrase is refused as an authentication failure, writes nothing, and the error never contains either passphrase", async () => {
  const { destination } = await makePackage();
  const staging = next("never-created");
  let message = "";
  assert.equal(
    codeOf(() => {
      try {
        authenticatePackage(destination, OTHER);
      } catch (error) {
        message = (error as Error).message;
        throw error;
      }
    }),
    "AUTH",
  );
  assert.equal(existsSync(staging), false);
  assert.ok(!message.includes(OTHER.toString()) && !message.includes(PASS.toString()));
  assert.ok(!message.includes(root), "no path in the message");
});

test("flipping any single header byte is refused, never accepted", async () => {
  const { destination } = await makePackage();
  const refusals = new Set<string>();
  for (let offset = 0; offset < HEADER_BYTES; offset++) {
    const variant = copyAs(destination, (b) => {
      b[offset] ^= 0x01;
      return b;
    });
    refusals.add(codeOf(() => verifyPackage(variant, PASS)));
  }
  // The refusals come from the right layer: format/version/bounds before
  // the key is derived, authentication for the authenticated fields.
  for (const code of refusals)
    assert.ok(
      ["FORMAT", "VERSION", "KDF", "TOO_LARGE", "TRUNCATED", "AUTH"].includes(code),
      code,
    );
  assert.ok(refusals.has("AUTH"), "salt, nonce and time are caught by authentication");
});

test("flipping a byte anywhere in the ciphertext or the tag is refused, with nothing written", async () => {
  const { destination, info } = await makePackage();
  const size = readFileSync(destination).length;
  const positions = [
    HEADER_BYTES,
    HEADER_BYTES + 1,
    HEADER_BYTES + Math.floor(info.databaseBytes / 2),
    HEADER_BYTES + info.databaseBytes - 1, // last database byte
    HEADER_BYTES + info.databaseBytes, // first ledger byte
    size - TAG_BYTES - 1, // last ciphertext byte
    size - TAG_BYTES, // first tag byte
    size - 1, // last tag byte
  ];
  for (const position of positions) {
    const variant = copyAs(destination, (b) => {
      b[position] ^= 0x80;
      return b;
    });
    assert.equal(codeOf(() => verifyPackage(variant, PASS)), "AUTH", `byte ${position}`);
  }
});

test("truncation and extension are refused from the file size alone, before any key is derived", async () => {
  const { destination } = await makePackage();
  const size = readFileSync(destination).length;
  const refused = (bytes: number) => {
    const variant = next("truncated");
    writeFileSync(variant, readFileSync(destination).subarray(0, bytes));
    return codeOf(() => verifyPackage(variant, PASS));
  };
  assert.equal(refused(size - 1), "TRUNCATED");
  assert.equal(refused(size - TAG_BYTES), "TRUNCATED");
  assert.equal(refused(size - 100_000), "TRUNCATED");
  assert.equal(refused(HEADER_BYTES), "TRUNCATED");
  assert.equal(refused(10), "TRUNCATED");
  assert.equal(refused(0), "TRUNCATED");
  const longer = copyAs(destination, (b) => Buffer.concat([b, Buffer.from([0])]));
  assert.equal(codeOf(() => verifyPackage(longer, PASS)), "FORMAT");
  // A shrunk file whose header was also edited to match is still refused: the
  // lengths are authenticated.
  const sneaky = copyAs(destination, (b) => {
    b.writeBigUInt64BE(BigInt(10), 52);
    return b.subarray(0, HEADER_BYTES + 10 + readFileSync(destination).readUInt32BE(60) + TAG_BYTES);
  });
  assert.equal(codeOf(() => verifyPackage(sneaky, PASS)), "AUTH");
});

test("malformed headers: bad magic, unknown version, KDF id, flags, reserved byte, impossible time and lengths", async () => {
  const { destination } = await makePackage();
  const edit = (apply: (b: Buffer) => void) => {
    const variant = copyAs(destination, (b) => {
      apply(b);
      return b;
    });
    return codeOf(() => verifyPackage(variant, PASS));
  };
  assert.equal(edit((b) => b.write("NOTAPKG!", 0, "ascii")), "FORMAT");
  assert.equal(edit((b) => b.writeUInt16BE(2, 8)), "VERSION");
  assert.equal(edit((b) => b.writeUInt16BE(0, 8)), "VERSION");
  assert.equal(edit((b) => (b[10] = 2)), "FORMAT");
  assert.equal(edit((b) => (b[11] = 1)), "FORMAT");
  assert.equal(edit((b) => (b[15] = 1)), "FORMAT");
  assert.equal(edit((b) => b.writeBigUInt64BE(BigInt(0), 44)), "FORMAT");
  assert.equal(edit((b) => b.writeBigUInt64BE(BigInt(Date.now()) + BigInt(10 * 86_400_000), 44)), "FORMAT");
  assert.equal(edit((b) => b.writeBigUInt64BE(BigInt(0), 52)), "FORMAT");
  assert.equal(edit((b) => b.writeUInt32BE(0, 60)), "FORMAT");
  // A text file and an empty-ish file are not packages either.
  const text = next("text");
  writeFileSync(text, "just some text that is long enough to pass the size check ".repeat(4));
  assert.equal(codeOf(() => verifyPackage(text, PASS)), "FORMAT");
});

test("excessive or abnormal key-derivation settings are refused as KDF errors before any derivation", async () => {
  const { destination } = await makePackage();
  const kdfCode = (logN: number, r: number, p: number) => {
    const variant = copyAs(destination, (b) => {
      b[12] = logN;
      b[13] = r;
      b[14] = p;
      return b;
    });
    return codeOf(() => verifyPackage(variant, PASS));
  };
  // Had scrypt been invoked with these, it would throw a memory error (a
  // different code) or allocate terabytes; the KDF code proves the bound ran first.
  for (const [logN, r, p] of [
    [19, 8, 1],
    [20, 8, 1],
    [25, 8, 1],
    [31, 8, 1],
    [255, 8, 1],
    [14, 8, 1],
    [0, 8, 1],
    [17, 16, 1],
    [17, 1, 1],
    [17, 8, 2],
    [17, 8, 0],
    [17, 255, 255],
  ])
    assert.equal(kdfCode(logN, r, p), "KDF", `${logN}/${r}/${p}`);
  // The same bound applies when writing.
  await assert.rejects(
    writePackage({
      databaseFile: fakeDatabase(1000),
      ledgerText,
      backupCreatedAt: created,
      passphrase: PASS,
      destination: next("never"),
      kdf: { logN: 25, r: 8, p: 1 },
    }),
    (error) => error instanceof PackageError && error.code === "KDF",
  );
});

test("declared sizes above the limits are refused before allocation; a lying length is refused against the real file size", async () => {
  const { destination, info } = await makePackage();
  // parseHeader is pure: huge declared lengths cost nothing and allocate nothing.
  const raw = readFileSync(destination).subarray(0, HEADER_BYTES);
  const huge = Buffer.from(raw);
  huge.writeBigUInt64BE(BigInt(2) ** BigInt(60), 52);
  assert.equal(codeOf(() => parseHeader(huge, 10 ** 6)), "TOO_LARGE");
  const hugeLedger = Buffer.from(raw);
  hugeLedger.writeUInt32BE(0xffffffff, 60);
  assert.equal(codeOf(() => parseHeader(hugeLedger, 10 ** 6)), "TOO_LARGE");
  // A package within the default limits but above stricter ones.
  const tight = { maxDatabaseBytes: info.databaseBytes - 1, maxLedgerBytes: 1 << 20 };
  assert.equal(codeOf(() => verifyPackage(destination, PASS, tight)), "TOO_LARGE");
  await assert.rejects(
    writePackage({
      databaseFile: fakeDatabase(1000),
      ledgerText,
      backupCreatedAt: created,
      passphrase: PASS,
      destination: next("never"),
      kdf: FAST,
      limits: { maxDatabaseBytes: 100, maxLedgerBytes: 1 << 20 },
    }),
    (error) => error instanceof PackageError && error.code === "TOO_LARGE",
  );
  // A header that declares an enormous (but limit-legal) database for a tiny file.
  const lying = Buffer.concat([Buffer.from(raw), randomBytes(64)]);
  lying.writeBigUInt64BE(BigInt(8 * 1024 ** 3), 52);
  const lyingFile = next("lying");
  writeFileSync(lyingFile, lying);
  assert.equal(codeOf(() => verifyPackage(lyingFile, PASS)), "TRUNCATED");
});

test("writing refuses an existing destination and a database path that is not a plain file, and a stage failure aborts", async () => {
  const databaseFile = fakeDatabase(1000);
  const existing = next("existing");
  writeFileSync(existing, "do not overwrite");
  await assert.rejects(
    writePackage({
      databaseFile,
      ledgerText,
      backupCreatedAt: created,
      passphrase: PASS,
      destination: existing,
      kdf: FAST,
    }),
  );
  assert.equal(readFileSync(existing, "utf8"), "do not overwrite");

  const dir = next("dir");
  mkdirSync(dir);
  await assert.rejects(
    writePackage({
      databaseFile: dir,
      ledgerText,
      backupCreatedAt: created,
      passphrase: PASS,
      destination: next("never"),
      kdf: FAST,
    }),
    (error) => error instanceof PackageError && error.code === "INPUT",
  );

  const link = next("link");
  let linked = true;
  try {
    symlinkSync(databaseFile, link);
  } catch {
    linked = false; // symlinks need a privilege on some Windows setups
  }
  if (linked)
    await assert.rejects(
      writePackage({
        databaseFile: link,
        ledgerText,
        backupCreatedAt: created,
        passphrase: PASS,
        destination: next("never"),
        kdf: FAST,
      }),
      (error) => process.platform === "win32" || (error instanceof PackageError && error.code === "INPUT"),
    );

  for (const stage of ["header-written", "encrypted", "synced"] as const)
    await assert.rejects(
      writePackage({
        databaseFile,
        ledgerText,
        backupCreatedAt: created,
        passphrase: PASS,
        destination: next("aborted"),
        kdf: FAST,
        onStage: (s) => {
          if (s === stage) throw new Error("injected");
        },
      }),
      /injected/,
    );
});

test("reading refuses a directory and (where links can be made) a symbolic link in place of the package", async () => {
  const { destination } = await makePackage();
  const dir = next("dir");
  mkdirSync(dir);
  assert.equal(codeOf(() => verifyPackage(dir, PASS)), "INPUT");
  const link = next("link");
  try {
    symlinkSync(destination, link);
  } catch {
    return;
  }
  if (process.platform !== "win32") assert.equal(codeOf(() => verifyPackage(link, PASS)), "INPUT");
});

test("passphrase rules: exactly one source, strong minimum, fail closed, nothing echoed", () => {
  const strong = "Tr0ub4dor&3 plus a long tail";
  assert.equal(loadPassphrase({ STYLE_BACKUP_PASSPHRASE: strong }).toString(), strong);
  const codeFor = (env: Record<string, string | undefined>): PackageErrorCode =>
    codeOf(() => loadPassphrase(env));
  assert.equal(codeFor({}), "PASSPHRASE_MISSING");
  assert.equal(codeFor({ STYLE_BACKUP_PASSPHRASE: "" }), "PASSPHRASE_MISSING");
  assert.equal(
    codeFor({ STYLE_BACKUP_PASSPHRASE: strong, STYLE_BACKUP_PASSPHRASE_FILE: "x" }),
    "PASSPHRASE_AMBIGUOUS",
  );
  for (const weak of [
    "short",
    "password",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // long but one character
    "abababababababababababab", // two characters
    "1234567890123456789", // 19 characters
    "has a nul \0 inside it, long enough",
    "x".repeat(2000) + "abcdefghij",
  ]) {
    let message = "";
    assert.equal(
      codeOf(() => {
        try {
          loadPassphrase({ STYLE_BACKUP_PASSPHRASE: weak });
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      }),
      "PASSPHRASE_WEAK",
    );
    assert.ok(!message.includes(weak.slice(0, 8)) || weak.length < 8, "the weak value is not echoed");
  }
  assert.doesNotThrow(() => validatePassphrase("abcdefghij0123456789"));
  assert.throws(() => validatePassphrase("abcdefghij012345678"), PackageError);
  // The environment entry is removed once it has been read.
  const env: Record<string, string | undefined> = { STYLE_BACKUP_PASSPHRASE: strong };
  loadPassphrase(env);
  assert.equal(env.STYLE_BACKUP_PASSPHRASE, undefined);
});

test("a passphrase file must be a plain, owner-only file; one trailing line break is dropped; a link or directory is refused", () => {
  const strong = "file based passphrase 0123456789";
  const file = next("pass");
  writeFileSync(file, strong + "\n");
  if (process.platform !== "win32") chmodSync(file, 0o600);
  const buffer = loadPassphrase({ STYLE_BACKUP_PASSPHRASE_FILE: file });
  assert.equal(buffer.toString(), strong, "trailing newline removed, nothing else");
  buffer.fill(0);

  const crlf = next("pass-crlf");
  writeFileSync(crlf, strong + "\r\n");
  if (process.platform !== "win32") chmodSync(crlf, 0o400);
  assert.equal(loadPassphrase({ STYLE_BACKUP_PASSPHRASE_FILE: crlf }).toString(), strong);

  const codeFor = (path_: string) =>
    codeOf(() => loadPassphrase({ STYLE_BACKUP_PASSPHRASE_FILE: path_ }));
  assert.equal(codeFor(next("missing")), "PASSPHRASE_FILE");
  const dir = next("passdir");
  mkdirSync(dir);
  assert.equal(codeFor(dir), "PASSPHRASE_FILE");
  const empty = next("empty");
  writeFileSync(empty, "");
  assert.equal(codeFor(empty), "PASSPHRASE_FILE");
  const big = next("big");
  writeFileSync(big, "a1b2c3d4e5".repeat(500));
  if (process.platform !== "win32") chmodSync(big, 0o600);
  assert.equal(codeFor(big), "PASSPHRASE_FILE", "over 4 KiB");

  // A weak value inside a perfectly protected file is still refused.
  const weak = next("weak");
  writeFileSync(weak, "tooshort\n");
  if (process.platform !== "win32") chmodSync(weak, 0o600);
  assert.equal(codeFor(weak), "PASSPHRASE_WEAK");

  if (process.platform !== "win32") {
    const open = next("open");
    writeFileSync(open, strong);
    chmodSync(open, 0o640);
    assert.equal(codeFor(open), "PASSPHRASE_FILE", "group-readable file refused");
    chmodSync(open, 0o604);
    assert.equal(codeFor(open), "PASSPHRASE_FILE", "world-readable file refused");
    const target = next("target");
    writeFileSync(target, strong);
    chmodSync(target, 0o600);
    const link = next("passlink");
    symlinkSync(target, link);
    assert.equal(codeFor(link), "PASSPHRASE_FILE", "a link is not followed");
  }
  // Nothing was left behind by the loader.
  assert.ok(readdirSync(root).length > 0);
});

test("a truncated copy of a package larger than the accepted size is also refused when cut by truncateSync (a half-copied file)", async () => {
  const { destination } = await makePackage();
  const half = next("half");
  writeFileSync(half, readFileSync(destination));
  truncateSync(half, Math.floor(readFileSync(destination).length / 2));
  assert.equal(codeOf(() => verifyPackage(half, PASS)), "TRUNCATED");
});
