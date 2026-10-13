import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setProcessLockObserver } from '../../src/server/lockDiagnostics.ts';

// Independent diagnostic process only. No SQL, database paths, accounts,
// request bodies or raw stacks are recorded. Existing observers stay unchanged.
const events = [];
let truncated = false;
setProcessLockObserver({
  acquire(event) {
    if (events.length >= 200) { truncated = true; return; }
    const stack = new Error().stack ?? '';
    const role = event.path === 'auth' ? 'auth'
      : /processNextMail/.test(stack) ? 'mail-process'
      : /reclaimExpiredPhotos/.test(stack) ? 'wardrobe-reclaim'
      : /mailOutbox/.test(stack) ? 'mail-other' : 'other';
    events.push({ role, atMs: performance.now(), ...event });
  },
});
const output = new URL(`./gate-waiter-trace-015-${process.pid}-${Date.now()}.json`, import.meta.url);
process.once('exit', () => {
  writeFileSync(fileURLToPath(output), JSON.stringify({ pid: process.pid, truncated, events }, null, 2) + '\n', { flag: 'wx' });
});
