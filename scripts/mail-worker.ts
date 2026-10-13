import { getReadyAuth } from "../src/server/auth";
import { closeDatabases, getDatabase, getDataDir } from "../src/server/database";
import { exportDeletionLedger } from "../src/server/deletionLedger";
import { mailLimits } from "../src/server/limits";
import { createMailHeartbeat } from "../src/server/mailHealth";
import {
  mailHeartbeatAgeMs,
  mailQueueStats,
  mailStepBoundMs,
  processNextMail,
  touchMailHeartbeat,
} from "../src/server/mailOutbox";
import { assertMailConfigured } from "../src/server/mail";

/**
 * Supervised account-mail worker. A separate process from the web app and from
 * the AI worker, so a slow vision model can never delay a verification or
 * recovery email and SMTP I/O never runs inside the web process.
 *
 *   mail-worker.ts            run the delivery loop
 *   mail-worker.ts --check    exit 0 if a worker reported in recently (container health check)
 *   mail-worker.ts --status   print queue COUNTS as JSON (no addresses, bodies or tokens)
 *
 * Several copies are safe: each message is claimed under a row lease inside a
 * write transaction. Delivery is at-least-once (see src/server/mailOutbox.ts).
 *
 * Health (build 009): a timer of the worker's own reports in every
 * STYLE_MAIL_HEARTBEAT_MS (default 10 s), whatever the loop is doing, but only
 * while the loop keeps making progress (src/server/mailHealth.ts). `--check`
 * calls the worker healthy when the last report is younger than
 * STYLE_MAIL_HEALTH_FRESH_MS (default 60 s, never below three beats).
 *
 * Shutdown (build 009): SIGTERM, SIGINT, or the message "shutdown" on an IPC
 * channel (the portable trigger the tests use, because Windows cannot deliver
 * SIGTERM to a child) stops claiming, cancels the send in flight by destroying
 * its SMTP socket, releases that message back to the queue with a short
 * record budget, and exits. Whatever is still running STYLE_MAIL_SHUTDOWN_EXIT_MS
 * (default 25 s) after the request is abandoned: the process exits, and a row
 * left `sending` returns to the queue when its lease lapses. compose.yaml's
 * `stop_grace_period` for this service is longer than that exit bound.
 */

const POLL_MS = 2000;

const shutdown = new AbortController();
let exitTimer: ReturnType<typeof setTimeout> | null = null;

function beginShutdown(): void {
  if (shutdown.signal.aborted) return;
  shutdown.abort();
  exitTimer = setTimeout(() => {
    console.error("Mail worker shutdown timed out; exiting.");
    process.exit(1);
  }, mailLimits().shutdownExitMs);
  exitTimer.unref?.();
}

process.on("SIGINT", beginShutdown);
process.on("SIGTERM", beginShutdown);
process.on("message", (message) => {
  if (message === "shutdown") beginShutdown();
});

/** Sleeps, but wakes at once when shutdown begins. */
const idle = (ms: number) =>
  new Promise<void>((resolve) => {
    if (shutdown.signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      shutdown.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    shutdown.signal.addEventListener("abort", done, { once: true });
  });

/**
 * Keeps the exported deletion ledger current (build 010,
 * src/server/deletionLedger.ts): about once a minute, if the database has a
 * deletion the file lacks (or the file is older than its refresh age), it is
 * rewritten atomically. Failures are logged with fixed text and never affect
 * mail delivery. The step is bounded (a 5 s wait for another exporter plus a
 * small write) and reports progress around itself so it cannot make the
 * heartbeat look stuck.
 */
const LEDGER_TICK_MS = 60_000;
let lastLedgerTick = 0;
async function ledgerTick(progress: () => void): Promise<void> {
  if (shutdown.signal.aborted || Date.now() - lastLedgerTick < LEDGER_TICK_MS) return;
  lastLedgerTick = Date.now();
  progress();
  try {
    await exportDeletionLedger(getDatabase(), getDataDir(), { lockWaitMs: 5_000 });
  } catch {
    console.error("Deletion ledger export failed.");
  }
  progress();
}

async function check(): Promise<number> {
  getDatabase();
  const age = mailHeartbeatAgeMs();
  return age !== null && age < mailLimits().healthFreshMs ? 0 : 1;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    process.exitCode = await check();
    return;
  }
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(mailQueueStats()));
    return;
  }
  assertMailConfigured();
  await getReadyAuth();
  const heartbeat = createMailHeartbeat({
    intervalMs: mailLimits().heartbeatMs,
    // One bounded step plus a margin: a loop silent for longer is wedged.
    stuckAfterMs: mailStepBoundMs() + 15_000,
    touch: touchMailHeartbeat,
    onError: () => console.warn("Mail worker heartbeat delayed."),
  });
  heartbeat.start();
  console.log("Mail worker started.");
  try {
    while (!shutdown.signal.aborted) {
      heartbeat.progress();
      let worked = false;
      try {
        // Drain what is due, one message at a time, then idle.
        for (let i = 0; i < 20 && !shutdown.signal.aborted; i++) {
          const did = await processNextMail({
            shutdown: shutdown.signal,
            onProgress: heartbeat.progress,
          });
          if (!did) break;
          worked = true;
        }
      } catch {
        // Includes "not started" write contention on claim: nothing changed.
        console.error("Mail worker tick failed.");
        heartbeat.progress();
      }
      await ledgerTick(heartbeat.progress);
      if (!worked) await idle(POLL_MS);
    }
  } finally {
    heartbeat.stop();
  }
  console.log("Mail worker stopped.");
}

main()
  .then(() => {
    closeDatabases();
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    // Fixed text only: an error here can carry configuration values.
    console.error(
      "Mail worker crashed:",
      error instanceof Error && /^Public deployment requires/.test(error.message)
        ? error.message
        : "unexpected error",
    );
    process.exit(1);
  });
