import { getAuthDatabase } from "../../src/server/database";
import {
  claimNextMailLocked,
  insertMailLocked,
} from "../../src/server/mailOutbox";
import { passwordResetMessage } from "../../src/server/mail";
import { runWriteTransaction } from "../../src/server/writeTransaction";

/**
 * Child process for tests/mailOutbox.test.ts. It dies abruptly (process.exit,
 * no ROLLBACK, no cleanup) at the exact points the outbox claims to survive:
 *
 *   abort   <userId> <email>   insert a mail row inside an open transaction, die before COMMIT
 *   commit  <userId> <email>   insert a mail row, COMMIT, die
 *   claim   -                  claim the next due message ("sending"), die before recording an outcome
 *
 * Exit code 9 means "died where intended"; anything else is a setup failure.
 * Uses the data directory in STYLE_DATA_DIR, which the parent has migrated.
 */
async function main(): Promise<void> {
  const [mode, userId, email] = process.argv.slice(2);
  if (mode === "abort" || mode === "commit") {
    const db = getAuthDatabase();
    db.exec("BEGIN IMMEDIATE");
    const result = insertMailLocked(db, {
      userId,
      kind: "reset-password",
      ...passwordResetMessage(email, "https://example.test/reset/crash-child"),
    });
    if (result.status !== "queued") process.exit(3);
    if (mode === "commit") db.exec("COMMIT");
    process.exit(9);
  }
  if (mode === "claim") {
    const claim = await runWriteTransaction((db) =>
      claimNextMailLocked(db, Date.now()),
    );
    process.exit(claim ? 9 : 4);
  }
  process.exit(2);
}

void main();
