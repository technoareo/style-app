import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  buildChildEnv,
  buildPlan,
  DEFAULT_REPS,
  FORCED_ENV,
  maxBurners,
  parseMatrixArgs,
  plannedRuns,
} from "../scripts/matrixConfig";

/**
 * The matrix runner (scripts/concurrency-matrix.ts) must refuse malformed
 * configuration instead of flooring it, never present an empty matrix as done,
 * and never hand the machine's private configuration to a disposable test
 * child. Sentinel values below are fake; assertions never print them (they
 * report the sentinel's index or a count).
 */

const CPUS = 8;
const files = ["tests/a.test.ts", "tests/concurrency.test.ts"];

const SENTINELS: Record<string, string> = {
  AUTH_SECRET: "sentinel-auth-secret-7f3a91c2e4b6d8a0f1c3e5a7b9d1f3a5",
  SMTP_URL: "smtps://sentinel-user:sentinel-pass-91@smtp.sentinel.invalid:465",
  MAIL_FROM: "Sentinel <sentinel-from@sentinel.invalid>",
  APP_URL: "https://sentinel-public-host.invalid",
  STYLE_PUBLIC_DEPLOYMENT: "true",
  STYLE_DATA_DIR: "/sentinel/private/data-dir",
  STYLE_SENTINEL_SETTING: "sentinel-style-setting",
  NODE_OPTIONS: "--max-old-space-size=17",
  NODE_PATH: "/sentinel/node-path",
  VISION_MODEL: "sentinel-model",
  OLLAMA_URL: "http://sentinel-ollama.invalid:11434",
};
const sentinelValues = Object.values(SENTINELS);
const sentinelNames = Object.keys(SENTINELS);

test("arguments: whole numbers only; fractions, zero, negatives, exponents, words and out-of-range values are refused", () => {
  const bad: string[][] = [
    ["--reps", "0"],
    ["--reps", "0.4"],
    ["--reps", "1.5"],
    ["--reps", "-1"],
    ["--reps", "1e2"],
    ["--reps", "abc"],
    ["--reps", ""],
    ["--reps", "51"],
    ["--reps"],
    ["--timeout-sec", "0"],
    ["--timeout-sec", "0.9"],
    ["--timeout-sec", "29"],
    ["--timeout-sec", "7201"],
    ["--timeout-sec", "30.5"],
    ["--burners", "0"],
    ["--burners", "0.5"],
    ["--burners", "2.5"],
    ["--burners", String(maxBurners(CPUS) + 1)],
    ["--burners", "100000"],
    ["--out"],
    ["--out", "--dry-run"],
    ["--bogus"],
    ["stress"],
    ["--scenario"],
    ["--scenario", ""],
    ["--scenario", "nothing"],
    ["--scenario", "all,stress"],
  ];
  for (const argv of bad)
    assert.throws(() => parseMatrixArgs(argv, CPUS), Error, `refused: ${argv.join(" ")}`);
});

test("arguments: valid values are taken as given and the plan is never empty", () => {
  const config = parseMatrixArgs(
    ["--scenario", "stress,load", "--reps", "2", "--timeout-sec", "45", "--burners", "3", "--out", "x"],
    CPUS,
  );
  assert.deepEqual(config.scenarios, ["stress", "load"]);
  const plan = buildPlan(config, files);
  assert.equal(plan.length, 2);
  assert.deepEqual(
    plan.map((p) => [p.scenario, p.reps, p.timeoutSec, p.burners]),
    [
      ["stress", 2, 45, 0],
      ["load", 2, 45, 3],
    ],
  );
  assert.equal(plannedRuns(plan), 4);

  const defaults = buildPlan(parseMatrixArgs([], CPUS), files);
  assert.deepEqual(
    defaults.map((p) => [p.scenario, p.reps]),
    Object.entries(DEFAULT_REPS),
  );
  assert.equal(plannedRuns(defaults), 10 + 3 + 3 + 3);
  assert.ok(defaults.every((p) => p.reps >= 1 && p.timeoutSec >= 30));
  assert.ok(defaults.find((p) => p.scenario === "serial")!.command.includes("--test-concurrency=1"));
  assert.ok(!defaults.find((p) => p.scenario === "default")!.command.includes("--test-concurrency"));
  assert.throws(() => buildPlan(parseMatrixArgs([], CPUS), []), /No tests/);
});

