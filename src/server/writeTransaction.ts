import type { DatabaseSync } from "node:sqlite";
import { getDatabase } from "./database";
import {
  isSqliteBusy,
  retryBusy,
  sleep,
  WRITE_POLL_MAX_MS,
} from "./sqliteRetry";
import {
  currentLockObserver,
  detailOf,
  monotonicNow,
  ms,
  notifyAcquire,
  notifyHold,
  type AcquireDetail,
  type AcquireEvent,
} from "./lockDiagnostics";
import {
  acquireWriteGate,
  WriteGateError,
  writeGateQueueLength,
} from "./writeGate";

/**
 * Production coordination path for every application and worker write on the
 * main connection (wardrobe, photos, queue, worker lock, mutation limits).
 *
 *   runWriteTransaction(fn):
 *     1. take the process-wide write gate (bounded wait);
 *     2. acquire the SQLite write lock with BEGIN IMMEDIATE, retrying
 *        asynchronously with backoff within the same time budget. The main
 *        connection's native busy wait is only 50 ms, so the event loop is
 *        never parked for seconds, whether the lock holder is another
 *        process (worker, second app instance) or this one;
 *     3. run `fn` synchronously (no await inside the SQL transaction) and
 *        COMMIT, or ROLLBACK if it throws.
 *
 * Only step 2 is retried, and a BEGIN that failed has done nothing. The body
 * `fn` runs at most once. If the budget runs out the call rejects with
 * {@link WriteContentionError} before the body ever runs, which routes
 * report as a retryable 503.
 *
 * Repository functions use {@link inTransaction}, which joins the
 * transaction opened here (so callers keep their synchronous signatures) and
 * otherwise opens its own, for single-process use such as tests.
 */

export class WriteContentionError extends Error {
  /**
   * Where the budget went (numbers only; build 011 diagnostics). Not part of
   * any response: routes report the fixed message and status.
   */
  acquire?: AcquireDetail;
  constructor(message = "The database is busy. Try again shortly.") {
    super(message);
    this.name = "WriteContentionError";
  }
}

export const DEFAULT_WRITE_ACQUIRE_MS = 10_000;
/** Pause after each committed write transaction so other processes can poll in. */
export const COURTESY_YIELD_MS = 3;

export type WriteOptions = {
  /** Total budget for the gate wait plus lock acquisition. */
  acquireTimeoutMs?: number;
};

export function isWriteContention(error: unknown): boolean {
  return (
    error instanceof WriteContentionError || error instanceof WriteGateError
  );
}

export async function runWriteTransaction<T>(
  fn: (db: DatabaseSync) => T,
  options: WriteOptions = {},
): Promise<T> {
  const budget = options.acquireTimeoutMs ?? DEFAULT_WRITE_ACQUIRE_MS;
  const deadline = Date.now() + budget;
  // Diagnostics only (lockDiagnostics.ts): measurements never feed back into
  // the control flow below, and observer failures are swallowed there.
  const observer = currentLockObserver();
  const startedAt = monotonicNow();
  const db = getDatabase();
  // Connection initialization is its own number: the first call in a process
  // opens the file (and takes the presence hold), which is neither a gate wait
  // nor a SQLite lock wait.
  const initializationMs = ms(monotonicNow() - startedAt);
  const queueDepth = writeGateQueueLength();
  let release: () => void;
  const gateRequestedAt = monotonicNow();
  try {
    release = await acquireWriteGate(budget);
  } catch (error) {
    const failedAt = monotonicNow();
    const waited = ms(failedAt - gateRequestedAt);
    notifyAcquire(observer, {
      path: "write",
      ok: false,
      outcome:
        error instanceof WriteGateError
          ? error.reason === "full"
            ? "gate-full"
            : "gate-timeout"
          : "error",
      budgetMs: budget,
      initializationMs,
      gateMs: waited,
      sqliteMs: 0,
      totalMs: ms(failedAt - startedAt),
      attempts: 0,
      queueDepth,
    });
    throw error;
  }
  const gateAcquiredAt = monotonicNow();
  let attempts = 0;
  // Read INSIDE the retried call, immediately after exec returns, so the
  // instant the lock was actually taken is not delayed by the microtask hop
  // back to this function.
  let beganAt = 0;
  let holdStartedAt: number | null = null;
  let committed = false;
  try {
    try {
      await retryBusy(
        () => {
          attempts++;
          const began = db.exec("BEGIN IMMEDIATE");
          beganAt = monotonicNow();
          return began;
        },
        {
          timeoutMs: Math.max(0, deadline - Date.now()),
          maxDelayMs: WRITE_POLL_MAX_MS,
        },
      );
    } catch (error) {
      const busy = isSqliteBusy(error);
      const failedAt = monotonicNow();
      const event: AcquireEvent = {
        path: "write",
        ok: false,
        outcome: busy ? "busy" : "error",
        budgetMs: budget,
        initializationMs,
        gateMs: ms(gateAcquiredAt - gateRequestedAt),
        sqliteMs: ms(failedAt - gateAcquiredAt),
        totalMs: ms(failedAt - startedAt),
        attempts,
        queueDepth,
      };
      notifyAcquire(observer, event);
      if (busy) {
        const refusal = new WriteContentionError();
        refusal.acquire = detailOf(event);
        throw refusal;
      }
      throw error;
    }
    holdStartedAt = beganAt;
    notifyAcquire(observer, {
      path: "write",
      ok: true,
      outcome: "acquired",
      budgetMs: budget,
      initializationMs,
      gateMs: ms(gateAcquiredAt - gateRequestedAt),
      sqliteMs: ms(beganAt - gateAcquiredAt),
      totalMs: ms(beganAt - startedAt),
      attempts,
      queueDepth,
    });
    // Synchronous from here: the body must not await inside the transaction.
    try {
      const result = fn(db);
      if (result instanceof Promise)
        throw new Error("Write transaction bodies must be synchronous.");
      db.exec("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (db.isTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The body's error is the one worth reporting.
        }
      }
      throw error;
    }
  } finally {
    try {
      // Safety net: no path above leaves a transaction open, and the
      // diagnostics below cannot throw (lockDiagnostics.ts), but the gate
      // must never be released with this connection still inside BEGIN.
      if (holdStartedAt !== null && !committed && db.isTransaction)
        db.exec("ROLLBACK");
    } catch {
      // The original outcome is the one worth reporting.
    }
    try {
      if (holdStartedAt !== null)
        notifyHold(observer, {
          path: "write",
          holdMs: ms(monotonicNow() - holdStartedAt),
          outcome: committed ? "commit" : "rollback",
        });
    } catch {
      // Defence in depth: release() below must always run.
    }
    release();
    // Courtesy yield after a COMMIT. SQLite's write lock is not FIFO across
    // processes, and a writer that immediately re-takes it can starve a
    // waiter that is between polls. A very short real pause (in this process
    // the gate has already been handed to the next waiter) opens a window for
    // other processes' pollers. It is not a retry and never repeats work.
    if (committed) await sleep(COURTESY_YIELD_MS);
  }
}

/**
 * Runs `fn` inside a write transaction. When {@link runWriteTransaction}
 * already opened one on this connection, joins it (the outer call owns
 * COMMIT/ROLLBACK); otherwise opens its own BEGIN IMMEDIATE.
 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
