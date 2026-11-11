import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Build 030 contract tests. They do NOT run `npm audit` (that needs the registry) and they do not record an audit
 * count: they pin the patched minimum versions in package.json AND in the lockfile that `npm ci` and the Docker
 * image install from, keep the Next packages aligned, and require the CI audit gate in the jobs that install
 * runtime dependencies. The audit itself is the CI step they check for.
 */

const root = process.cwd();
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; overrides?: Record<string, unknown> };
const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string; dev?: boolean }> };

/** Patched releases (GHSA-2464-fhr4-w9xw and GHSA-p3m5-59mp-jv5r for next; GHSA-mrhx-c7xc-m3w5 for zod; the nodemailer addressparser advisories). */
const MIN = { next: "15.5.29", "@next/env": "15.5.29", "eslint-config-next": "15.5.29", zod: "4.6.7", nodemailer: "10.4.0" } as const;

const parse = (v: string): [number, number, number] => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  assert.ok(m, `not a plain x.y.z version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const atLeast = (have: string, want: string) => {
  const a = parse(have);
  const b = parse(want);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
/** The lowest version a range like ^15.5.29 or 15.5.29 can resolve to. */
const rangeFloor = (range: string) => range.replace(/^[\^~]/, "");

test("the version helpers behave (so the pins below mean something)", () => {
  assert.equal(atLeast("15.5.29", "15.5.29"), true);
  assert.equal(atLeast("15.5.27", "15.5.29"), false);
  assert.equal(atLeast("15.6.0", "15.5.29"), true);
  assert.equal(atLeast("16.0.0", "15.5.29"), true);
  assert.equal(atLeast("4.6.5", "4.6.7"), false);
  assert.equal(atLeast("10.1.0", "10.4.0"), false);
  assert.equal(rangeFloor("^15.5.29"), "15.5.29");
  assert.throws(() => parse("15.5"), /not a plain/);
});

test("package.json declares at least the patched versions", () => {
  for (const name of ["next", "@next/env", "zod", "nodemailer"] as const)
    assert.ok(atLeast(rangeFloor(pkg.dependencies[name]), MIN[name]), `${name} ${pkg.dependencies[name]} must allow no version below ${MIN[name]}`);
  assert.ok(atLeast(rangeFloor(pkg.devDependencies["eslint-config-next"]), MIN["eslint-config-next"]), `eslint-config-next ${pkg.devDependencies["eslint-config-next"]}`);
});

test("the lockfile (what npm ci and the Docker image install) resolves the patched versions", () => {
  for (const name of Object.keys(MIN) as Array<keyof typeof MIN>) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry?.version, `${name} is in the lockfile`);
    assert.ok(atLeast(entry.version as string, MIN[name]), `lockfile ${name} ${entry.version} must be at least ${MIN[name]}; run npm install, do not hand-edit the lockfile`);
  }
  // runtime packages are not marked dev-only
  for (const name of ["next", "@next/env", "zod", "nodemailer"]) assert.notEqual(lock.packages[`node_modules/${name}`]?.dev, true, `${name} must stay a runtime dependency`);
});

test("next, @next/env and eslint-config-next stay on the same version", () => {
  const versions = ["next", "@next/env", "eslint-config-next"].map((n) => lock.packages[`node_modules/${n}`]?.version);
  assert.equal(new Set(versions).size, 1, `Next packages are misaligned: ${versions.join(", ")}`);
  // the declared floors are aligned too, and the Next eslint plugin matches
  assert.equal(rangeFloor(pkg.dependencies.next), rangeFloor(pkg.dependencies["@next/env"]));
  assert.equal(rangeFloor(pkg.dependencies.next), rangeFloor(pkg.devDependencies["eslint-config-next"]));
  const plugin = lock.packages["node_modules/@next/eslint-plugin-next"]?.version;
  assert.equal(plugin, versions[0], "@next/eslint-plugin-next follows eslint-config-next");
});

test("no override pins a patched package back to a vulnerable version", () => {
  const overrides = JSON.stringify(pkg.overrides ?? {});
  for (const name of ["next", "@next/env", "zod", "nodemailer"]) assert.ok(!overrides.includes(`"${name}"`), `${name} is not overridden`);
});

// ------------------------------------------------------------------ the CI audit gate

/** The steps of one job, as raw text blocks, in order. */
function job(ci: string, name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} exists`);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
const code = (s: string) => s.replace(/^\s*#.*$/gm, "");

test("the build and docker jobs run npm audit --omit=dev right after npm ci, and nothing can make it pass on a finding", () => {
  const ci = read(".github/workflows/ci.yml").replace(/\r\n/g, "\n");
  for (const name of ["build", "docker"]) {
    const body = code(job(ci, name));
    const iCi = body.indexOf("run: npm ci");
    const iAudit = body.indexOf("run: npm audit --omit=dev");
    assert.ok(iCi >= 0 && iAudit > iCi, `${name}: npm audit --omit=dev comes after npm ci`);
    // before anything is built, tested or started
    const firstWork = [body.indexOf("run: npm run typecheck"), body.indexOf("run: docker build"), body.indexOf("run: npm test")].filter((i) => i >= 0);
    assert.ok(firstWork.every((i) => iAudit < i), `${name}: the audit gate comes before typecheck/test/docker build`);
    assert.equal((body.match(/npm audit/g) ?? []).length, 1, `${name}: exactly one audit step`);
    const step = /- name: Audit runtime dependencies[^\n]*\n\s+run: npm audit --omit=dev\n/.exec(body)?.[0] ?? "";
    assert.ok(step, `${name}: the audit is its own named step`);
    assert.doesNotMatch(step, /continue-on-error|\|\||--audit-level|--force|--no-audit/, `${name}: the step cannot be softened`);
  }
  assert.doesNotMatch(code(ci), /continue-on-error:\s*true/, "no job ignores failures");
  assert.doesNotMatch(code(ci), /npm audit[^\n]*(--audit-level|\|\||2>&1 \|)/, "no audit level or pipe lets a finding pass");
});

test("the runtime Docker image installs from the same lockfile the audit reads, and the docker job audits before building it", () => {
  const dockerfile = read("Dockerfile");
  const stages = dockerfile.split(/^FROM /m).slice(1);
  const deps = stages.find((s) => /^\S+\s+AS\s+dependencies\b/i.test(s)) ?? "";
  const build = stages.find((s) => /^\S+\s+AS\s+build\b/i.test(s)) ?? "";
  const runtime = stages.find((s) => /^\S+\s+AS\s+runtime\b/i.test(s)) ?? "";
  assert.ok(deps && build && runtime, "build, dependencies and runtime stages exist");
  for (const [label, stage] of [["dependencies", deps], ["build", build]] as const) {
    // package.json, package-lock.json (package*.json) AND .npmrc (the install-script policy), all before npm ci
    assert.match(stage, /^COPY package\*\.json \.npmrc \.\/$/m, `${label} stage copies package.json, package-lock.json and .npmrc`);
    assert.ok(stage.indexOf("COPY package*.json .npmrc ./") < stage.indexOf("npm ci"), `${label}: the manifests and .npmrc are copied before npm ci`);
  }
  assert.match(deps, /RUN npm ci --omit=dev\b/, "runtime node_modules are the lockfile's production set");
  assert.doesNotMatch(dockerfile, /npm install|npm update|npm audit fix|--legacy-peer-deps|--force/, "the image never resolves versions itself");
  assert.match(runtime, /COPY --from=dependencies \/app\/node_modules \.\/node_modules/, "the runtime image uses the audited production set");
  // the docker job audits before it builds that image
  const body = code(job(read(".github/workflows/ci.yml").replace(/\r\n/g, "\n"), "docker"));
  assert.ok(body.indexOf("npm audit --omit=dev") < body.indexOf("docker build -t style-studio:ci ."));
});

// ------------------------------------------------------------------ install-script policy and toolchain

const full = JSON.parse(read("package.json")) as {
  engines?: { node?: string };
  packageManager?: string;
  devEngines?: Record<string, { name?: string; version?: string; onFail?: string }>;
  allowScripts?: Record<string, unknown>;
};
const readNpmrc = () => read(".npmrc").replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith(";"));

