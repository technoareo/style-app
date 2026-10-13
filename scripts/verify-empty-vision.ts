import sharp from 'sharp';
import {writeFile} from 'node:fs/promises';
async function main(){
const photo=await sharp({create:{width:512,height:512,channels:3,background:'#e5e8e0'}}).jpeg().toBuffer();
const started=Date.now();
const r=await fetch('http://127.0.0.1:3000/api/analyze',{method:'POST',headers:{origin:'http://127.0.0.1:3000','content-type':'application/json'},body:JSON.stringify({consent:true,image:`data:image/jpeg;base64,${photo.toString('base64')}`}),signal:AbortSignal.timeout(250000)});
const data=await r.json();await writeFile('docs/verification/no-clothing.json',JSON.stringify({...data,image:undefined,status:r.status,seconds:(Date.now()-started)/1000},null,2));
if(!r.ok || data.items.length)throw new Error('No-clothing image was not safely handled');console.log('No-clothing live vision passed.');
}main().catch(e=>{console.error(e);process.exitCode=1});
