import { randomBytes } from "node:crypto";
import { getReadyAuth } from "../../src/server/auth";
import { closeDatabases, getDatabase } from "../../src/server/database";
import { runPhysicalCleanup } from "../../src/server/physicalCleanup";
import { runWriteTransaction } from "../../src/server/writeTransaction";

/**
 * Child for tests/physicalCleanupConcurrency034.test.ts. Its own process and
 * connections against the shared <STYLE_DATA_DIR>/app.db. For each round it
 * creates a user that owns a distinctive marker row, deletes the user (the
 * deletion trigger bumps the cleanup counter in that same statement) and runs
 * a bounded physical cleanup, concurrently with its siblings.
 */
async function main(): Promise<void> {
  await getReadyAuth();
  const tag = process.env.CHILD_TAG!;
  const rounds = Number(process.env.CHILD_ROUNDS ?? 5);
  const outcomes: string[] = [];
  for (let i = 0; i < rounds; i++) {
    const id = `${tag}-user-${i}`;
    const marker = `MARK-${tag}-${i}-`;
    const now = new Date().toISOString();
    await runWriteTransaction((db) => {
      db.prepare(
        "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,?,?)",
      ).run(id, "x", `${id}@example.test`, now, now);
      db.prepare(
        "INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)",
      ).run(
        `${id}-photo`,
        id,
        Buffer.concat([Buffer.from(marker), randomBytes(9000)]),
        "sha",
        Date.now(),
      );
    });
    await runWriteTransaction((db) => {
      db.prepare("DELETE FROM user WHERE id=?").run(id);
    });
    outcomes.push(await runPhysicalCleanup({ budgetMs: 8_000 }));
  }
  closeDatabases();
  console.log(JSON.stringify({ outcomes }));
}

main().then(
  () => process.exit(0),
  () => {
    console.log(JSON.stringify({ error: true }));
    process.exit(1);
  },
);
