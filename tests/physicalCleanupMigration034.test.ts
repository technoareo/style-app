import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Build 034: upgrading a database that a build 033 (or earlier) server wrote.
 * The current schema is created by the real stack, then put back into the exact
 * pre-034 state (old trigger, no physical_cleanup table, no migration row) with
 * existing users, data and ledger tombstones, and migrated again.
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dataDir, { recursive: true });
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
delete process.env.STYLE_PUBLIC_DEPLOYMENT;
delete process.env.SMTP_URL;

// The trigger exactly as builds up to 033 created it.
const OLD_TRIGGER = `
CREATE TRIGGER user_deletion_ledger
AFTER DELETE ON user
BEGIN
  INSERT OR REPLACE INTO account_deletions(user_id, deleted_at)
  VALUES (OLD.id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;`;

after(async () => {
  (await import("../src/server/database")).closeDatabases();
});

function migrate(db: DatabaseSync, migrateApplicationSchema: (db: DatabaseSync) => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    migrateApplicationSchema(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("a current (pre-034) database is upgraded in place: data kept, legacy tombstones counted, trigger replaced, idempotent", async () => {
  const database = await import("../src/server/database");
  const { getReadyAuth } = await import("../src/server/auth");
  const cleanup = await import("../src/server/physicalCleanup");
  const auth = await getReadyAuth();
  const db = database.getDatabase();

  const kept = (
    await auth.api.signUpEmail({
      body: { email: "kept@example.test", name: "Kept", password: "Kept upgrade passphrase 42!" },
    })
  ).user.id;
  const doomed = (
    await auth.api.signUpEmail({
      body: { email: "doomed@example.test", name: "Doomed", password: "Doomed upgrade passphrase 42!" },
    })
  ).user.id;
  db.prepare("INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES('kept-photo',?,?,?,?)").run(
    kept,
    Buffer.from("kept-bytes"),
    "sha",
    Date.now(),
  );
  const iso = new Date().toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  // A token addressed by e-mail address (identifier) and one by user id (value).
  db.prepare("INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES('v-email','doomed@example.test','otp',?,?,?)").run(later, iso, iso);
  db.prepare("INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES('v-id','reset-password:t',?,?,?,?)").run(doomed, later, iso, iso);
  db.prepare("INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES('v-other','other@example.test','otp',?,?,?)").run(later, iso, iso);

  // Put the database back into its pre-034 state, with two earlier deletions.
  db.exec("DROP TRIGGER user_deletion_ledger; DROP TABLE physical_cleanup;");
  db.exec(OLD_TRIGGER);
  db.prepare("DELETE FROM schema_migrations WHERE id=?").run(database.PHYSICAL_CLEANUP_MIGRATION);
  db.exec("INSERT INTO account_deletions(user_id,deleted_at) VALUES('old-1',1),('old-2',2)");
  assert.equal(cleanup.readCleanupStatus(db).migrated, false);

  migrate(db, database.migrateApplicationSchema);

  let status = cleanup.readCleanupStatus(db);
  assert.equal(status.migrated, true);
  assert.equal(status.legacyDeletions, 2, "earlier deletions are reported as pre-034 (possible residue)");
  assert.equal(status.pending, false, "an upgrade alone owes no cleanup");
  assert.ok(db.prepare("SELECT 1 FROM user WHERE id=?").get(kept), "users kept");
  assert.ok(db.prepare("SELECT 1 FROM photo_assets WHERE id='kept-photo'").get(), "photos kept");
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id=?").get(database.PHYSICAL_CLEANUP_MIGRATION));
  const sql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='user_deletion_ledger'").get() as { sql: string }
  ).sql;
  assert.match(sql, /physical_cleanup/);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='user_deletion_ledger'").get() as { n: number }).n,
    1,
    "exactly one ledger trigger",
  );

  // Idempotent: a second run changes neither the counters nor the legacy count.
  migrate(db, database.migrateApplicationSchema);
  assert.deepEqual(cleanup.readCleanupStatus(db), status);

  // The upgraded trigger does all three things in the deleting statement.
  db.prepare("DELETE FROM user WHERE id=?").run(doomed);
  status = cleanup.readCleanupStatus(db);
  assert.equal(status.requested, 1);
  assert.equal(status.pending, true);
  assert.ok(status.pendingSinceMs && status.pendingSinceMs > 0);
  assert.ok(db.prepare("SELECT 1 FROM account_deletions WHERE user_id=?").get(doomed), "tombstone recorded");
  assert.equal(db.prepare("SELECT 1 FROM verification WHERE id='v-id'").get(), undefined, "token by user id deleted");
  assert.equal(db.prepare("SELECT 1 FROM verification WHERE id='v-email'").get(), undefined, "token by e-mail address deleted");
  assert.ok(db.prepare("SELECT 1 FROM verification WHERE id='v-other'").get(), "someone else's token untouched");
  assert.equal(status.legacyDeletions, 2, "legacy count is fixed at first migration");

  // A rolled-back deletion leaves no mark and no tombstone.
  db.exec("BEGIN IMMEDIATE");
  db.prepare("DELETE FROM user WHERE id=?").run(kept);
  db.exec("ROLLBACK");
  assert.equal(cleanup.readCleanupStatus(db).requested, 1);
  assert.equal(db.prepare("SELECT 1 FROM account_deletions WHERE user_id=?").get(kept), undefined);
  assert.ok(db.prepare("SELECT 1 FROM user WHERE id=?").get(kept));

  assert.equal(await cleanup.runPhysicalCleanup(), "clean");
  assert.equal(cleanup.readCleanupStatus(db).pending, false);
});

