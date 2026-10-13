// Compiled loopback HTTP probe. Server uses supported 1000 ms operator budget.
import http from 'node:http';
import fs from 'node:fs';
const out='docs/verification/body-http-probe-012-initial.json';
if(fs.existsSync(out))throw new Error('Refusing to overwrite evidence');
const results=[];
async function probe(label,mode){
 return new Promise(resolve=>{
  const started=performance.now();let finished=false,interval,abortTimer;
  const result={label,mode,network:true,expectedBudgetMs:1000};
  const done=()=>{if(finished)return;finished=true;clearTimeout(watchdog);clearTimeout(abortTimer);clearInterval(interval);result.elapsedMs=performance.now()-started;req.destroy();resolve(result);};
  const req=http.request({hostname:'127.0.0.1',port:3000,path:'/api/auth/sign-in/email',method:'POST',headers:{
   origin:'http://127.0.0.1:3000','content-type':'application/json','content-length':mode==='oversize'?33000:1000,connection:'close'
  }},res=>{
   result.status=res.statusCode;result.cacheControl=res.headers['cache-control'];let body='';
   res.on('data',chunk=>{body+=chunk.toString();if(body.length>8192){result.bodyTooLarge=true;done();}});
   res.on('end',()=>{try{result.reply=JSON.parse(body);}catch{result.invalidJson=true;}done();});
   res.on('error',error=>{result.responseError=error.code??error.name;done();});
  });
  req.on('error',error=>{result.networkError=error.code??error.name;done();});
  req.on('close',()=>{if(mode==='abort'&&!finished){result.clientAbortObserved=true;done();}});
  const watchdog=setTimeout(()=>{result.watchdog=true;done();},8000);
  req.flushHeaders();
  if(mode==='oversize')req.end(Buffer.alloc(33000,32));
  else{
   req.write('{');
   if(mode==='trickle')interval=setInterval(()=>{if(!finished)req.write(' ');},100);
   if(mode==='abort')abortTimer=setTimeout(()=>req.destroy(),200);
  }
 });
}
for(const mode of ['stall','trickle','abort','oversize']){
 const result=await probe('auth-'+mode,mode);results.push(result);console.log(JSON.stringify(result));
}
const health=await fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(8000)});
const problems=[];
for(const result of results){
 if(['stall','trickle'].includes(result.mode)&&(result.status!==408||result.elapsedMs<850||result.elapsedMs>4000))problems.push(result.label+': timeout response/bound not verified');
 if(result.mode==='oversize'&&result.status!==413)problems.push(result.label+': expected413');
 if(result.mode==='abort'&&!result.clientAbortObserved&&!result.networkError)problems.push(result.label+': client close not observed');
 if(result.watchdog)problems.push(result.label+': outer watchdog');
}
if(health.status!==200)problems.push('health after probes is not200');
const evidence={compiledLoopbackOnly:true,deployedProxyTest:false,operatorBudgetMs:1000,productionDefaultMs:20000,results,healthStatus:health.status,problems,
 notes:'Direct-handler default20s evidence is separate. A real client disconnect cannot receive an application reply; subsequent health confirms the strict-rejection server remains running.'};
fs.writeFileSync(out,JSON.stringify(evidence,null,2));
console.log(JSON.stringify({healthStatus:health.status,problems}));
if(problems.length)process.exitCode=1;