test("install scripts are denied by name: exactly esbuild, fsevents and unrs-resolver, all false, no approval anywhere", () => {
  assert.deepEqual(full.allowScripts, { esbuild: false, fsevents: false, "unrs-resolver": false });
  for (const [key, value] of Object.entries(full.allowScripts ?? {})) {
    assert.ok(!key.includes("@") || key.startsWith("@") && !/@\d/.test(key), `${key}: name only, no version, so a version bump cannot silently lose the denial`);
    assert.strictEqual(value, false, `${key} is an explicit denial`);
  }
  assert.ok(!Object.values(full.allowScripts ?? {}).includes(true), "no true approval");
});

type LockEntry = { hasInstallScript?: boolean; optional?: boolean; dev?: boolean; os?: string[]; cpu?: string[] };
const lockEntries = Object.entries(lock.packages as Record<string, LockEntry>);
const scriptPackages = lockEntries.filter(([, e]) => e.hasInstallScript === true).map(([p, e]) => ({ name: p.split("node_modules/").pop() as string, entry: e }));

test("every package in the lockfile that has an install script is covered by an explicit denial, whatever platform it is for", () => {
  // DECISION (build 030): no platform exclusion. The lockfile is shared by every developer and build platform, and npm 11
  // strict mode refuses an install-script package that has no entry wherever that package is installable. Excluding
  // "impossible here" packages from this contract would pass on Linux/Windows and fail on the first Mac. So every
  // package the lockfile records with an install script needs an explicit decision, optional and OS-restricted ones included.
  assert.ok(scriptPackages.length >= 1, "the lockfile still records install-script packages, so this check is not vacuous");
  const denied = new Set(Object.keys(full.allowScripts ?? {}));
  for (const { name } of scriptPackages) assert.ok(denied.has(name), `${name} has an install script and no explicit decision in allowScripts`);
  // and no denial is stale: each one names a package the lockfile actually records with a script
  const recorded = new Set(scriptPackages.map((p) => p.name));
  for (const name of denied) assert.ok(recorded.has(name), `${name} is denied but no lockfile package of that name has an install script (stale entry)`);
});

