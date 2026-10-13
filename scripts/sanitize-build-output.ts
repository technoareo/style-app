/**
 * CLI wrapper: `tsx scripts/sanitize-build-output.ts` (run by `npm run build`
 * after `next build`). All logic, and the full list of boundary guarantees,
 * lives in packaging-sanitize.ts so it can be tested against isolated temp
 * trees. Any error fails the build.
 */
import { sanitizeBuildOutput } from "./packaging-sanitize";

try {
  const result = sanitizeBuildOutput(process.cwd());
  console.log(
    `Sanitized build output: ${result.droppedEntries} trace entries dropped from ${result.rewritten} manifests, ${result.removed} bundled private paths or escaping links removed (generated output only).`,
  );
} catch (error) {
  console.error(
    "Sanitizing the build output failed; failing the build:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}
