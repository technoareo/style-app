// Synthetic helper timing probe, not a deployed-network test.
import fs from 'node:fs';
import {readBoundedBody} from '../../src/server/boundedBody.ts';
const out=process.argv[2]??'docs/verification/body-deadline-boundary-probe-012.json';
if(fs.existsSync(out))throw new Error('Refusing to overwrite previous probe evidence');
const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"probe":true}'));controller.close();}});
const request=new Request('http://127.0.0.1/probe',{method:'POST',body,duplex:'half'});
const budgetMs=50;
const started=performance.now();
const pending=readBoundedBody(request,{maxBytes:100,timeoutMs:budgetMs});
queueMicrotask(()=>{const end=performance.now()+120;while(performance.now()<end){}});
const result=await pending;
const elapsedMs=performance.now()-started;
const evidence={syntheticOnly:true,directHelper:true,networkTest:false,budgetMs,elapsedMs,status:result.status,
 acceptedAfterDeadline:result.status==='ok'&&elapsedMs>budgetMs,readerReleased:!body.locked,
 explanation:'A queued microtask delays the read continuation while timers cannot run. An absolute deadline needs an elapsed-clock check, not only a timer flag.'};
fs.writeFileSync(out,JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
