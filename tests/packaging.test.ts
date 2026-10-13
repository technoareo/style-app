import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/tempDir";
import {
  assertInside,
  collectPackagingProblems,
  forbiddenReason,
  isInside,
  PackagingBoundaryError,
} from "../scripts/packaging-rules";
import {
  removeGenerated,
  removeLink,
  sanitizeBuildOutput,
} from "../scripts/packaging-sanitize";

/**
 * The sanitizer deletes things, so every test runs against a tree it builds
 * itself under the OS temp directory: a stand-in "project" with canary files
 * for the real source, `.data`, `.runtime` and `.env`, a separate "outside"
 * folder with its own canary, and Windows junctions / POSIX symlinks aimed at
 * both. A canary that disappears or changes is a failed test. Nothing here
 * reads or writes the actual project's `.data`, `.runtime` or `.env`.
 */

const PREFIX = "style-pack-";
const up5 = "../../../../../";

const put = (file: string, text = "x") => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (file: string) => readFileSync(file, "utf8");
const gone = (p: string) => {
  try {
    lstatSync(p);
    return false;
  } catch {
    return true;
  }
};

/** Directory junction on Windows, directory symlink elsewhere. Needs no privilege. */
function link(target: string, at: string, links: string[]) {
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(target, at, "junction");
  links.push(at);
}

/** Removes created links as links first, so recursive cleanup can never follow one. */
function cleanup(dir: string, links: string[]) {
  for (const l of [...links].reverse()) {
    try {
      lstatSync(l);
      removeLink(l);
    } catch {
      // already gone
    }
  }
  removeTempDir(dir, PREFIX);
}

function manifestText(files: string[]) {
  return JSON.stringify({ version: 1, files });
}

/** A realistic unsanitized project: real state, generated output, private copies. */
function layout(dir: string) {
  const proj = path.join(dir, "proj");
  const outside = path.join(dir, "outside");
  put(path.join(outside, "canary.txt"), "OUTSIDE");
  // Real project state that must never be touched.
  put(path.join(proj, "src", "keep.ts"), "SOURCE");
  put(path.join(proj, ".data", "app.db"), "REAL-DB-CANARY");
  put(path.join(proj, ".data", "auth-secret"), "REAL-SECRET-CANARY");
  put(path.join(proj, ".runtime", "tool.bin"), "REAL-RUNTIME-CANARY");
  put(path.join(proj, ".env"), "REAL-ENV-CANARY");
  put(path.join(proj, "tests", "t.ts"), "REAL-TEST");
  put(path.join(proj, "docs", "d.md"), "REAL-DOC");
  put(path.join(proj, "node_modules", "next", "package.json"), "{}");
  // Generated output.
  const sa = path.join(proj, ".next", "standalone");
  put(path.join(sa, "server.js"), "// server");
  put(path.join(sa, "node_modules", "next", "package.json"), "{}");
  put(path.join(sa, "node_modules", "sharp", "package.json"), "{}");
  const files = [
    up5 + "node_modules/next/index.js",
    up5 + "node_modules/sharp/lib/index.js",
    up5 + ".data/app.db",
    up5 + "tests/t.ts",
    up5 + "docs/d.md",
    up5 + ".env",
    up5 + "src/keep.ts",
  ];
  const manifest = path.join(proj, ".next/server/app/api/a/route.js.nft.json");
  put(manifest, manifestText(files));
  const copy = path.join(sa, ".next/server/app/api/a/route.js.nft.json");
  put(copy, manifestText(files));
  // Private copies Next's tracer bundled into the standalone folder.
  put(path.join(sa, ".data", "app.db"), "COPY-DB");
  put(path.join(sa, ".data", "auth-secret"), "COPY-SECRET");
  put(path.join(sa, ".env.production"), "COPY-ENV");
  put(path.join(sa, "tests", "t.ts"), "COPY-TEST");
  put(path.join(sa, "docs", "d.md"), "COPY-DOC");
  put(path.join(sa, "sub", ".runtime", "z"), "COPY-RUNTIME");
  put(path.join(sa, "app.db-wal"), "COPY-WAL");
  return { proj, outside, sa, manifest, copy };
}

