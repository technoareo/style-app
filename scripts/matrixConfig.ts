/**
 * Configuration rules of scripts/concurrency-matrix.ts, kept in a module of
 * their own so tests can exercise them without starting anything:
 *
 *  - strict argument parsing: unknown options, missing values, fractions,
 *    zero, negatives, exponents and out-of-range numbers are REFUSED (never
 *    floored or ignored), and an empty matrix is an error;
 *  - the environment given to every disposable child (test runs and CPU
 *    burners) is built from an allow-list, so application and private
 *    configuration of the machine that runs the matrix (secrets, SMTP, public
 *    URL, Node option overrides, STYLE_* settings) cannot reach a test.
 *
 * Nothing here prints an environment value.
 */

export const SCENARIOS = ["stress", "serial", "default", "load"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const DEFAULT_REPS: Record<Scenario, number> = {
  stress: 10,
  serial: 3,
  default: 3,
  load: 3,
};
export const DEFAULT_TIMEOUT_SEC: Record<Scenario, number> = {
  stress: 600,
  serial: 1800,
  default: 1200,
  load: 900,
};

export const MAX_REPS = 50;
export const MIN_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 7200;
export const MAX_BURNERS_HARD = 64;

/** Burners above twice the logical CPUs (and 64) add nothing but risk. */
export function maxBurners(cpus: number): number {
  return Math.max(1, Math.min(MAX_BURNERS_HARD, Math.floor(cpus) * 2));
}

export type MatrixConfig = {
  scenarios: Scenario[];
  reps: number | null;
  timeoutSec: number | null;
  burners: number;
  out: string | null;
  dryRun: boolean;
};

/** A positive decimal integer in [min, max]; anything else throws. */
function integer(flag: string, raw: string | undefined, min: number, max: number): number {
  if (raw === undefined || !/^[0-9]{1,9}$/.test(raw))
    throw new Error(`${flag} needs a whole number from ${min} to ${max}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${flag} must be a whole number from ${min} to ${max}.`);
  return value;
}

export function parseMatrixArgs(argv: readonly string[], cpus: number): MatrixConfig {
  const config: MatrixConfig = {
    scenarios: [...SCENARIOS],
    reps: null,
    timeoutSec: null,
    burners: Math.min(Math.max(1, Math.floor(cpus)), maxBurners(cpus)),
    out: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--dry-run":
        config.dryRun = true;
        break;
      case "--scenario": {
        const raw = argv[++i];
        if (raw === undefined || raw.trim() === "")
          throw new Error("--scenario needs a comma list of stress, serial, default, load or all.");
        const names = raw.split(",").map((s) => s.trim());
        if (names.includes("all")) {
          if (names.length !== 1) throw new Error("--scenario all cannot be combined with other names.");
          config.scenarios = [...SCENARIOS];
        } else {
          const chosen: Scenario[] = [];
          for (const name of names) {
            if (!(SCENARIOS as readonly string[]).includes(name))
              throw new Error(`--scenario: unknown scenario "${name.slice(0, 20)}".`);
            if (!chosen.includes(name as Scenario)) chosen.push(name as Scenario);
          }
          config.scenarios = chosen;
        }
        break;
      }
      case "--reps":
        config.reps = integer(flag, argv[++i], 1, MAX_REPS);
        break;
      case "--timeout-sec":
        config.timeoutSec = integer(flag, argv[++i], MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
        break;
      case "--burners":
        config.burners = integer(flag, argv[++i], 1, maxBurners(cpus));
        break;
      case "--out": {
        const raw = argv[++i];
        if (raw === undefined || raw.trim() === "" || raw.startsWith("--"))
          throw new Error("--out needs a directory path.");
        config.out = raw;
        break;
      }
      default:
        throw new Error(`Unknown option: ${String(flag).slice(0, 30)}.`);
    }
  }
  if (config.scenarios.length === 0) throw new Error("No scenario selected: the matrix would be empty.");
  return config;
}

export type PlanItem = {
  scenario: Scenario;
  reps: number;
  timeoutSec: number;
  burners: number;
  command: string;
};

export function nodeArgsFor(scenario: Scenario, testFiles: readonly string[]): string[] {
  const base = ["--import", "tsx", "--test"];
  if (scenario === "stress" || scenario === "load") return [...base, "tests/concurrency.test.ts"];
  if (scenario === "serial") return [...base, "--test-concurrency=1", ...testFiles];
  return [...base, ...testFiles];
}

export function buildPlan(config: MatrixConfig, testFiles: readonly string[]): PlanItem[] {
  if (testFiles.length === 0) throw new Error("No tests/*.test.ts files were found.");
  const plan = config.scenarios.map((scenario) => ({
    scenario,
    reps: config.reps ?? DEFAULT_REPS[scenario],
    timeoutSec: config.timeoutSec ?? DEFAULT_TIMEOUT_SEC[scenario],
    burners: scenario === "load" ? config.burners : 0,
    command: `node ${nodeArgsFor(scenario, testFiles).join(" ")}`,
  }));
  if (plan.length === 0 || plan.some((p) => p.reps < 1))
    throw new Error("The matrix would be empty.");
  return plan;
}

export function plannedRuns(plan: readonly PlanItem[]): number {
  return plan.reduce((sum, p) => sum + p.reps, 0);
}

// ------------------------------------------------------------ environment

/**
 * The ONLY names (compared case-insensitively, as Windows does) copied from
 * the parent environment: what a Node test process needs to start and to find
 * its temporary and user directories. Nothing from the application, mail,
 * authentication, deployment or Node option families is on this list.
 */
const ALLOWED = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERPROFILE",
    "USERNAME",
    "USER",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ].map((name) => name.toUpperCase()),
);

