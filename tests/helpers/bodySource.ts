/**
 * Controllable request-body sources for the body-deadline tests. Every timer
 * the source starts is cleared when the stream is cancelled, so a test that
 * leaves a source running cannot keep the process alive.
 */

export type CancelBehavior = "ok" | "hang" | "reject";

export type SourceOptions = {
  /** Bytes enqueued immediately. */
  first?: Uint8Array;
  /** Enqueue `chunk` every `everyMs` until cancelled (a steady trickle). */
  trickle?: { everyMs: number; chunk: Uint8Array };
  /** Close the stream normally right after `first`. */
  end?: boolean;
  /** Error the stream after this many ms. */
  errorAfterMs?: number;
  /** What the source's own cancel() callback does. */
  cancel?: CancelBehavior;
};

export type BodySource = {
  stream: ReadableStream<Uint8Array>;
  state: { cancelled: number };
  /** Clears any timer still running (tests call it in finally). */
  stop: () => void;
};

export function makeSource(options: SourceOptions = {}): BodySource {
  const state = { cancelled: 0 };
  let interval: ReturnType<typeof setInterval> | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (interval) clearInterval(interval);
    if (errorTimer) clearTimeout(errorTimer);
    interval = undefined;
    errorTimer = undefined;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.first) controller.enqueue(options.first);
      if (options.end) controller.close();
      if (options.trickle) {
        const { everyMs, chunk } = options.trickle;
        interval = setInterval(() => {
          try {
            controller.enqueue(chunk);
          } catch {
            stop();
          }
        }, everyMs);
      }
      if (options.errorAfterMs !== undefined)
        errorTimer = setTimeout(
          () => controller.error(new Error("source failed")),
          options.errorAfterMs,
        );
    },
    cancel() {
      state.cancelled++;
      stop();
      if (options.cancel === "hang") return new Promise<void>(() => {});
      if (options.cancel === "reject")
        return Promise.reject(new Error("cancel failed"));
    },
  });
  return { stream, state, stop };
}

/** RequestInit for a streamed body (Node needs duplex: "half"). */
export function streamInit(
  stream: ReadableStream<Uint8Array>,
  init: Record<string, unknown> = {},
): RequestInit {
  return { method: "POST", body: stream, duplex: "half", ...init } as RequestInit;
}

/** Number of live Timeout handles, to show a call left none behind. */
export function activeTimers(): number {
  return process
    .getActiveResourcesInfo()
    .filter((name) => name === "Timeout").length;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
