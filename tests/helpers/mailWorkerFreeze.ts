import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Test-only preload for tests/mailWorker.test.ts (`node --import tsx --import
 * <this file> scripts/mail-worker.ts`). Production code has no such hook and
 * never imports this file.
 *
 * On the IPC message `{ freeze: { ack, release, capMs } }` it blocks the
 * worker's event loop SYNCHRONOUSLY, which is what a truly stalled process
 * looks like from outside (its timers, and so its heartbeat, stop):
 *
 *   1. writes the `ack` file (exclusive create) to tell the parent "frozen
 *      from here on";
 *   2. waits, sleeping in 25 ms slices with Atomics.wait (no CPU spin), until
 *      the `release` file exists or `capMs` passes (a safety cap so a test that
 *      dies cannot leave the process blocked for ever; at most 5 minutes).
 *
 * The parent holds the freeze for exactly as long as it needs (until the real
 * `--check` process has read the stale heartbeat) by creating `release` later.
 *
 * Path guards: both files must sit directly in the directory named by
 * TEST_FREEZE_DIR (resolved to its real path) and have the exact fixture names
 * `freeze-ack-<8 hex>` / `freeze-release-<8 hex>`. Anything else is ignored.
 * This file creates only the ack file and deletes nothing.
 */
const NAME = { ack: /^freeze-ack-[0-9a-f]{8}$/, release: /^freeze-release-[0-9a-f]{8}$/ };

function ownFixture(file: unknown, kind: "ack" | "release"): string | null {
  const dir = process.env.TEST_FREEZE_DIR;
  if (typeof file !== "string" || !dir) return null;
  try {
    const real = realpathSync(dir);
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== real) return null;
    return NAME[kind].test(path.basename(resolved)) ? resolved : null;
  } catch {
    return null;
  }
}

process.on("message", (message) => {
  const freeze =
    message && typeof message === "object"
      ? (message as { freeze?: { ack?: unknown; release?: unknown; capMs?: unknown } }).freeze
      : undefined;
  if (!freeze) return;
  const ack = ownFixture(freeze.ack, "ack");
  const release = ownFixture(freeze.release, "release");
  if (!ack || !release) return;
  const cap = Math.min(Math.max(Number(freeze.capMs) || 0, 0), 300_000);
  writeFileSync(ack, "frozen", { flag: "wx" });
  const end = Date.now() + cap;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release) && Date.now() < end) Atomics.wait(sleeper, 0, 0, 25);
});
