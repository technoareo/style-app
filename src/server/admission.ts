import { RequestError } from "./access";
import { limits } from "./limits";
import { countAccount } from "./uploadMetrics";

/**
 * Process-wide semaphore for image work (request body read, header inspection
 * and decode/normalization), shared by every route that accepts a photo.
 *
 *  - at most `imageConcurrency` run at once;
 *  - at most `imageQueue` wait; further callers are refused at once (503 with
 *    a retry hint) instead of piling up in memory;
 *  - a waiter gives up after `imageWaitMs` and is removed from the queue.
 *
 * The semaphore is deliberately separate from the SQLite write gate. Callers
 * must NOT hold it while waiting for the write gate or a database
 * transaction, and the guarded function must not start one: do the image work
 * first, release, then write. State lives on globalThis because Next bundles
 * each route separately.
 */

type Waiter = {
  grant: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type State = { active: number; queue: Waiter[]; refused: number };
const KEY = Symbol.for("style-studio.image-work");

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { active: 0, queue: [], refused: 0 });
}

export function imageWorkStats() {
  const s = state();
  return { active: s.active, queued: s.queue.length, refused: s.refused };
}

const busy = (s: State) => {
  s.refused++;
  return new RequestError(
    503,
    "Photo processing is busy. Try again in a few seconds.",
    { retryAfterSeconds: 5, code: "busy" },
  );
};

const cancelled = () => new RequestError(400, "The request was cancelled.");

function acquire(signal?: AbortSignal): Promise<() => void> {
  const s = state();
  const { imageConcurrency, imageQueue, imageWaitMs } = limits();
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = s.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant(); // ownership handed over; `active` stays counted
      } else s.active--;
    };
  };
  if (s.active < imageConcurrency) {
    s.active++;
    return Promise.resolve(makeRelease());
  }
  if (s.queue.length >= imageQueue) return Promise.reject(busy(s));
  // A caller whose client is already gone does not join the queue.
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    // While queued, a client abort removes the waiter at once (it is not a
    // "busy" refusal and is not counted as one). Timing limits are unchanged.
    const onAbort = () => {
      const index = s.queue.indexOf(waiter);
      if (index < 0) return;
      s.queue.splice(index, 1);
      clearTimeout(waiter.timer);
      reject(cancelled());
    };
    const waiter: Waiter = {
      grant: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(makeRelease());
      },
      reject,
      timer: setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        const index = s.queue.indexOf(waiter);
        if (index >= 0) s.queue.splice(index, 1);
        reject(busy(s));
      }, imageWaitMs),
    };
    s.queue.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs `fn` while holding one image-work slot. */
export async function withImageWork<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await acquire(signal);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Per-account admission (build 013, G21): at most ONE in-flight image work
 * (body read + decode) per signed-in account, shared by /api/photos and
 * /api/analyze. A second one from the same account is refused at once with a
 * fixed, retryable 429 BEFORE it takes, or queues for, a global slot, so one
 * account cannot occupy several of the few shared slots with slow uploads.
 *
 * Scope. The token is taken immediately before the global semaphore and
 * released in the same `finally` that releases the global slot, i.e. when the
 * guarded function ends by success, error, body timeout/abort/oversize/decode
 * failure, or when waiting for a global slot fails (busy / wait timeout). It is
 * therefore always released BEFORE the caller's database write, and it never
 * covers anything the global semaphore does not.
 *
 * Bound, enforced SYNCHRONOUSLY before an id is added: the holder set never
 * exceeds imageConcurrency + imageQueue (the same limits() the semaphore
 * uses). A caller that would be the one over that count is refused with the
 * ordinary global busy 503 (counted as a global refusal, not as an admitted
 * account), without ever entering the set. An earlier version added first and
 * relied on the semaphore's own refusal, so a burst of calls in one tick could
 * all be in the set until their rejections propagated (build 013 first run:
 * peak 12 against a limit of 3). Every holder is then inside withImageWork()
 * as active, queued (each leaves within imageWaitMs or on client abort), or
 * about to leave. The set holds opaque account ids in memory only; they are
 * never logged, counted by label or exposed (uploadMetrics.ts keeps integers
 * by fixed route).
 *
 * A client abort while queued (`signal`) removes the waiter from the queue at
 * once; before this was added the semaphore ignored the request signal while
 * queued, so an aborted request kept its queue place and token until granted
 * or timed out.
 *
 * Another account is unaffected: its token is independent, so it can upload
 * while the first account's slow body read is still running, as long as a
 * global slot is free.
 *
 * Shared across Next route bundles through a Symbol on globalThis.
 */
const ACCOUNT_KEY = Symbol.for("style-studio.account-image-work");
type AccountState = { holders: Set<string> };

function accountState(): AccountState {
  const g = globalThis as unknown as Record<symbol, AccountState | undefined>;
  return (g[ACCOUNT_KEY] ??= { holders: new Set<string>() });
}

/** Accounts currently holding an in-flight image work (a count, never ids). */
export function accountImageWorkActive(): number {
  return accountState().holders.size;
}

export const ACCOUNT_UPLOAD_RETRY_SECONDS = 3;

export async function withAccountImageWork<T>(
  accountId: string,
  route: "photos" | "analyze",
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { holders } = accountState();
  if (holders.has(accountId)) {
    countAccount(route, "refused");
    throw new RequestError(
      429,
      "Another photo from your account is still being processed. Try again in a moment.",
      { retryAfterSeconds: ACCOUNT_UPLOAD_RETRY_SECONDS, code: "upload-in-progress" },
    );
  }
  const { imageConcurrency, imageQueue } = limits();
  if (holders.size >= imageConcurrency + imageQueue) throw busy(state());
  holders.add(accountId);
  countAccount(route, "admitted");
  try {
    return await withImageWork(fn, signal);
  } finally {
    holders.delete(accountId);
    countAccount(route, "released");
  }
}
