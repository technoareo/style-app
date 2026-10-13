import fs from 'node:fs';
import sharp from 'sharp';
const started=Date.now();
const categories=['Top','Bottom','Dress','Layer','Shoes','Accessory','Unknown'];
const schema={type:'object',properties:{items:{type:'array',maxItems:30,items:{type:'array',minItems:6,maxItems:6,prefixItems:[{type:'string',enum:categories},{type:'string',maxLength:20},{type:'number',minimum:0,maximum:1},{type:'number',minimum:0,maximum:1},{type:'number',minimum:0,maximum:1},{type:'number',minimum:0,maximum:1}]}}},required:['items'],additionalProperties:false};
const bytes=await sharp('tests/fixtures/candidates/natural-closet.jpg').rotate().resize(768,768,{fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();
const evidence={experiment:'compact-locate-only-008',fixture:'natural-closet.jpg',developmentOnly:true,heldOut:false,recognitionBenchmark:false,imageMaxSide:768,predictionBudget:1200,context:4096,timeoutMs:240000,items:[],valid:false};
try{
const r=await fetch('http://127.0.0.1:11434/api/chat',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(240000),body:JSON.stringify({model:'qwen3-vl:4b-instruct',stream:false,think:false,format:schema,options:{temperature:0,num_ctx:4096,num_predict:1200},keep_alive:'30m',messages:[{role:'user',images:[bytes.toString('base64')],content:'Locate every distinct visible clothing item in this closet photo, up to30. Exclude hangers, rail, furniture, printed drawings and background. Return JSON items arrays [category, visible main color, x, y, width, height]. Bounding rectangles normalized0to1 against entire photo. No names, brand, fabric, explanation or other attributes. Use Unknown when category not visible. Do not combine separate garments. Be concise; return complete JSON.'}]})});
if(!r.ok)throw new Error('model-http-'+r.status);
const body=await r.json();
evidence.modelStats=Object.fromEntries(['done_reason','total_duration','load_duration','prompt_eval_count','prompt_eval_duration','eval_count','eval_duration'].filter(k=>body[k]!==undefined).map(k=>[k,body[k]]));
const parsed=JSON.parse(body.message?.content??'');
evidence.valid=Array.isArray(parsed.items)&&parsed.items.length<=30&&parsed.items.every(a=>Array.isArray(a)&&a.length===6&&categories.includes(a[0])&&typeof a[1]==='string'&&a[1].length<=20&&a.slice(2).every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1)&&a[4]>0&&a[5]>0&&a[2]+a[4]<=1.01&&a[3]+a[5]<=1.01);
if(evidence.valid)evidence.items=parsed.items;
}catch(e){evidence.failure=e?.name==='TimeoutError'?'timeout':e?.message==='model-http-500'?'model-http-500':'invalid-or-unavailable';}
evidence.durationMs=Date.now()-started;
fs.writeFileSync('docs/verification/compact-closet-experiment-008.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({valid:evidence.valid,itemCount:evidence.items.length,durationMs:evidence.durationMs,failure:evidence.failure,modelStats:evidence.modelStats}));
