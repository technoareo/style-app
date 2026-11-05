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
 * File operations of the build 026 intake and labelling tools, behind a seam so tests can make a write fail
 * half way. Only open (exclusive) / write / fsync / close / unlink / mkdir are used for output: no rename and
 * no hard link, which Windows sandboxes refuse (EPERM) on some volumes. Input reads refuse links, junctions
 * and anything that changes while it is read.
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
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new EvaluationRefusal([`${path.basename(file)} already exists; evidence is never overwritten`]);
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

export type SourceRead = { bytes: Buffer; size: number };

export type ReadOps = {
  lstat: typeof lstatSync;
  realpath: (p: string) => string;
  open: (p: string) => number;
  fstat: typeof fstatSync;
  readAll: (fd: number) => Buffer;
  close: (fd: number) => void;
};
const realRead: ReadOps = {
  lstat: lstatSync,
  realpath: (p) => realpathSync.native(p),
  open: (p) => openSync(p, "r"),
  fstat: fstatSync,
  readAll: (fd) => readFileSync(fd),
  close: (fd) => closeSync(fd),
};

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
  return ops.realpath(dir);
}

/**
 * Reads one file from `dir` for import. Refused: a name that is not bare, a missing file, a symbolic link or
 * junction (lstat), a non-regular file, a file with several hard links, a real path outside the directory,
 * an oversized file, and a file whose size or modification time changed while it was read.
 * The refusal text never contains the operator's file name or path (they may identify a person).
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
  if (before.nlink > 1) throw new EvaluationRefusal(["a listed source file has several hard links; copy it to a plain file first"]);
  if (before.size > maxBytes) throw new EvaluationRefusal([`a listed source file is larger than ${maxBytes} bytes`]);
  const real = ops.realpath(full);
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || !samePath(path.dirname(real), root)) throw new EvaluationRefusal(["a listed source file resolves outside the source directory"]);
  const fd = ops.open(full);
  let bytes: Buffer;
  let during;
  try {
    during = ops.fstat(fd);
    bytes = ops.readAll(fd);
  } finally {
    ops.close(fd);
  }
  let after;
  try {
    after = ops.lstat(full);
  } catch {
    throw new EvaluationRefusal(["a source file disappeared while it was read"]);
  }
  const stable = (s: { size: number; mtimeMs: number }) => s.size === before.size && s.mtimeMs === before.mtimeMs;
  if (!stable(during) || !stable(after) || bytes.length !== before.size || after.isSymbolicLink())
    throw new EvaluationRefusal(["a source file changed while it was being read; import it again once it is not being written"]);
  return { bytes, size: bytes.length };
}

/** Reads a small regular file from the intake workspace without following a link. */
export function readWorkspaceFile(file: string, ops: ReadOps = realRead): Buffer {
  let st;
  try {
    st = ops.lstat(file);
  } catch {
    throw new EvaluationRefusal([`${path.basename(file)} cannot be read`]);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new EvaluationRefusal([`${path.basename(file)} is not a regular file (links are refused)`]);
  return readFileSync(file);
}