/** Forced for every child: local development behaviour, no public deployment. */
export const FORCED_ENV: Readonly<Record<string, string>> = {
  APP_URL: "http://127.0.0.1:3000",
  STYLE_PUBLIC_DEPLOYMENT: "false",
  NEXT_TELEMETRY_DISABLED: "1",
};

/** The only extra variable a caller may pass: where the stress test writes its report. */
export const REPORT_VARIABLE = "CONCURRENCY_REPORT_FILE";

/**
 * The environment type of a disposable child. The project's Next typings make
 * `NODE_ENV` a REQUIRED member of `NodeJS.ProcessEnv`, so a plain
 * `Record<string, string>` is not accepted where a `ProcessEnv` is expected.
 * This type states the truth instead of casting around it: it IS a
 * `ProcessEnv`, and `NODE_ENV` is always the one value forced below.
 */
export type ChildEnv = NodeJS.ProcessEnv & { readonly NODE_ENV: "development" };

/**
 * Forced `NODE_ENV`. Before this build the matrix children simply had no
 * NODE_ENV (it was dropped with everything not on the allow-list); an unset
 * value behaves as development for Next and Better Auth. It is now set
 * explicitly to the same non-production, non-test mode so it can neither be
 * inherited from the machine (for example `production`) nor be missing from
 * the typed environment. This is the only intended difference from unset.
 */
export const FORCED_NODE_ENV = "development" as const;

export type ChildEnvironment = {
  env: ChildEnv;
  /** Names only. */
  keptNames: string[];
  droppedCount: number;
};

export function buildChildEnv(
  source: Readonly<Record<string, string | undefined>>,
  reportFile?: string,
): ChildEnvironment {
  const copied: Record<string, string> = {};
  let dropped = 0;
  for (const [name, value] of Object.entries(source)) {
    // NODE_ENV is not on the allow-list: an inherited value is dropped and
    // replaced by the forced one below.
    if (value !== undefined && ALLOWED.has(name.toUpperCase())) copied[name] = value;
    else dropped++;
  }
  Object.assign(copied, FORCED_ENV);
  if (reportFile !== undefined) copied[REPORT_VARIABLE] = reportFile;
  const env: ChildEnv = { ...copied, NODE_ENV: FORCED_NODE_ENV };
  return {
    env,
    keptNames: Object.keys(env).sort(),
    droppedCount: dropped,
  };
}
