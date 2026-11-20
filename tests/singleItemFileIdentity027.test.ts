import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EvaluationRefusal } from "../scripts/vision-evaluation/evaluate";
import { MAX_WORKSPACE_FILE_BYTES, readSourceFile, readWorkspaceFile, realRead, sameFile, type ReadOps, type StatLike } from "../scripts/vision-evaluation/single-item/fsx";
import { makeTempDir, removeTempDir } from "./helpers/tempDir";

/**
 * Build 027: a file read is bound to the OPENED HANDLE's identity. A co-resident process that swaps a same-size,
 * same-mtime regular file in between the observation of a path and the open (and maybe swaps it back) must be
 * refused wherever the platform supplies anything that tells the files apart. Every file here is synthetic.
 */

const root = process.cwd();
// The repository targets below ES2020: the trailing-n bigint literal syntax is rejected there, BigInt(...) is not.
const B = (n: number): bigint => BigInt(n);

// ------------------------------------------------------------------ an in-memory disk the tests can swap under the reader

type F = { ino: bigint; dev: bigint; size: bigint; mtime: bigint; ctime: bigint; birth: bigint; data: Buffer; kind?: "file" | "dir" | "link"; nlink?: bigint };
const stat = (f: F): StatLike => ({
  isSymbolicLink: () => f.kind === "link",
  isFile: () => (f.kind ?? "file") === "file",
  isDirectory: () => f.kind === "dir",
  nlink: f.nlink ?? B(1),
  size: f.size,
  ino: f.ino,
  dev: f.dev,
  mtimeNs: f.mtime,
  ctimeNs: f.ctime,
  birthtimeNs: f.birth,
});
const file = (over: Partial<F> = {}, data = Buffer.from("AAAAAAAAAA")): F => ({ ino: B(11), dev: B(7), size: B(data.length), mtime: B(1000), ctime: B(2000), birth: B(3000), data, ...over });
/** A same-size, same-mtime file that differs in the fields a platform may or may not supply. */
const lookalike = (a: F, over: Partial<F> = {}): F => ({ ...a, data: Buffer.alloc(a.data.length, 0x42), ...over });

/** Keys are normalized so "srcdir/a.jpg" and "srcdir\\a.jpg" are one path, as path.join produces on Windows. */
class PathMap extends Map<string, F> {
  override set(k: string, v: F) {
    return super.set(path.normalize(k), v);
  }
  override get(k: string) {
    return super.get(path.normalize(k));
  }
  override delete(k: string) {
    return super.delete(path.normalize(k));
  }
}

class Disk {
  paths = new PathMap();
  handles = new Map<number, F>();
  next = 100;
  /** runs just before the open (after the caller's lstat), after the open (before fstat), and during the read */
  beforeOpen: (() => void) | null = null;
  afterOpen: (() => void) | null = null;
  duringRead: (() => void) | null = null;
  opens = 0;
  reads = 0;
  at(p: string) {
    const f = this.paths.get(p);
    if (!f) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT", path: p });
    return f;
  }
  ops(): ReadOps {
    return {
      lstat: (p) => stat(this.at(p)),
      realpath: (p) => (p.endsWith("srcdir") ? "/real/srcdir" : `/real/srcdir/${p.split(/[\\/]/).pop()}`),
      open: (p) => {
        this.beforeOpen?.();
        const f = this.at(p);
        const fd = this.next++;
        this.handles.set(fd, f);
        this.opens++;
        this.afterOpen?.();
        return fd;
      },
      fstat: (fd) => stat(this.handles.get(fd) as F),
      readAll: (fd) => {
        this.reads++;
        this.duringRead?.();
        return (this.handles.get(fd) as F).data;
      },
      close: (fd) => void this.handles.delete(fd),
    };
  }
}
function disk(a: F, name = "srcdir/photo.jpg"): { d: Disk; name: string } {
  const d = new Disk();
  d.paths.set("srcdir", file({ kind: "dir", ino: B(1) }, Buffer.alloc(0)));
  d.paths.set(name, a);
  return { d, name };
}
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof EvaluationRefusal) return e.message;
    throw e;
  }
  return assert.fail("expected a refusal");
};
const IDENTITY = /identity did not hold/;
const readSource = (d: Disk, name: string) => readSourceFile("srcdir", path.basename(name), 1000, d.ops());

