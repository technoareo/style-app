import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportDeletionLedger } from "../../src/server/deletionLedger";

/**
 * Child for tests/deletionLedger.test.ts: runs LEDGER_ROUNDS exports against
 * `<STYLE_DATA_DIR>/app.db` (its own connection) and reports how many of them
 * actually wrote a new generation. Several of these run at once while the
 * parent inserts deletions and samples the ledger file.
 */
async function main(): Promise<void> {
  const dataDir = process.env.STYLE_DATA_DIR!;
  const rounds = Number(process.env.LEDGER_ROUNDS ?? 20);
  const pause = Number(process.env.LEDGER_PAUSE_MS ?? 15);
  const db = new DatabaseSync(path.join(dataDir, "app.db"), { timeout: 5000 });
  let written = 0;
  let last = 0;
  for (let i = 0; i < rounds; i++) {
    const result = await exportDeletionLedger(db, dataDir, { lockWaitMs: 60_000 });
    if (result.written) written++;
    last = result.generation;
    await new Promise((r) => setTimeout(r, pause));
  }
  db.close();
  console.log(JSON.stringify({ written, last }));
}

main().then(
  () => process.exit(0),
  () => {
    console.log(JSON.stringify({ error: true }));
    process.exit(1);
  },
);
