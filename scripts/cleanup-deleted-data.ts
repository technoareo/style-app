import { existsSync } from "node:fs";
import path from "node:path";
import {
  closeDatabases,
  getDatabase,
  getDataDir,
  secureDeleteVerified,
} from "../src/server/database";
import { readCleanupStatus, runPhysicalCleanup } from "../src/server/physicalCleanup";

/**
 * Deleted-data cleanup (build 034, src/server/physicalCleanup.ts).
 *
 *   cleanup-deleted-data.ts                       print the status as JSON (counts and times only)
 *   cleanup-deleted-data.ts --run                 run one bounded cleanup (secure checkpoint + WAL truncate), then print the status
 *   cleanup-deleted-data.ts --run --force         also run when nothing is owed
 *   cleanup-deleted-data.ts --run --budget-ms=N   total time allowed, whole milliseconds 100..300000 (default 30000)
 *
 * Arguments are strict: anything else, `--force` without `--run`, or a
 * `--budget-ms` that is not a plain whole number in range is refused (exit 2)
 * before the database is touched.
 *
 * It needs only the database, NOT the mail or launch-information configuration
 * (it does not build Better Auth), so it also works on a host where those
 * variables are not set. It does not create or migrate a database: it refuses
 * when there is no app.db (exit 1, CLEANUP_NO_DATABASE) or when the build 034
 * schema has not been applied yet (exit 1, CLEANUP_NOT_MIGRATED: start the app,
 * the AI worker or the mailer once; they apply it).
 *
 * Safe to run beside the web app and workers: it takes the same locks and gives
 * up after a bounded wait. Output never contains user ids, addresses, paths or SQL.
 * Exit codes: 0 nothing owed; 3 a cleanup is still owed (run it again, or see
 * docs/DEPLOYMENT.md); 2 bad arguments; 1 the status could not be read.
 */
const MIN_BUDGET_MS = 100;
const MAX_BUDGET_MS = 300_000;
const DEFAULT_BUDGET_MS = 30_000;

type Parsed = { run: boolean; force: boolean; budgetMs: number };

/** Returns the parsed options, or a fixed diagnostic. Pure; exported for tests. */
export function parseArgs(args: string[]): Parsed | { error: string } {
  let run = false;
  let force = false;
  let budgetMs: number | null = null;
  for (const arg of args) {
    if (arg === "--run") run = true;
    else if (arg === "--force") force = true;
    else if (arg.startsWith("--budget-ms=")) {
      const value = arg.slice("--budget-ms=".length);
      if (budgetMs !== null) return { error: "CLEANUP_BAD_ARGS: --budget-ms was given twice." };
      if (!/^[0-9]{1,7}$/.test(value))
        return { error: "CLEANUP_BAD_ARGS: --budget-ms must be a whole number of milliseconds." };
      budgetMs = Number(value);
      if (budgetMs < MIN_BUDGET_MS || budgetMs > MAX_BUDGET_MS)
        return {
          error: `CLEANUP_BAD_ARGS: --budget-ms must be between ${MIN_BUDGET_MS} and ${MAX_BUDGET_MS}.`,
        };
    } else return { error: "CLEANUP_BAD_ARGS: unknown argument. Allowed: --run, --force, --budget-ms=N." };
  }
  if (force && !run) return { error: "CLEANUP_BAD_ARGS: --force only applies together with --run." };
  if (budgetMs !== null && !run) return { error: "CLEANUP_BAD_ARGS: --budget-ms only applies together with --run." };
  return { run, force, budgetMs: budgetMs ?? DEFAULT_BUDGET_MS };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(path.join(getDataDir(), "app.db"))) {
    console.error("CLEANUP_NO_DATABASE: there is no database in the data directory.");
    process.exitCode = 1;
    return;
  }
  const db = getDatabase();
  if (!readCleanupStatus(db).migrated) {
    console.error(
      "CLEANUP_NOT_MIGRATED: the database has not been upgraded to build 034 yet; start the app or a worker once.",
    );
    process.exitCode = 1;
    return;
  }
  let outcome: string | undefined;
  if (parsed.run)
    outcome = await runPhysicalCleanup({
      open: true,
      force: parsed.force,
      budgetMs: parsed.budgetMs,
    });
  const status = readCleanupStatus(db);
  console.log(
    JSON.stringify({
      ...(outcome ? { outcome } : {}),
      secureDelete: secureDeleteVerified(),
      ...status,
      owed: Math.max(0, status.requested - status.completed),
    }),
  );
  process.exitCode = status.pending ? 3 : 0;
}

// Only runs as a command, never when a test imports parseArgs.
if (process.argv[1] && path.basename(process.argv[1]).startsWith("cleanup-deleted-data")) {
  main()
    .catch(() => {
      console.error("CLEANUP_STATUS_FAILED: the cleanup status could not be read.");
      process.exitCode = 1;
    })
    .finally(() => {
      try {
        closeDatabases();
      } catch {
        // The exit code already reports the outcome.
      }
    });
}
