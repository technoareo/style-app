import type { DatabaseSync } from "node:sqlite";
import {
  DatabaseQuarantineError,
  getDatabase,
  isQuarantined,
  quarantineMainConnection,
} from "./database";
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
 *        COMMIT, or ROLLBACK if it throws. Steps 2's successful BEGIN, 3 and
 *        the COMMIT/ROLLBACK are ONE synchronous block (build 016).
 *
 * Only the BEGIN is retried, and a BEGIN that failed has done nothing. The
 * body `fn` runs at most once: once BEGIN has succeeded, a body or COMMIT
 * error (even a busy-shaped one) is returned as a tagged result and rethrown
 * after retryBusy, never thrown through it. If the budget runs out the call rejects with
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
      beginMs: 0,
      backoffMs: 0,
    });
    throw error;
  }
  const gateAcquiredAt = monotonicNow();
  let attempts = 0;
  // Observation-only (never read by the control flow): time spent inside
  // native BEGIN IMMEDIATE calls, and the real time between one refused attempt
  // and the next (the async back-off sleep plus its timer hop).
  let beginMs = 0;
  let backoffMs = 0;
  let lastAttemptEndedAt: number | null = null;
  // Native bounds of the hold, read in the same synchronous block that takes
  // the lock, runs the body and finishes the transaction.
  let began = false;
  let beganAt = 0;
  let bodyEndedAt = 0;
  let endedAt = 0;
  let committed = false;
  let attempt: Attempt<T> | undefined;
  let refused: { error: unknown; failedAt: number } | undefined;
  // The handle used from here on. A caller that queued behind the gate captured
  // `db` before the wait; if the gate holder quarantined (or closed) it meanwhile,
  // resolve the live connection now, under the gate. The time this takes is part
  // of `sqliteMs` (gate acquired -> first BEGIN), not of `initializationMs` or
  // `gateMs`, and the entry budget and deadline are not extended or reset.
  let live: DatabaseSync = db;
  let reopenFailed = false;
  try {
    try {
      if (isQuarantined(db)) {
        try {
          live = getDatabase();
        } catch (error) {
          reopenFailed = true;
          throw error;
        }
      }
      attempt = await retryBusy(
        () => {
          attempts++;
          const attemptStartedAt = monotonicNow();
          if (lastAttemptEndedAt !== null)
            backoffMs += attemptStartedAt - lastAttemptEndedAt;
          try {
            live.exec("BEGIN IMMEDIATE");
          } catch (error) {
            // Only a failed BEGIN may reach retryBusy: it did nothing.
            lastAttemptEndedAt = monotonicNow();
            beginMs += lastAttemptEndedAt - attemptStartedAt;
            throw error;
          }
          beganAt = monotonicNow();
          beginMs += beganAt - attemptStartedAt;
          began = true;
          // From here to the return, ONE synchronous block: the body, COMMIT
          // or ROLLBACK run before any microtask, timer or other request, and
          // nothing is thrown, so no body or COMMIT error (busy-shaped or not)
          // can make retryBusy replay the transaction. The outcome is tagged
          // and rethrown by the caller, with its identity intact.
          try {
            const result = fn(live);
            if (result instanceof Promise)
              throw new Error("Write transaction bodies must be synchronous.");
            bodyEndedAt = monotonicNow();
            live.exec("COMMIT");
            endedAt = monotonicNow();
            committed = true;
            return { ok: true, value: result };
          } catch (error) {
            if (bodyEndedAt === 0) bodyEndedAt = monotonicNow();
            if (live.isTransaction) {
              try {
                live.exec("ROLLBACK");
              } catch {
                // The body's (or COMMIT's) error is the one worth reporting.
              }
            }
            endedAt = monotonicNow();
            return { ok: false, error };
          }
        },
        {
          timeoutMs: Math.max(0, deadline - Date.now()),
          maxDelayMs: WRITE_POLL_MAX_MS,
        },
      );
    } catch (error) {
      refused = { error, failedAt: monotonicNow() };
    }
    if (began && !committed) settleOrQuarantine(live);
  } finally {
    release();
  }
  // Observers hear about the call only now: after the native transaction has
  // ended and the process gate is released, so a slow observer lengthens
  // neither SQLite's write lock nor the gate's ownership. It is NOT free for the
  // event loop: release() only resolves the next waiter's promise, which cannot
  // run until this synchronous code returns, so a slow synchronous observer
  // still delays the next writer's start. Production installs no observer; this
  // matters for diagnostics only. Acquisition is reported before the hold.
  // Both are contained (never throw).
  if (refused) {
    // A failed re-resolution is not lock contention, whatever its shape: it is
    // reported as itself and never mapped to WriteContentionError.
    const busy = !reopenFailed && isSqliteBusy(refused.error);
    const event: AcquireEvent = {
      path: "write",
      ok: false,
      outcome: busy ? "busy" : "error",
      budgetMs: budget,
      initializationMs,
      gateMs: ms(gateAcquiredAt - gateRequestedAt),
      sqliteMs: ms(refused.failedAt - gateAcquiredAt),
      totalMs: ms(refused.failedAt - startedAt),
      attempts,
      queueDepth,
      beginMs: ms(beginMs),
      backoffMs: ms(backoffMs),
    };
    notifyAcquire(observer, event);
    if (busy) {
      const refusal = new WriteContentionError();
      refusal.acquire = detailOf(event);
      throw refusal;
    }
    throw refused.error;
  }
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
    beginMs: ms(beginMs),
    backoffMs: ms(backoffMs),
  });
  notifyHold(observer, {
    path: "write",
    holdMs: ms(endedAt - beganAt),
    outcome: committed ? "commit" : "rollback",
    bodyMs: ms(bodyEndedAt - beganAt),
    // COMMIT when committed, otherwise the ROLLBACK (or its absence).
    commitMs: ms(endedAt - bodyEndedAt),
  });
  // Courtesy yield after a COMMIT. SQLite's write lock is not FIFO across
  // processes, and a writer that immediately re-takes it can starve a
  // waiter that is between polls. A very short real pause (in this process
  // the gate has already been handed to the next waiter) opens a window for
  // other processes' pollers. It is not a retry and never repeats work.
  if (committed) await sleep(COURTESY_YIELD_MS);
  if (attempt && attempt.ok) return attempt.value;
  throw attempt ? attempt.error : new Error("Write transaction did not run.");
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Safety net before the gate is released after a transaction that did not
 * commit: roll back if the connection is still inside it (the in-block ROLLBACK
 * normally already did). If the connection STILL cannot be shown to be outside
 * a transaction, it is quarantined (database.ts) instead of being handed to the
 * next caller. Never throws: the original outcome is the one worth reporting.
 */
function settleOrQuarantine(db: DatabaseSync): void {
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } catch {
    // Judged below.
  }
  let inside = true; // If it cannot be asked, assume the worst.
  try {
    inside = db.isTransaction;
  } catch {
    // A connection that cannot answer is not safe to hand on either.
  }
  if (inside) quarantineMainConnection(db);
}

/**
 * Runs `fn` inside a write transaction. When {@link runWriteTransaction}
 * already opened one on this connection, joins it (the outer call owns
 * COMMIT/ROLLBACK); otherwise opens its own BEGIN IMMEDIATE.
 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  // A quarantined (or closed) handle may still report an open transaction;
  // joining it would run `fn` inside work nobody will ever commit or undo.
  if (isQuarantined(db)) throw new DatabaseQuarantineError();
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // The body's (or COMMIT's) error stays the one reported, even if the
    // rollback itself fails; a connection left inside the transaction is
    // quarantined so nothing can join it.
    settleOrQuarantine(db);
    throw error;
  }
}