// the two reads under test, with the same swap scenarios applied to both
type Reader = { label: string; read: (d: Disk, name: string) => Buffer; build: (a: F) => { d: Disk; name: string } };
const readers: Reader[] = [
  { label: "source photo", read: (d, n) => readSource(d, n).bytes, build: (a) => disk(a, "srcdir/photo.jpg") },
  { label: "workspace evidence", read: (d, n) => readWorkspaceFile(n, d.ops()), build: (a) => disk(a, "ws/records/img-0123.json") },
];

for (const r of readers) {
  test(`${r.label}: an unchanged file is read through the handle and reports its identity basis`, () => {
    const a = file();
    const { d, name } = r.build(a);
    assert.deepEqual(r.read(d, name), a.data);
    assert.equal(d.opens, 1, "opened once");
    assert.equal(d.reads, 1, "read once, through the handle");
    if (r.label === "source photo") assert.equal(readSource(d, name).identity, "file-index");
  });

  test(`${r.label}: a same-size, same-mtime file with a different file index swapped in before the open is refused`, () => {
    const a = file();
    const { d, name } = r.build(a);
    d.beforeOpen = () => d.paths.set(name, lookalike(a, { ino: B(99) }));
    assert.match(refusal(() => r.read(d, name)), IDENTITY);
    assert.equal(d.reads, 0, "nothing was read from the swapped file");
    assert.equal(d.handles.size, 0, "the handle was closed");
  });

  test(`${r.label}: swapped in before the open and swapped BACK after it is still refused (the handle is the impostor)`, () => {
    const a = file();
    const { d, name } = r.build(a);
    d.beforeOpen = () => d.paths.set(name, lookalike(a, { ino: B(99) }));
    d.afterOpen = () => d.paths.set(name, a);
    assert.match(refusal(() => r.read(d, name)), IDENTITY);
    assert.equal(d.reads, 0);
  });

  test(`${r.label}: a different device with the same file index is a different file`, () => {
    const a = file();
    const { d, name } = r.build(a);
    d.beforeOpen = () => d.paths.set(name, lookalike(a, { dev: B(8) }));
    assert.match(refusal(() => r.read(d, name)), IDENTITY);
  });

  test(`${r.label}: a swap that persists after the open is refused by the post-read observation of the path`, () => {
    const a = file();
    const { d, name } = r.build(a);
    d.duringRead = () => d.paths.set(name, lookalike(a, { ino: B(99) }));
    assert.match(refusal(() => r.read(d, name)), IDENTITY);
  });

  test(`${r.label}: a swap in and back DURING the read cannot change the bytes, which came from the handle`, () => {
    const a = file();
    const { d, name } = r.build(a);
    d.duringRead = () => {
      d.paths.set(name, lookalike(a, { ino: B(99) }));
      d.paths.set(name, a);
    };
    assert.deepEqual(r.read(d, name), a.data, "the trusted handle still names the original file; the bytes are its own");
  });

  test(`${r.label}: with NO file index, a differing change, creation or modification time still refuses the swap`, () => {
    for (const diff of [{ ctime: B(2001) }, { birth: B(3001) }, { mtime: B(1001) }] as Array<Partial<F>>) {
      const a = file({ ino: B(0), dev: B(0) });
      const { d, name } = r.build(a);
      d.beforeOpen = () => d.paths.set(name, lookalike(a, diff));
      assert.match(refusal(() => r.read(d, name)), IDENTITY, JSON.stringify(diff, (_, v) => (typeof v === "bigint" ? String(v) : v)));
    }
  });

  test(`${r.label}: one side with a file index and the other without is a mismatch, not a pass`, () => {
    const a = file();
    const { d, name } = r.build(a);
    d.beforeOpen = () => d.paths.set(name, lookalike(a, { ino: B(0), dev: B(0) }));
    assert.match(refusal(() => r.read(d, name)), IDENTITY);
  });

  test(`${r.label}: content that grows or shrinks between the observation and the read is refused`, () => {
    const a = file();
    const { d, name } = r.build(a);
    d.duringRead = () => {
      const h = [...d.handles.values()][0];
      h.data = Buffer.alloc(4);
    };
    assert.match(refusal(() => r.read(d, name)), IDENTITY);
  });

  test(`${r.label}: the handle turning out to be a link, directory or other non-file is refused`, () => {
    const a = file();
    const { d, name } = r.build(a);
    d.beforeOpen = () => d.paths.set(name, lookalike(a, { kind: "dir" }));
    assert.match(refusal(() => r.read(d, name)), IDENTITY);
    const b = r.build(a);
    b.d.duringRead = () => b.d.paths.set(b.name, lookalike(a, { kind: "link" }));
    assert.match(refusal(() => r.read(b.d, b.name)), IDENTITY);
  });

  test(`${r.label}: refusals are generic: no file name, path or rights-holder text`, () => {
    const secret = "jane-wedding-secret";
    const a = file();
    const { d, name } = (() => {
      const nm = r.label === "source photo" ? `srcdir/${secret}.jpg` : `ws/${secret}-policy.json`;
      return disk(a, nm);
    })();
    d.beforeOpen = () => d.paths.set(name, lookalike(a, { ino: B(99) }));
    const msg = refusal(() => r.read(d, name));
    assert.ok(!msg.includes("jane") && !msg.includes(secret) && !msg.includes("wedding") && !msg.includes("srcdir"), msg);
  });
}

