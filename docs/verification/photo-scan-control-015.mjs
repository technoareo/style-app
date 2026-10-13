import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Read-only main database from the previous synthetic probe. Control table is
// TEMP in memory. No application database or persistent index is modified.
const file = path.resolve(process.argv[2] ?? '');
const expectedRoot = path.join(process.cwd(), '.data', 'probes') + path.sep;
if (!file.startsWith(expectedRoot) || !path.basename(path.dirname(file)).startsWith('photo-scan-015-') || path.basename(file) !== 'synthetic.db') throw new Error('Expected the owned synthetic probe database.');
const db = new DatabaseSync(file, { readOnly: true });
const counts = db.prepare("SELECT COUNT(*) AS n,SUM(sha256<>'synthetic-not-a-photo-hash') AS unexpected FROM photo_assets").get();
if (counts.n !== 50 || counts.unexpected !== 0) throw new Error('Synthetic dataset guard failed.');
db.exec('PRAGMA temp_store=MEMORY; CREATE TEMP TABLE small_assets AS SELECT id,user_id,zeroblob(128) AS data,sha256,created_at FROM photo_assets; CREATE INDEX temp.small_owner ON small_assets(user_id);');
const cutoff = Date.now() - 86_400_000;
const variants = [];
for (const query of ['readHint', 'saveSweep']) {
  for (const [variant, table, index] of [['largeOwner', 'photo_assets', 'photo_owner_probe'], ['largeCovering', 'photo_assets', 'photo_cover_probe'], ['smallOwner', 'small_assets', 'small_owner']]) {
    const sql = `SELECT ${query === 'readHint' ? 'id' : 'id,created_at'} FROM ${table} INDEXED BY ${index} WHERE user_id=?${query === 'readHint' ? ' AND created_at<?' : ''}`;
    const args = query === 'readHint' ? ['owner-a', cutoff] : ['owner-a'];
    variants.push({ query, variant, statement: db.prepare(sql), args, timings: [], plan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(x => x.detail) });
  }
}
let seed = 15016;
for (let round = 0; round < 12; round++) {
  const order = [...variants];
  for (let i = order.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  for (const v of order) {
    const started = performance.now();
    const n = v.statement.all(...v.args).length;
    v.timings.push(performance.now() - started);
    if (n !== (v.query === 'readHint' ? 20 : 40)) throw new Error('Query results diverged.');
  }
}
const results = variants.map(v => { const sorted = [...v.timings].sort((a,b) => a-b); return { query: v.query, variant: v.variant, timingsMs: v.timings, medianMs: sorted[6], maxMs: sorted.at(-1), plan: v.plan }; });
db.close();
const report = { kind: 'synthetic-sql-alternating-small-blob-control', repetitions: 12, largePayloadBytes: 2400000, smallPayloadBytes: 128, results, limitations: ['Forced index SQL microbenchmark, not application GET/PUT or concurrency.', 'Synthetic bytes, no real images/accounts.', 'Main database read-only; small table TEMP in memory.', 'OS caches not cleared; physical read counts not captured.'] };
writeFileSync(path.join(process.cwd(), 'docs', 'verification', 'photo-scan-control-015.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(results.map(({query,variant,medianMs,maxMs,plan}) => ({query,variant,medianMs,maxMs,plan})), null, 2));