test("sanitize removes private copies and trace entries, leaves real state and outside folders alone, never follows links, and is idempotent", () => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, outside, sa, manifest, copy } = layout(dir);
    // Links inside the generated bundle, each aimed at something precious.
    link(path.join(proj, ".runtime"), path.join(sa, ".runtime"), links); // forbidden name, real target
    link(outside, path.join(sa, "escape"), links); // innocent name, target outside the bundle
    link(outside, path.join(sa, ".data", "sneaky"), links); // link INSIDE a doomed directory
    link(path.join(proj, ".data"), path.join(sa, "legit", "to-data"), links); // under a kept folder
    link(path.join(sa, "node_modules", "next"), path.join(sa, "ok-link"), links); // stays inside: kept

    assert.ok(
      collectPackagingProblems(proj).length > 0,
      "the unsanitized output is detected as unsafe",
    );

    const first = sanitizeBuildOutput(proj);
    assert.ok(first.droppedEntries > 0 && first.rewritten === 2 && first.removed > 0);

    // Private copies and escaping links are gone.
    for (const rel of [
      ".data", ".env.production", "tests", "docs", "sub/.runtime",
      "app.db-wal", ".runtime", "escape", "legit/to-data",
    ])
      assert.ok(gone(path.join(sa, rel)), `${rel} removed from the bundle`);
    // The bundle still has what it needs, and the harmless internal link stays.
    assert.ok(existsSync(path.join(sa, "server.js")));
    assert.ok(existsSync(path.join(sa, "node_modules", "next", "package.json")));
    assert.ok(lstatSync(path.join(sa, "ok-link")).isSymbolicLink());

    // Nothing real or outside was touched, including through the links.
    assert.equal(read(path.join(proj, ".data", "app.db")), "REAL-DB-CANARY");
    assert.equal(read(path.join(proj, ".data", "auth-secret")), "REAL-SECRET-CANARY");
    assert.equal(read(path.join(proj, ".runtime", "tool.bin")), "REAL-RUNTIME-CANARY");
    assert.equal(read(path.join(proj, ".env")), "REAL-ENV-CANARY");
    assert.equal(read(path.join(proj, "src", "keep.ts")), "SOURCE");
    assert.equal(read(path.join(proj, "tests", "t.ts")), "REAL-TEST");
    assert.equal(read(path.join(proj, "docs", "d.md")), "REAL-DOC");
    assert.equal(read(path.join(outside, "canary.txt")), "OUTSIDE");

    // Both manifests keep only non-private entries, and keep their version.
    for (const file of [manifest, copy]) {
      const parsed = JSON.parse(read(file));
      assert.equal(parsed.version, 1);
      assert.deepEqual(parsed.files, [
        up5 + "node_modules/next/index.js",
        up5 + "node_modules/sharp/lib/index.js",
        up5 + "src/keep.ts",
      ]);
    }
    assert.deepEqual(collectPackagingProblems(proj), []);

    // Idempotent: a second run changes nothing.
    const before = read(manifest);
    assert.deepEqual(sanitizeBuildOutput(proj), {
      droppedEntries: 0,
      rewritten: 0,
      removed: 0,
    });
    assert.equal(read(manifest), before);
    assert.deepEqual(collectPackagingProblems(proj), []);
  } finally {
    cleanup(dir, links);
  }
});