// ------------------------------------------------------------------ what is NOT detectable, stated as a test

test("the honest limit: with no file index and identical size and all timestamps, a swapped file cannot be told apart (and is reported as such)", () => {
  const a = file({ ino: B(0), dev: B(0) });
  const { d, name } = disk(a);
  d.beforeOpen = () => d.paths.set(name, lookalike(a));
  const read = readSource(d, name);
  assert.equal(read.identity, "size-and-timestamps", "the weaker basis is reported, never presented as a file-index proof");
  assert.deepEqual(read.bytes, Buffer.alloc(10, 0x42));
  assert.equal(sameFile(stat(a), stat(lookalike(a))).basis, "size-and-timestamps");
});

test("sameFile: a zero file index is 'not provided', never an identity", () => {
  const a = file({ ino: B(0), dev: B(5) });
  const b = file({ ino: B(0), dev: B(9) });
  assert.equal(sameFile(stat(a), stat(b)).same, true, "devices are not compared without a file index");
  assert.equal(sameFile(stat(file()), stat(file({ ino: B(12) }))).same, false);
  assert.equal(sameFile(stat(file()), stat(file({ size: B(11) }))).same, false);
  // millisecond-only platforms: compared as numbers, still exact
  const ms = (t: number): StatLike => ({ ...stat(file({ ino: B(0) })), mtimeNs: undefined, mtimeMs: t });
  assert.equal(sameFile(ms(5), ms(5)).same, true);
  assert.equal(sameFile(ms(5), ms(6)).same, false);
});

// ------------------------------------------------------------------ existing protections still hold on the new path

test("link, hard-link, containment and size protections are unchanged", () => {
  const a = file();
  const links = disk({ ...a, kind: "link" });
  assert.match(refusal(() => readSource(links.d, links.name)), /symbolic link or junction/);
  const hard = disk({ ...a, nlink: B(2) });
  assert.match(refusal(() => readSource(hard.d, hard.name)), /hard links/);
  const big = disk(file({ size: B(5000) }, Buffer.alloc(5000)));
  assert.match(refusal(() => readSource(big.d, big.name)), /larger than/);
  const out = disk(a);
  const ops = out.d.ops();
  assert.match(refusal(() => readSourceFile("srcdir", "photo.jpg", 1000, { ...ops, realpath: (p) => (p.endsWith("srcdir") ? "/real/srcdir" : "/elsewhere/photo.jpg") })), /outside the source directory/);
  const ws = disk(a, "ws/x.json");
  ws.d.paths.set("ws/x.json", { ...a, kind: "link" });
  assert.match(refusal(() => readWorkspaceFile("ws/x.json", ws.d.ops())), /not a regular file/);
  const wbig = disk(file({ size: B(5000) }, Buffer.alloc(5000)), "ws/x.json");
  assert.match(refusal(() => readWorkspaceFile("ws/x.json", wbig.d.ops(), 100)), /larger than 100 bytes/);
  assert.ok(MAX_WORKSPACE_FILE_BYTES >= 40 * 1024 * 1024, "the workspace limit still admits a 40 MB image");
  assert.match(refusal(() => readWorkspaceFile("ws/missing.json", ws.d.ops())), /cannot be read/);
});

// ------------------------------------------------------------------ the real file system

