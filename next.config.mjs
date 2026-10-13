/**
 * Private runtime state must never be traced into the standalone bundle (or a
 * container image built from it). Server code resolves its data directory from
 * process.cwd() at run time, which makes Next's file tracer pull in everything
 * under the project, including local `.data` databases, the generated auth
 * secret, captured mail, runtime binaries, env files, test data and the frozen
 * release snapshots. These excludes keep them out on Linux/Docker. On Windows
 * they cannot match: Next 15.5 builds each exclude with path.join(dir, glob)
 * (backslashes) and picomatch reads a backslash as an escape. So the `build`
 * script also runs scripts/sanitize-build-output.ts (removes private paths from
 * the generated manifests and standalone copy only, inside .next, fail closed)
 * and scripts/verify-packaging.ts (path-only check); see
 * scripts/packaging-rules.ts. start-server.ts re-checks before starting.
 */
const PRIVATE_RUNTIME = [
  ".data/**",
  "**/.data/**",
  ".runtime/**",
  "**/.runtime/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".codex/**",
  "release-snapshots/**",
  "tests/**",
  "docs/**",
  ".git/**",
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  logging: false,
  images: { unoptimized: true },
  trailingSlash: false,
  outputFileTracingExcludes: {
    "*": PRIVATE_RUNTIME,
  },
};

export default nextConfig;
