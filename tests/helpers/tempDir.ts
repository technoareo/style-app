import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Temp directories for tests that build their own SQLite files. Recursive
 * cleanup is only ever performed on a directory that, after resolving
 * symlinks/junctions and 8.3 short names to an absolute path, is a direct
 * child of the real OS temp dir and carries the exact prefix this helper
 * created it with. Anything else is refused rather than deleted.
 */

const norm = (p: string) =>
  process.platform === "win32" ? p.toLowerCase() : p;

function realTmp(): string {
  return realpathSync.native(tmpdir());
}

export function makeTempDir(prefix: string): string {
  if (!/^[A-Za-z0-9._-]{4,}$/.test(prefix))
    throw new Error("Unsafe temp directory prefix.");
  return realpathSync.native(mkdtempSync(path.join(realTmp(), prefix)));
}

export function assertSafeTempDir(dir: string, prefix: string): string {
  const root = realTmp();
  const target = realpathSync.native(path.resolve(dir));
  const inside =
    norm(path.dirname(target)) === norm(root) &&
    path.basename(target).length > prefix.length &&
    norm(path.basename(target)).startsWith(norm(prefix));
  if (!inside)
    throw new Error(`Refusing to recursively delete outside temp: ${target}`);
  return target;
}

export function removeTempDir(dir: string, prefix: string): void {
  const target = assertSafeTempDir(dir, prefix);
  // SQLite files can stay locked briefly on Windows after close().
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
