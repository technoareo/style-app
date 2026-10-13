/**
 * Shared rules for keeping private runtime state out of the build output.
 * Used by scripts/packaging-sanitize.ts (via sanitize-build-output.ts),
 * scripts/verify-packaging.ts and scripts/start-server.ts. PATHS ONLY: nothing
 * here opens a traced file, a database, `.env`, `.data` or `.runtime` content;
 * the only file contents ever read are the generated `*.nft.json` path lists.
 *
 * Why this exists: server code resolves its data directory from process.cwd()
 * at run time, so Next's file tracer (nft) pulls the project's `.data`
 * (databases, generated auth secret, captured mail), `tests` and `docs` into
 * the route trace manifests and `.next/standalone`. Next's own
 * `outputFileTracingExcludes` cannot be relied on for this on Windows:
 * collect-build-traces.js builds each exclude with path.join(dir, exclude),
 * which yields backslashes, and picomatch treats a backslash as an escape, so
 * no pattern ever matches an absolute Windows path. The excludes in
 * next.config.mjs still work on Linux/Docker; the sanitize step makes every
 * platform safe, and the verify step fails closed.
 *
 * Boundary rules (build 008). Every check is PHYSICAL, not just lexical:
 *  - `.next` and `.next/standalone` must be real directories (not symlinks,
 *    not Windows junctions) whose real path equals the path built from the
 *    project's real path, so no ancestor between the project and the output
 *    can redirect a write or deletion elsewhere;
 *  - a trace manifest must be a regular file; a link is refused, because
 *    rewriting it would write through the link;
 *  - links inside the generated bundle are never followed.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

export class PackagingBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackagingBoundaryError";
  }
}

export const FORBIDDEN_DIRS = new Set([
  ".data",
  ".runtime",
  ".codex",
  ".git",
  "release-snapshots",
]);
const FORBIDDEN_ROOT_DIRS = new Set(["tests", "docs"]);
const FORBIDDEN_NAMES: RegExp[] = [
  /^\.env(\..+)?$/,
  /^auth-secret$/,
  /^mail-outbox$/,
  /^app\.db(-wal|-shm|\.restore-pending)?$/,
  /^style-[0-9TZ.-]+\.db$/,
  /^schema\.lock$/,
];

/** Why a bundle-relative path must not ship, or null if it is fine. */
export function forbiddenReason(rel: string): string | null {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  // Dependencies are not project state; judge only the project's own paths.
  const nm = parts.indexOf("node_modules");
  const own = nm === -1 ? parts : parts.slice(0, nm);
  for (const part of own)
    if (FORBIDDEN_DIRS.has(part)) return `directory ${part}`;
  if (own.length && FORBIDDEN_ROOT_DIRS.has(own[0])) return `project ${own[0]}/`;
  const base = own.at(-1);
  if (base && base !== ".env.example")
    for (const re of FORBIDDEN_NAMES) if (re.test(base)) return `file ${base}`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Lexical and physical path checks                                   */
/* ------------------------------------------------------------------ */

/** True when `child` is strictly inside `parent` (lexically; both resolved). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(".." + path.sep) &&
    !path.isAbsolute(rel)
  );
}

/** True when the two paths name the same location (case rules of the platform). */
export const samePath = (a: string, b: string): boolean =>
  path.relative(path.resolve(a), path.resolve(b)) === "";

/** Throws unless `target` is strictly inside `parent` (no `..`, no other drive). */
export function assertInside(parent: string, target: string): void {
  if (!isInside(parent, target))
    throw new PackagingBoundaryError(
      `Refusing to touch a path outside the generated output: ${path.resolve(target)}`,
    );
}

/**
 * For a path that is about to be modified or removed: it must be strictly
 * inside `boundaryReal` lexically AND its parent directory must physically
 * resolve to the same place, so no link in the chain can redirect the
 * operation. The target itself is judged separately (a link is unlinked, never
 * followed).
 */
export function assertSafeToTouch(boundaryReal: string, target: string): void {
  assertInside(boundaryReal, target);
  let parentReal: string;
  try {
    parentReal = realpathSync(path.dirname(target));
  } catch {
    throw new PackagingBoundaryError(
      `Cannot resolve the folder of ${path.resolve(target)}`,
    );
  }
  const expected = path.join(parentReal, path.basename(target));
  if (!samePath(expected, target) || !isInside(boundaryReal, expected))
    throw new PackagingBoundaryError(
      `A link in the path would redirect ${path.resolve(target)} outside the generated output`,
    );
}

export type OutputRoots = {
  rootReal: string;
  nextDir: string;
  standalone: string;
  hasStandalone: boolean;
};

/** A real directory (not a link) whose physical path equals its lexical path. */
function assertPlainDirectory(rootReal: string, dir: string, label: string) {
  const info = lstatSync(dir);
  if (info.isSymbolicLink())
    throw new PackagingBoundaryError(
      `${label} is a symlink or junction; refusing to use it.`,
    );
  if (!info.isDirectory())
    throw new PackagingBoundaryError(`${label} is not a directory.`);
  const real = realpathSync(dir);
  if (!samePath(real, dir) || !isInside(rootReal, real))
    throw new PackagingBoundaryError(
      `${label} resolves outside the project through a link; refusing to use it.`,
    );
}

/**
 * Resolves and validates the generated-output roots for a project. Throws
 * PackagingBoundaryError when `.next` or `.next/standalone` is a link, resolves
 * outside the real project, or is not a directory; throws ENOENT-based
 * errors with a clear message when `.next` is missing.
 */
export function resolveOutputRoots(root: string): OutputRoots {
  const rootReal = realpathSync(root);
  const nextDir = path.join(rootReal, ".next");
  if (!existsSync(nextDir) && !safeLstat(nextDir))
    throw new PackagingBoundaryError(
      "No .next directory. Run `npm run build` first.",
    );
  assertPlainDirectory(rootReal, nextDir, ".next");
  const standalone = path.join(nextDir, "standalone");
  const hasStandalone = Boolean(safeLstat(standalone));
  if (hasStandalone) assertPlainDirectory(nextDir, standalone, ".next/standalone");
  return { rootReal, nextDir, standalone, hasStandalone };
}

function safeLstat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Walking generated output                                           */
/* ------------------------------------------------------------------ */

/** Every `*.nft.json` under `dir` (including `standalone/.next`), not node_modules. Links are yielded, never followed. */
export function* manifests(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // lstat, not the Dirent flag: it is the call that reports Windows
    // junctions as links on every platform, and a link is never descended.
    const info = safeLstat(full);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      if (entry.name.endsWith(".nft.json")) yield full; // refused by the callers
    } else if (info.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* manifests(full);
    } else if (entry.name.endsWith(".nft.json")) yield full;
  }
}

