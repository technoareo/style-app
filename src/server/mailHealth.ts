/**
 * Mail-worker heartbeat (build 009).
 *
 * Build 008 touched the heartbeat once per outer pass and then ran up to 20
 * sends in a row, so a healthy worker working through slow deliveries looked
 * stale to the 60 s health check. The heartbeat is now a timer of its own:
 *
 *  - it fires on the event loop, so a process whose loop is stalled (a long
 *    synchronous block, a frozen runtime) stops reporting and goes unhealthy;
 *  - it reports only while the worker loop has made PROGRESS within
 *    `stuckAfterMs` (the longest bounded step: claim, one send, one record
 *    attempt). A loop that is alive but wedged on a promise that never settles
 *    stops reporting too, so the beat means "working", not just "running";
 *  - writes never overlap: while one write is in flight, later ticks do
 *    nothing, and each write is bounded by its own acquire budget.
 *
 * Pure of the database: `touch` is injected. No addresses, bodies or tokens
 * pass through here.
 */

export type MailHeartbeatOptions = {
  intervalMs: number;
  /** No beat is written when the loop has not reported progress for this long. */
  stuckAfterMs: number;
  /** Writes one beat. Must be bounded (the production one is: 5 s acquire budget). */
  touch: () => Promise<void>;
  /** Called when a write fails (the beat is simply retried on the next tick). */
  onError?: () => void;
  now?: () => number;
};

export type MailHeartbeat = {
  start(): void;
  stop(): void;
  /** The worker loop calls this at the start and end of every bounded step. */
  progress(): void;
  /** One tick, exposed so tests can drive it with a fake clock. */
  tick(): Promise<"written" | "skipped-stuck" | "skipped-busy" | "failed">;
};

export function createMailHeartbeat(
  options: MailHeartbeatOptions,
): MailHeartbeat {
  const now = options.now ?? Date.now;
  let lastProgress = now();
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick() {
    if (inFlight) return "skipped-busy" as const;
    if (now() - lastProgress > options.stuckAfterMs)
      return "skipped-stuck" as const;
    inFlight = true;
    try {
      await options.touch();
      return "written" as const;
    } catch {
      options.onError?.();
      return "failed" as const;
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer) return;
      lastProgress = now();
      void tick();
      timer = setInterval(() => void tick(), options.intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    progress() {
      lastProgress = now();
    },
    tick,
  };
}
