/**
 * Bounded, repeatable evidence matrix for the write-contention failure seen in
 * build 010 (docs/reviews/build-010-claude.md section 2, implementation-011-notes.md).
 * It MEASURES; it does not change the test command, the workload or any
 * timeout, and it never turns a failure into a pass.
 *
 *   npx tsx scripts/concurrency-matrix.ts [options]
 *
 *   --scenario list   comma list of: stress, serial, default, load, all   (default all)
 *                       stress   tests/concurrency.test.ts alone                        x10
 *                       serial   every tests/*.test.ts, node --test-concurrency=1       x3
 *                       default  every tests/*.test.ts, node's default concurrency      x3
 *                       load     tests/concurrency.test.ts alone while CPU burners run  x3
 *   --reps N          repetitions per selected scenario, whole number 1..50
 *   --timeout-sec N   outer wall-clock limit per run, whole number 30..7200
 *                     (defaults: 600, 1800, 1200, 900)
 *   --burners N       CPU burner processes for `load`, whole number 1..min(64, 2 x CPUs)
 *                     (default: logical CPUs)
 *   --out dir         result directory (default docs/verification/matrix-011/<stamp>)
 *   --dry-run         print the plan and the child environment's NAMES, run nothing
 *
 * Anything else (unknown options, fractions, zero, negatives, exponents,
 * values out of range, an empty selection) is refused before anything is
 * started. See scripts/matrixConfig.ts.
 *
 * Environment: every child (test run or burner) gets an ALLOW-LISTED
 * environment plus forced local development settings (APP_URL=127.0.0.1,
 * STYLE_PUBLIC_DEPLOYMENT=false). Secrets, SMTP and public-URL settings,
 * NODE_OPTIONS, NODE_PATH and every STYLE_* setting of the parent are not
 * passed on. Values are never printed; --dry-run lists names only.
 *
 * Each run:
 *  - is a fresh `node --import tsx --test ...` process (the runner `npm test`
 *    uses), with this repository as working directory; the stress test makes
 *    its own fresh data directory (.data/tests/<uuid>) every time;
 *  - writes its full output to <out>/<scenario>-<n>.log and the stress test's
 *    structured report (CONCURRENCY_REPORT_FILE) to <out>/<scenario>-<n>.json;
 *  - is killed, with its whole process tree, if it exceeds the outer timeout.
 * Every process started here (test runs, CPU burners) is tracked and killed on
 * exit, SIGINT and SIGTERM; burners also stop themselves at a deadline. Kill
 * or spawn problems are RECORDED and printed; the summary says whether every
 * child was confirmed stopped, and the exit code is not 0 if any was not.
 *
 * Results are rewritten to <out>/summary.json after every run. The matrix is
 * complete only when `completed` equals `planned`; the script exits non-zero
 * otherwise. Run it yourself; nothing runs it automatically. Start small:
 *
 *   npx tsx scripts/concurrency-matrix.ts --dry-run
 *   npx tsx scripts/concurrency-matrix.ts --scenario stress --reps 2
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import {
  buildChildEnv,
  buildPlan,
  type ChildEnv,
  nodeArgsFor,
  parseMatrixArgs,
  plannedRuns,
  type Scenario,
} from "./matrixConfig";

// ---------------------------------------------------------------- processes

const owned = new Set<ChildProcess>();
/** Problems stopping or starting children; never silent. */
const problems: string[] = [];

const isDead = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;

/** Returns a description of the failure to stop `child`, or null. */
function killTree(child: ChildProcess): string | null {
  const pid = child.pid;
  if (!pid || isDead(child)) return null;
  if (process.platform === "win32") {
    // Whole tree, no shell.
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.error) return `taskkill could not run (${result.error.message.slice(0, 80)})`;
    if (result.status !== 0 && !isDead(child))
      return `taskkill exited ${result.status} and the process may still be running`;
    return null;
  }
  try {
    process.kill(-pid, "SIGKILL"); // the group started with detached: true
    return null;
  } catch (groupError) {
    try {
      child.kill("SIGKILL");
      return null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (groupError as NodeJS.ErrnoException).code;
      return isDead(child) ? null : `kill failed (${String(code)})`;
    }
  }
}

function killAll(): void {
  for (const child of owned) {
    const failure = killTree(child);
    if (failure) {
      problems.push(`pid ${child.pid}: ${failure}`);
      console.error(`[matrix] WARNING could not stop pid ${child.pid}: ${failure}`);
    }
  }
}
process.on("exit", killAll);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    killAll();
    process.exit(130);
  });

function track(child: ChildProcess, label: string): ChildProcess {
  owned.add(child);
  child.on("exit", () => owned.delete(child));
  // A failed spawn emits 'error'; without a listener that would crash the script.
  child.on("error", (error) => {
    problems.push(`${label}: ${error.message.slice(0, 120)}`);
    owned.delete(child);
  });
  return child;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (isDead(child)) return resolve(true);
    const timer = setTimeout(() => resolve(isDead(child)), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(isDead(child));
    });
  });
}

