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
 * When started with an IPC channel (fork) it sends `{ stage: "raw-copied" }` at
 * that stage, so the parent can act exactly then (for example kill it with
 * SIGKILL, which runs no exit hooks at all).
 *
 * Prints one JSON line: { startedAt, rawCopiedAt, doneAt, file, leftovers }.
 * Exit 0 done; 1 BackupFailure.
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  const stamp = process.env.TEST_BACKUP_STAMP;
  const holdMs = Number(process.env.TEST_BACKUP_HOLD_MS ?? 0);
  const blockMs = Number(process.env.TEST_BACKUP_BLOCK_MS ?? 0);
  let rawCopiedAt = 0;
  try {
    const result = await createBackup(getDatabase(), {
      dataDir: process.env.STYLE_DATA_DIR!,
      ...(stamp ? { now: () => new Date(stamp) } : {}),
      ...(process.env.TEST_BACKUP_WAIT_MS
        ? { lockWaitMs: Number(process.env.TEST_BACKUP_WAIT_MS) }
        : {}),
      onStage: async (stage) => {
        if (stage !== "raw-copied") return;
        rawCopiedAt = Date.now();
        process.send?.({ stage });
        if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
        if (blockMs > 0)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
      },
    });
    console.log(
      JSON.stringify({ startedAt, rawCopiedAt, doneAt: Date.now(), ...result }),
    );
    closeDatabases();
    process.exit(0);
  } catch (error) {
    console.log(
      JSON.stringify({
        startedAt,
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
