import fs from 'node:fs';
const outputPath=process.argv[2] || 'docs/verification/account-bound-probe-013.json';
if(fs.existsSync(outputPath)) throw new Error('Refusing to overwrite existing evidence: '+outputPath);
process.env.STYLE_IMAGE_CONCURRENCY='1';process.env.STYLE_IMAGE_QUEUE='2';process.env.STYLE_IMAGE_WAIT_MS='100';
const {withAccountImageWork,accountImageWorkActive}=await import('../../src/server/admission.ts');
let release;const held=new Promise(resolve=>{release=resolve;});
const jobs=[];let peak=0;
for(let i=0;i<100;i++){
 jobs.push(withAccountImageWork('synthetic-'+i,'photos',()=>i===0?held:Promise.resolve()).catch(()=>undefined));
 peak=Math.max(peak,accountImageWorkActive());
}
release();await Promise.all(jobs);
const result={syntheticOnly:true,requests:100,configuredGlobalCapacity:3,peakAccountHolders:peak,afterDrain:accountImageWorkActive(),boundExceeded:peak>3};
fs.writeFileSync(outputPath,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
