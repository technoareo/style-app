import type { DatabaseSync } from "node:sqlite";
import { getDatabase, mainConnectionOpen } from "./database";
import { isSqliteBusy, retryBusy, sleep, WRITE_POLL_MAX_MS } from "./sqliteRetry";
import { tableExists } from "./sensitiveTables";
import { acquireWriteGate } from "./writeGate";

/**
 * Physical cleanup after an account deletion (build 034).
 *
 * WHAT IT DOES. Deleting an account is committed by Better Auth through the
 * ordinary write path. With `PRAGMA secure_delete=ON` (enabled and verified on
 * every live connection in database.ts) SQLite zero-fills the deleted content
 * in the page images it writes. In WAL mode those images land in `app.db-wal`
 * first, and the OLDER images (still holding the deleted bytes) stay in
 * `app.db` and in earlier WAL frames until a checkpoint copies the newest
 * images over them and the log is reset. `wal_checkpoint(TRUNCATE)` does that:
 * it writes every frame back into app.db and truncates the WAL to zero bytes.
 *
 * DURABILITY. The `user_deletion_ledger` trigger (database.ts) bumps
 * `physical_cleanup.requested` in the SAME statement that deletes the user, so
 * a committed deletion always leaves a durable "cleanup owed" mark and a
 * rolled-back one leaves none. Cleanup records `completed = <requested as read
 * BEFORE the checkpoint>` only after a checkpoint that reported busy = 0, so a
 * deletion that commits during the checkpoint stays owed. The counters hold no
 * user data (no ids, no addresses), which is why they can be logged and shown.
 *
 * COMPLETENESS. A pass loops until it has re-read the counter and found nothing
 * owed (a deletion committing between the read and the bookkeeping is picked up
 * at once), and a checkpoint only counts when busy = 0 AND the log was reset
 * (log = 0). Bookkeeping writes take the in-process write gate.
 *
 * FAILURE. Cleanup runs strictly AFTER the deletion committed. It never
 * throws, never touches user rows, and nothing it does can undo or report
 * failure of a deletion: a busy or failed checkpoint just leaves the mark owed.
 * It is retried by (a) a bounded in-process backoff, (b) the mail worker's
 * periodic sweep, (c) every process start, (d) `npm run cleanup:deleted-data`.
 *
 * LIMITS (see docs/DEPLOYMENT.md): this does not reach backups, snapshots,
 * replicas, SSD wear-levelling or filesystem journals, nor residue written
 * before build 034 (counted as `legacyDeletions`).
 */

export type CleanupOutcome =
  | "clean" // nothing owed (or the owed deletions are now physically cleaned)
  | "busy" // another process held the database too long; still owed
  | "failed" // unexpected error; still owed
  | "not-migrated" // the build 034 schema is not present yet
  | "pending" // deletions kept arriving (or the budget ran out) before the counter drained; retryable
  | "unavailable"; // no open connection (shutdown, or not started): never opened just for this

export type CleanupStatus = {
  migrated: boolean;
  pending: boolean;
  requested: number;
  completed: number;
  pendingSinceMs: number | null;
  attempts: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureCode: "busy" | "error" | null;
  /** Deletions recorded before build 034 (no secure_delete, no truncation). */
  legacyDeletions: number;
};

type Row = {
  requested: number;
  completed: number;
  pending_since: number | null;
  attempts: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_failure_code: string | null;
  legacy_deletions: number;
};

export function readCleanupStatus(db: DatabaseSync): CleanupStatus {
  const empty: CleanupStatus = {
    migrated: false,
    pending: false,
    requested: 0,
    completed: 0,
    pendingSinceMs: null,
    attempts: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureCode: null,
    legacyDeletions: 0,
  };
  if (!tableExists(db, "physical_cleanup")) return empty;
  const row = db
    .prepare(
      "SELECT requested,completed,pending_since,attempts,last_attempt_at,last_success_at,last_failure_code,legacy_deletions FROM physical_cleanup WHERE id=1",
    )
    .get() as Row | undefined;
  if (!row) return empty;
  return {
    migrated: true,
    pending: row.completed < row.requested,
    requested: row.requested,
    completed: row.completed,
    pendingSinceMs: row.pending_since,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastFailureCode: row.last_failure_code === "busy" ? "busy" : row.last_failure_code ? "error" : null,
    legacyDeletions: row.legacy_deletions,
  };
}