test("a .next that is a link, or sits behind one, is refused before anything is changed", () => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, outside } = layout(dir);
    // Move the generated output outside the project and link it back in.
    const elsewhere = path.join(dir, "elsewhere");
    put(path.join(elsewhere, "dotnext", "standalone", "server.js"), "// s");
    put(path.join(elsewhere, "dotnext", "standalone", ".data", "canary"), "ELSEWHERE-CANARY");
    put(
      path.join(elsewhere, "dotnext", "server", "a.nft.json"),
      manifestText([up5 + ".data/x"]),
    );
    // Replace the project's real .next with a junction to it.
    const realNext = path.join(proj, ".next");
    const parked = path.join(dir, "parked-next");
    mkdirSync(parked);
    renameSync(realNext, path.join(parked, ".next"));
    link(path.join(elsewhere, "dotnext"), realNext, links);

    assert.throws(() => sanitizeBuildOutput(proj), PackagingBoundaryError);
    assert.match(collectPackagingProblems(proj).join("\n"), /symlink or junction/);
    assert.equal(
      read(path.join(elsewhere, "dotnext", "standalone", ".data", "canary")),
      "ELSEWHERE-CANARY",
    );
    assert.equal(read(path.join(outside, "canary.txt")), "OUTSIDE");
    assert.equal(
      read(path.join(elsewhere, "dotnext", "server", "a.nft.json")),
      manifestText([up5 + ".data/x"]),
      "the manifest behind the link was not rewritten",
    );
  } finally {
    cleanup(dir, links);
  }
});

test("a standalone folder that is a link is refused, and nothing behind it is deleted", () => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, sa } = layout(dir);
    const elsewhere = path.join(dir, "elsewhere-standalone");
    put(path.join(elsewhere, "server.js"), "// s");
    put(path.join(elsewhere, ".data", "canary"), "STANDALONE-TARGET-CANARY");
    // Park the real standalone folder and link the name to the other one.
    const parked = path.join(dir, "parked-standalone");
    renameSync(sa, parked);
    link(elsewhere, sa, links);

    assert.throws(() => sanitizeBuildOutput(proj), PackagingBoundaryError);
    assert.match(collectPackagingProblems(proj).join("\n"), /symlink or junction/);
    assert.equal(
      read(path.join(elsewhere, ".data", "canary")),
      "STANDALONE-TARGET-CANARY",
    );
  } finally {
    cleanup(dir, links);
  }
});

test("a trace manifest that is a link is refused rather than written through", () => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, outside, manifest } = layout(dir);
    // A "manifest" that is a junction to an outside folder (needs no privilege).
    const evil = path.join(proj, ".next/server/app/api/a/evil.nft.json");
    link(outside, evil, links);
    const before = read(manifest);

    assert.throws(() => sanitizeBuildOutput(proj), /symlink or junction/);
    assert.match(collectPackagingProblems(proj).join("\n"), /evil\.nft\.json.*symlink or junction/);
    assert.equal(read(path.join(outside, "canary.txt")), "OUTSIDE");
    assert.equal(read(manifest), before, "nothing was rewritten before the abort");
    assert.ok(existsSync(path.join(proj, ".next/standalone/.data/app.db")), "nothing was deleted before the abort");
  } finally {
    cleanup(dir, links);
  }
});

test("a file symlink used as a manifest is refused (skipped where the OS needs privilege)", (t) => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, outside } = layout(dir);
    const target = path.join(outside, "target.nft.json");
    put(target, manifestText([up5 + ".data/app.db"]));
    const at = path.join(proj, ".next/server/app/api/a/linked.nft.json");
    try {
      symlinkSync(target, at, "file");
      links.push(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("creating file symlinks needs a privilege this account lacks");
        return;
      }
      throw error;
    }
    const before = read(target);
    assert.throws(() => sanitizeBuildOutput(proj), /symlink or junction/);
    assert.equal(read(target), before, "the file behind the link was not rewritten");
  } finally {
    cleanup(dir, links);
  }
});

