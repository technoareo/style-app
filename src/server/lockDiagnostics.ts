import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

/**
 * Evidence-only diagnostics for write-lock acquisition and hold (build 011).
 *
 * Nothing here changes behaviour. The production write path
 * (writeTransaction.ts) and the auth dialect (authDialect.ts) measure how long
 * each call waited for the process write gate and for the SQLite write lock,
 * how many BEGIN attempts it took, and how long a transaction held the lock.
 * They report to an OBSERVER if, and only if, the program installed one:
 *
 *   - `runWithLockObserver(observer, fn)`: an AsyncLocalStorage context, so
 *     concurrent contexts in one process stay isolated (used by tests);
 *   - `setProcessLockObserver(observer)`: one process-wide observer (used by
 *     the diagnostic child processes of tests/concurrency.test.ts).
 *
 * There is no environment variable, HTTP parameter, header or public API that
 * turns it on, and nothing is logged by default. With no observer installed the
 * only cost is two property lookups and two monotonic clock reads per call.
 *
 * Events carry numbers and fixed words only: no user id, e-mail, token, SQL
 * text or parameter, image data or path. Durations come from the monotonic
 * clock (`performance.now`), never from Date.
 *
 * An observer is untrusted for control flow: every call into it is wrapped, so
 * an exception thrown by an observer is swallowed here and can never change a
 * transaction's outcome, mask the original failure, or prevent a rollback or
 * the release of the gate.
 *
 * The state lives on globalThis (as the write gate does) because Next bundles
 * route modules separately.
 */

export type LockPath = "write" | "auth";

export type AcquireOutcome =
  | "acquired"
  | "gate-timeout"
  | "gate-full"
  | "busy"
  | "error";

/** One attempt to start a write transaction, successful or not. */
export type AcquireEvent = {
  path: LockPath;
  ok: boolean;
  outcome: AcquireOutcome;
  /**
   * The budget the caller was given: one budget shared by the gate wait and
   * the SQLite wait, on both paths. (Before build 015 the `auth` path gave each
   * wait this budget on its own, so `totalMs` could reach twice this value.)
   */
  budgetMs: number;
  /**
   * Time spent opening the database connection on this call (`getDatabase()`:
   * the first call in a process also opens the file and takes the presence
   * hold; later calls are ~0). Write path only; always 0 on the auth path,
   * whose connection exists before a transaction can begin.
   */
  initializationMs: number;
  /** Time spent waiting for the process write gate (0 if it was free); nothing else. */
  gateMs: number;
  /**
   * From owning the gate until BEGIN IMMEDIATE returned successfully (the
   * instant is read inside the retried call, right after `exec` returns) or
   * the attempt was finally refused. Includes native busy waits and back-off.
   */
  sqliteMs: number;
  /**
   * From the start of the call until BEGIN succeeded or the call failed:
   * initializationMs + gateMs + sqliteMs + a few microseconds of bookkeeping.
   */
  totalMs: number;
  /** BEGIN IMMEDIATE attempts made (0 if the gate was never obtained). */
  attempts: number;
  /** Callers already waiting in the gate queue when this call arrived. */
  queueDepth: number;
  /**
   * Write path only (absent on the auth path). Time spent inside native
   * `BEGIN IMMEDIATE` calls, SUMMED over all attempts of this one call: it is
   * not a per-attempt latency (one 200 ms native wait and five 40 ms waits
   * look the same), and percentiles of these per-call sums are not percentiles
   * of attempts. Quote it together with `attempts`. Observation only.
   */
  beginMs?: number;
  /**
   * Write path only. Real time between a refused BEGIN and the next attempt
   * (the async back-off sleep including timer lateness), SUMMED over this one
   * call; not per-attempt and not the requested delay. Observation only.
   */
  backoffMs?: number;
};

/** A transaction that held the lock: from a successful BEGIN to its end. */
export type HoldEvent = {
  path: LockPath;
  holdMs: number;
  outcome: "commit" | "rollback";
  /**
   * Write path only: successful BEGIN until the body returned or threw (one
   * value per call; for a rolled-back call it ends at the throw).
   */
  bodyMs?: number;
  /**
   * Write path only: body end until COMMIT returned, or, for a rolled-back
   * call, until ROLLBACK returned (so it is rollback time there). It is the
   * disk's cost as much as the code's.
   */
  commitMs?: number;
};

