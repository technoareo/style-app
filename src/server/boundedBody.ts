/**
 * One bounded raw request-body reader, shared by the public auth wrapper
 * (src/app/api/auth/[...all]/route.ts) and readJson (src/server/access.ts).
 *
 * Bounds, all enforced here and nowhere else:
 *  - an ABSOLUTE total deadline, started before the first read. Progress never
 *    extends it, so a steady trickle of bytes cannot hold a request open;
 *  - a byte cap, checked as chunks arrive;
 *  - the client's own abort (`request.signal`), including one that happened
 *    before the first read.
 *
 * On every early exit (timeout, abort, over-limit, stream error) the stream is
 * cancelled and the reader released. The cancel is NOT awaited indefinitely:
 * an upstream source can make its cancel callback slow or reject, so we wait at
 * most `cancelGraceMs`, swallow any rejection, and move on. The timer and the
 * abort listener are always removed in `finally`.
 *
 * The deadline is not configurable by the request. Callers pass
 * `limits().bodyReadTimeoutMs` (STYLE_BODY_READ_TIMEOUT_MS, 20 s default,
 * 1 s..120 s); a missing, zero, negative or non-finite value falls back to that
 * same default, so no argument can switch the bound off.
 *
 * Memory (build 013, G25). Two things used to grow with the NUMBER of chunks
 * rather than with the bytes:
 *  - every loop iteration added a reaction to one long-lived "interrupted"
 *    promise through Promise.race. Now each read gets its own, fresh wake-up
 *    (`wakeRead`), which is dropped when that read settles, so nothing
 *    accumulates however many chunks arrive;
 *  - every chunk was kept as its own Uint8Array. Now small chunks are copied
 *    into fixed-size slabs (BodyCollector) and only large chunks are kept as
 *    they are, so retained pieces are bounded by about maxBytes / 16 KiB plus
 *    one slab, never by the chunk count. Zero-byte chunks are dropped.
 * Bytes, caps, the deadline and the cleanup are unchanged.
 *
 * Observability: the outcome of every read and of every cancel is counted by
 * fixed route and status in uploadMetrics.ts (numbers only).
 */

import { limits } from "./limits";
import {
  countBody,
  countCancel,
  normalizeRoute,
  type CancelOutcome,
  type UploadRoute,
} from "./uploadMetrics";

export type BoundedBodyOptions = {
  /** Largest accepted body, in bytes. */
  maxBytes: number;
  /** Total time allowed for the whole body. Invalid values use the default. */
  timeoutMs?: number;
  /** Longest wait for the stream's own cancel() to settle. Internal. */
  cancelGraceMs?: number;
  /** Which fixed route to count this read under (anything else is "other"). */
  route?: UploadRoute;
};

export type BoundedBody =
  | { status: "ok"; bytes: Buffer }
  | { status: "empty" }
  | { status: "timeout" }
  | { status: "aborted" }
  | { status: "too_large" };

const DEFAULT_CANCEL_GRACE_MS = 250;
/** Size of one coalescing slab. */
export const SLAB_BYTES = 65_536;

/** Budget actually used for a requested value (never unbounded). */
export function effectiveBodyTimeoutMs(requested?: number): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : limits().bodyReadTimeoutMs;
}

/**
 * Collects a body into a bounded number of pieces. Chunks smaller than a
 * quarter of a slab are copied into the current slab; larger ones are kept as
 * they are (after sealing the slab, so order is preserved); empty chunks are
 * ignored. `size` is the exact number of bytes added. Callers enforce the byte
 * cap BEFORE calling add(), so the collector never holds more than the cap.
 */
export class BodyCollector {
  private readonly pieces: Uint8Array[] = [];
  private slab: Buffer | null = null;
  private used = 0;
  private readonly direct: number;
  size = 0;

  constructor(private readonly slabBytes: number = SLAB_BYTES) {
    this.direct = Math.max(1, Math.floor(slabBytes / 4));
  }

  /** Pieces currently retained (sealed pieces plus an open slab with data). */
  get pieceCount(): number {
    return this.pieces.length + (this.used > 0 ? 1 : 0);
  }

  add(chunk: Uint8Array): void {
    const n = chunk.length;
    if (n === 0) return;
    this.size += n;
    if (n >= this.direct) {
      this.seal();
      this.pieces.push(chunk);
      return;
    }
    if (this.slab && this.used + n > this.slab.length) this.seal();
    if (!this.slab) {
      this.slab = Buffer.allocUnsafe(this.slabBytes);
      this.used = 0;
    }
    this.slab.set(chunk, this.used);
    this.used += n;
  }

  private seal(): void {
    if (this.slab && this.used > 0) {
      // A mostly empty slab is copied out to an exact-size buffer so it does
      // not pin its whole allocation; a fuller one is kept as a view. Either
      // way retained memory stays within about twice the bytes collected.
      this.pieces.push(
        this.used * 2 < this.slab.length
          ? Buffer.from(this.slab.subarray(0, this.used))
          : this.slab.subarray(0, this.used),
      );
    }
    this.slab = null;
    this.used = 0;
  }

