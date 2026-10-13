/**
 * Process-wide FIFO gate for database writers, with bounded waiting.
 *
 * Why it exists: node:sqlite is synchronous. A synchronous `BEGIN IMMEDIATE`
 * that has to wait for the SQLite write lock blocks the whole event loop. If
 * the lock is held by an *async* transaction in the same process (Better
 * Auth's sign-up transaction spans password hashing, see
 * docs/reviews/concurrency-005-notes.md), that transaction can never resume
 * to release the lock, so the waiter just burns its busy_timeout and fails.
 *
 * Every in-process writer therefore takes this gate first:
 *   - the auth dialect holds it from BEGIN IMMEDIATE until COMMIT/ROLLBACK;
 *   - application and worker writes take it through runWriteTransaction
 *     (writeTransaction.ts), which also acquires the SQLite lock
 *     asynchronously; {@link withWriteGate} is the bare gate.
 * With the gate held, a synchronous writer can only wait on *other
 * processes*, whose progress does not depend on this event loop.
 *
 * Bounds: a waiter gives up after `timeoutMs` (default 15 s) and is removed
 * from the queue, and the queue length is capped, so a stuck holder cannot
 * make waiters accumulate without limit. Both failures reject with
 * {@link WriteGateError}, which routes report as a retryable 503.
 *
 * The state lives on globalThis so duplicated module instances (Next bundles
 * each route separately) still share one gate.
 */

export class WriteGateError extends Error {
  /** Why the gate refused (diagnostics only; the message is unchanged). */
  readonly reason: "timeout" | "full";
  constructor(message: string, reason: "timeout" | "full" = "timeout") {
    super(message);
    this.name = "WriteGateError";
    this.reason = reason;
  }
}

export const WRITE_GATE_TIMEOUT_MS = 15_000;
export const WRITE_GATE_MAX_QUEUE = 256;

type Waiter = {
  grant: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type GateState = { locked: boolean; queue: Waiter[] };

const KEY = Symbol.for("style-studio.write-gate");

function state(): GateState {
  const g = globalThis as unknown as Record<symbol, GateState | undefined>;
  return (g[KEY] ??= { locked: false, queue: [] });
}

/** Number of callers currently queued behind the holder (for tests/metrics). */
export function writeGateQueueLength(): number {
  return state().queue.length;
}

/**
 * Resolves with a release function once the caller owns the gate (FIFO).
 * Rejects with {@link WriteGateError} if the queue is full or the wait
 * exceeds `timeoutMs`; a timed-out waiter is removed so it can never be
 * granted the gate later.
 */
export function acquireWriteGate(
  timeoutMs: number = WRITE_GATE_TIMEOUT_MS,
): Promise<() => void> {
  const gate = state();
  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = gate.queue.shift();
      if (next) {
        // Ownership is handed straight to the next waiter; `locked` stays true.
        clearTimeout(next.timer);
        next.grant();
      } else gate.locked = false;
    };
  };
  if (!gate.locked) {
    gate.locked = true;
    return Promise.resolve(makeRelease());
  }
  if (gate.queue.length >= WRITE_GATE_MAX_QUEUE)
    return Promise.reject(new WriteGateError("Write queue is full.", "full"));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      grant: () => resolve(makeRelease()),
      reject,
      timer: setTimeout(() => {
        const index = gate.queue.indexOf(waiter);
        if (index >= 0) gate.queue.splice(index, 1);
        reject(new WriteGateError("Timed out waiting for the write queue."));
      }, timeoutMs),
    };
    gate.queue.push(waiter);
  });
}

/** Runs `fn` while holding the gate. `fn` may be synchronous database work. */
export async function withWriteGate<T>(fn: () => T | Promise<T>): Promise<T> {
  const release = await acquireWriteGate();
  try {
    return await fn();
  } finally {
    release();
  }
}
