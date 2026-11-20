import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CAPTURE_FOUNDATION_MIGRATION,
  migrateCaptureFoundation,
  rollbackCaptureFoundationForStaging,
} from "../src/server/database";
import { publicFeatureFlags } from "../src/server/featureFlags";

function stagingDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE user(id TEXT PRIMARY KEY);
    INSERT INTO user VALUES('u1');
    CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE wardrobe_spaces(user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,revision INTEGER,data_json TEXT NOT NULL);
    CREATE TABLE photo_assets(id TEXT PRIMARY KEY,user_id TEXT,data BLOB,sha256 TEXT,created_at INTEGER);
  `);
  return db;
}

test("capture foundation is additive, backfills old items, and is idempotent", () => {
  const db = stagingDatabase();
  const before = JSON.stringify({
    name: "Owner",
    saved: true,
    wardrobe: [{ id: "g1", name: "Shirt", available: false }],
  });
  db.prepare("INSERT INTO wardrobe_spaces VALUES('u1',7,?)").run(before);
  migrateCaptureFoundation(db);
  migrateCaptureFoundation(db);

  for (const table of ["extraction_jobs", "field_edits", "consents"])
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
      table,
    );
  const after = JSON.parse(
    (db.prepare("SELECT data_json FROM wardrobe_spaces WHERE user_id='u1'").get() as { data_json: string })
      .data_json,
  );
  assert.deepEqual(after.wardrobe[0], {
    id: "g1",
    name: "Shirt",
    available: false,
    status: "laundry",
    unavailableUntil: null,
    fit: "unknown",
    formality: "unknown",
    warmth: "unknown",
  });
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id=?").get(CAPTURE_FOUNDATION_MIGRATION));
  db.prepare("DELETE FROM user WHERE id='u1'").run();
  assert.equal(
    db.prepare("SELECT 1 FROM capture_migration_backups WHERE user_id='u1'").get(),
    undefined,
    "the migration safety copy follows account deletion",
  );
  db.close();
});

test("staging rollback restores byte-identical wardrobe JSON and removes only capture objects", () => {
  const db = stagingDatabase();
  const before = '{"saved":true,"wardrobe":[{"id":"g1","available":true}]}';
  db.prepare("INSERT INTO wardrobe_spaces VALUES('u1',2,?)").run(before);
  migrateCaptureFoundation(db);
  rollbackCaptureFoundationForStaging(db);
  const restored = (db.prepare("SELECT data_json FROM wardrobe_spaces WHERE user_id='u1'").get() as {
    data_json: string;
  }).data_json;
  assert.equal(restored, before);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE id=?").get(CAPTURE_FOUNDATION_MIGRATION), undefined);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wardrobe_spaces'").get());
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extraction_jobs'").get(), undefined);
  db.close();
});

test("capture defaults off, PWA cache defaults on, and malformed flags fail closed", () => {
  assert.deepEqual(publicFeatureFlags({}), { captureV2: false, pwaCache: true });
  assert.deepEqual(
    publicFeatureFlags({ STYLE_CAPTURE_V2_ENABLED: "true", STYLE_PWA_CACHE_ENABLED: "false" }),
    { captureV2: true, pwaCache: false },
  );
  assert.deepEqual(
    publicFeatureFlags({ STYLE_CAPTURE_V2_ENABLED: "maybe", STYLE_PWA_CACHE_ENABLED: "maybe" }),
    { captureV2: false, pwaCache: false },
  );
});

test("PWA registrar obeys no-store runtime config and purges Style Studio caches when disabled", () => {
  const source = readFileSync("src/components/PwaRegistrar.tsx", "utf8");
  assert.match(source, /fetch\("\/api\/runtime-config", \{ cache: "no-store" \}\)/);
  assert.match(source, /getRegistrations\(\)/);
  assert.match(source, /registration\.unregister\(\)/);
  assert.match(source, /key\.startsWith\("style-studio-"\)/);
  assert.match(source, /navigator\.serviceWorker\.register\("\/sw\.js"/);
});
