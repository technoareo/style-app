import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const out='docs/verification/owned-body-http-probe-012.json';
if(fs.existsSync(out))throw new Error('Refusing to overwrite evidence');
for(const key of Object.keys(process.env))if(key.startsWith('STYLE_'))delete process.env[key];
for(const key of ['SMTP_URL','MAIL_FROM','AUTH_SECRET','NODE_OPTIONS','NODE_PATH'])delete process.env[key];
process.env.STYLE_DATA_DIR=path.resolve('.data/release-012-browser');
process.env.STYLE_PUBLIC_DEPLOYMENT='false';process.env.STYLE_BODY_READ_TIMEOUT_MS='1000';process.env.APP_URL='http://127.0.0.1:3000';
const {getReadyAuth}=await import('../../src/server/auth.ts');
const {getDatabase,closeDatabases}=await import('../../src/server/database.ts');
const {runWriteTransaction}=await import('../../src/server/writeTransaction.ts');
const results=[],problems=[];
try{
 const auth=await getReadyAuth(),email=`network-${randomUUID()}@example.test`,password='Disposable network passphrase 42!';
 const created=await auth.api.signUpEmail({body:{name:'Network probe wearer',email,password}});
 // Fixture-only verification of this new synthetic identity; browser tests separately cover email verification.
 await runWriteTransaction(db=>db.prepare('UPDATE user SET emailVerified=1 WHERE id=? AND email=?').run(created.user.id,email));
 const signed=await auth.api.signInEmail({body:{email,password},asResponse:true});
 const cookie=signed.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 const headers={origin:process.env.APP_URL,'content-type':'application/json',cookie,'x-style-account':created.user.id,'content-length':1000,connection:'close'};
 async function slow(label,url,method,mode){return new Promise(resolve=>{
  const start=performance.now();let done=false,trickle,abort;const result={label,mode};
  const finish=()=>{if(done)return;done=true;clearTimeout(outer);clearTimeout(abort);clearInterval(trickle);result.elapsedMs=performance.now()-start;req.destroy();resolve(result);};
  const req=http.request({hostname:'127.0.0.1',port:3000,path:url,method,headers},res=>{
   result.status=res.statusCode;result.cacheControl=res.headers['cache-control'];let text='';
   res.on('data',chunk=>{text+=chunk;if(text.length>8192){result.responseTooLarge=true;finish();}});
   res.on('end',()=>{try{result.reply=JSON.parse(text);}catch{result.invalidJson=true;}finish();});
   res.on('error',error=>{result.networkError=error.code;finish();});
  });
  req.on('error',error=>{result.networkError=error.code;finish();});
  const outer=setTimeout(()=>{result.watchdog=true;finish();},8000);
  req.flushHeaders();req.write('{');
  if(mode==='trickle')trickle=setInterval(()=>{if(!done)req.write(' ');},100);
  if(mode==='abort')abort=setTimeout(()=>req.destroy(),200);
 });}
 for(const [label,url,method,mode] of [['wardrobe-stall','/api/wardrobe','PUT','stall'],['wardrobe-trickle','/api/wardrobe','PUT','trickle'],['photo-stall','/api/photos','POST','stall'],['photo-abort','/api/photos','POST','abort']]){
  const result=await slow(label,url,method,mode);results.push(result);console.log(JSON.stringify(result));
  if(mode!=='abort'&&(result.status!==408||result.elapsedMs<850||result.elapsedMs>4000))problems.push(label+': expected bounded408');
  if(mode==='abort'&&!result.networkError)problems.push(label+': expected client disconnect');
  if(result.watchdog||result.invalidJson||result.responseTooLarge)problems.push(label+': invalid response/watchdog');
 }
 const response=await fetch(process.env.APP_URL+'/api/wardrobe',{headers:{cookie},signal:AbortSignal.timeout(8000)});
 const wardrobe=await response.json();
 const assets=getDatabase().prepare('SELECT COUNT(*) AS n FROM photo_assets WHERE user_id=?').get(created.user.id).n;
 if(response.status!==200||wardrobe.revision!==0||wardrobe.wardrobe.length||assets)problems.push('Synthetic account wardrobe/photo state changed');
 const health=await fetch(process.env.APP_URL+'/api/health',{signal:AbortSignal.timeout(8000)});
 if(health.status!==200)problems.push('Server did not remain healthy');
 fs.writeFileSync(out,JSON.stringify({compiledLoopback:true,operatorBudgetMs:1000,productionDefaultMs:20000,fixtureVerificationBypass:true,results,wardrobeStatus:response.status,revision:wardrobe.revision,photoAssets:assets,healthStatus:health.status,problems},null,2));
 console.log(JSON.stringify({problems,revision:wardrobe.revision,photoAssets:assets,healthStatus:health.status}));
 if(problems.length)process.exitCode=1;
}finally{closeDatabases();}
