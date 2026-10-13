import http from 'node:http';
import fs from 'node:fs';
const out='docs/verification/early-refusal-transport-014-corrected.json';
if(fs.existsSync(out))throw Error('Preserve existing evidence');
function probe(url,declaredBytes,expectedStatus,sentBytes){return new Promise(resolve=>{
 const start=performance.now(),agent=new http.Agent({keepAlive:true});let socket,done=false,watchdog,observation;
 const r={url,declaredBytes,sentBytes,expectedStatus};
 const finish=()=>{if(done)return;done=true;clearTimeout(watchdog);clearTimeout(observation);r.socketOpenBeforeCleanup=Boolean(socket&&!socket.destroyed);r.clientCleanupMs=performance.now()-start;req.destroy();agent.destroy();setTimeout(()=>resolve(r),20);};
 const req=http.request({hostname:'127.0.0.1',port:3001,path:url,method:'POST',agent,headers:{origin:'http://127.0.0.1:3000','content-type':'application/json','content-length':declaredBytes,connection:'keep-alive'}},res=>{
  r.status=res.statusCode;r.connection=res.headers.connection;let body='';res.on('data',c=>body+=c);
  res.on('end',()=>{r.responseMs=performance.now()-start;try{r.reply=JSON.parse(body);}catch{r.invalidJson=true;}if(socket?.destroyed)finish();else observation=setTimeout(finish,1000);});
 });
 req.on('socket',s=>{socket=s;s.on('close',()=>{r.closedBeforeCleanup=r.clientCleanupMs===undefined;r.closedMs=performance.now()-start;if(r.responseMs!==undefined)finish();});});
 req.on('error',e=>{r.error=e.code;finish();});
 watchdog=setTimeout(()=>{if(done)return;r.watchdog=true;finish();},5000);
 req.flushHeaders();req.write(Buffer.concat([Buffer.from('{'),Buffer.alloc(sentBytes-1,32)]));
 });}
const results=await Promise.all([probe('/api/auth/sign-up/email',100000,413,32769),probe('/api/photos',1000,401,1)]);
const problems=[];for(const r of results)if(r.status!==r.expectedStatus||r.responseMs>2000||r.socketOpenBeforeCleanup||r.closedBeforeCleanup!==true||r.invalidJson||r.watchdog)problems.push(r.url);
const health=await fetch('http://127.0.0.1:3001/api/health',{signal:AbortSignal.timeout(4000)});if(health.status!==200)problems.push('health');
fs.writeFileSync(out,JSON.stringify({diagnosticProxyOnly:true,caddyVersion:'2.11.7',windowsLoopbackHttp1Only:true,clientRequestNeverEndedBeforeResponse:true,results,health:health.status,problems},null,2),{flag:'wx'});
console.log(JSON.stringify({results,health:health.status,problems}));if(problems.length)process.exitCode=1;
