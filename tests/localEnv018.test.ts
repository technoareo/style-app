import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadLocalEnvFiles } from "../src/server/localEnv";

/**
 * Local launch: the standalone analysis worker reads .env files with the SAME
 * loader Next.js uses (@next/env), so VISION_MODEL cannot name one model for
 * readiness and another for inference. These tests exercise the real loader on
 * temporary directories; they change process.env and restore it.
 */

const NAMES = ["NODE_ENV", "VISION_MODEL", "BASE_MODEL", "ONLY_ENV", "ONLY_LOCAL", "STYLE_PUBLIC_DEPLOYMENT", "AUTH_SECRET"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
});
afterEach(() => {
  for (const n of NAMES)
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
});

const dir = () => mkdtempSync(path.join(tmpdir(), "style-env-"));
const write = (d: string, name: string, text: string) => writeFileSync(path.join(d, name), text);

test("Next's order in development: .env.development.local > .env.local > .env.development > .env", () => {
  const d = dir();
  write(d, ".env", "VISION_MODEL=from-env\nONLY_ENV=1\n");
  write(d, ".env.development", "VISION_MODEL=from-development\n");
  write(d, ".env.local", "VISION_MODEL=from-local\nONLY_LOCAL=2\n");
  assert.deepEqual(loadLocalEnvFiles({ dir: d, dev: true }), [".env.local", ".env.development", ".env"]);
  assert.equal(process.env.VISION_MODEL, "from-local");
  assert.equal(process.env.ONLY_ENV, "1");
  assert.equal(process.env.ONLY_LOCAL, "2");
  delete process.env.VISION_MODEL;
  write(d, ".env.development.local", "VISION_MODEL=from-development-local\n");
  loadLocalEnvFiles({ dir: d, dev: true });
  assert.equal(process.env.VISION_MODEL, "from-development-local");
});

test("production mode reads the production files and ignores the development ones", () => {
  const d = dir();
  write(d, ".env.development", "VISION_MODEL=from-development\n");
  write(d, ".env.production", "VISION_MODEL=from-production\n");
  loadLocalEnvFiles({ dir: d, dev: false });
  assert.equal(process.env.VISION_MODEL, "from-production");
});