test("environment: only allow-listed names survive, forced local settings win, and no sentinel value reaches the result", () => {
  const source: Record<string, string> = {
    ...SENTINELS,
    PATH: "/usr/bin",
    Path: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    HOME: "/home/x",
    UNRELATED_TOKEN: "sentinel-unrelated",
    NODE_ENV: "production",
  };
  const { env, keptNames, droppedCount } = buildChildEnv(source, "report.json");
  assert.equal(env.NODE_ENV, "development", "an inherited NODE_ENV is replaced by the forced one");
  for (const name of sentinelNames) {
    const forced = name in FORCED_ENV;
    assert.ok(forced || !(name in env), `sentinel name ${sentinelNames.indexOf(name)} is not passed on`);
  }
  assert.ok(!("NODE_OPTIONS" in env) && !("NODE_PATH" in env), "Node option overrides are cleared");
  assert.ok(!("UNRELATED_TOKEN" in env));
  for (const [i, value] of sentinelValues.entries())
    assert.ok(
      !Object.values(env).includes(value),
      `sentinel value ${i} does not reach the child environment`,
    );
  assert.equal(env.APP_URL, "http://127.0.0.1:3000");
  assert.equal(env.STYLE_PUBLIC_DEPLOYMENT, "false");
  assert.equal(env.CONCURRENCY_REPORT_FILE, "report.json");
  assert.ok("PATH" in env && "SystemRoot" in env && "TEMP" in env, "what a Node process needs is kept");
  assert.ok(droppedCount >= sentinelNames.length - 2, "the dropped count includes the sentinels");
  assert.ok(Array.isArray(keptNames) && keptNames.every((n) => typeof n === "string"));
  assert.ok(
    !keptNames.some((n) => ["AUTH_SECRET", "SMTP_URL", "MAIL_FROM", "NODE_OPTIONS"].includes(n)),
  );
});

test("a REAL child started with the built environment sees none of the sentinels", async () => {
  const { env } = buildChildEnv({ ...process.env, ...SENTINELS, NODE_ENV: "production" });
  const script =
    "const s=JSON.parse(process.argv[1]);" +
    "const values=Object.values(process.env);" +
    "const leakedValues=s.values.filter(v=>values.includes(v)).length;" +
    "const leakedNames=s.names.filter(n=>n in process.env&&!['APP_URL','STYLE_PUBLIC_DEPLOYMENT'].includes(n)).length;" +
    "process.stdout.write(JSON.stringify({leakedValues,leakedNames,app:process.env.APP_URL,pub:process.env.STYLE_PUBLIC_DEPLOYMENT,mode:process.env.NODE_ENV,opts:process.env.NODE_OPTIONS===undefined}));";
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", script, JSON.stringify({ values: sentinelValues, names: sentinelNames })],
      { env, windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code: number | null) =>
      code === 0 ? resolve(out) : reject(new Error("child failed")),
    );
  });
  assert.deepEqual(JSON.parse(output), {
    leakedValues: 0,
    leakedNames: 0,
    app: "http://127.0.0.1:3000",
    pub: "false",
    mode: "development",
    opts: true,
  });
});

function runRunner(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "scripts/concurrency-matrix.ts", ...args],
      { cwd: process.cwd(), env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? (error as { code?: unknown }).code : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test("the real runner's dry plan lists the matrix and environment NAMES, and prints no sentinel value", async () => {
  const result = await runRunner(["--dry-run"], SENTINELS);
  assert.equal(result.code, 0, result.stderr.slice(0, 500));
  for (const [i, value] of sentinelValues.entries()) {
    assert.ok(!result.stdout.includes(value), `sentinel value ${i} absent from stdout`);
    assert.ok(!result.stderr.includes(value), `sentinel value ${i} absent from stderr`);
  }
  const plan = JSON.parse(result.stdout) as {
    plannedRuns: number;
    plan: { scenario: string; reps: number }[];
    childEnvironment: { names: string[]; droppedVariableCount: number };
  };
  assert.equal(plan.plannedRuns, 19);
  assert.deepEqual(
    plan.plan.map((p) => p.scenario),
    ["stress", "serial", "default", "load"],
  );
  const names = plan.childEnvironment.names;
  for (const name of ["AUTH_SECRET", "SMTP_URL", "MAIL_FROM", "NODE_OPTIONS", "NODE_PATH", "STYLE_DATA_DIR"])
    assert.ok(!names.includes(name), `${name} is not in the child environment`);
  assert.ok(names.includes("APP_URL") && names.includes("CONCURRENCY_REPORT_FILE"));
  assert.ok(plan.childEnvironment.droppedVariableCount >= sentinelNames.length);
});

test("the real runner refuses a malformed or empty matrix before starting anything, without echoing values", async () => {
  for (const args of [["--reps", "0"], ["--reps", "0.5"], ["--burners", "999"], ["--timeout-sec", "1"], ["--scenario", ""]]) {
    const result = await runRunner(args, SENTINELS);
    assert.notEqual(result.code, 0, `refused: ${args.join(" ")}`);
    assert.equal(result.stdout.trim(), "", "nothing was planned or started");
    for (const [i, value] of sentinelValues.entries())
      assert.ok(!result.stderr.includes(value), `sentinel value ${i} absent from stderr`);
  }
});
