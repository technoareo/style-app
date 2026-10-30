import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * LOCAL CONTRACT CHECK ONLY. It reads Dockerfile, compose.yaml and
 * docs/DEPLOYMENT.md as text and checks that every operator script those files
 * run inside the container is copied into the runtime image, and that the
 * relative imports of those scripts land in folders the runtime image copies.
 * It does NOT build the image or run any container; the Docker execution of
 * these scripts is still unrun (no Docker in this environment).
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Script paths ("scripts/x.ts") that a text runs, optionally only on matching lines. */
export function scriptsReferenced(text: string, lineFilter?: RegExp): string[] {
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (lineFilter && !lineFilter.test(line)) continue;
    for (const m of line.matchAll(/\bscripts\/([A-Za-z0-9_-]+\.ts)\b/g))
      found.add(`scripts/${m[1]}`);
  }
  return [...found].sort();
}

/** Files and folders the Dockerfile's final (runtime) stage copies from the build. */
export function runtimeCopies(dockerfile: string): { files: string[]; dirs: string[] } {
  const stages = dockerfile.split(/^FROM /m).slice(1);
  const runtime = stages.find((s) => /^\S+\s+AS\s+runtime\b/i.test(s)) ?? "";
  const files: string[] = [];
  const dirs: string[] = [];
  for (const line of runtime.split(/\r?\n/)) {
    const m = /^COPY\s+--from=build\s+(?:--chown=\S+\s+)?\/app\/(\S+)\s+\.\/(\S+)\s*$/.exec(
      line.trim(),
    );
    if (!m) continue;
    // Destination equals source in this Dockerfile; anything else is not a package of that path.
    if (m[1] !== m[2].replace(/^\.\//, "")) continue;
    (/\.\w+$/.test(m[1]) ? files : dirs).push(m[1]);
  }
  return { files, dirs };
}

/** Problems: scripts referenced but not packaged, or imports leaving the packaged tree. */
export function packagingProblems(
  referenced: string[],
  copies: { files: string[]; dirs: string[] },
  readScript: (file: string) => string | null,
): string[] {
  const problems: string[] = [];
  const packaged = (rel: string) =>
    copies.files.includes(rel) || copies.dirs.some((d) => rel === d || rel.startsWith(d + "/"));
  for (const script of referenced) {
    const source = readScript(script);
    if (source === null) {
      problems.push(`${script} is referenced by a deployment command but does not exist`);
      continue;
    }
    if (!copies.files.includes(script))
      problems.push(`${script} is run by a deployment command but the runtime image does not COPY it`);
    for (const m of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join("scripts", m[1]));
      if (!packaged(target) && !copies.files.some((f) => f.replace(/\.\w+$/, "") === target))
        problems.push(`${script} imports ${m[1]} (${target}), which the runtime image does not copy`);
    }
  }
  return problems;
}

const readScriptFromDisk = (file: string) =>
  existsSync(path.join(root, file)) ? read(file) : null;

test("every operator script that compose.yaml or the deployment guide runs in the container is copied into the runtime image", () => {
  const referenced = [
    ...new Set([
      ...scriptsReferenced(read("compose.yaml")),
      // Only the container commands of the guide; host-side tools are not in scope.
      ...scriptsReferenced(read("docs/DEPLOYMENT.md"), /docker compose (exec|run)\b/),
    ]),
  ].sort();
  // The set must include the ones this check exists for, so an extraction bug cannot pass vacuously.
  for (const expected of [
    "scripts/init-auth.ts",
    "scripts/analysis-worker.ts",
    "scripts/mail-worker.ts",
    "scripts/restore-database.ts",
    "scripts/export-deletion-ledger.ts",
    "scripts/backup-encrypted.ts",
    "scripts/restore-encrypted.ts",
  ])
    assert.ok(referenced.includes(expected), `${expected} should be found as referenced`);

  const copies = runtimeCopies(read("Dockerfile"));
  assert.ok(copies.files.length >= 5 && copies.dirs.includes("src/server"));
  assert.deepEqual(packagingProblems(referenced, copies, readScriptFromDisk), []);
});

test("the ledger export script is copied explicitly", () => {
  assert.ok(runtimeCopies(read("Dockerfile")).files.includes("scripts/export-deletion-ledger.ts"));
});

test("the encrypted backup and restore commands (build 021) are copied explicitly, with every module they import", () => {
  const copies = runtimeCopies(read("Dockerfile"));
  for (const script of ["scripts/backup-encrypted.ts", "scripts/restore-encrypted.ts"])
    assert.ok(copies.files.includes(script), script);
  // The scripts import only from the copied src/server tree, and the shared restore lives there too.
  assert.ok(copies.dirs.includes("src/server"));
  for (const module of ["encryptedPackage", "encryptedBackup", "encryptedRestore", "restoreDatabase", "backupPassphrase"])
    assert.ok(existsSync(path.join(root, "src/server", module + ".ts")), module);
  // The documented commands name the two scripts, so the generic check above covers them.
  assert.ok(scriptsReferenced(read("docs/DEPLOYMENT.md"), /docker compose (exec|run)\b/).includes("scripts/restore-encrypted.ts"));
});

test("the checker reports an unpackaged script, a missing script and an import that leaves the image", () => {
  const copies = {
    files: ["scripts/a.ts", "scripts/c.ts"],
    dirs: ["src/server"],
  };
  const sources: Record<string, string> = {
    "scripts/a.ts": `import x from "../src/server/ok";`,
    "scripts/b.ts": `import x from "../src/server/ok";`,
    "scripts/c.ts": `import x from "../src/app/outside";`,
  };
  const problems = packagingProblems(
    ["scripts/a.ts", "scripts/b.ts", "scripts/c.ts", "scripts/gone.ts"],
    copies,
    (f) => sources[f] ?? null,
  );
  assert.equal(problems.length, 3);
  assert.match(problems.join("\n"), /scripts\/b\.ts is run .* does not COPY it/);
  assert.match(problems.join("\n"), /scripts\/gone\.ts is referenced .* does not exist/);
  assert.match(problems.join("\n"), /scripts\/c\.ts imports \.\.\/src\/app\/outside/);
});
