import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

// Disposable diagnostic only: a queued synthetic 75ms task witnesses whether
// the SQLite transaction remains open before the synchronous body begins.
const fixture = path.join(process.cwd(), '.data', 'probes', 'write-gap-015-' + randomUUID());
mkdirSync(fixture, { recursive: true });
process.env.STYLE_DATA_DIR = fixture;
const { getDatabase, closeDatabases } = await import('../../src/server/database.ts');
const { runWriteTransaction } = await import('../../src/server/writeTransaction.ts');
const db = getDatabase();
db.exec('CREATE TABLE gap_probe(v INTEGER)');
const nativeExec = db.exec.bind(db);
const events = [];
let calls = 0;
db.exec = function(sql) {
  const result = nativeExec(sql);
  if (sql === 'BEGIN IMMEDIATE') {
    events.push({ event: 'begin-return', atMs: performance.now(), active: db.isTransaction, calls });
    queueMicrotask(() => {
      events.push({ event: 'queued-task-start', atMs: performance.now(), active: db.isTransaction, calls });
      const end = performance.now() + 75;
      while (performance.now() < end) {}
      events.push({ event: 'queued-task-end', atMs: performance.now(), active: db.isTransaction, calls });
    });
  }
  if (sql === 'COMMIT') events.push({ event: 'commit-return', atMs: performance.now(), active: db.isTransaction, calls });
  return result;
};
try {
  await runWriteTransaction(() => {
    calls++;
    events.push({ event: 'body', atMs: performance.now(), active: db.isTransaction, calls });
    db.prepare('INSERT INTO gap_probe VALUES(1)').run();
  });
  const rows = db.prepare('SELECT COUNT(*) AS n FROM gap_probe').get().n;
  const sourceSha256 = createHash('sha256').update(readFileSync('src/server/writeTransaction.ts')).digest('hex');
  const report = { kind: 'synthetic-queued-task-write-lock-gap', calls, rows, sourceSha256, events,
    limitations: ['Synthetic scheduling injection, not proof of the full-suite failure cause.', 'One disposable database and one writer; no real account data.', 'No application or test source mutation.'] };
  const name = process.argv[2] ?? 'write-turn-gap-probe-015.json';
  if (!/^[a-z0-9._-]+\.json$/i.test(name)) throw new Error('Expected a new report basename.');
  writeFileSync(path.join(process.cwd(), 'docs', 'verification', name), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.exec = nativeExec;
  closeDatabases();
}
