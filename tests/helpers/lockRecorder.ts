import type {
  AcquireEvent,
  HoldEvent,
  LockObserver,
  LockPath,
} from "../../src/server/lockDiagnostics";

/**
 * Bounded, per-process collector for the lock diagnostics of
 * src/server/lockDiagnostics.ts. Test and harness use only. Holds numbers and
 * fixed words; at most `maxSamples` values per series are retained (counts,
 * sums and maxima stay exact beyond that, percentiles then describe the
 * retained prefix and `truncated` says so).
 */

export type Stats = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
};

const round = (v: number) => Math.round(v * 10) / 10;

/** Nearest-rank percentiles over a copy of `values`. */
export function stats(values: readonly number[]): Stats {
  if (!values.length) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
  };
}

class Series {
  readonly values: number[] = [];
  seen = 0;
  max = 0;
  constructor(private readonly cap: number) {}
  add(v: number): void {
    this.seen++;
    if (v > this.max) this.max = v;
    if (this.values.length < this.cap) this.values.push(v);
  }
  get truncated(): boolean {
    return this.seen > this.values.length;
  }
  summary(): Stats {
    const s = stats(this.values);
    // The maximum stays exact even when percentiles saw only a prefix.
    return { ...s, count: this.seen, max: round(this.max) };
  }
}

class PathRecorder {
  ok = 0;
  failed = 0;
  readonly outcomes: Record<string, number> = {};
  queueDepthMax = 0;
  readonly total: Series;
  readonly totalOk: Series;
  readonly totalFailed: Series;
  readonly init: Series;
  readonly gate: Series;
  readonly sqlite: Series;
  readonly attempts: Series;
  readonly hold: Series;
  commits = 0;
  rollbacks = 0;
  constructor(cap: number) {
    this.total = new Series(cap);
    this.totalOk = new Series(cap);
    this.totalFailed = new Series(cap);
    this.init = new Series(cap);
    this.gate = new Series(cap);
    this.sqlite = new Series(cap);
    this.attempts = new Series(cap);
    this.hold = new Series(cap);
  }
  acquire(e: AcquireEvent): void {
    if (e.ok) this.ok++;
    else this.failed++;
    this.outcomes[e.outcome] = (this.outcomes[e.outcome] ?? 0) + 1;
    this.queueDepthMax = Math.max(this.queueDepthMax, e.queueDepth);
    this.total.add(e.totalMs);
    (e.ok ? this.totalOk : this.totalFailed).add(e.totalMs);
    this.init.add(e.initializationMs);
    this.gate.add(e.gateMs);
    this.sqlite.add(e.sqliteMs);
    this.attempts.add(e.attempts);
  }
  holdEvent(e: HoldEvent): void {
    if (e.outcome === "commit") this.commits++;
    else this.rollbacks++;
    this.hold.add(e.holdMs);
  }
  summary() {
    return {
      acquire: {
        count: this.ok + this.failed,
        ok: this.ok,
        failed: this.failed,
        outcomes: { ...this.outcomes },
        queueDepthMax: this.queueDepthMax,
        totalMs: this.total.summary(),
        totalMsOk: this.totalOk.summary(),
        totalMsFailed: this.totalFailed.summary(),
        initializationMs: this.init.summary(),
        gateMs: this.gate.summary(),
        sqliteMs: this.sqlite.summary(),
        attempts: this.attempts.summary(),
      },
      hold: {
        count: this.commits + this.rollbacks,
        commit: this.commits,
        rollback: this.rollbacks,
        holdMs: this.hold.summary(),
      },
      truncated:
        this.total.truncated || this.gate.truncated || this.hold.truncated,
    };
  }
}

export type LockRecorder = {
  observer: LockObserver;
  /** Raw events (bounded), for tests that assert on individual calls. */
  readonly acquires: readonly AcquireEvent[];
  readonly holds: readonly HoldEvent[];
  summary(): Record<LockPath, ReturnType<PathRecorder["summary"]>>;
};

export function createLockRecorder(maxSamples = 20_000): LockRecorder {
  const paths: Record<LockPath, PathRecorder> = {
    write: new PathRecorder(maxSamples),
    auth: new PathRecorder(maxSamples),
  };
  const acquires: AcquireEvent[] = [];
  const holds: HoldEvent[] = [];
  return {
    observer: {
      acquire(e) {
        paths[e.path].acquire(e);
        if (acquires.length < maxSamples) acquires.push(e);
      },
      hold(e) {
        paths[e.path].holdEvent(e);
        if (holds.length < maxSamples) holds.push(e);
      },
    },
    acquires,
    holds,
    summary: () => ({ write: paths.write.summary(), auth: paths.auth.summary() }),
  };
}

/** Records the wall-clock outcome of each call a harness makes (ok and failed). */
export function createCallTimer(maxSamples = 20_000) {
  const all = new Series(maxSamples);
  const ok = new Series(maxSamples);
  const failed = new Series(maxSamples);
  return {
    async time<T>(fn: () => Promise<T>): Promise<T> {
      const t0 = performance.now();
      try {
        const value = await fn();
        const d = performance.now() - t0;
        all.add(d);
        ok.add(d);
        return value;
      } catch (error) {
        const d = performance.now() - t0;
        all.add(d);
        failed.add(d);
        throw error;
      }
    },
    /** For calls already awaited elsewhere (for example Promise.allSettled). */
    record(durationMs: number, success: boolean): void {
      all.add(durationMs);
      (success ? ok : failed).add(durationMs);
    },
    summary: () => ({
      all: all.summary(),
      ok: ok.summary(),
      failed: failed.summary(),
    }),
  };
}
