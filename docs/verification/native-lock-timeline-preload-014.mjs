// Root-owned diagnostic preload; not application implementation. No SQL text,
// database paths, account data, credentials or bodies are recorded.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const dir=process.env.STYLE_DIAGNOSTIC_TIMELINE_DIR;
if(!dir||!path.isAbsolute(dir)||!fs.existsSync(dir))throw Error('Explicit existing diagnostic directory required');
const native=DatabaseSync.prototype.exec,events=[],ids=new WeakMap();let next=0,truncated=false;
const startedEpoch=performance.timeOrigin+performance.now();
const childIndex=process.argv.findIndex(x=>x.endsWith('concurrency-child.ts'));
const role=childIndex>=0?process.argv[childIndex+1]:'test-parent-or-runner';
DatabaseSync.prototype.exec=function(sql){
 const match=typeof sql==='string'?/^\s*(BEGIN\s+IMMEDIATE|COMMIT|ROLLBACK)\s*;?\s*$/i.exec(sql):null;
 if(!match)return Reflect.apply(native,this,[sql]);
 if(!ids.has(this))ids.set(this,++next);
 const entry={connection:ids.get(this),kind:match[1].toUpperCase().replace(/\s+/g,' '),startEpochMs:performance.timeOrigin+performance.now(),activeBefore:this.isTransaction};
 let ok=false;
 try{const r=Reflect.apply(native,this,[sql]);ok=true;return r;}finally{
  entry.endEpochMs=performance.timeOrigin+performance.now();entry.ok=ok;entry.activeAfter=this.isTransaction;
  if(events.length<50000)events.push(entry);else truncated=true;
 }
};
process.on('exit',()=>{
 const out=path.join(dir,`native-${process.pid}.json`);
 fs.writeFileSync(out,JSON.stringify({diagnosticOnly:true,syntheticTestWorkload:true,pid:process.pid,role,startedEpochMs:startedEpoch,endedEpochMs:performance.timeOrigin+performance.now(),epochSource:'performance.timeOrigin + monotonic now; same-host alignment, not exact native unlock timestamps',truncated,events}),{flag:'wx'});
});
