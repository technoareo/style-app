import { cpSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { collectPackagingProblems } from "./packaging-rules";
import { loadLocalEnvFiles } from "../src/server/localEnv";
const root = process.cwd(),
  standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js")))
  throw new Error("Build Style Studio before starting the compiled app.");
// Refuse to start a build that bundled private runtime state (paths only).
const packagingProblems = collectPackagingProblems(root);
if (packagingProblems.length)
  throw new Error(
    `The build output contains private runtime paths; rebuild with \`npm run build\`. First problem: ${packagingProblems[0]}`,
  );
const hostIndex = process.argv.indexOf("--hostname");
const host = hostIndex >= 0 ? process.argv[hostIndex + 1] : "127.0.0.1";
if (
  !["127.0.0.1", "localhost"].includes(host) &&
  process.env.STYLE_PUBLIC_DEPLOYMENT !== "true"
)
  throw new Error(
    "Configure public deployment before exposing the app outside this computer.",
  );
cpSync(
  path.join(root, ".next", "static"),
  path.join(standalone, ".next", "static"),
  { recursive: true },
);
if (existsSync(path.join(root, "public")))
  cpSync(path.join(root, "public"), path.join(standalone, "public"), {
    recursive: true,
  });
// Local launcher only. The compiled standalone server.js does chdir(__dirname)
// and so reads .env files from .next/standalone, never from this folder, which
// left a value such as VISION_MODEL in .env.local invisible to the web process
// while the analysis worker (same loader, repo root) did see it. Load the repo
// root files here, in production mode like `next start`, and the child inherits
// them. Placed after the host check so a file cannot unlock a public host; it
// reads nothing when STYLE_PUBLIC_DEPLOYMENT=true.
loadLocalEnvFiles({ dir: root, dev: false });
const child = spawn(process.execPath, [path.join(standalone, "server.js")], {
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    HOSTNAME: host,
    STYLE_DATA_DIR: process.env.STYLE_DATA_DIR || path.join(root, ".data"),
  },
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code || 0));
