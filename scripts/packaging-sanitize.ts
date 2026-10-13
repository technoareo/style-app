/**
 * Removes private runtime paths from the GENERATED build output. The CLI
 * wrapper (sanitize-build-output.ts) runs it right after `next build`, then the
 * packaging check runs; both must pass for the build to succeed.
 *
 * What it touches, and only this:
 *   1. every `*.nft.json` trace manifest under `.next` (generated lists of
 *      file paths): entries naming private runtime paths are dropped, and the
 *      file is replaced atomically (unpredictable temp name, exclusive create, rename in the same folder);
 *   2. COPIES of such files/directories inside `.next/standalone` (the
 *      standalone bundle Next generated): deleted; and links inside the bundle
 *      that leave it: unlinked.
 * It never touches the project's real `.data`, `.runtime`, `.env*`, tests,
 * docs or any source.
 *
 * Boundary guarantees (see packaging-rules.ts):
 *   - `.next` and `.next/standalone` must be real directories whose physical
 *     path equals their lexical path; a symlink/junction at either, or any link
 *     between the project and them, aborts before anything is changed;
 *   - every deletion target is strictly inside `.next/standalone` AND its
 *     parent folder physically resolves to the same place, so a link in the
 *     chain cannot redirect the deletion;
 *   - a link is removed AS A LINK (never followed, never emptied through);
 *     directories are emptied entry by entry with the same checks;
 *   - a manifest that is a link, is unreadable, is not JSON or whose `files`
 *     is not a list of strings aborts the build (fail closed): it is never
 *     written through;
 *   - it is idempotent: a second run on sanitized output changes nothing.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  assertSafeToTouch,
  bundleRoot,
  entries,
  forbiddenReason,
  isInside,
  linkTarget,
  manifestProblem,
  manifests,
  PackagingBoundaryError,
  readManifest,
  resolveOutputRoots,
  samePath,
} from "./packaging-rules";

export type SanitizeResult = {
  droppedEntries: number;
  rewritten: number;
  removed: number;
};

/** Removes a symlink or junction itself, never its target. */
export function removeLink(link: string): void {
  try {
    unlinkSync(link);
  } catch {
    // Windows directory symlinks and junctions are removed with rmdir, which
    // on a link removes only the link.
    rmdirSync(link);
  }
}

function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    chmodSync(file, 0o666);
    unlinkSync(file);
  }
}

/**
 * Removes a directory tree that lies inside `boundaryReal`. Links are removed
 * as links; a directory whose physical path differs from its lexical one (a
 * link the platform did not flag) is treated as a link, never entered.
 */
function removeTree(dir: string, boundaryReal: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    const info = lstatSync(child);
    if (entry.isSymbolicLink() || info.isSymbolicLink()) {
      removeLink(child);
      continue;
    }
    if (info.isDirectory()) {
      const real = realpathSync(child);
      if (!samePath(real, child) || !isInside(boundaryReal, real)) {
        removeLink(child);
        continue;
      }
      removeTree(child, boundaryReal);
    } else removeFile(child);
  }
  rmdirSync(dir);
}

/** Removes one generated copy (file, directory or link) under the boundary. */
export function removeGenerated(boundaryReal: string, target: string): void {
  assertSafeToTouch(boundaryReal, target);
  const info = lstatSync(target);
  if (info.isSymbolicLink()) removeLink(target);
  else if (info.isDirectory()) removeTree(target, boundaryReal);
  else removeFile(target);
}

export type SanitizeOptions = {
  /** Test seam only: the unique part of the temporary manifest name. */
  tempSuffix?: () => string;
};

/**
 * Replaces a validated manifest. The temporary file has an unpredictable name
 * and is created EXCLUSIVELY (`wx` = O_CREAT|O_EXCL, which also refuses a
 * pre-existing symlink or junction at that path rather than following it), in
 * the manifest's own folder after that folder's physical path was checked.
 * If anything already exists at the temporary path the build fails; nothing is
 * truncated or written through. The temporary file is removed on failure only
 * if this call created it.
 */
function writeManifestAtomically(
  boundary: string,
  manifest: string,
  text: string,
  suffix: string,
): void {
  if (!/^[A-Za-z0-9]{1,32}$/.test(suffix))
    throw new PackagingBoundaryError("Unsafe temporary file name.");
  const temp = `${manifest}.${suffix}.sanitizing`;
  assertSafeToTouch(boundary, temp);
  const fd = openSync(temp, "wx"); // throws EEXIST if anything is there
  try {
    try {
      writeFileSync(fd, text, "utf8"); // writes everything to the descriptor we created
    } finally {
      closeSync(fd);
    }
    renameSync(temp, manifest);
  } catch (error) {
    try {
      if (lstatSync(temp).isFile()) unlinkSync(temp);
    } catch {
      // nothing of ours left to remove
    }
    throw error;
  }
}

export function sanitizeBuildOutput(
  root: string,
  options: SanitizeOptions = {},
): SanitizeResult {
  // Throws before any change if .next or .next/standalone is a link or
  // resolves outside the real project.
  const { rootReal, nextDir, standalone, hasStandalone } =
    resolveOutputRoots(root);

  // 1. Validate EVERY manifest before changing anything, so a bad one aborts
  //    the whole run instead of leaving the output half-sanitized.
  const plan: { manifest: string; text: string; dropped: number }[] = [];
  for (const manifest of manifests(nextDir)) {
    const shown = path.relative(rootReal, manifest);
    const issue = manifestProblem(nextDir, manifest);
    if (issue)
      throw new PackagingBoundaryError(`Trace manifest ${shown} ${issue}.`);
    const original = readManifest(manifest);
    if (!original)
      throw new PackagingBoundaryError(
        `Unreadable or malformed trace manifest ${shown}`,
      );
    const base = bundleRoot(rootReal, manifest);
    const kept = original.files.filter((file) => {
      const rel = path.relative(base, path.resolve(path.dirname(manifest), file));
      return forbiddenReason(rel) === null;
    });
    if (kept.length === original.files.length) continue;
    plan.push({
      manifest,
      text: JSON.stringify({ ...original, files: kept }),
      dropped: original.files.length - kept.length,
    });
  }

  // 2. Work out what to delete inside the standalone bundle.
  const doomed: string[] = [];
  if (hasStandalone) {
    const covered = (p: string) =>
      doomed.some((d) => p === d || p.startsWith(d + path.sep));
    for (const e of entries(standalone)) {
      if (covered(e.full)) continue;
      if (forbiddenReason(path.relative(standalone, e.full)) !== null) {
        doomed.push(e.full);
        continue;
      }
      if (e.isLink) {
        // A link that leaves the bundle (or cannot be read) is generated
        // clutter at best and a path to private data at worst: unlink it.
        const target = linkTarget(e.full);
        if (!target || (!isInside(standalone, target) && !samePath(standalone, target)))
          doomed.push(e.full);
      }
    }
  }

  // 3. Apply. Manifests first (atomic replacement), then deletions.
  let droppedEntries = 0;
  for (const item of plan) {
    writeManifestAtomically(
      nextDir,
      item.manifest,
      item.text,
      (options.tempSuffix ?? (() => randomBytes(8).toString("hex")))(),
    );
    droppedEntries += item.dropped;
  }
  let removed = 0;
  for (const target of doomed) {
    removeGenerated(standalone, target);
    removed++;
  }
  return { droppedEntries, rewritten: plan.length, removed };
}