test("real files: bytes come back, the handle reports a file index on this platform, and a real swap is refused", (t) => {
  const dir = makeTempDir("s027-");
  try {
    const f = path.join(dir, "evidence.json");
    writeFileSync(f, "AAAAAAAAAA");
    assert.deepEqual(readWorkspaceFile(f), Buffer.from("AAAAAAAAAA"));
    const before = realRead.lstat(f);
    const fd = realRead.open(f);
    const opened = realRead.fstat(fd);
    realRead.close(fd);
    assert.equal(sameFile(before, opened).same, true, "path and handle are one file");
    const indexed = BigInt(opened.ino ?? 0) !== BigInt(0);
    if (!indexed) t.diagnostic("this platform/volume reports no file index; only the timestamp basis is available here");
    else assert.equal(sameFile(before, opened).basis, "file-index");

    // swap: delete the file and create another of the same size with the same mtime, between the observation and the open
    const stamp = statSync(f).mtime;
    const impostor = () => {
      unlinkSync(f);
      writeFileSync(f, "BBBBBBBBBB");
      utimesSync(f, stamp, stamp);
    };
    const swapped: ReadOps = { ...realRead, open: (p) => (impostor(), realRead.open(p)) };
    const probe = realRead.lstat(f);
    // does this platform/volume let the two files be told apart at all? (NTFS can reuse the file ID and tunnel the creation time)
    impostor();
    const probeAfter = realRead.lstat(f);
    writeFileSync(f, "AAAAAAAAAA");
    utimesSync(f, stamp, stamp);
    if (sameFile(probe, probeAfter).same) {
      t.skip("this volume gives the swapped file the same index, size and every timestamp; the swap cannot be detected here (documented limit)");
      return;
    }
    writeFileSync(f, "AAAAAAAAAA");
    utimesSync(f, stamp, stamp);
    const msg = refusal(() => readWorkspaceFile(f, swapped));
    assert.match(msg, IDENTITY);
    assert.ok(!msg.includes("evidence"), "no file name in the refusal");
  } finally {
    removeTempDir(dir, "s027-");
  }
});

test("real files: a real source photo read through the handle matches its bytes; a file edited in place is refused where the platform shows it", (t) => {
  const dir = makeTempDir("s027-");
  try {
    const src = path.join(dir, "src");
    writeFileSync(path.join(dir, "keep.txt"), "x");
    require("node:fs").mkdirSync(src);
    const f = path.join(src, "p.jpg");
    writeFileSync(f, Buffer.alloc(300, 9));
    const read = readSourceFile(src, "p.jpg", 10_000);
    assert.equal(read.size, 300);
    assert.deepEqual(readFileSync(f), read.bytes);
    // in-place rewrite of the same length during the read: ctime/mtime move on a real volume
    const stamp = statSync(f).mtime;
    const ops: ReadOps = {
      ...realRead,
      readAll: (fd) => {
        const bytes = realRead.readAll(fd);
        writeFileSync(f, Buffer.alloc(300, 7));
        utimesSync(f, new Date(stamp.getTime() + 5000), new Date(stamp.getTime() + 5000));
        return bytes;
      },
    };
    assert.match(refusal(() => readSourceFile(src, "p.jpg", 10_000, ops)), IDENTITY);
    t.diagnostic("in-place modification during the read refused on this platform");
  } finally {
    removeTempDir(dir, "s027-");
  }
});

// ------------------------------------------------------------------ operating-system failures are sanitized (reviewer blocker)