export type CheckpointResult = { busy: number; log?: number };

export type CleanupOptions = {
  /** Total time this call may spend (default 5 s). */
  budgetMs?: number;
  /** Run even when nothing is owed (CLI `--force`). Applies to the first pass only. */
  force?: boolean;
  /** Open the main connection if needed (CLI). Default: use only an open one. */
  open?: boolean;
  /** Test seam: replaces the checkpoint statement. */
  checkpoint?: (db: DatabaseSync) => CheckpointResult;
  /** Test seam: called when a pass has read "nothing owed" and is about to report clean. */
  beforeReportClean?: () => void;
};

type Flight = { promise: Promise<CleanupOutcome> | null };
// Next bundles each route separately, so module state would be duplicated:
// keep the single-flight on globalThis like the write gate does.
const FLIGHT = Symbol.for("style-studio.physicalCleanup.flight");
function flight(): Flight {
  const g = globalThis as unknown as Record<symbol, Flight>;
  return (g[FLIGHT] ??= { promise: null });
}

function defaultCheckpoint(db: DatabaseSync): CheckpointResult {
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
    | { busy: number; log: number }
    | undefined;
  return { busy: row?.busy ?? 1, log: row?.log };
}

/**
 * A truncating checkpoint is complete only when it was not blocked (busy = 0)
 * AND the log was reset (log = 0, or -1 when the database is not in WAL mode).
 * Anything else, including a missing row, is not proof.
 */
function checkpointComplete(r: CheckpointResult): boolean {
  return r.busy === 0 && (r.log === undefined || r.log === 0 || r.log === -1);
}

const MAX_JOINED_RERUNS = 3;

function stillOwed(): boolean {
  try {
    return mainConnectionOpen() && readCleanupStatus(getDatabase()).pending;
  } catch {
    return false;
  }
}

/**
 * One bounded cleanup. Never throws. Concurrent callers share one in-flight run,
 * and EVERY caller (the one that started it and the ones that joined it)
 * re-reads the durable counter once the run has finished: a deletion that
 * committed after the run's last read makes it run again (at most
 * {@link MAX_JOINED_RERUNS} times), so `"clean"` is never returned while a
 * deletion is owed at that moment. Out of attempts it returns `"pending"`.
 */
export async function runPhysicalCleanup(
  options: CleanupOptions = {},
  reruns = 0,
): Promise<CleanupOutcome> {
  const f = flight();
  let run = f.promise;
  if (!run) {
    const started: Promise<CleanupOutcome> = doCleanup(options).finally(() => {
      if (f.promise === started) f.promise = null;
    });
    f.promise = started;
    run = started;
  }
  const outcome = await run;
  if (outcome === "clean" && stillOwed()) {
    if (reruns >= MAX_JOINED_RERUNS) return "pending";
    return runPhysicalCleanup({ ...options, force: false }, reruns + 1);
  }
  return outcome;
}

/** Runs `fn` with the in-process write gate held (no other transaction can be open on the main connection). */
async function underGate<T>(budgetMs: number, fn: () => T): Promise<T> {
  const release = await acquireWriteGate(Math.max(50, Math.min(2_000, budgetMs)));
  try {
    return fn();
  } finally {
    release();
  }
}

