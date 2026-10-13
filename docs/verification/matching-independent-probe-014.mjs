import fs from 'node:fs';
import {maximumMatching} from '../../scripts/vision-evaluation/matching.ts';
import {iou} from '../../scripts/vision-evaluation/geometry.ts';
const out='docs/verification/matching-independent-probe-014.json';if(fs.existsSync(out))throw Error('Existing evidence');
let seed=14014;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const box=()=>{const x=rnd()*.6,y=rnd()*.6;return [x,y,x+.15+rnd()*.24,y+.15+rnd()*.24];};
let total=0;const failures=[];
for(let k=0;k<1200;k++){
 const g=Array.from({length:1+k%4},box),p=Array.from({length:1+(k*3)%4},box),threshold=[.1,.25,.5,.75][k%4];
 let bestCount=-1,bestSum=-1;
 function exhaustive(row,used,count,sum){if(row===g.length){if(count>bestCount||(count===bestCount&&sum>bestSum)){bestCount=count;bestSum=sum;}return;}exhaustive(row+1,used,count,sum);for(let j=0;j<p.length;j++){if(used.has(j))continue;const overlap=iou(g[row],p[j]);if(overlap<threshold)continue;used.add(j);exhaustive(row+1,used,count+1,sum+overlap);used.delete(j);}}
 exhaustive(0,new Set(),0,0);const matched=maximumMatching(g,p,threshold),sum=matched.reduce((s,m)=>s+m.iou,0);total++;
 if(matched.length!==bestCount||Math.abs(sum-bestSum)>1e-10||new Set(matched.map(x=>x.gold)).size!==matched.length||new Set(matched.map(x=>x.pred)).size!==matched.length)failures.push({case:k,bestCount,bestSum,actualCount:matched.length,actualSum:sum});
}
fs.writeFileSync(out,JSON.stringify({syntheticOnly:true,seed:14014,cases:total,oracle:'independent exhaustive enumeration of all admissible assignments',thresholds:[.1,.25,.5,.75],failures},null,2),{flag:'wx'});console.log(JSON.stringify({cases:total,failures}));if(failures.length)process.exitCode=1;
