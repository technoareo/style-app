/**
 * Child process for tests/concurrency.test.ts. Not for manual use.
 *
 *   register <count>      sign up <count> accounts through Better Auth
 *   write <count>         <count> read+write transactions via runWriteTransaction
 *   worker <count>        <count> worker heartbeats plus queue sweeps via the
 *                         worker's async entry points
 *   crash-delete <userId> BEGIN, delete the user, then exit WITHOUT committing
 *
 * All children share STYLE_DATA_DIR with the parent and block on
 * CONCURRENCY_START_AT (epoch ms) after module setup, so their database
 * work begins at the same instant instead of depending on spawn timing.
 * Prints one JSON line: { role, ok, failures, timing }.
 *
 * `timing` (build 011, evidence only; it changes no behaviour) holds, for the
 * stress phase after the start instant: the phase durations, a summary of every
 * operation this child made including the failed ones (p50/p95/p99/max), and
 * the lock diagnostics of src/server/lockDiagnostics.ts (gate wait, SQLite
 * wait, attempts, queue depth, auth/write lock hold). Durations are monotonic
 * milliseconds. It contains no ids, e-mail addresses, tokens, SQL or paths.
 */
const [role, arg] = process.argv.slice(2);
const count = Number(arg);
const startAt = Number(process.env.CONCURRENCY_START_AT);
const tag = `${process.pid}`;
const processStartedAt = performance.now();

type Timing = Record<string, unknown>;
type Outcome = { ok: number; failures: string[]; timing?: Timing };

/**
 * Prepares recording (imports happen BEFORE the release instant so they cost
 * the stress phase nothing); `begin()` then installs the process-wide lock
 * observer (src/server/lockDiagnostics.ts) at the release instant. This is the
 * only place the observer is installed.
 */
async function prepareProbe() {
  const { setProcessLockObserver } = await import("../src/server/lockDiagnostics");
  const { createLockRecorder, createCallTimer } = await import(
    "../tests/helpers/lockRecorder"
  );
  const recorder = createLockRecorder();
  const calls = createCallTimer();
  const setupEndedAt = performance.now();
  let waitedUntil = setupEndedAt;
  return {
    calls,
    begin(): void {
      waitedUntil = performance.now();
      setProcessLockObserver(recorder.observer);
    },
    finish(): Timing {
      setProcessLockObserver(null);
      return {
        phases: {
          setupMs: Math.round(setupEndedAt - processStartedAt),
          waitMs: Math.round(waitedUntil - setupEndedAt),
          stressMs: Math.round(performance.now() - waitedUntil),
        },
        calls: calls.summary(),
        locks: recorder.summary(),
      };
    },
  };
}

/**
 * Failure text for the parent test: where it happened, the SQLite error codes,
 * the first stack frames and the cause chain. Contains no credentials or
 * message bodies (only error metadata and this repository's stack frames).
 */
function describeError(stage: string, error: unknown): string {
  const parts: string[] = [`stage=${stage}`];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as {
      name?: string;
      message?: string;
      code?: unknown;
      errcode?: unknown;
      errstr?: unknown;
      stack?: string;
      cause?: unknown;
      acquire?: Record<string, number>;
    };
    const frames = (e.stack ?? "")
      .split("\n")
      .slice(1, 7)
      .map((line) => line.trim().replace(/\(.*[\\/]style-app[\\/]/, "("))
      .join(" <- ");
    parts.push(
      `${depth ? "cause" : "error"}=${e.name ?? "Error"}: ${e.message ?? String(current)}` +
        ` errcode=${String(e.errcode ?? "-")} errstr=${String(e.errstr ?? "-")} code=${String(e.code ?? "-")}` +
        (e.acquire
          ? ` acquire=${JSON.stringify(e.acquire)}`
          : "") +
        ` sinceStart=${Date.now() - startAt}ms` +
        ` at ${frames || "no stack"}`,
    );
    current = e.cause;
  }
  return parts.join(" | ");
}

