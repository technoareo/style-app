import { randomUUID } from "node:crypto";
import { getReadyAuth } from "../src/server/auth";
import { closeDatabases } from "../src/server/database";
import {
  acquireWorkerLockAsync,
  cleanupOnStartupAsync,
  heartbeatWorker,
  releaseWorkerLockAsync,
  runWorkerTick,
  type HeartbeatState,
} from "../src/server/analysisJobs";

/**
 * Standalone analysis worker process. Polls the durable job queue every two
 * seconds and runs at most one inference sequentially per tick. Holds a
 * persistent global lock in `worker_state` (renewed by a heartbeat) so a
 * second, accidentally launched worker process refuses to run concurrent
 * GPU inference; a worker that dies without releasing the lock is
 * recoverable by a fresh worker after five minutes.
 *
 * All database writes go through the production write path
 * (runWriteTransaction): bounded asynchronous lock acquisition, so waiting
 * on another process never parks this event loop, and the SQL body is never
 * replayed. Transient contention is not fatal: a failed heartbeat or claim
 * is retried on the next beat/tick, and the worker only stops when the lock
 * is definitely lost or has gone half a lease without a successful renewal.
 *
 * No network control port of any kind. Stops only on SIGINT/SIGTERM.
 */

const OWNER_ID = randomUUID();
const POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;
// Each heartbeat waits at most this long for the write lock, well under the
// heartbeat period, so beats never pile up behind a contended database.
const HEARTBEAT_WRITE_BUDGET_MS = 5000;

let stopping = false;
let activeController: AbortController | null = null;
function requestStop(): void {
  stopping = true;
  activeController?.abort();
}
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries a not-yet-started write at startup; the first attempt is bounded. */
async function startupStep<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= 6 || stopping) throw error;
      await sleep(1000 * attempt);
    }
  }
}

async function main(): Promise<void> {
  await getReadyAuth();
  await startupStep(() => cleanupOnStartupAsync());

  if (!(await startupStep(() => acquireWorkerLockAsync(OWNER_ID)))) {
    console.log("Another analysis worker already holds the lock. Exiting.");
    process.exitCode = 1;
    return;
  }
  console.log("Analysis worker started.");
  const state: HeartbeatState = { lastRenewedAt: Date.now() };

  const beat = async (): Promise<boolean> => {
    try {
      const result = await heartbeatWorker(OWNER_ID, state, {
        acquireTimeoutMs: HEARTBEAT_WRITE_BUDGET_MS,
      });
      if (result === "degraded")
        console.warn("Worker heartbeat delayed by database contention.");
      return result === "ok" || result === "degraded";
    } catch {
      console.error("Worker heartbeat failed unexpectedly.");
      return Date.now() - state.lastRenewedAt < 150_000;
    }
  };

  while (!stopping) {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let beating = false;
    try {
      if (!(await beat())) break;
      activeController = new AbortController();
      const processed = await runWorkerTick(
        OWNER_ID,
        () => {
          heartbeat = setInterval(() => {
            if (beating) return; // never stack beats behind a slow one
            beating = true;
            void beat()
              .then((alive) => {
                if (!alive) requestStop();
              })
              .finally(() => {
                beating = false;
              });
          }, HEARTBEAT_MS);
        },
        () => {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
        },
        activeController.signal,
      );
      if (!processed && !(await beat())) {
        console.log("Lost the worker lock. Exiting.");
        break;
      }
    } catch {
      // Includes "not started" write contention on claim: nothing changed.
      console.error("Analysis worker tick failed.");
    } finally {
      activeController = null;
      if (heartbeat) clearInterval(heartbeat);
    }
    await sleep(POLL_MS);
  }

  try {
    await releaseWorkerLockAsync(OWNER_ID);
  } catch {
    // The lease simply expires if the release cannot be written.
  }
  console.log("Analysis worker stopped.");
}

main()
  .then(() => {
    closeDatabases();
    process.exit(0);
  })
  .catch(() => {
    console.error("Analysis worker crashed.");
    process.exit(1);
  });