async function doCleanup(options: CleanupOptions): Promise<CleanupOutcome> {
  const budget = Math.max(100, options.budgetMs ?? 5_000);
  const deadline = Date.now() + budget;
  const remaining = () => deadline - Date.now();
  const checkpoint = options.checkpoint ?? defaultCheckpoint;
  if (!options.open && !mainConnectionOpen()) return "unavailable";
  let db: DatabaseSync;
  try {
    db = getDatabase();
  } catch {
    return "failed";
  }

  let force = options.force === true;
  let last: "busy" | "error" = "busy";
  for (let attempt = 0; ; attempt++) {
    try {
      const status = readCleanupStatus(db);
      if (!status.migrated) return "not-migrated";
      if (!status.pending && !force) {
        options.beforeReportClean?.();
        return "clean";
      }
      // Read BEFORE the checkpoint: a deletion committing meanwhile stays owed.
      const target = status.requested;
      // The gate is held for the statement, so only OTHER processes can make
      // the checkpoint busy.
      const result = await underGate(remaining(), () => checkpoint(db));
      if (checkpointComplete(result)) {
        await retryBusy(() => underGate(remaining(), () => markDone(db, target)), {
          timeoutMs: Math.max(200, remaining()),
          maxDelayMs: WRITE_POLL_MAX_MS,
        });
        force = false;
        attempt = -1; // progress: the next pass starts fresh and re-reads the counter
        // A deletion may have committed meanwhile: loop to re-read it rather
        // than report clean from a stale target.
        if (remaining() <= 0) return stillOwed() ? "pending" : "clean";
        continue;
      }
      last = "busy";
    } catch (error) {
      last = isSqliteBusy(error) || (error as { name?: string })?.name === "WriteGateError" ? "busy" : "error";
    }
    if (remaining() <= 0) break;
    await sleep(Math.min(250, 25 * 2 ** attempt) + Math.random() * 10);
  }
  await recordFailure(db, last);
  return last === "busy" ? "busy" : "failed";
}

function markDone(db: DatabaseSync, target: number): void {
  const now = Date.now();
  db.prepare(
    `UPDATE physical_cleanup SET
       pending_since = CASE WHEN MAX(completed, ?) >= requested THEN NULL ELSE pending_since END,
       completed = MAX(completed, ?),
       attempts = 0, last_attempt_at = ?, last_success_at = ?, last_failure_code = NULL
     WHERE id = 1`,
  ).run(target, target, now, now);
}

/** Best effort, under the write gate: a failure to record a failure changes nothing and is ignored. */
async function recordFailure(db: DatabaseSync, kind: "busy" | "error"): Promise<void> {
  try {
    const s = await underGate(1_000, () => {
      db.prepare(
        "UPDATE physical_cleanup SET attempts = attempts + 1, last_attempt_at = ?, last_failure_code = ? WHERE id = 1",
      ).run(Date.now(), kind);
      return readCleanupStatus(db);
    });
    // Fixed text and counters only: no id, address, path or SQL.
    console.error(
      `[cleanup] deleted-data cleanup still owed: reason=${kind} attempts=${s.attempts} owed=${s.requested - s.completed}`,
    );
  } catch {
    // Diagnostics never alter the state.
  }
}

const RETRY_DELAYS_MS = [2_000, 10_000, 60_000, 300_000];
const TIMER = Symbol.for("style-studio.physicalCleanup.timer");
type TimerState = { timer: ReturnType<typeof setTimeout>; dueAt: number };
const timerState = () =>
  (globalThis as unknown as Record<symbol, TimerState | undefined>)[TIMER];

/** Milliseconds until the pending scheduled run, or null (diagnostics and tests). */
export function scheduledCleanupDueInMs(): number | null {
  const t = timerState();
  return t ? Math.max(0, t.dueAt - Date.now()) : null;
}

/**
 * Fire-and-forget: runs a cleanup shortly after the caller's response is on its
 * way and, while it is still owed, retries with a bounded backoff (4 retries,
 * the last after 5 minutes). Beyond that the durable sweep (mail worker,
 * restart, CLI) owns it. There is one pending timer per process; a call that
 * wants an EARLIER run than the pending one (a fresh deletion while a long retry
 * is waiting) pulls it forward and restarts the backoff, and a call that wants a
 * later one changes nothing. Never throws, never awaited by a request.
 */
export function schedulePhysicalCleanup(delayMs = 250, step = 0): void {
  try {
    const g = globalThis as unknown as Record<symbol, TimerState | undefined>;
    const dueAt = Date.now() + delayMs;
    const current = g[TIMER];
    if (current) {
      if (current.dueAt <= dueAt) return;
      clearTimeout(current.timer);
    }
    const timer = setTimeout(() => {
      g[TIMER] = undefined;
      void runPhysicalCleanup().then((outcome) => {
        if (
          (outcome === "busy" || outcome === "failed" || outcome === "pending") &&
          step < RETRY_DELAYS_MS.length
        )
          schedulePhysicalCleanup(RETRY_DELAYS_MS[step], step + 1);
      });
    }, delayMs);
    timer.unref?.();
    g[TIMER] = { timer, dueAt };
  } catch {
    // Scheduling is best effort; the durable mark is what matters.
  }
}