export type LockObserver = {
  acquire?: (event: AcquireEvent) => void;
  hold?: (event: HoldEvent) => void;
};

/** The diagnostic detail attached to errors (numbers only). */
export type AcquireDetail = Pick<
  AcquireEvent,
  | "budgetMs"
  | "initializationMs"
  | "gateMs"
  | "sqliteMs"
  | "totalMs"
  | "attempts"
  | "queueDepth"
>;

const PROCESS_KEY = Symbol.for("style-studio.lock-observer.process");
const CONTEXT_KEY = Symbol.for("style-studio.lock-observer.context");

type Holder = { observer: LockObserver | null };

function processHolder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  return (g[PROCESS_KEY] ??= { observer: null });
}

function contextStore(): AsyncLocalStorage<LockObserver> {
  const g = globalThis as unknown as Record<
    symbol,
    AsyncLocalStorage<LockObserver> | undefined
  >;
  return (g[CONTEXT_KEY] ??= new AsyncLocalStorage<LockObserver>());
}

/** Installs (or, with null, removes) the process-wide observer. */
export function setProcessLockObserver(observer: LockObserver | null): void {
  processHolder().observer = observer;
}

/** Runs `fn` with `observer` for every lock call made inside its async chain. */
export function runWithLockObserver<T>(observer: LockObserver, fn: () => T): T {
  return contextStore().run(observer, fn);
}

/** The observer in effect for the caller: its context first, then the process. */
export function currentLockObserver(): LockObserver | null {
  return contextStore().getStore() ?? processHolder().observer;
}

/** Monotonic milliseconds (fractional). */
export function monotonicNow(): number {
  return performance.now();
}

/** Rounds to 0.1 ms so events stay compact and comparable. */
export function ms(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

const noop = () => {};

/**
 * Calls `observer[name](snapshot)` with TOTAL containment: nothing an observer
 * does can escape this function.
 *  - the property lookup is inside the `try` (a throwing getter or a throwing
 *    Proxy trap is contained);
 *  - the callback receives a frozen COPY of the event, so it can neither
 *    mutate the caller's metrics nor affect the diagnostic detail that is
 *    attached to errors;
 *  - a returned promise or thenable is never awaited, but a rejection is
 *    absorbed (`then(undefined, noop)`), so an `async` observer that throws
 *    cannot become an unhandled rejection; even reading `then` or calling it
 *    is inside the `try`.
 * It never throws, never returns a value and never waits.
 */
function invoke(
  observer: LockObserver | null,
  name: "acquire" | "hold",
  event: AcquireEvent | HoldEvent,
): void {
  try {
    if (!observer) return;
    const callback = (observer as Record<string, unknown>)[name];
    if (typeof callback !== "function") return;
    absorb(callback.call(observer, Object.freeze({ ...event })), 0);
  } catch {
    // An observer must never change the outcome.
  }
}

/**
 * Makes a returned promise or thenable harmless without waiting for it: a
 * rejection is handled. A hostile thenable's own `then` may itself return a
 * rejecting promise, so the result is absorbed again, to a small fixed depth.
 */
function absorb(value: unknown, depth: number): void {
  try {
    if (depth > 3) return;
    if (value === null || (typeof value !== "object" && typeof value !== "function"))
      return;
    const then = (value as { then?: unknown }).then;
    if (typeof then === "function") absorb(then.call(value, undefined, noop), depth + 1);
  } catch {
    // Contained: nothing here may escape.
  }
}

export function notifyAcquire(
  observer: LockObserver | null,
  event: AcquireEvent,
): void {
  invoke(observer, "acquire", event);
}

export function notifyHold(
  observer: LockObserver | null,
  event: HoldEvent,
): void {
  invoke(observer, "hold", event);
}

export function detailOf(event: AcquireEvent): AcquireDetail {
  return {
    budgetMs: event.budgetMs,
    initializationMs: event.initializationMs,
    gateMs: event.gateMs,
    sqliteMs: event.sqliteMs,
    totalMs: event.totalMs,
    attempts: event.attempts,
    queueDepth: event.queueDepth,
  };
}