  toBuffer(): Buffer {
    this.seal();
    return Buffer.concat(this.pieces, this.size);
  }
}

/**
 * Cancels a reader without ever waiting longer than `graceMs` or throwing.
 * Reports whether the cancel settled, rejected, or was still pending when the
 * grace period ended.
 */
async function abandon(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  graceMs: number,
): Promise<CancelOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: Promise<CancelOutcome>;
  try {
    cancelled = reader.cancel().then(
      (): CancelOutcome => "settled",
      (): CancelOutcome => "rejected",
    );
  } catch {
    // A reader that throws synchronously from cancel(): nothing to wait for.
    return "rejected";
  }
  const grace = new Promise<CancelOutcome>((resolve) => {
    timer = setTimeout(() => resolve("grace_expired"), graceMs);
  });
  try {
    return await Promise.race([cancelled, grace]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reads the request body under the bounds above. Returns a status instead of
 * throwing for the four expected outcomes so callers choose the response;
 * a genuine stream error is rethrown after cleanup. Every outcome is counted
 * under `options.route` (see uploadMetrics.ts).
 */
export async function readBoundedBody(
  req: Request,
  options: BoundedBodyOptions,
): Promise<BoundedBody> {
  const route = normalizeRoute(options.route);
  let result: BoundedBody;
  try {
    result = await readBounded(req, options, route);
  } catch (error) {
    countBody(route, "error");
    throw error;
  }
  countBody(route, result.status);
  return result;
}

async function readBounded(
  req: Request,
  options: BoundedBodyOptions,
  route: UploadRoute,
): Promise<BoundedBody> {
  const stream = req.body;
  if (!stream) return { status: "empty" };
  const graceMs =
    options.cancelGraceMs && options.cancelGraceMs > 0
      ? options.cancelGraceMs
      : DEFAULT_CANCEL_GRACE_MS;
  const reader = stream.getReader();
  const signal = req.signal;
  // Held in an object because the timer and abort callbacks assign it.
  const state: { stopped: "timeout" | "aborted" | null } = { stopped: null };
  // Wake-up for the read that is in flight right now, if any. It is created
  // fresh for each read and cleared when that read settles, so no promise
  // outlives its read and no reactions pile up across chunks.
  let wakeRead: (() => void) | null = null;
  const stop = (why: "timeout" | "aborted") => {
    if (!state.stopped) state.stopped = why;
    wakeRead?.();
  };
  const onAbort = () => stop("aborted");
  const budgetMs = effectiveBodyTimeoutMs(options.timeoutMs);
  // Monotonic absolute deadline. The timer alone is not enough: timer
  // callbacks cannot run while microtasks are still draining, so a result
  // that is already queued could otherwise be accepted after the deadline.
  // Every result is therefore also checked against the clock.
  const deadline = performance.now() + budgetMs;
  const timer = setTimeout(() => stop("timeout"), budgetMs);
  if (signal?.aborted) stop("aborted");
  else signal?.addEventListener("abort", onAbort, { once: true });
  /** The first recorded stop reason; records "timeout" if the clock says so. */
  const stoppedReason = (): "timeout" | "aborted" | null => {
    if (!state.stopped && performance.now() >= deadline) stop("timeout");
    return state.stopped;
  };

  /**
   * One read, raced against a fresh wake-up. Resolves null when interrupted.
   * A rejection of the read itself is passed on; if we stopped waiting first,
   * the later outcome lands on an already-settled promise and is ignored, so
   * it can never surface as an unhandled rejection.
   */
  const readOnce = () =>
    new Promise<ReadableStreamReadResult<Uint8Array> | null>(
      (resolve, reject) => {
        wakeRead = () => resolve(null);
        // The caller checked stoppedReason() just before this, with no await
        // in between, so a stop cannot have been missed.
        reader.read().then(resolve, reject);
      },
    ).finally(() => {
      wakeRead = null;
    });

  const collector = new BodyCollector(
    Math.min(SLAB_BYTES, Math.max(1024, options.maxBytes)),
  );
  let size = 0;
  let finished = false;
  const giveUp = async (): Promise<void> => {
    countCancel(route, await abandon(reader, graceMs));
    finished = true;
  };
  try {
    while (true) {
      const before = stoppedReason();
      if (before) {
        await giveUp();
        return { status: before };
      }
      const raced = await readOnce();
      // Checked before accepting a chunk, a zero-byte chunk or end-of-stream:
      // a result that arrives after the deadline is discarded, never accepted.
      const after = stoppedReason();
      if (after) {
        await giveUp();
        return { status: after };
      }
      if (!raced || raced.done) break;
      size += raced.value.length;
      if (size > options.maxBytes) {
        await giveUp();
        return { status: "too_large" };
      }
      collector.add(raced.value);
    }
    const last = stoppedReason();
    if (last) {
      finished = true;
      return { status: last };
    }
    finished = true;
    return { status: "ok", bytes: collector.toBuffer() };
  } catch (error) {
    if (!finished) await giveUp();
    finished = true;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Already released, or the stream refused; nothing further to free.
    }
  }
}
