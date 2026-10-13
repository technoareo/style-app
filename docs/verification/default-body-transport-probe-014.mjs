import http from 'node:http';
import fs from 'node:fs';
const out=process.argv[2]||'docs/verification/default-body-transport-probe-014.json';if(fs.existsSync(out))throw Error('Preserve existing evidence');
const proxyOnly=process.argv[3]==='proxy-only';
const observationMs=Number(process.argv[4]||5000);if(!Number.isInteger(observationMs)||observationMs<1000||observationMs>15000)throw Error('Invalid observation interval');
function probe(port,mode){return new Promise(resolve=>{
 const started=performance.now(),agent=new http.Agent({keepAlive:true,maxSockets:1}),result={port,mode,requestedConnection:'keep-alive',declaredBytes:1000};let socket,done=false,observation,trickle,watchdog;
 const elapsed=()=>performance.now()-started;
 const finish=()=>{if(done)return;done=true;clearTimeout(watchdog);clearTimeout(observation);clearInterval(trickle);result.socketOpenBeforeClientCleanup=Boolean(socket&&!socket.destroyed);result.clientCleanupAtMs=elapsed();req.destroy();agent.destroy();setTimeout(()=>resolve(result),30);};
 const req=http.request({hostname:'127.0.0.1',port,path:'/api/auth/sign-up/email',method:'POST',agent,headers:{origin:'http://127.0.0.1:3000','content-type':'application/json','content-length':1000,connection:'keep-alive'}},res=>{
  result.status=res.statusCode;result.responseHeaders={connection:res.headers.connection,keepAlive:res.headers['keep-alive'],cacheControl:res.headers['cache-control']};let body='';
  res.on('data',chunk=>{body+=chunk;if(body.length>8192){result.responseTooLarge=true;finish();}});
  res.on('end',()=>{result.responseFinishedAtMs=elapsed();try{result.reply=JSON.parse(body);}catch{result.invalidJson=true;}if(socket?.destroyed)finish();else observation=setTimeout(()=>{result.observationExpired=true;finish();},observationMs);});
  res.on('error',e=>{result.responseError=e.code;finish();});
 });
 req.on('socket',s=>{socket=s;s.on('close',hadError=>{result.socketClosedAtMs=elapsed();result.socketCloseHadError=hadError;result.closedBeforeClientCleanup=result.clientCleanupAtMs===undefined;if(result.responseFinishedAtMs!==undefined)finish();});});
 req.on('error',e=>{result.requestError=e.code;finish();});
 watchdog=setTimeout(()=>{result.watchdog=true;finish();},35000+(observationMs-5000));req.flushHeaders();req.write('{');if(mode==='trickle')trickle=setInterval(()=>{if(!done)req.write(' ');},1000);
 });}
const results=await Promise.all([...(proxyOnly?[]:[probe(3000,'stall'),probe(3000,'trickle')]),probe(3001,'stall'),probe(3001,'trickle')]);
const problems=[];for(const r of results){if(r.status!==408||r.responseFinishedAtMs<19000||r.responseFinishedAtMs>27000||r.watchdog||r.invalidJson)problems.push(`deadline-response:${r.port}:${r.mode}`);if(r.socketOpenBeforeClientCleanup)problems.push(`socket-open-after-${observationMs}ms-observation:${r.port}:${r.mode}`);}
const health=[];for(const port of [3000,3001]){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(4000)});health.push({port,status:r.status});if(r.status!==200)problems.push('health:'+port);}catch{problems.push('health:'+port);}}
fs.writeFileSync(out,JSON.stringify({compiledBuild:'AyhSS6LYgUPv-LCv9p02d',defaultBudgetMs:20000,caddyVersion:'2.11.7',proxyOnly,observationMs,windowsLoopbackHttp1Only:true,noClientDestroyUntilObservationOrWatchdog:true,results,health,problems},null,2),{flag:'wx'});console.log(JSON.stringify({results,health,problems}));if(problems.length)process.exitCode=1;
