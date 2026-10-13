/**
 * Packaging check: fails if the production build output contains private
 * runtime state. Run after `npm run build` (the build script already runs the
 * sanitize step and then this check, so a failing check fails the build).
 *
 *   npm run verify:packaging
 *
 * Paths only; see scripts/packaging-rules.ts for what is forbidden and why.
 */
import path from "node:path";
import { collectPackagingProblems } from "./packaging-rules";

const problems = collectPackagingProblems(process.cwd());
if (problems.length) {
  console.error(`Packaging check FAILED (${problems.length} problem(s)):`);
  for (const p of problems.slice(0, 50)) console.error(" - " + p);
  if (problems.length > 50)
    console.error(` ... and ${problems.length - 50} more`);
  process.exit(1);
}
console.log(
  `Packaging check passed in ${path.basename(process.cwd())}: trace manifests and the standalone tree contain no private runtime paths (paths only; no file contents were read).`,
);