test("fsevents: optional and macOS-only, denied explicitly; the limits of that decision are pinned", () => {
  // fsevents is an optional macOS file-watcher binding (pulled in by tsx and others). On Linux (the production platform)
  // and Windows (root) npm ignores it as platform-ineligible, so `npm install-scripts ls` reports nothing for it there.
  // On macOS it IS eligible, and without a decision strict mode would fail the install with ESTRICTALLOWSCRIPTS. It is
  // denied rather than approved: fsevents 2.3.x ships its prebuilt fsevents.node in the package, and the install script
  // only matters when that binary is missing. LIMIT: this has NOT been run on macOS by the builder or root; if a Mac
  // developer sees file-watching fail, the fix is a reviewed change of this entry, not a bypass flag.
  const fsevents = scriptPackages.find((p) => p.name === "fsevents");
  assert.ok(fsevents, "fsevents is recorded with an install script");
  assert.equal(fsevents.entry.optional, true, "optional: never required on any platform");
  assert.deepEqual(fsevents.entry.os, ["darwin"], "only installable on macOS");
  assert.strictEqual((full.allowScripts as Record<string, unknown>).fsevents, false);
  // Every OTHER install-script package must be installable on the supported build/runtime platforms (it is a real
  // decision there), and none may be a platform-restricted optional package we have not thought about.
  const restricted = scriptPackages.filter((p) => p.entry.optional === true || (p.entry.os?.length ?? 0) > 0 || (p.entry.cpu?.length ?? 0) > 0).map((p) => p.name).sort();
  assert.deepEqual(restricted, ["fsevents"], "the only optional/OS-restricted install-script package is fsevents; a new one needs a deliberate review of this test and the policy");
  const unrestricted = scriptPackages.filter((p) => !restricted.includes(p.name)).map((p) => p.name).sort();
  assert.deepEqual(unrestricted, ["esbuild", "unrs-resolver"], "the runnable install-script packages (they run, or are skipped by the denial, on Linux and Windows)");
});

test(".npmrc turns on strict-allow-scripts and carries no bypass", () => {
  const lines = readNpmrc();
  assert.ok(lines.includes("strict-allow-scripts=true"), "strict-allow-scripts=true");
  assert.equal(lines.filter((l) => /^strict-allow-scripts\s*=/.test(l)).length, 1, "set once");
  for (const l of lines) assert.doesNotMatch(l, /^(ignore-scripts\s*=\s*false|force|legacy-peer-deps|audit\s*=\s*false|strict-allow-scripts\s*=\s*false|allow-scripts)/i, `bypass in .npmrc: ${l}`);
});

