// Root diagnostic for this exact compiled build; no app source or public hook.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const app = path.resolve(__dirname, '../..');
assert.equal(fs.readFileSync(path.join(app, '.next/BUILD_ID'), 'utf8').trim(), '9wveLyH8cu_KguIMt4AZB');
for (const key of Object.keys(process.env)) {
  if (key.startsWith('STYLE_') || ['APP_URL','AUTH_SECRET','SMTP_URL','MAIL_FROM','OLLAMA_URL'].includes(key)) delete process.env[key];
}
process.env.NODE_ENV = 'production';
process.env.APP_URL = 'http://127.0.0.1:3000';
process.env.AUTH_SECRET = crypto.randomBytes(32).toString('hex');
process.env.STYLE_DATA_DIR = path.join(app, '.data/tests', `compiled-health016-${crypto.randomUUID()}`);
fs.mkdirSync(process.env.STYLE_DATA_DIR, { recursive: true });
async function main() {
  const health = require(path.join(app, '.next/server/app/api/health/route.js'));
  const runtime = require(path.join(app, '.next/server/webpack-runtime.js'));
  const database = runtime(87267);
  require(path.join(app, '.next/server/app/api/wardrobe/route.js'));
  assert.equal(runtime(87267), database, 'Loading wardrobe retains the same database module object');
  const get = health.routeModule.userland.GET;
  let response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ready:true});
  const db = database.C3(); // getDatabase in this build
  db.exec('BEGIN IMMEDIATE');
  Object.defineProperty(db, 'close', {configurable:true, value(){throw new Error('synthetic close failure');}});
  try {
    database.KK(db); // quarantineMainConnection in this build
    assert.equal(database.Bl(), true);
    for (let i=0;i<2;i++) {
      response = await get();
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), {ready:false});
    }
    console.log('PASS: compiled health 200 -> quarantine -> 503 twice; wardrobe and health share cached database module 87267. No public server/fault hook, SMTP, or model used.');
  } finally {
    delete db.close;
    if (db.isOpen) { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
  }
}
main().catch(error => { console.error(error); process.exitCode=1; });