const SECRET_PATH = "C:\\Users\\jane-doe\\weddings\\secret-photo.jpg";
const osError = (code: string, syscall: string) => Object.assign(new Error(`${code}: operation not permitted, ${syscall} '${SECRET_PATH}'`), { code, errno: -4048, path: SECRET_PATH, syscall });
/** Nothing of a path, a name, an OS error code, an errno or a syscall may appear. */
const assertGeneric = (msg: string) => assert.ok(!/jane|secret|wedding|C:|\\|ENOENT|EACCES|EBUSY|EPERM|EIO|errno|-4048|syscall|'/i.test(msg), `leaked: ${msg}`);
const readWith = (label: string, ops: ReadOps, name: string): Buffer => (label === "source photo" ? readSourceFile("srcdir", path.basename(name), 1000, ops).bytes : readWorkspaceFile(name, ops));

/** Ops over a Disk where individual operations can be replaced, and every close is counted. */
function spy(d: Disk, over: Partial<ReadOps>): { ops: ReadOps; closes: number[] } {
  const base = d.ops();
  const closes: number[] = [];
  const ops: ReadOps = {
    ...base,
    ...over,
    close: (fd) => {
      closes.push(fd);
      (over.close ?? base.close)(fd);
    },
  };
  return { ops, closes };
}

for (const r of readers) {
  test(`${r.label}: a path deleted or renamed between the observation and the open is a generic refusal`, () => {
    for (const how of ["deleted", "renamed"] as const) {
      const { d, name } = r.build(file());
      d.beforeOpen = () => {
        const f = d.paths.get(name) as F;
        d.paths.delete(name);
        if (how === "renamed") d.paths.set(`${name}.moved`, f);
      };
      const msg = refusal(() => readWith(r.label, d.ops(), name));
      assert.match(msg, /could not be read/, how);
      assertGeneric(msg);
      assert.equal(d.reads, 0);
      assert.equal(d.handles.size, 0);
    }
  });

  test(`${r.label}: open throwing an error that contains a full path is replaced by a generic refusal`, () => {
    for (const code of ["EACCES", "EBUSY", "EPERM", "EIO"]) {
      const { d, name } = r.build(file());
      const { ops, closes } = spy(d, { open: () => { throw osError(code, "open"); } });
      const msg = refusal(() => readWith(r.label, ops, name));
      assert.match(msg, /could not be read/);
      assertGeneric(msg);
      assert.equal(closes.length, 0, "there is no handle to close when the open failed");
    }
  });

  test(`${r.label}: fstat, readAll and the post-read fstat throwing sensitive errors are generic, and the handle is still closed`, () => {
    const cases: Array<[string, (d: Disk) => Partial<ReadOps>]> = [
      ["first fstat", (d) => ({ fstat: () => { throw osError("EIO", "fstat"); } })],
      ["readAll", (d) => ({ readAll: () => { throw osError("EIO", "read"); } })],
      [
        "post-read fstat",
        (d) => {
          let n = 0;
          const base = d.ops();
          return { fstat: (fd: number) => { if (++n === 2) throw osError("EIO", "fstat"); return base.fstat(fd); } };
        },
      ],
    ];
    for (const [what, make] of cases) {
      const { d, name } = r.build(file());
      const { ops, closes } = spy(d, make(d));
      const msg = refusal(() => readWith(r.label, ops, name));
      assert.match(msg, /could not be read/, what);
      assertGeneric(msg);
      assert.equal(closes.length, 1, `${what}: the handle was closed exactly once`);
    }
  });

  test(`${r.label}: a close failure after a successful read fails closed with a generic refusal and returns no bytes`, () => {
    const { d, name } = r.build(file());
    const { ops, closes } = spy(d, { close: () => { throw osError("EIO", "close"); } });
    const msg = refusal(() => readWith(r.label, ops, name));
    assert.match(msg, /could not be read/);
    assertGeneric(msg);
    assert.equal(closes.length, 1);
    assert.equal(d.reads, 1, "the read happened; its result was discarded");
  });

  test(`${r.label}: a close failure while another failure is active reports the stronger earlier failure`, () => {
    // earlier failure = a sensitive readAll error: reported generically, close error does not replace or add to it
    const a = r.build(file());
    const s1 = spy(a.d, { readAll: () => { throw osError("EIO", "read"); }, close: () => { throw osError("EBUSY", "close"); } });
    const m1 = refusal(() => readWith(r.label, s1.ops, a.name));
    assert.match(m1, /could not be read/);
    assertGeneric(m1);
    assert.equal(s1.closes.length, 1);
    // earlier failure = an identity mismatch: the identity message wins over the generic close message
    const b = r.build(file());
    b.d.beforeOpen = () => b.d.paths.set(b.name, lookalike(file(), { ino: B(99) }));
    const s2 = spy(b.d, { close: () => { throw osError("EBUSY", "close"); } });
    const m2 = refusal(() => readWith(r.label, s2.ops, b.name));
    assert.match(m2, IDENTITY);
    assertGeneric(m2);
    assert.equal(s2.closes.length, 1);
  });

  test(`${r.label}: the handle is closed on every outcome and no path read happens after the open`, () => {
    // success
    const ok = r.build(file());
    const s = spy(ok.d, {});
    readWith(r.label, s.ops, ok.name);
    assert.equal(s.closes.length, 1);
    assert.equal(ok.d.opens, 1, "one open; never a second open or a path-based reread");
    // identity failure
    const bad = r.build(file());
    bad.d.afterOpen = () => bad.d.paths.set(bad.name, lookalike(file(), { ino: B(99) }));
    const s2 = spy(bad.d, {});
    refusal(() => readWith(r.label, s2.ops, bad.name));
    assert.equal(s2.closes.length, 1);
    assert.equal(bad.d.opens, 1);
  });
}

test("source reads: a realpath that throws a sensitive error is a generic refusal", () => {
  const { d, name } = disk(file());
  const base = d.ops();
  for (const which of ["dir", "file"] as const) {
    const ops: ReadOps = { ...base, realpath: (p) => { if (which === "dir" ? p.endsWith("srcdir") : !p.endsWith("srcdir")) throw osError("ENOENT", "realpath"); return base.realpath(p); } };
    const msg = refusal(() => readSourceFile("srcdir", "photo.jpg", 1000, ops));
    assert.match(msg, /could not be resolved/);
    assertGeneric(msg);
  }
});

test("command line: an unreadable evidence file is a refusal (exit 2) that names no path", async () => {
  const dir = makeTempDir("s027-");
  try {
    const { initWorkspace } = await import("../scripts/vision-evaluation/single-item/intake");
    const { runIntakeCli } = await import("../scripts/vision-evaluation/single-item/cli-intake");
    const ws = path.join(dir, "ws");
    initWorkspace(ws, "single-item-v1", new Date("2026-11-01T10:00:00Z"));
    const out: string[] = [];
    const io = { log: (l: string) => out.push(l), error: (l: string) => out.push(l), now: () => new Date("2026-11-05T12:00:00Z") };
    const missing = path.join(dir, "jane-doe-wedding", "secret-policy.json");
    const code = await runIntakeCli(["single-sample", "--workspace", ws, "--coverage", missing, "--policy", missing, "--out", path.join(dir, "plan.json")], io);
    assert.equal(code, 2);
    const text = out.join("\n");
    assert.match(text, /cannot be read/);
    assert.ok(!/jane|secret|wedding/.test(text), text);
    const code2 = await runIntakeCli(["single-intake-import", "--workspace", ws, "--batch", missing, "--source-dir", dir, "--operator", "op-4k9x2m"], io);
    assert.equal(code2, 2);
    assert.ok(!/jane|secret|wedding/.test(out.join("\n")));
  } finally {
    removeTempDir(dir, "s027-");
  }
});

// ------------------------------------------------------------------ source guard

test("fsx never reads by path after the handle is trusted, and still has no rename, link, copy or recursive delete", () => {
  const code = readFileSync(path.join(root, "scripts", "vision-evaluation", "single-item", "fsx.ts"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  assert.ok(!/\b(renameSync|copyFileSync|cpSync|(?<!un)linkSync|symlinkSync|rmSync)\b/.test(code.replace(/unlinkSync/g, "")));
  assert.ok(!/readFileSync\((?!fd\))/.test(code), "the only readFileSync is the handle read");
  assert.ok(!/realpathSync\(/.test(code), "realpath only via realpathSync.native");
  assert.ok(/lstatSync\(p, \{ bigint: true \}\)/.test(code) && /fstatSync\(fd, \{ bigint: true \}\)/.test(code), "bigint stats, so inode and nanosecond times are not rounded");
  for (const f of ["intake.ts", "review.ts", "sampling.ts", "cli-intake.ts"]) {
    const src = readFileSync(path.join(root, "scripts", "vision-evaluation", "single-item", f), "utf8");
    assert.ok(!/\breadFileSync\b/.test(src.replace(/import[^;]*;/g, "")), `${f}: reads go through readWorkspaceFile / readSourceFile`);
  }
});

test("documentation: the strengthened guarantee and its remaining platform limit are stated", () => {
  const notes = readFileSync(path.join(root, "docs", "reviews", "implementation-027-notes.md"), "utf8");
  assert.match(notes, /opened handle/i);
  assert.match(notes, /file index/i);
  assert.match(notes, /not launch-ready/i);
  assert.match(notes, /Remaining limit/i);
  for (const f of ["scripts/vision-evaluation/README.md", "docs/reviews/implementation-026-notes.md"]) assert.match(readFileSync(path.join(root, f), "utf8"), /build 027|Build 027/, f);
});