function waitUntil(epochMs: number): void {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  for (let left = epochMs - Date.now(); left > 0; left = epochMs - Date.now())
    Atomics.wait(gate, 0, 0, Math.min(left, 50));
}

async function register(): Promise<Outcome> {
  const { getReadyAuth } = await import("../src/server/auth");
  const auth = await getReadyAuth();
  const probe = await prepareProbe();
  waitUntil(startAt);
  probe.begin();
  const failures: string[] = [];
  let ok = 0;
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, i) =>
      probe.calls.time(() =>
        auth.api.signUpEmail({
          body: {
            email: `conc-${tag}-${i}@example.test`,
            name: `Conc ${tag}-${i}`,
            password: "Test concurrency passphrase 41!",
          },
        }),
      ),
    ),
  );
  for (const r of results) {
    if (r.status === "fulfilled") ok++;
    else failures.push(describeError("signUpEmail", r.reason));
  }
  return { ok, failures, timing: probe.finish() };
}

async function write(): Promise<Outcome> {
  // The production write path: bounded async lock acquisition, then a
  // synchronous read-then-write body that is never replayed.
  const { runWriteTransaction } =
    await import("../src/server/writeTransaction");
  const probe = await prepareProbe();
  waitUntil(startAt);
  probe.begin();
  const failures: string[] = [];
  let ok = 0;
  for (let i = 0; i < count; i++) {
    try {
      await probe.calls.time(() =>
        runWriteTransaction((db) => {
          db.prepare("SELECT COUNT(*) AS n FROM user").get();
          db.prepare(
            "INSERT OR REPLACE INTO account_deletions(user_id,deleted_at) VALUES(?,?)",
          ).run(`conc-writer-${tag}-${i}`, Date.now());
        }),
      );
      ok++;
    } catch (error) {
      failures.push(describeError("runWriteTransaction", error));
    }
  }
  return { ok, failures, timing: probe.finish() };
}

async function worker(): Promise<Outcome> {
  const { getReadyAuth } = await import("../src/server/auth");
  await getReadyAuth();
  const q = await import("../src/server/analysisJobs");
  const owner = `conc-worker-${tag}`;
  const probe = await prepareProbe();
  waitUntil(startAt);
  probe.begin();
  const failures: string[] = [];
  let ok = 0;
  if (!(await q.acquireWorkerLockAsync(owner)))
    return { ok, failures: ["lock not free"], timing: probe.finish() };
  const state = { lastRenewedAt: Date.now() };
  for (let i = 0; i < count; i++) {
    try {
      // The same heartbeat and sweep entry points the worker process uses.
      await probe.calls.time(async () => {
        const beat = await q.heartbeatWorker(owner, state);
        if (beat !== "ok") throw new Error(`heartbeat ${beat}`);
        await q.cleanupOnStartupAsync();
      });
      ok++;
    } catch (error) {
      failures.push(describeError("heartbeat/cleanup", error));
    }
  }
  await q.releaseWorkerLockAsync(owner);
  return { ok, failures, timing: probe.finish() };
}

async function crashDelete(): Promise<never> {
  const { getDatabase } = await import("../src/server/database");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  db.prepare("DELETE FROM user WHERE id=?").run(arg);
  console.log(JSON.stringify({ role, ok: 1, failures: [] }));
  // Abrupt exit with the deletion (and its trigger-written ledger row) still
  // uncommitted: neither may survive.
  process.exit(3);
}

(async () => {
  if (role === "crash-delete") return crashDelete();
  const outcome =
    role === "register"
      ? await register()
      : role === "worker"
        ? await worker()
        : await write();
  console.log(JSON.stringify({ role, ...outcome }));
  process.exit(outcome.failures.length ? 1 : 0);
})().catch((error) => {
  console.log(
    JSON.stringify({
      role,
      ok: 0,
      failures: [describeError("child-setup-or-role", error)],
    }),
  );
  process.exit(1);
});