test("readiness is not claimed for a partial or direct migration: a trigger without the verification delete, or a missing counter row, is repaired", async () => {
  const database = await import("../src/server/database");
  const cleanup = await import("../src/server/physicalCleanup");
  const db = database.getDatabase();
  const iso = new Date().toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(database.applicationMigrationApplied(db), true, "the fully migrated database passes");

  // (i) A build-034 trigger written when no verification table existed: has physical_cleanup, lacks the delete.
  db.exec(`
DROP TRIGGER user_deletion_ledger;
CREATE TRIGGER user_deletion_ledger AFTER DELETE ON user BEGIN
  INSERT OR REPLACE INTO account_deletions(user_id, deleted_at) VALUES (OLD.id, 1);
  UPDATE physical_cleanup SET requested = requested + 1 WHERE id = 1;
END;`);
  assert.equal(database.applicationMigrationApplied(db), false, "recorded migration + physical_cleanup in the trigger is not enough");
  migrate(db, database.migrateApplicationSchema);
  assert.equal(database.applicationMigrationApplied(db), true);
  db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('repair-1','x','repair-1@example.test',0,?,?)").run(iso, iso);
  db.prepare("INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES('v-repair','reset-password:r','repair-1',?,?,?)").run(later, iso, iso);
  db.prepare("DELETE FROM user WHERE id='repair-1'").run();
  assert.equal(db.prepare("SELECT 1 FROM verification WHERE id='v-repair'").get(), undefined, "the repaired trigger deletes the person's tokens");

  // (ii) The single counter row is missing: deletions would owe nothing.
  assert.equal(await cleanup.runPhysicalCleanup(), "clean");
  db.exec("DELETE FROM physical_cleanup");
  assert.equal(database.applicationMigrationApplied(db), false);
  migrate(db, database.migrateApplicationSchema);
  assert.equal(database.applicationMigrationApplied(db), true);
  assert.equal(cleanup.readCleanupStatus(db).migrated, true, "the counter row is back");

  // (iii) The old (pre-034) trigger alone is also not ready.
  db.exec("DROP TRIGGER user_deletion_ledger;" + OLD_TRIGGER);
  assert.equal(database.applicationMigrationApplied(db), false);
  migrate(db, database.migrateApplicationSchema);
  assert.equal(database.applicationMigrationApplied(db), true);
});
