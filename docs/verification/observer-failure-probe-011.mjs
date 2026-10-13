import fs from 'node:fs';
import {notifyAcquire} from '../../src/server/lockDiagnostics.ts';
const sample={path:'write',ok:true,outcome:'acquired',budgetMs:10000,gateMs:0,sqliteMs:1,totalMs:1,attempts:1,queueDepth:0};
const record={diagnosticOnly:true,noDatabaseOpened:true,getterEscaped:false,asyncUnhandled:false};
try {notifyAcquire({get acquire(){throw new Error('synthetic observer getter failure');}},sample);}catch{record.getterEscaped=true;}
const listener=()=>{record.asyncUnhandled=true;};
process.on('unhandledRejection',listener);
notifyAcquire({acquire:async()=>{throw new Error('synthetic async observer failure');}},sample);
await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
process.off('unhandledRejection',listener);
fs.writeFileSync('docs/verification/observer-failure-probe-011.json',JSON.stringify(record,null,2));
console.log(JSON.stringify(record));
process.exitCode=record.getterEscaped||record.asyncUnhandled?1:0;