test("the temporary manifest file is created exclusively: a decoy planted at its path is never written through, truncated or replaced", (t) => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, outside, manifest, copy } = layout(dir);
    const suffix = "decoy0123";
    const tempOf = (m: string) => `${m}.${suffix}.sanitizing`;
    const opts = { tempSuffix: () => suffix };
    const manifestsBefore = [read(manifest), read(copy)];
    const outsideFile = path.join(outside, "target.txt");
    put(outsideFile, "OUTSIDE-TARGET");
    const unchanged = () => {
      assert.deepEqual([read(manifest), read(copy)], manifestsBefore);
      assert.equal(read(path.join(outside, "canary.txt")), "OUTSIDE");
      assert.equal(read(outsideFile), "OUTSIDE-TARGET");
    };

    // (a) a regular file already sits at the temporary path.
    for (const m of [manifest, copy]) put(tempOf(m), "DECOY-FILE");
    assert.throws(() => sanitizeBuildOutput(proj, opts), /EEXIST|exists/i);
    for (const m of [manifest, copy])
      assert.equal(read(tempOf(m)), "DECOY-FILE", "the decoy was not truncated");
    unchanged();

    // (b) a junction/directory symlink to an outside folder sits there.
    for (const m of [manifest, copy]) {
      removeLink(tempOf(m)); // regular file from (a): plain unlink
      link(outside, tempOf(m), links);
    }
    assert.throws(() => sanitizeBuildOutput(proj, opts), /EEXIST|exists/i);
    unchanged();
    for (const m of [manifest, copy]) {
      assert.ok(lstatSync(tempOf(m)).isSymbolicLink(), "the planted link is still a link");
      removeLink(tempOf(m));
    }

    // (c) a file symlink to an outside file (needs a privilege on Windows).
    try {
      for (const m of [manifest, copy]) {
        symlinkSync(outsideFile, tempOf(m), "file");
        links.push(tempOf(m));
      }
      assert.throws(() => sanitizeBuildOutput(proj, opts), /EEXIST|exists/i);
      unchanged();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.diagnostic("file-symlink variant skipped: no privilege to create one");
    }
    for (const m of [manifest, copy])
      if (!gone(tempOf(m))) removeLink(tempOf(m));

    // With the decoys gone the same fixed name works, and leaves no temp file.
    const done = sanitizeBuildOutput(proj, opts);
    assert.equal(done.rewritten, 2);
    for (const m of [manifest, copy]) assert.ok(gone(tempOf(m)));
    assert.equal(read(path.join(outside, "canary.txt")), "OUTSIDE");
    assert.equal(read(outsideFile), "OUTSIDE-TARGET");
  } finally {
    cleanup(dir, links);
  }
});

test("a default run leaves no temporary manifest files behind, and rejects an unsafe temporary name", () => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, manifest, copy } = layout(dir);
    // A name that could climb out of the folder is refused before any write.
    const before = [read(manifest), read(copy)];
    assert.throws(
      () => sanitizeBuildOutput(proj, { tempSuffix: () => "../escape" }),
      /Unsafe temporary file name/,
    );
    assert.deepEqual([read(manifest), read(copy)], before);
    sanitizeBuildOutput(proj);
    for (const m of [manifest, copy]) {
      const leftovers = readdirSync(path.dirname(m)).filter((n) =>
        n.endsWith(".sanitizing"),
      );
      assert.deepEqual(leftovers, []);
    }
  } finally {
    cleanup(dir, links);
  }
});

test("malformed manifests fail closed and abort before any manifest is rewritten or any copy is deleted", () => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, manifest, sa } = layout(dir);
    const bad = path.join(proj, ".next/server/app/api/a/bad.nft.json");
    const goodBefore = read(manifest);
    for (const text of [
      "this is not json",
      JSON.stringify({ version: 1, files: "nope" }),
      JSON.stringify({ version: 1, files: [1, 2] }),
      JSON.stringify([]),
      "",
    ]) {
      put(bad, text);
      assert.throws(() => sanitizeBuildOutput(proj), /malformed|Unreadable/i, text);
      assert.match(collectPackagingProblems(proj).join("\n"), /malformed|unreadable/i);
      assert.equal(read(manifest), goodBefore, "valid manifest untouched");
      assert.ok(existsSync(path.join(sa, ".data", "app.db")), "no copy deleted");
    }
  } finally {
    cleanup(dir, links);
  }
});