export type Entry = { full: string; isLink: boolean };

/**
 * Names (not contents) of everything in `dir`, skipping the inside of
 * node_modules. Links are reported with `isLink` and never descended into.
 */
export function* entries(dir: string): Generator<Entry> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const info = safeLstat(full);
    if (!info) continue;
    const isLink = info.isSymbolicLink() || entry.isSymbolicLink();
    yield { full, isLink };
    if (!isLink && info.isDirectory() && entry.name !== "node_modules")
      yield* entries(full);
  }
}

/** Names only (compatibility helper). */
export function* names(dir: string): Generator<string> {
  for (const e of entries(dir)) yield e.full;
}

/**
 * Where a link points, resolved against its folder, or null if it cannot be
 * read. Used only to decide whether a link inside the bundle escapes it.
 */
export function linkTarget(link: string): string | null {
  try {
    return path.resolve(path.dirname(link), readlinkSync(link));
  } catch {
    return null;
  }
}

/**
 * The directory a manifest's entries are relative to the bundle root of:
 * manifests inside `.next/standalone` are relative to that directory, all
 * others to the project root.
 */
export function bundleRoot(root: string, manifest: string): string {
  const standalone = path.join(root, ".next", "standalone");
  const rel = path.relative(standalone, manifest);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? standalone
    : root;
}

export type Manifest = { version?: number; files: string[] } & Record<
  string,
  unknown
>;

/** The parsed manifest if it is a JSON object whose `files` is an array of strings; otherwise null. */
export function readManifest(manifest: string): Manifest | null {
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.files) &&
      parsed.files.every((f: unknown) => typeof f === "string")
    )
      return parsed as Manifest;
  } catch {
    // Unreadable or malformed: the caller fails closed.
  }
  return null;
}

export function readManifestFiles(manifest: string): string[] | null {
  return readManifest(manifest)?.files ?? null;
}