/** CPU burners that stop on their own at the deadline. */
function startBurners(
  count: number,
  lifetimeMs: number,
  env: ChildEnv,
  into: ChildProcess[],
): void {
  const source = "const end=Date.now()+Number(process.argv[1]);while(Date.now()<end){}";
  // Each burner is recorded in `into` the moment it exists, so a failure part
  // way through still lets the caller stop the ones already started.
  for (let i = 0; i < count; i++)
    into.push(
      track(
        spawn(process.execPath, ["-e", source, String(lifetimeMs)], {
          env,
          stdio: "ignore",
          windowsHide: true,
          detached: process.platform !== "win32",
        }),
        `burner ${i + 1}`,
      ),
    );
}

// -------------------------------------------------------------------- runs

type Counts = { tests?: number; pass?: number; fail?: number; skipped?: number };

function parseCounts(log: string): Counts {
  const counts: Counts = {};
  for (const m of log.matchAll(/^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)/gm))
    counts[m[1] as keyof Counts] = Number(m[2]);
  return counts;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Largest value of a statistic across the parent and every child report. */
function summariseReport(report: Json | null) {
  if (!report) return null;
  const procs: Json[] = [
    report.parent,
    ...((report.children as Json[]) ?? []).map((c) => c.timing),
  ].filter(Boolean);
  const peak = (pick: (locks: Json) => number | undefined): number =>
    Math.max(0, ...procs.map((p) => pick(p.locks ?? {}) ?? 0));
  const sum = (pick: (locks: Json) => number | undefined): number =>
    procs.reduce((a, p) => a + (pick(p.locks ?? {}) ?? 0), 0);
  return {
    phasesMs: report.phasesMs,
    problems: report.problems,
    childFailures: ((report.children as Json[]) ?? []).map((c) => ({
      role: c.role,
      ok: c.ok,
      failures: c.failures,
      code: c.code,
    })),
    // Peaks are per process; percentiles of different processes are not merged.
    writeAcquireMaxMs: peak((l) => l.write?.acquire?.totalMs?.max),
    writeAcquireP99MaxMs: peak((l) => l.write?.acquire?.totalMs?.p99),
    writeInitMaxMs: peak((l) => l.write?.acquire?.initializationMs?.max),
    writeGateMaxMs: peak((l) => l.write?.acquire?.gateMs?.max),
    writeSqliteMaxMs: peak((l) => l.write?.acquire?.sqliteMs?.max),
    writeAcquireFailed: sum((l) => l.write?.acquire?.failed),
    authAcquireMaxMs: peak((l) => l.auth?.acquire?.totalMs?.max),
    authAcquireFailed: sum((l) => l.auth?.acquire?.failed),
    authHoldMaxMs: peak((l) => l.auth?.hold?.holdMs?.max),
    queueDepthMax: peak((l) =>
      Math.max(l.write?.acquire?.queueDepthMax ?? 0, l.auth?.acquire?.queueDepthMax ?? 0),
    ),
  };
}

type RunResult = {
  scenario: Scenario;
  rep: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  /** True only when the test process and every burner were confirmed dead. */
  allChildrenStopped: boolean;
  stopProblems: string[];
  durationSec: number;
  counts: Counts;
  report: ReturnType<typeof summariseReport>;
  log: string;
};

async function runOne(
  scenario: Scenario,
  rep: number,
  timeoutSec: number,
  burnerCount: number,
  outDir: string,
  testFiles: readonly string[],
): Promise<RunResult> {
  const id = `${scenario}-${rep}`;
  const logPath = path.join(outDir, `${id}.log`);
  const reportPath = path.join(outDir, `${id}.json`);
  const { env } = buildChildEnv(process.env, reportPath);
  const started = Date.now();
  const stopProblems: string[] = [];
  let fd: number | null = openSync(logPath, "w");
  const closeLog = () => {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
      fd = null;
    }
  };
  const loads: ChildProcess[] = [];
  let child: ChildProcess | null = null;
  let timedOut = false;
  let spawnError: string | null = null;
  let exitCode: number | null = null;
  let signal: string | null = null;
  try {
    if (scenario === "load")
      startBurners(burnerCount, timeoutSec * 1000 + 15_000, env, loads);
    child = track(
      spawn(process.execPath, nodeArgsFor(scenario, testFiles), {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        detached: process.platform !== "win32",
      }),
      `test run ${id}`,
    );
    const running = child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        const failure = killTree(running);
        if (failure) stopProblems.push(`test run: ${failure}`);
      }, timeoutSec * 1000);
      running.once("error", (error) => {
        spawnError = error.message.slice(0, 120);
        clearTimeout(timer);
        resolve();
      });
      running.once("exit", (code, sig) => {
        exitCode = code;
        signal = sig;
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (error) {
    spawnError = error instanceof Error ? error.message.slice(0, 120) : "spawn failed";
  } finally {
    // Nothing of ours may outlive the run, and every failure to stop is kept.
    for (const target of [...(child ? [child] : []), ...loads]) {
      const failure = killTree(target);
      if (failure) stopProblems.push(`pid ${target.pid}: ${failure}`);
    }
    for (const target of [...(child ? [child] : []), ...loads]) {
      if (target.pid !== undefined && !(await waitForExit(target, 5000)))
        stopProblems.push(`pid ${target.pid}: still running 5 s after the kill`);
    }
    closeLog();
  }
  problems.push(...stopProblems.map((p) => `${id}: ${p}`));

  let log = "";
  try {
    log = readFileSync(logPath, "utf8");
  } catch {
    // Counts stay empty.
  }
  let report: Json | null = null;
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      report = null;
    }
  }
  return {
    scenario,
    rep,
    exitCode,
    signal,
    timedOut,
    spawnError,
    allChildrenStopped: stopProblems.length === 0 && spawnError === null,
    stopProblems,
    durationSec: Math.round((Date.now() - started) / 100) / 10,
    counts: parseCounts(log),
    report: summariseReport(report),
    log: path.relative(process.cwd(), logPath),
  };
}