test("a traced runtime package missing from the bundle fails verification; a bundled one that is never traced does not", () => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, sa } = layout(dir);
    sanitizeBuildOutput(proj);
    assert.deepEqual(collectPackagingProblems(proj), []);
    // `zod` is bundled into the server chunks: not in any manifest, so not required.
    assert.ok(!existsSync(path.join(sa, "node_modules", "zod")));
    // `sharp` is traced as an external runtime file: its folder must survive.
    removeGenerated(sa, path.join(sa, "node_modules", "sharp"));
    assert.match(
      collectPackagingProblems(proj).join("\n"),
      /traced runtime package sharp is missing/,
    );
    // And the long-standing minimum.
    removeGenerated(sa, path.join(sa, "node_modules", "next"));
    assert.match(collectPackagingProblems(proj).join("\n"), /lacks node_modules\/next/);
  } finally {
    cleanup(dir, links);
  }
});

test("a link in the path can never redirect a deletion", () => {
  const dir = makeTempDir(PREFIX);
  const links: string[] = [];
  try {
    const { proj, outside, sa } = layout(dir);
    link(outside, path.join(sa, "linkdir"), links);
    // The lexical path is inside the bundle; the physical one is not.
    assert.throws(
      () => removeGenerated(sa, path.join(sa, "linkdir", "canary.txt")),
      PackagingBoundaryError,
    );
    assert.equal(read(path.join(outside, "canary.txt")), "OUTSIDE");
    // Asking to remove the link itself removes only the link.
    removeGenerated(sa, path.join(sa, "linkdir"));
    assert.ok(gone(path.join(sa, "linkdir")));
    assert.equal(read(path.join(outside, "canary.txt")), "OUTSIDE");
    // Paths outside the bundle are refused outright.
    assert.throws(
      () => removeGenerated(sa, path.join(proj, ".data", "app.db")),
      PackagingBoundaryError,
    );
    assert.throws(() => removeGenerated(sa, sa), PackagingBoundaryError);
    assert.equal(read(path.join(proj, ".data", "app.db")), "REAL-DB-CANARY");
  } finally {
    cleanup(dir, links);
  }
});

test("path helpers: strict containment without false alarms for names that start with dots", () => {
  const parent = path.join(path.parse(process.cwd()).root, "a", "b");
  assert.ok(isInside(parent, path.join(parent, "..data")), "a name starting with .. is a child");
  assert.ok(isInside(parent, path.join(parent, "x", "y")));
  assert.ok(!isInside(parent, parent), "the parent itself is not strictly inside");
  assert.ok(!isInside(parent, path.join(parent, "..")));
  assert.ok(!isInside(parent, path.join(parent, "..", "c")));
  assert.doesNotThrow(() => assertInside(parent, path.join(parent, "..data", "z")));
  assert.throws(() => assertInside(parent, path.join(parent, "..", "x")), PackagingBoundaryError);

  assert.equal(forbiddenReason(".data/app.db"), "directory .data");
  assert.equal(forbiddenReason("sub/.runtime/z"), "directory .runtime");
  assert.equal(forbiddenReason("tests/a.ts"), "project tests/");
  assert.equal(forbiddenReason("docs/a.md"), "project docs/");
  assert.equal(forbiddenReason(".env.production"), "file .env.production");
  assert.equal(forbiddenReason(".env.example"), null);
  assert.equal(forbiddenReason("node_modules/pkg/tests/a.js"), null, "dependencies are not project state");
  assert.equal(forbiddenReason("src/components/A.tsx"), null);
});