test("the toolchain is pinned and enforced: Node >=24.20 <25 and npm >=11.19 <12, onFail error", () => {
  assert.equal(full.engines?.node, ">=24.20 <25");
  assert.equal(full.packageManager, "npm@11.19.0");
  assert.deepEqual(full.devEngines, {
    runtime: { name: "node", version: ">=24.20 <25", onFail: "error" },
    packageManager: { name: "npm", version: ">=11.19 <12", onFail: "error" },
  });
  const [maj, min] = (/^npm@(\d+)\.(\d+)\.\d+$/.exec(full.packageManager ?? "") ?? []).slice(1).map(Number);
  assert.ok(maj === 11 && min >= 19, "the pinned packageManager satisfies its own devEngines range");
  assert.equal(full.devEngines?.runtime.version, full.engines?.node, "engines and devEngines agree on Node");
});

test("nothing installs with a bypass: exactly the two audited npm ci commands, no policy-defeating flag, .npmrc not ignored", () => {
  // (that .npmrc is copied before each npm ci is asserted once, in the Docker image test above)
  const dockerfile = read("Dockerfile");
  assert.equal((dockerfile.match(/npm ci/g) ?? []).length, 2, "exactly the two audited installs");
  const ci = read(".github/workflows/ci.yml").replace(/\r\n/g, "\n").replace(/^\s*#.*$/gm, "");
  for (const [label, text] of [["Dockerfile", dockerfile], ["ci.yml", ci]] as const)
    assert.doesNotMatch(text, /--force|--legacy-peer-deps|--ignore-scripts=false|--allow-scripts|strict-allow-scripts=false|npm_config_ignore_scripts|--no-audit/i, `${label}: no flag that bypasses the policy`);
  const dockerignore = read(".dockerignore").split(/\r?\n/).map((l) => l.trim());
  assert.ok(!dockerignore.some((l) => l === ".npmrc" || l === ".npmrc*" || l === "*.npmrc"), ".dockerignore does not exclude .npmrc (it is a build input)");
});

test("parser patch and the dev-only audit exception are recorded honestly in the notes and README", () => {
  assert.ok(atLeast(lock.packages["node_modules/@typescript-eslint/parser"]?.version ?? "0.0.0", "8.72.2"), "@typescript-eslint/parser is at least 8.72.2");
  const notes = read("docs/reviews/implementation-030-notes.md");
  const readme = read("README.md");
  for (const re of [/GHSA-g3hv-75wg-m249/, /6 moderate/, /development-only/i, /npm audit fix/, /strict-allow-scripts/, /ESTRICTALLOWSCRIPTS/, /esbuild/, /unrs-resolver/, /717 (tests|total)/, /704/, /0 vulnerabilities/, /EPERM/]) assert.match(notes, re, String(re));
  for (const re of [/0 vulnerabilities/, /6 moderate/, /GHSA-g3hv-75wg-m249/, /strict-allow-scripts/]) assert.match(readme, re, `README: ${re}`);
  assert.doesNotMatch(readme + notes, /all dependencies (are )?clean|every dependency (is )?clean/i, "no claim that everything is clean");
});

test("the audit command is in package scripts' sight: README and the notes tell the operator to run it themselves, not to trust a count", () => {
  const readme = read("README.md");
  assert.match(readme, /npm audit --omit=dev/);
  assert.doesNotMatch(readme, /Runtime dependency auditing reports no known vulnerabilities/, "the false clean-audit claim is gone");
  assert.doesNotMatch(readme, /Docker is not installed in the current workspace, so the container package has not yet been executed/, "the false never-run claim is gone");
  assert.match(readme, /42828271674/);
  assert.match(readme, /640a69d/);
  const notes = read("docs/reviews/implementation-030-notes.md");
  for (const re of [/GHSA-2464-fhr4-w9xw/, /GHSA-p3m5-59mp-jv5r/, /GHSA-mrhx-c7xc-m3w5/, /42828271674/, /188 ms/, /not launch-ready|not ready for public/i, /hosting/i, /domain/i, /SMTP/, /off-server backup/i, /capacity/i, /rights-cleared/i, /minimatch/]) assert.match(notes, re, String(re));
  for (const f of ["README.md", "docs/DEPLOYMENT.md", "docs/reviews/implementation-030-notes.md"])
    for (const l of read(f).split("\n"))
      if (/ready to launch|launch[- ]ready|launch readiness|production[- ]ready|public(ly)? ready/i.test(l)) assert.match(l, /no claim|not |never|cannot|until|remain|open|unverified|without/i, `${f}: ${l.slice(0, 120)}`);
});
