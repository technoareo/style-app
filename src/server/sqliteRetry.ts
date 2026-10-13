/**
 * Shared bounded, asynchronous retry for SQLite lock contention.
 *
 * Only ever wrap an operation that has no effect when it fails with
 * SQLITE_BUSY/SQLITE_LOCKED: a BEGIN IMMEDIATE that did not start, or a
 * single autocommit statement that was refused. Never wrap a transaction
 * body.
 */

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { errcode?: unknown }).errcode;
  // errcode may carry an extended code (e.g. 261, 517); primary is the low byte.
  return (
    typeof code === "number" &&
    ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED)
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RetryOptions = {
  /** Total time budget for retrying (default 10 s). */
  timeoutMs?: number;
  /** First backoff step; doubles up to 250 ms, plus jitter (default 20 ms). */
  baseDelayMs?: number;
  /** Return false to stop retrying and rethrow (default: always allowed). */
  canRetry?: () => boolean;
  /**
   * Cap on one backoff step (default 250 ms). SQLite's lock is not FIFO: a
   * waiter that backs off for long gaps loses to writers that re-take the lock
   * immediately, so lock acquisition uses a short cap (see WRITE_POLL_MAX_MS)
   * to keep long waiters polling often.
   */
  maxDelayMs?: number;
};

/** Backoff cap for write-lock acquisition: poll often, never starve. */
export const WRITE_POLL_MAX_MS = 40;

export async function retryBusy<T>(
  op: () => T | Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const base = options.baseDelayMs ?? 20;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (
        !isSqliteBusy(error) ||
        (options.canRetry && !options.canRetry()) ||
        Date.now() >= deadline
      )
        throw error;
      await sleep(
        Math.min(options.maxDelayMs ?? 250, base * 2 ** attempt) +
          Math.random() * 10,
      );
    }
  }
}
