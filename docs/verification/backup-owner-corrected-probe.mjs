import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createBackup} from '../../src/server/backupDatabase.ts';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
if(process.argv[2]==='child'){
 const dir=process.argv[3];const db=new DatabaseSync(path.join(dir,'app.db'));
 try{await createBackup(db,{dataDir:dir,onStage:stage=>{if(stage==='raw-copied'){process.send?.({stage});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80000);}}});db.close();process.exit(0);}catch{db.close();process.exit(1);}
}else{
 const dir=path.join(process.cwd(),'.data','tests','lease-probe-'+randomUUID());fs.mkdirSync(dir,{recursive:true});
 const db=new DatabaseSync(path.join(dir,'app.db'));
 db.exec('CREATE TABLE analysis_jobs(marker TEXT);CREATE TABLE mail_outbox(marker TEXT);CREATE TABLE verification(marker TEXT);CREATE TABLE session(marker TEXT);CREATE TABLE kept(marker TEXT);INSERT INTO analysis_jobs VALUES(\'SYNTHETIC-LEASE-PROBE\');INSERT INTO kept VALUES(\'KEEP\');');
 const child=fork(process.argv[1],['child',dir],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
 let exitCode=null;const exited=new Promise(r=>child.once('exit',code=>{exitCode=code;r(code);}));
 await Promise.race([new Promise(r=>child.once('message',r)),pause(15000).then(()=>{throw new Error('stage-not-observed');})]);
 const backups=path.join(dir,'backups');const partial=fs.readdirSync(backups).find(n=>n.endsWith('.partial'));
 console.log('Observed raw-copy stage; owner remains alive while its event loop is deliberately blocked.');
 await pause(65000);
 const evidence={experiment:'live-owner-process-backup-lock-009-corrected',syntheticOnly:true,blockedOwnerMs:80000,secondStartedAfterMs:65000,ownerStillLiveBeforeSecond:child.exitCode===null,partialPresentBeforeSecond:fs.existsSync(path.join(backups,partial)),secondBackupSucceeded:false};
 try{const second=await createBackup(db,{dataDir:dir,lockWaitMs:0});evidence.secondBackupSucceeded=true;evidence.secondFile=second.file;}catch{evidence.secondBackupSucceeded=false;}
 evidence.activePartialRemoved= !fs.existsSync(path.join(backups,partial));
 evidence.firstOwnerExitCode=await exited;db.close();
 fs.writeFileSync('docs/verification/live-owner-backup-lock-009-corrected.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}

