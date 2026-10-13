import fs from 'node:fs';
import path from 'node:path';
const dir='docs/verification/native-timeline-014',out='docs/verification/native-timeline-summary-014.json';
if(fs.existsSync(out))throw Error('Existing evidence must be preserved');
const records=fs.readdirSync(dir).filter(x=>/^native-\d+\.json$/.test(x)).map(x=>JSON.parse(fs.readFileSync(path.join(dir,x),'utf8')));
const holds=[],processes=[];
for(const r of records){const active=new Map();let success=0,failed=0,maxNativeMs=0,unfinished=0;
 for(const e of r.events){maxNativeMs=Math.max(maxNativeMs,e.endEpochMs-e.startEpochMs);
  if(e.kind==='BEGIN IMMEDIATE'){if(!e.ok){failed++;continue;}success++;if(e.activeBefore===false&&e.activeAfter===true)active.set(e.connection,e);}
  else if(e.ok&&e.activeBefore===true&&e.activeAfter===false){const b=active.get(e.connection);if(b){holds.push({pid:r.pid,role:r.role,connection:e.connection,exit:e.kind,lower:[b.endEpochMs,e.startEpochMs],upper:[b.startEpochMs,e.endEpochMs],lowerMs:e.startEpochMs-b.endEpochMs,upperMs:e.endEpochMs-b.startEpochMs});active.delete(e.connection);}}
 }unfinished=active.size;processes.push({pid:r.pid,role:r.role,events:r.events.length,truncated:r.truncated,successfulBegins:success,failedBegins:failed,maxNativeMs,unpairedHolds:unfinished});}
const lowerOverlap=[],upperOverlap=[];
for(let i=0;i<holds.length;i++)for(let j=i+1;j<holds.length;j++){const a=holds[i],b=holds[j];if(a.pid===b.pid&&a.connection===b.connection)continue;const lower=Math.min(a.lower[1],b.lower[1])-Math.max(a.lower[0],b.lower[0]),upper=Math.min(a.upper[1],b.upper[1])-Math.max(a.upper[0],b.upper[0]);if(lower>2)lowerOverlap.push({a:i,b:j,ms:lower});if(upper>2)upperOverlap.push({a:i,b:j,ms:upper});}
const byRole={};for(const h of holds){const r=byRole[h.role]??={count:0,lowerSumMs:0,upperSumMs:0,maxLowerMs:0,maxUpperMs:0};r.count++;r.lowerSumMs+=h.lowerMs;r.upperSumMs+=h.upperMs;r.maxLowerMs=Math.max(r.maxLowerMs,h.lowerMs);r.maxUpperMs=Math.max(r.maxUpperMs,h.upperMs);}
const report={diagnosticOnly:true,processes,pairedHolds:holds.length,byRole,lowerOverlapBeyond2ms:lowerOverlap,upperOverlapBeyond2msCount:upperOverlap.length,largestLowerHolds:[...holds].sort((a,b)=>b.lowerMs-a.lowerMs).slice(0,12),limits:['Native-call instrumentation adds overhead; this is not the unchanged full-suite release result.','Lower interval is successful BEGIN return until COMMIT/ROLLBACK invocation, with native active-transaction flags. Upper brackets include lock acquisition wait and post-unlock work; their overlaps are not ownership violations.','Same-host epoch alignment and floating timings have uncertainty; all connections are assumed to be the unchanged scenario shared database. No SQL text or database paths were captured.','No exact native unlock instant, auth mutex timing, live CPU utilization or scheduling fairness is established.']};fs.writeFileSync(out,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({...report,largestLowerHolds:undefined}));
