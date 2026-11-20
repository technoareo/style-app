import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { EvaluationRefusal } from "../evaluate";

/**
 * File operations of the build 026/027 intake and labelling tools, behind a seam so tests can make a write fail
 * half way or a read see a swapped file. Output uses only open (exclusive) / write / fsync / close / unlink /
 * mkdir: no rename and no hard link, which Windows sandboxes refuse (EPERM) on some volumes. Input reads refuse
 * links and junctions, and are bound to the opened handle's identity (see readBound).
 */

export type FsOps = {
  openExclusive: (file: string) => number;
  write: (fd: number, bytes: Buffer) => void;
  fsync: (fd: number) => void;
  close: (fd: number) => void;
  unlink: (file: string) => void;
  mkdir: (dir: string) => void;
  rmdir: (dir: string) => void;
};

export const realFs: FsOps = {
  openExclusive: (file) => openSync(file, "wx"),
  write: (fd, bytes) => {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
  },
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  unlink: (file) => unlinkSync(file),
  mkdir: (dir) => void mkdirSync(dir), // not recursive: an existing directory is an error (EEXIST)
  rmdir: (dir) => rmdirSync(dir), // fails on a non-empty directory, so only an empty one we made is ever removed
};

/**
 * Creates `file` exclusively (never overwrites) and writes `bytes`. A failure after the open removes that
 * half-written file, and only that one. EEXIST is reported as a refusal and the other writer's file is left alone.
 */