/** A manifest must be a regular file; a link would be written through. */
export function manifestProblem(nextDir: string, manifest: string): string | null {
  const info = safeLstat(manifest);
  if (!info) return "missing";
  if (info.isSymbolicLink()) return "is a symlink or junction";
  if (!info.isFile()) return "is not a regular file";
  try {
    if (!isInside(nextDir, path.join(realpathSync(path.dirname(manifest)), path.basename(manifest))))
      return "resolves outside .next";
  } catch {
    return "cannot be resolved";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Required runtime packages                                          */
/* ------------------------------------------------------------------ */

/**
 * Packages the build's OWN trace manifests say the server needs from
 * node_modules (paths only). Packages that webpack bundled into the server
 * chunks never appear here, so "bundled versus external" needs no hand-kept
 * list: whatever the tracer marked as an external runtime file must still be
 * physically present in the standalone bundle after sanitizing. The strongest
 * check remains scripts/verify-standalone.ts, which starts the bundle with no
 * ancestor node_modules and exercises real routes.
 */
export function tracedPackages(root: string, nextDir: string, standalone: string): Set<string> {
  const found = new Set<string>();
  for (const manifest of manifests(nextDir)) {
    if (isInside(standalone, manifest)) continue; // copies of the same lists
    const files = readManifestFiles(manifest);
    if (!files) continue; // reported separately
    for (const file of files) {
      const relative = path.relative(
        root,
        path.resolve(path.dirname(manifest), file),
      );
      if (path.isAbsolute(relative)) continue; // another drive
      const rel = relative.split(path.sep);
      if (rel[0] === "..") continue;
      const i = rel.indexOf("node_modules");
      if (i === -1) continue;
      const name = rel[i + 1];
      if (!name) continue;
      found.add(name.startsWith("@") && rel[i + 2] ? `${name}/${rel[i + 2]}` : name);
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* The verification everything shares                                 */
/* ------------------------------------------------------------------ */

/** Everything wrong with the build output right now (empty = clean). */
export function collectPackagingProblems(root: string): string[] {
  const problems: string[] = [];
  let roots: OutputRoots;
  try {
    roots = resolveOutputRoots(root);
  } catch (error) {
    return [error instanceof Error ? error.message : "Unusable build output."];
  }
  const { rootReal, nextDir, standalone, hasStandalone } = roots;
  let manifestCount = 0;
  for (const manifest of manifests(nextDir)) {
    manifestCount++;
    const shown = path.relative(rootReal, manifest);
    const issue = manifestProblem(nextDir, manifest);
    if (issue) {
      problems.push(`trace manifest ${shown} ${issue}`);
      continue;
    }
    const files = readManifestFiles(manifest);
    if (!files) {
      problems.push(`unreadable or malformed trace manifest: ${shown}`);
      continue;
    }
    const base = bundleRoot(rootReal, manifest);
    for (const file of files) {
      const rel = path.relative(base, path.resolve(path.dirname(manifest), file));
      const reason = forbiddenReason(rel);
      if (reason) problems.push(`${shown} traces ${rel} (${reason})`);
    }
  }
  if (manifestCount === 0)
    problems.push("no *.nft.json trace manifests found; was this a production build?");
  if (!hasStandalone || !safeLstat(path.join(standalone, "server.js"))?.isFile())
    problems.push("`.next/standalone/server.js` is missing (output: standalone?)");
  else {
    if (!existsSync(path.join(standalone, "node_modules", "next")))
      problems.push("standalone output lacks node_modules/next (over-excluded?)");
    for (const e of entries(standalone)) {
      const rel = path.relative(standalone, e.full);
      const reason = forbiddenReason(rel);
      if (reason) problems.push(`standalone contains ${rel} (${reason})`);
      if (e.isLink) {
        const target = linkTarget(e.full);
        if (!target || (!isInside(standalone, target) && !samePath(standalone, target)))
          problems.push(`standalone contains a link that leaves the bundle: ${rel}`);
      }
    }
    // Everything the tracer called an external runtime file must have survived.
    for (const name of tracedPackages(rootReal, nextDir, standalone))
      if (!existsSync(path.join(standalone, "node_modules", ...name.split("/"))))
        problems.push(
          `traced runtime package ${name} is missing from the standalone bundle (over-sanitized or an incomplete trace)`,
        );
  }
  return problems;
}