test("a variable set in the environment the process STARTED with is never overwritten (fresh process, as the worker runs)", () => {
  // @next/env treats the environment present at its first call as the shell's;
  // so this is checked in a new process, exactly how the worker starts.
  const d = dir();
  write(d, ".env.local", "VISION_MODEL=from-file\nONLY_LOCAL=from-file\n");
  const code = `import(${JSON.stringify(pathToFileURL(path.resolve("src/server/localEnv.ts")).href)}).then((m) => {
    m.loadLocalEnvFiles({ dir: process.argv[1], dev: true });
    console.log(JSON.stringify({ model: process.env.VISION_MODEL, other: process.env.ONLY_LOCAL }));
  });`;
  const run = spawnSync(process.execPath, ["--import", "tsx", "-e", code, d], {
    env: { ...process.env, VISION_MODEL: "from-shell", ONLY_LOCAL: undefined },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { model: "from-shell", other: "from-file" });
});

test("variable expansion works as in Next ($VAR and ${VAR}), quotes and comments are parsed", () => {
  const d = dir();
  write(d, ".env.local", '# comment\nBASE_MODEL=qwen3-vl\nVISION_MODEL="${BASE_MODEL}:4b-instruct" # trailing\n');
  loadLocalEnvFiles({ dir: d, dev: true });
  assert.equal(process.env.VISION_MODEL, "qwen3-vl:4b-instruct");
});

test("no files means nothing is loaded or changed", () => {
  assert.deepEqual(loadLocalEnvFiles({ dir: dir(), dev: true }), []);
  assert.equal(process.env.VISION_MODEL, undefined);
});

test("a public deployment never reads env files from disk", () => {
  const d = dir();
  write(d, ".env.local", "VISION_MODEL=from-file\nAUTH_SECRET=from-file\n");
  process.env.STYLE_PUBLIC_DEPLOYMENT = "true";
  assert.deepEqual(loadLocalEnvFiles({ dir: d, dev: true }), []);
  assert.equal(process.env.VISION_MODEL, undefined);
  assert.equal(process.env.AUTH_SECRET, undefined);
});

test("the analysis worker loads it before any other module, it uses Next's own loader, and the image packages it", () => {
  const worker = readFileSync("scripts/analysis-worker.ts", "utf8");
  const imports = [...worker.matchAll(/^import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.equal(imports[0], "../src/server/localEnvAuto", "first import");
  assert.match(readFileSync("src/server/localEnvAuto.ts", "utf8"), /loadLocalEnvFiles\(\);/);
  assert.match(readFileSync("src/server/localEnv.ts", "utf8"), /from "@next\/env"/);
  // src/server is copied whole into the runtime image; next (and so @next/env) is a runtime dependency.
  assert.match(readFileSync("Dockerfile", "utf8"), /COPY --from=build [^\n]*\/app\/src\/server \.\/src\/server/);
  assert.ok(JSON.parse(readFileSync("package.json", "utf8")).dependencies.next);
  assert.ok(JSON.parse(readFileSync("node_modules/@next/env/package.json", "utf8")).version);
});

test("without an explicit mode the worker follows NODE_ENV exactly as the launcher sets it: production reads the production files, anything else the development ones", () => {
  const d = dir();
  write(d, ".env.development", "VISION_MODEL=from-development\n");
  write(d, ".env.production", "VISION_MODEL=from-production\n");
  (process.env as Record<string, string>).NODE_ENV = "production";
  loadLocalEnvFiles({ dir: d });
  assert.equal(process.env.VISION_MODEL, "from-production");
  delete process.env.VISION_MODEL;
  (process.env as Record<string, string>).NODE_ENV = "development";
  loadLocalEnvFiles({ dir: d });
  assert.equal(process.env.VISION_MODEL, "from-development");
});

test("the local launcher runs Next.js in production mode, so it gives the worker the same mode before starting it", () => {
  const script = readFileSync("scripts/start-local.ps1", "utf8");
  const mode = script.indexOf("$env:NODE_ENV = 'production'");
  const worker = script.indexOf("scripts/analysis-worker.ts");
  const web = script.indexOf("npm.cmd run start");
  assert.ok(mode > 0 && worker > mode, "NODE_ENV is set before the worker starts");
  assert.ok(web > worker, "the web process is the production 'npm run start'");
  // `npm run start` is the compiled launcher, and the compiled server.js chdir()s into
  // .next/standalone, so it never sees repo-root .env files by itself. The launcher
  // therefore loads them (production mode, after the public-host check, before the spawn).
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).scripts.start, "tsx scripts/start-server.ts");
  const launcher = readFileSync("scripts/start-server.ts", "utf8");
  const load = launcher.indexOf("loadLocalEnvFiles({ dir: root, dev: false });");
  assert.ok(load > 0, "the launcher loads the repo-root env files in production mode");
  assert.ok(load > launcher.indexOf("Configure public deployment before exposing"), "after the public-host check");
  assert.ok(load < launcher.indexOf("const child = spawn("), "before the server process is started");
  assert.ok(
    readFileSync("node_modules/next/dist/build/utils.js", "utf8").includes("process.chdir(__dirname)"),
    "Next's standalone server template still chdir()s into its own folder (the reason for the launcher change)",
  );
});

test("@next/env is a direct runtime dependency, aligned with the version next itself uses", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(pkg.dependencies["@next/env"], "declared in dependencies, not only transitively");
  const installed = JSON.parse(readFileSync("node_modules/@next/env/package.json", "utf8")).version as string;
  const wanted = pkg.dependencies["@next/env"] as string;
  assert.match(wanted, /^\^?\d+\.\d+\.\d+$/);
  assert.equal(installed.split(".")[0], wanted.replace(/^\^/, "").split(".")[0], "same major");
  assert.equal(JSON.parse(readFileSync("node_modules/next/package.json", "utf8")).dependencies["@next/env"], installed, "the copy next uses is the one the worker uses");
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.ok(lock.packages[""].dependencies["@next/env"], "recorded in the lockfile root");
});
