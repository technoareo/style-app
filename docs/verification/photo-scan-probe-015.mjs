import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Independent SQL microbenchmark. Synthetic bytes are NOT valid clothing photos.
// No app configuration, user data, environment secrets or actual account files.
const fixtureDir = path.join(process.cwd(), '.data', 'probes', 'photo-scan-015-' + randomUUID());
mkdirSync(fixtureDir, { recursive: true });
const dbFile = path.join(fixtureDir, 'synthetic.db');
const db = new DatabaseSync(dbFile);
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE photo_assets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,data BLOB NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE INDEX photo_owner_probe ON photo_assets(user_id);`);
const now = Date.now();
const payloadBytes = 2_400_000;
const bytes = Buffer.allocUnsafe(payloadBytes);
let seed = 15013;
for (let i = 0; i < bytes.length; i++) {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  bytes[i] = seed & 255;
}
const insert = db.prepare('INSERT INTO photo_assets VALUES(?,?,?,?,?)');
db.exec('BEGIN IMMEDIATE');
for (let i = 0; i < 50; i++) insert.run('synthetic-' + i, i < 40 ? 'owner-a' : 'owner-b', bytes, 'synthetic-not-a-photo-hash', now - (i % 2 ? 2 : 0) * 86_400_000);
db.exec('COMMIT');
const queries = {
  readHint: ['SELECT id FROM photo_assets WHERE user_id=? AND created_at<?', ['owner-a', now - 86_400_000]],
  saveSweep: ['SELECT id,created_at FROM photo_assets WHERE user_id=?', ['owner-a']],
};
const measure = () => Object.fromEntries(Object.entries(queries).map(([name, [sql, args]]) => {
  const statement = db.prepare(sql);
  const timings = [];
  let resultCount = 0;
  for (let i = 0; i < 20; i++) {
    const start = performance.now(); resultCount = statement.all(...args).length;
    timings.push(performance.now() - start);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  return [name, { resultCount, timingsMs: timings, medianMs: sorted[10], p95Ms: sorted[18], plan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(x => x.detail) }];
}));
const baseline = measure();
// ONLY this disposable synthetic database receives the candidate index.
const indexStart = performance.now();
db.exec('CREATE INDEX photo_cover_probe ON photo_assets(user_id,created_at,id)');
const indexCreationMs = performance.now() - indexStart;
const covering = measure();
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
const report = { kind: 'synthetic-sql-microbenchmark', payloadBytes, rows: 50, ownedRows: 40,
  ownedPayloadBytes: 40 * payloadBytes, databaseBytes: statSync(dbFile).size,
  repetitions: 20, baseline, indexCreationMs, covering,
  limitations: ['Not an application GET/PUT or concurrency test.', 'No valid images or real accounts.', 'One connection; OS/page caches not cleared; covering measured after baseline.', 'No physical-page-read counter captured.', 'No application migration, index or source change.'] };
const output = path.join(process.cwd(), 'docs', 'verification', 'photo-scan-probe-015.json');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ baseline, covering, indexCreationMs, ownedPayloadBytes: report.ownedPayloadBytes }, null, 2));
