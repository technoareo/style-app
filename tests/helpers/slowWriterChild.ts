import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Child for tests/backupLarge.test.ts: a REAL second process that writes to the
 * database being backed up, once immediately and then every WRITER_EVERY_MS
 * (default 5000), standing in for the heartbeats, sessions and jobs the
 * application writes while a backup copies.
 *
 * Each write is ONE autocommit INSERT into `writes(at)`. The child reads its
 * clock immediately BEFORE the statement (`start`) and immediately AFTER
 * `run()` has returned (`end`); a returned autocommit statement is a committed
 * one, so the whole commit lies within [start, end]. Both times are kept in
 * memory; `at` in the table is `start`, which gives the parent a durable row
 * count and start times to cross-check against.
 *
 * Collection is an acknowledged barrier, not message timing: on "stop" the
 * child stops its timer, closes the database (nothing is in flight any more),
 * and sends ONE message carrying the complete list of intervals and the number
 * of failed writes, then exits when that message has been handed to the pipe.
 * The parent decides overlap only from the intervals inside that message.
 */
const dataDir = process.env.STYLE_DATA_DIR!;
const every = Number(process.env.WRITER_EVERY_MS ?? 5000);
const db = new DatabaseSync(path.join(dataDir, "app.db"), { timeout: 30_000 });
const insert = db.prepare("INSERT INTO writes(at) VALUES (?)");
const intervals: [number, number][] = [];
let failed = 0;

function write(): void {
  const start = Date.now();
  try {
    insert.run(start);
    intervals.push([start, Date.now()]);
  } catch {
    failed++;
  }
}

write();
process.send?.({ ready: true });
const timer = setInterval(write, every);
process.on("message", (message) => {
  if (message !== "stop") return;
  clearInterval(timer);
  try {
    db.close();
  } catch {
    // Reported through the row-count cross-check in the parent.
  }
  process.send?.({ stopped: true, intervals, failed }, () => process.exit(0));
});
