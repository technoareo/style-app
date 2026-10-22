import { BackupFailure, createBackup } from "../../src/server/backupDatabase";
import { closeDatabases, getDatabase } from "../../src/server/database";

/**
 * Child process for tests/backupSafety.test.ts. Runs createBackup() against
 * the (already migrated) data directory in STYLE_DATA_DIR.
 *
 *   TEST_BACKUP_STAMP       ISO time used as the backup clock (same stamp in two
 *                           children = same-millisecond backups)
 *   TEST_BACKUP_HOLD_MS     stay at the "raw-copied" stage this long WITHOUT
 *                           blocking the event loop (an async wait)
 *   TEST_BACKUP_BLOCK_MS    block this process's MAIN THREAD for this long at the
 *                           "raw-copied" stage with Atomics.wait: a stand-in for a
 *                           long synchronous step (VACUUM). The process stays alive.
 *   TEST_BACKUP_WAIT_MS     how long to wait for another backup's lock (default 30 s)
 *
 *   TEST_BACKUP_RELEASE_GATE  after the hold (and before the block), also wait for
 *                           the parent's IPC message `{ cmd: "release" }`; a
 *                           message that arrives earlier is remembered
 *
 * When started with an IPC channel (fork) it sends, as discriminated messages:
 *   `{ stage: "waiting", at }`     once, the first time the backups lock is found
 *                                  held by another backup (a real busy refusal,
 *                                  before the first poll sleep);
 *   `{ stage: "raw-copied", at }`  at that stage, so the parent can act exactly
 *                                  then (for example kill it with SIGKILL, which
 *                                  runs no exit hooks at all).
 * A failing send is ignored: it must not change the backup.
 *
 * Prints one JSON line: { startedAt, rawCopiedAt, doneAt, waitingAt, file,
 * leftovers }. Exit 0 done; 1 BackupFailure.
 */
function send(message: Record<string, unknown>): void {
  try {
    process.send?.(message);
  } catch {
    // The parent may already be gone.
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const stamp = process.env.TEST_BACKUP_STAMP;
  const holdMs = Number(process.env.TEST_BACKUP_HOLD_MS ?? 0);
  const blockMs = Number(process.env.TEST_BACKUP_BLOCK_MS ?? 0);
  let rawCopiedAt = 0;
  let waitingAt = 0;
  const released = process.env.TEST_BACKUP_RELEASE_GATE
    ? new Promise<void>((resolve) => {
        process.on("message", (message) => {
          if ((message as { cmd?: unknown } | null)?.cmd === "release") resolve();
        });
      })
    : null;
  try {
    const result = await createBackup(getDatabase(), {
      dataDir: process.env.STYLE_DATA_DIR!,
      ...(stamp ? { now: () => new Date(stamp) } : {}),
      ...(process.env.TEST_BACKUP_WAIT_MS
        ? { lockWaitMs: Number(process.env.TEST_BACKUP_WAIT_MS) }
        : {}),
      onLockWait: () => {
        waitingAt = Date.now();
        send({ stage: "waiting", at: waitingAt });
      },
      onStage: async (stage) => {
        if (stage !== "raw-copied") return;
        rawCopiedAt = Date.now();
        send({ stage, at: rawCopiedAt });
        if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
        if (released) await released;
        if (blockMs > 0)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
      },
    });
    console.log(
      JSON.stringify({ startedAt, waitingAt, rawCopiedAt, doneAt: Date.now(), ...result }),
    );
    closeDatabases();
    process.exit(0);
  } catch (error) {
    console.log(
      JSON.stringify({
        startedAt,
        waitingAt,
        rawCopiedAt,
        doneAt: Date.now(),
        leftovers: error instanceof BackupFailure ? error.leftovers : [],
        error: error instanceof Error ? error.message : "error",
      }),
    );
    process.exit(1);
  }
}

void main();
