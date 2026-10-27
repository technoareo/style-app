import path from "node:path";
import { loadEnvConfig } from "@next/env";

/**
 * Local development only. The standalone analysis worker is a plain Node
 * process, so it reads no env file by itself, while Next.js reads `.env*` for
 * the web process. To make them agree (VISION_MODEL above all) the worker uses
 * the SAME loader Next.js uses, `@next/env`, instead of a copy of its rules:
 * the same file order for the mode (`.env.$MODE.local`, `.env.local`,
 * `.env.$MODE`, `.env`; `.env.local` is skipped in test mode), the same
 * `$VAR` / `${VAR}` expansion, and the same rule that a variable already set in
 * the process environment is never overwritten.
 *
 * Mode: Next picks it from how it was started (`next dev` reads the
 * development files, `next start` the production files). The worker has no such
 * signal, so it follows NODE_ENV (production only when NODE_ENV=production).
 * The one setup that works identically for both is to put shared settings in
 * `.env.local` (read in every mode but test) or `.env`; do not rely on
 * `.env.development` / `.env.production` files for settings the web process and
 * the worker must share.
 *
 * It does nothing in a public deployment (STYLE_PUBLIC_DEPLOYMENT=true, which
 * Compose forces on): there the configuration comes from the container
 * environment (`.env.production` through `env_file`), and no file on disk may
 * change it. @next/env is a dependency of `next`, which the runtime image
 * installs, but it is not even called there. Nothing is logged: values may be
 * secrets. Returns the base names of the files that were read.
 */
export function loadLocalEnvFiles(options: { dir?: string; dev?: boolean } = {}): string[] {
  if (process.env.STYLE_PUBLIC_DEPLOYMENT === "true") return [];
  const dir = options.dir ?? process.cwd();
  const dev = options.dev ?? process.env.NODE_ENV !== "production";
  const quiet = { info() {}, error() {} };
  // forceReload: the loader caches by process; each call here reads the files again.
  const { loadedEnvFiles } = loadEnvConfig(dir, dev, quiet, true);
  return loadedEnvFiles.map((file) => path.basename(file.path));
}
