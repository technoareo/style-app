import { closeDatabases, getDatabase } from "../../src/server/database";

/**
 * Child for tests/processPresence.test.ts and tests/restoreFresh.test.ts: a
 * REAL process that opens the live database through the application's own
 * getDatabase() and then sits idle (no transaction, no statement), exactly
 * like an app, worker or mailer between requests. It reports over IPC and
 * stays until it receives "exit" or is killed.
 */
getDatabase();
process.send?.({ ready: true });
process.on("message", (message) => {
  if (message === "exit") {
    closeDatabases();
    process.exit(0);
  }
});
setInterval(() => {}, 1 << 30);
