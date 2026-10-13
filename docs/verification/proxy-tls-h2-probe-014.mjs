import http2 from 'node:http2';import fs from 'node:fs';import crypto from 'node:crypto';
const out=process.argv[2]||'docs/verification/proxy-tls-h2-probe-014.json';if(fs.existsSync(out))throw Error('Preserve evidence');
// Read only the task-generated PUBLIC CA certificate. Private keys are not inspected.
const ca=fs.readFileSync('.runtime/caddy-probe-014/storage/pki/authorities/local/root.crt');
const start=performance.now(),elapsed=()=>performance.now()-start,record={candidateOnly:true,windowsLoopbackTls:true,systemTrustInstallationDisabled:true,tlsVerificationDisabled:false,publicCaSha256:crypto.createHash('sha256').update(ca).digest('hex'),goaway:[],sessionErrors:[],requests:[],problems:[]};
const client=http2.connect('https://localhost:3000',{ca,rejectUnauthorized:true,lookup:(_host,opts,cb)=>opts?.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)});
client.on('goaway',(code,lastStreamID)=>record.goaway.push({code,lastStreamID,atMs:elapsed()}));client.on('error',e=>record.sessionErrors.push(e.code||e.name));client.on('close',()=>record.sessionClosedAtMs=elapsed());
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function request(label,path,stall=false){return new Promise(resolve=>{
 const at=elapsed(),row={label,path,startedAtMs:at};let req,timer,done=false;
 const finish=()=>{if(done)return;done=true;clearTimeout(timer);row.finishedAtMs=elapsed();record.requests.push(row);resolve(row);};
 try{req=client.request({':method':stall?'POST':'GET',':path':path,...(stall?{'content-type':'application/json','content-length':'1000',origin:'https://localhost:3000'}:{})},{endStream:!stall});}
 catch(e){row.error=e.code||e.name;finish();return;}
 req.on('response',h=>{row.status=h[':status'];row.connectionHeader=h.connection??null;});let body='';req.on('data',c=>body+=c);
 req.on('end',()=>{row.responseMs=elapsed()-at;try{row.reply=JSON.parse(body);}catch{row.invalidJson=true;}finish();});
 req.on('error',e=>{row.error=e.code||e.name;finish();});req.on('close',()=>{row.streamClosedAtMs=elapsed();row.rstCode=req.rstCode;});
 timer=setTimeout(()=>{row.watchdog=true;req.close(http2.constants.NGHTTP2_CANCEL);finish();},stall?35000:4000);
 if(stall)req.write('{');
 });}
try{
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('TLS connection timeout')),5000);client.once('connect',()=>{clearTimeout(t);resolve();});client.once('error',e=>{clearTimeout(t);reject(e);});});
 record.authorized=client.socket.authorized;record.alpn=client.socket.alpnProtocol;if(!record.authorized||record.alpn!=='h2')record.problems.push('TLS/H2 not verified');
 const initial=await request('initial-health','/api/health');if(initial.status!==200)record.problems.push('Initial health');
 const stalled=request('stalled-auth-default-deadline','/api/auth/sign-up/email',true);
 for(let i=0;i<3;i++){await sleep(4500);const r=await request('health-during-stall-'+i,'/api/health');if(r.status!==200)record.problems.push('Healthy multiplexed request failed');}
 const response=await stalled;if(response.status!==408||response.responseMs<19000||response.responseMs>27000||response.invalidJson||response.watchdog)record.problems.push('Default deadline response failed');
 await sleep(1000);const after=await request('health-after-error-same-session','/api/health');if(after.status!==200)record.problems.push('HTTP2 session cannot be reused after error');
 record.sessionDestroyedBeforeClientCleanup=client.destroyed;record.clientCleanupAtMs=elapsed();
}catch(e){record.failure={name:e.name,code:e.code,message:String(e.message).slice(0,250)};record.problems.push('Probe setup/runtime failure');}
finally{client.destroy();await sleep(30);record.elapsedMs=elapsed();fs.writeFileSync(out,JSON.stringify(record,null,2),{flag:'wx'});console.log(JSON.stringify(record));if(record.problems.length)process.exitCode=1;}
