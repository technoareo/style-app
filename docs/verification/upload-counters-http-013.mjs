import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const out='docs/verification/upload-counters-http-013.json';
if(fs.existsSync(out))throw Error('Existing evidence must be preserved');
for(const key of Object.keys(process.env))if(key.startsWith('STYLE_'))delete process.env[key];
for(const key of ['SMTP_URL','MAIL_FROM','AUTH_SECRET'])delete process.env[key];
process.env.STYLE_DATA_DIR=path.resolve('.data/release-013-browser');
process.env.STYLE_PUBLIC_DEPLOYMENT='false';process.env.APP_URL='http://127.0.0.1:3000';
const {getReadyAuth}=await import('../../src/server/auth.ts');
const {closeDatabases}=await import('../../src/server/database.ts');
const {runWriteTransaction}=await import('../../src/server/writeTransaction.ts');
const base=process.env.APP_URL,results=[],problems=[];
const metrics=async()=>{const r=await fetch(base+'/api/health/uploads',{signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('Metrics unavailable');return r.json();};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const auth=await getReadyAuth();
 async function identity(){const email=`counter-${randomUUID()}@example.test`,password='Disposable counter passphrase 42!';const made=await auth.api.signUpEmail({body:{name:'Counter fixture',email,password}});await runWriteTransaction(db=>db.prepare('UPDATE user SET emailVerified=1 WHERE id=? AND email=?').run(made.user.id,email));const signed=await auth.api.signInEmail({body:{email,password},asResponse:true});return {id:made.user.id,cookie:signed.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};}
 const a=await identity(),b=await identity();
 function request(owner,mode){let req;const started=performance.now();const promise=new Promise(resolve=>{let timer,watchdog,done=false;const finish=result=>{if(done)return;done=true;clearInterval(timer);clearTimeout(watchdog);req.destroy();resolve({...result,elapsedMs:performance.now()-started});};req=http.request({hostname:'127.0.0.1',port:3000,path:'/api/photos',method:'POST',headers:{origin:base,cookie:owner.cookie,'x-style-account':owner.id,'content-type':'application/json',connection:'close',...(mode==='chunked'?{}:{'content-length':1000})}},res=>{res.resume();res.on('end',()=>finish({status:res.statusCode}));res.on('error',e=>finish({error:e.code}));});req.on('error',e=>finish({error:e.code}));watchdog=setTimeout(()=>finish({watchdog:true}),5000);req.flushHeaders();req.write('{');if(mode==='chunked')timer=setInterval(()=>req.write(' '),80);});return {promise,abort:()=>req.destroy()};}
 const before=await metrics();const stalled=request(a,'stall');
 let active;for(let i=0;i<30;i++){active=await metrics();if(active.accountsHoldingUpload===1)break;await sleep(15);}
 if(active.accountsHoldingUpload!==1)problems.push('No observed active owner');
 const duplicate=await request(a,'stall').promise;
 const other=await fetch(base+'/api/photos',{method:'POST',headers:{origin:base,cookie:b.cookie,'x-style-account':b.id,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(4000)});
 const stalledResult=await stalled.promise;const afterStall=await metrics();
 results.push({case:'same-owner-and-other-user',duplicate,otherStatus:other.status,stalledResult,active,after:afterStall});
 if(duplicate.status!==429||stalledResult.status!==408||other.status!==400||afterStall.accountsHoldingUpload!==0)problems.push('Fairness/stall response mismatch');
 const chunkedResult=await request(a,'chunked').promise;const afterChunked=await metrics();results.push({case:'chunked-without-content-length',response:chunkedResult,after:afterChunked});
 if(chunkedResult.status!==408||afterChunked.accountsHoldingUpload!==0)problems.push('Chunked deadline/release mismatch');
 const abortBefore=await metrics();const aborted=request(a,'abort');await sleep(180);aborted.abort();const client=await aborted.promise;await sleep(300);const early=await metrics();await sleep(1100);const late=await metrics();
 const abortDelta=late.bodies.photos.aborted-abortBefore.bodies.photos.aborted,timeoutDelta=late.bodies.photos.timeout-abortBefore.bodies.photos.timeout;
 results.push({case:'client-disconnect',client,early,late,serverAbortDelta:abortDelta,serverTimeoutDelta:timeoutDelta});
 if(late.accountsHoldingUpload!==0||abortDelta+timeoutDelta!==1)problems.push('Disconnect did not release with one observable body outcome');
 if(afterChunked.bodies.photos.timeout-before.bodies.photos.timeout!==2)problems.push('Expected two server-observed deadlines');
 fs.writeFileSync(out,JSON.stringify({compiledLoopback:true,operatorBudgetMs:1000,fixtureVerificationBypass:true,before,results,problems},null,2),{flag:'wx'});
 console.log(JSON.stringify({problems,duplicateStatus:duplicate.status,otherStatus:other.status,chunkedStatus:chunkedResult.status,serverAbortDelta:abortDelta,serverTimeoutDelta:timeoutDelta,earlyHolders:early.accountsHoldingUpload,finalHolders:late.accountsHoldingUpload}));if(problems.length)process.exitCode=1;
}finally{closeDatabases();}