async function main(): Promise<number> {
  const cpus = availableParallelism();
  const config = parseMatrixArgs(process.argv.slice(2), cpus);
  const testFiles = readdirSync("tests")
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => `tests/${name}`);
  const plan = buildPlan(config, testFiles);
  const planned = plannedRuns(plan);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(
    config.out ?? path.join("docs", "verification", "matrix-011", stamp),
  );

  if (config.dryRun) {
    const { keptNames, droppedCount } = buildChildEnv(process.env, "<report file>");
    console.log(
      JSON.stringify(
        {
          outDir,
          plannedRuns: planned,
          plan,
          // Names only. Values are never printed.
          childEnvironment: { names: keptNames, droppedVariableCount: droppedCount },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "plan.json"), JSON.stringify({ stamp, planned, plan }, null, 2));
  const results: RunResult[] = [];
  const writeSummary = () =>
    writeFileSync(
      path.join(outDir, "summary.json"),
      JSON.stringify(
        {
          planned,
          completed: results.length,
          complete: results.length === planned,
          allChildrenStopped: problems.length === 0,
          problems,
          results,
        },
        null,
        2,
      ),
    );
  writeSummary();
  for (const item of plan) {
    for (let rep = 1; rep <= item.reps; rep++) {
      console.log(`[matrix] ${item.scenario} ${rep}/${item.reps} (limit ${item.timeoutSec}s)`);
      const result = await runOne(item.scenario, rep, item.timeoutSec, item.burners, outDir, testFiles);
      results.push(result);
      writeSummary();
      console.log(
        `[matrix]   exit=${result.exitCode} timedOut=${result.timedOut} stopped=${result.allChildrenStopped} ` +
          `${result.durationSec}s pass=${result.counts.pass ?? "?"} fail=${result.counts.fail ?? "?"} ` +
          `maxWriteAcquire=${result.report?.writeAcquireMaxMs ?? "n/a"}ms problems=${result.report?.problems ?? "n/a"}`,
      );
      if (result.spawnError) console.error(`[matrix] could not start the run: ${result.spawnError}`);
    }
  }
  console.log("\nscenario  rep  exit  timeout  stopped  secs   fail  maxWriteAcq(ms)  maxAuthHold(ms)  problems");
  for (const r of results)
    console.log(
      [
        r.scenario.padEnd(9),
        String(r.rep).padStart(3),
        String(r.exitCode).padStart(5),
        String(r.timedOut).padStart(8),
        String(r.allChildrenStopped).padStart(8),
        String(r.durationSec).padStart(6),
        String(r.counts.fail ?? "?").padStart(6),
        String(r.report?.writeAcquireMaxMs ?? "n/a").padStart(16),
        String(r.report?.authHoldMaxMs ?? "n/a").padStart(16),
        String(r.report?.problems ?? "n/a").padStart(9),
      ].join("  "),
    );
  console.log(
    `\nCompleted ${results.length} of ${planned} planned runs. Results: ${path.relative(process.cwd(), outDir)}${path.sep}summary.json`,
  );
  if (problems.length) {
    console.error("[matrix] PROBLEMS (children may still be running; check by hand):");
    for (const p of problems) console.error(`  - ${p}`);
  }
  // A failing test run is evidence, not a script error; the exit code says
  // whether the matrix was complete, clean and every child confirmed stopped,
  // and whether any run failed.
  const incomplete = results.length !== planned;
  const failed = results.some((r) => r.exitCode !== 0 || r.timedOut || r.spawnError !== null);
  return incomplete || problems.length ? 2 : failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error("Matrix runner stopped:", error instanceof Error ? error.message : "unexpected error");
    killAll();
    process.exitCode = 2;
  },
);
