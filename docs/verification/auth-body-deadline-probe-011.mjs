// Direct application-handler probe, not a deployment/network timeout test.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const out = process.argv[2]??'docs/verification/auth-body-deadline-probe-011.json';
if (fs.existsSync(out)) throw new Error('Refusing to overwrite probe evidence');
for (const name of Object.keys(process.env)) if (name.startsWith('STYLE_')) delete process.env[name];
for (const name of ['SMTP_URL','MAIL_FROM','AUTH_SECRET','NODE_OPTIONS','NODE_PATH']) delete process.env[name];
process.env.STYLE_DATA_DIR = path.resolve('.data/tests', 'auth-body-probe-'+randomUUID());
process.env.STYLE_PUBLIC_DEPLOYMENT = 'false';
process.env.APP_URL = 'http://127.0.0.1:3000';
let controller;
let canceled = false;
let settled = false;
let settledAtMs = null;
const body = new ReadableStream({
  start(c) { controller=c; c.enqueue(new TextEncoder().encode('{"email":"')); },
  cancel() { canceled=true; }
});
const { POST } = await import('../../src/app/api/auth/[...all]/route.ts');
const start = performance.now();
const request = new Request('http://127.0.0.1:3000/api/auth/sign-in/email', {
  method:'POST', headers:{'content-type':'application/json',origin:'http://127.0.0.1:3000'}, body, duplex:'half'
});
const result = POST(request).then(response=>{settled=true;settledAtMs=performance.now()-start;return response;});
await new Promise(resolve=>setTimeout(resolve,21_000));
const observed = {
  syntheticOnly:true, directHandler:true, deploymentDeadlineTest:false,
  observationMs:performance.now()-start, settledByObservation:settled,
  bodyCanceledByObservation:canceled,
  settledAtMs,
  finding:'No application-level twenty-second auth body deadline if the handler is still pending; upstream HTTP defaults are outside this probe.'
};
// End only this probe's input. Do not leave a pending stream or auth call.
if (!settled) controller.error(new Error('Synthetic probe input closed'));
const response = await result;
observed.cleanupResponseStatus = response.status;
observed.totalMs = performance.now()-start;
const { closeDatabases } = await import('../../src/server/database.ts');
closeDatabases();
fs.writeFileSync(out,JSON.stringify(observed,null,2));
console.log(JSON.stringify(observed));