export function writeExclusive(file: string, bytes: Buffer, ops: FsOps = realFs): void {
  let fd: number;
  try {
    fd = ops.openExclusive(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new EvaluationRefusal(["an output file already exists; evidence is never overwritten"]);
    throw e;
  }
  let ok = false;
  let closeError: unknown = null;
  try {
    ops.write(fd, bytes);
    ops.fsync(fd);
    ok = true;
  } finally {
    try {
      ops.close(fd);
    } catch (e) {
      ok = false;
      closeError = e;
    }
    if (!ok) {
      try {
        ops.unlink(file);
      } catch {
        /* ours; best effort */
      }
    }
  }
  if (closeError !== null) throw closeError;
}

/** Tracks every file one command created so a later failure can remove exactly those and nothing else. */
export class Creations {
  private readonly files: string[] = [];
  private readonly dirs: string[] = [];
  constructor(private readonly ops: FsOps = realFs) {}
  file(file: string, bytes: Buffer): void {
    writeExclusive(file, bytes, this.ops);
    this.files.push(file);
  }
  dir(dir: string): void {
    this.ops.mkdir(dir);
    this.dirs.push(dir);
  }
  /** Removes what this object created (files first, then empty directories, newest first). Never touches anything else. */
  rollback(): void {
    for (const f of this.files.reverse()) {
      try {
        this.ops.unlink(f);
      } catch {
        /* best effort */
      }
    }
    for (const d of this.dirs.reverse()) {
      try {
        // only an empty directory that we made is removed (rmdir fails on a non-empty one)
        this.ops.rmdir(d);
      } catch {
        /* not empty or gone: leave it */
      }
    }
    this.files.length = 0;
    this.dirs.length = 0;
  }
  get created(): readonly string[] {
    return [...this.files];
  }
}

// ----------------------------------------------------------------------------- safe input

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** A bare file name an operator can type: no separators, drive letters, streams, traversal or reserved device names. */
export function bareNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || name === "") return "file name is missing";
  if (name.length > 128) return "file name is too long";
  if (/[\\/:*?"<>|\0-\x1f]/.test(name)) return "file name contains a path separator, drive/stream colon or control character";
  if (name === "." || name === ".." || name.includes("..")) return "file name contains '..'";
  if (/[. ]$/.test(name) || /^[ ]/.test(name)) return "file name ends with a dot or space (Windows would resolve it to another name)";
  if (WINDOWS_RESERVED.test(name)) return "file name is a reserved device name";
  return null;
}

/** What the identity comparison could rely on: a file index (inode / NTFS file ID) with its device, or only size and timestamps. */
export type IdentityBasis = "file-index" | "size-and-timestamps";

export type SourceRead = { bytes: Buffer; size: number; identity: IdentityBasis };

/** The fields of a stat the identity checks use. Real stats come from the bigint variant, so nothing is rounded. */
export type StatLike = {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  nlink: number | bigint;
  size: number | bigint;
  ino?: number | bigint;
  dev?: number | bigint;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
  birthtimeNs?: bigint;
  mtimeMs?: number | bigint;
  ctimeMs?: number | bigint;
  birthtimeMs?: number | bigint;
};

export type ReadOps = {
  lstat: (p: string) => StatLike;
  realpath: (p: string) => string;
  open: (p: string) => number;
  fstat: (fd: number) => StatLike;
  readAll: (fd: number) => Buffer;
  close: (fd: number) => void;
};
export const realRead: ReadOps = {
  lstat: (p) => lstatSync(p, { bigint: true }),
  realpath: (p) => realpathSync.native(p),
  open: (p) => openSync(p, "r"),
  fstat: (fd) => fstatSync(fd, { bigint: true }),
  readAll: (fd) => readFileSync(fd),
  close: (fd) => closeSync(fd),
};

// The repository targets below ES2020, where the trailing-n bigint literal syntax is rejected; BigInt(...) is not.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const nonZero = (v: number | bigint | undefined) => v !== undefined && BigInt(v) !== ZERO;
const hasIndex = (s: StatLike) => nonZero(s.ino);
const str = (v: unknown) => (v === undefined ? "-" : String(v));

/**
 * Compares two observations of what must be ONE file. Compared where the platform supplies them: size, the file
 * index and device (only when non-zero: a zero index means "not provided" and is never treated as an identity),
 * and the modification, change and creation times (nanosecond when available). If one observation has a file
 * index and the other does not, that is itself a mismatch.
 */
export function sameFile(a: StatLike, b: StatLike): { same: boolean; basis: IdentityBasis } {
  const indexed = hasIndex(a) || hasIndex(b);
  if (indexed && (!hasIndex(a) || !hasIndex(b) || str(a.ino) !== str(b.ino) || str(a.dev) !== str(b.dev))) return { same: false, basis: "file-index" };
  const t = (s: StatLike) => [str(s.size), str(s.mtimeNs ?? s.mtimeMs), str(s.ctimeNs ?? s.ctimeMs), str(s.birthtimeNs ?? s.birthtimeMs)].join("|");
  return { same: t(a) === t(b), basis: indexed ? "file-index" : "size-and-timestamps" };
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The directory the operator names must itself be a real directory (not a link or junction). */
export function checkSourceDir(dir: string, ops: ReadOps = realRead): string {
  let st;
  try {
    st = ops.lstat(dir);
  } catch {
    throw new EvaluationRefusal(["the source directory cannot be read"]);
  }
  if (st.isSymbolicLink()) throw new EvaluationRefusal(["the source directory is a link or junction; name the real directory"]);
  if (!st.isDirectory()) throw new EvaluationRefusal(["the source path is not a directory"]);
  return realpathOf(ops, dir);
}

/** realpath with the OS error text removed (it contains the path). */
function realpathOf(ops: ReadOps, p: string): string {
  try {
    return ops.realpath(p);
  } catch {
    throw new EvaluationRefusal(["a source path could not be resolved (it may have been moved or deleted)"]);
  }
}

const UNREADABLE = "a file could not be read (it may have been moved, deleted or made inaccessible); nothing was read";
const CHANGED ="a file changed while it was being read, or was replaced by another file (its identity did not hold); try again once nothing else is touching it";

/**
 * The one way bytes are read from a path: bound to the OPENED HANDLE, not to the name.
 *   1. The caller lstat-ed the path (`before`): a regular, non-link file.
 *   2. Open it and fstat the handle: it must be the same file as (1) (file index and device where the platform
 *      provides them, size, mtime, ctime, birth time).
 *   3. Read ONLY through the handle: no path-based read and no second open.
 *   4. fstat the handle again and lstat the path again: both must still be that same file, and the byte count
 *      must equal the size.
 * A same-size, same-mtime regular file swapped in between (1) and (2), or swapped in and back around the read, is
 * refused wherever the platform supplies a file index or a change/birth time that differs. Where it supplies
 * neither, only size and mtime remain and that residual risk is stated in the notes. Messages are generic: they
 * never contain a name or a path.
 */
function readBound(full: string, maxBytes: number, before: StatLike, ops: ReadOps): SourceRead {
  // Every operating-system failure below becomes the same generic refusal: Node's own errors carry the full path
  // and an errno, which may identify a person, so nothing from them is ever shown.
  let fd: number;
  try {
    fd = ops.open(full);
  } catch {
    throw new EvaluationRefusal([UNREADABLE]);
  }
  const guarded = <T>(step: () => T): T => {
    try {
      return step();
    } catch {
      throw new EvaluationRefusal([UNREADABLE]);
    }
  };
  let bytes!: Buffer;
  let opened!: StatLike;
  let finished!: StatLike;
  let failure: EvaluationRefusal | null = null;
  try {
    opened = guarded(() => ops.fstat(fd));
    if (!opened.isFile() || !sameFile(before, opened).same) throw new EvaluationRefusal([CHANGED]);
    if (BigInt(opened.size) > BigInt(maxBytes)) throw new EvaluationRefusal([`a file is larger than ${maxBytes} bytes`]);
    bytes = guarded(() => ops.readAll(fd));
    finished = guarded(() => ops.fstat(fd));
  } catch (e) {
    failure = e instanceof EvaluationRefusal ? e : new EvaluationRefusal([UNREADABLE]);
  }
  // The handle is always closed. A failure already in flight is the strongest and is the one reported; a close
  // failure on its own fails closed (the read cannot be trusted), with the same generic text.
  let closeFailed = false;
  try {
    ops.close(fd);
  } catch {
    closeFailed = true;
  }
  if (failure) throw failure;
  if (closeFailed) throw new EvaluationRefusal([UNREADABLE]);
  let after: StatLike;
  try {
    after = ops.lstat(full);
  } catch {
    throw new EvaluationRefusal(["a file disappeared while it was read"]);
  }
  if (after.isSymbolicLink() || !after.isFile()) throw new EvaluationRefusal([CHANGED]);
  if (!sameFile(opened, finished).same || !sameFile(opened, after).same || BigInt(bytes.length) !== BigInt(opened.size)) throw new EvaluationRefusal([CHANGED]);
  return { bytes, size: bytes.length, identity: hasIndex(opened) ? "file-index" : "size-and-timestamps" };
}

/**
 * Reads one file from `dir` for import. Refused: a name that is not bare, a missing file, a symbolic link or
 * junction (lstat), a non-regular file, a file with several hard links, a real path outside the directory, an
 * oversized file, and any file whose identity cannot be held from before the open to after the read (readBound).
 */
export function readSourceFile(dir: string, name: string, maxBytes: number, ops: ReadOps = realRead): SourceRead {
  const bad = bareNameProblem(name);
  if (bad) throw new EvaluationRefusal([`source file: ${bad}`]);
  const root = checkSourceDir(dir, ops);
  const full = path.join(dir, name);
  let before;
  try {
    before = ops.lstat(full);
  } catch {
    throw new EvaluationRefusal(["a listed source file does not exist"]);
  }
  if (before.isSymbolicLink()) throw new EvaluationRefusal(["a listed source file is a symbolic link or junction; links are never followed"]);
  if (!before.isFile()) throw new EvaluationRefusal(["a listed source entry is not a regular file"]);
  if (BigInt(before.nlink) > ONE) throw new EvaluationRefusal(["a listed source file has several hard links; copy it to a plain file first"]);
  if (BigInt(before.size) > BigInt(maxBytes)) throw new EvaluationRefusal([`a listed source file is larger than ${maxBytes} bytes`]);
  const real = realpathOf(ops, full);
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || !samePath(path.dirname(real), root)) throw new EvaluationRefusal(["a listed source file resolves outside the source directory"]);
  return readBound(full, maxBytes, before, ops);
}

/** Largest workspace file read in one piece (images are at most 40 MB; records, reviews and plans are far smaller). */
export const MAX_WORKSPACE_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Reads a file of the intake workspace or an operator-named evidence file (policy, coverage spec, plan, review,
 * batch, record, seal, pooled image) through an opened handle with the same identity and stability checks as
 * readSourceFile. A link, a junction or a non-regular file is refused. Hard links are not refused here (pooled
 * and evidence files are ours or the operator's own).
 */
export function readWorkspaceFile(file: string, ops: ReadOps = realRead, maxBytes = MAX_WORKSPACE_FILE_BYTES): Buffer {
  let before;
  try {
    before = ops.lstat(file);
  } catch {
    throw new EvaluationRefusal(["a workspace or evidence file cannot be read"]);
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new EvaluationRefusal(["a workspace or evidence file is not a regular file (links are refused)"]);
  if (BigInt(before.size) > BigInt(maxBytes)) throw new EvaluationRefusal([`a workspace or evidence file is larger than ${maxBytes} bytes`]);
  return readBound(file, maxBytes, before, ops).bytes;
}
