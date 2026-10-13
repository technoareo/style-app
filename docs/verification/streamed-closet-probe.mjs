import fs from 'node:fs';
import sharp from 'sharp';
import {analysisSchema,VISION_PROMPT,visionOutputSchema} from '../../src/domain/analysis.ts';
const model=process.argv[2]||'qwen3-vl:2b-instruct';
const maxSide=Number(process.argv[3]||768);
const started=Date.now();
const image=await sharp('tests/fixtures/candidates/natural-closet.jpg').rotate().resize(maxSide,maxSide,{fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();
const record={experiment:'streamed-full-schema-009',model,maxSide,developmentOnly:true,heldOut:false,qualityBenchmark:false,timeoutMs:240000,firstContentMs:null,firstThinkingMs:null,completed:false,validated:false,itemCount:0};
let content='',frames=0;
try{
const response=await fetch('http://127.0.0.1:11434/api/chat',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(240000),body:JSON.stringify({model,stream:true,think:false,format:visionOutputSchema,keep_alive:'10m',options:{temperature:0,num_ctx:4096,num_predict:2048},messages:[{role:'user',images:[image.toString('base64')],content:VISION_PROMPT+' Keep evidence and warning concise. Do not detect drawings or prints on clothing as separate items.'}]})});
if(!response.ok)throw new Error('http-'+response.status);
const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
function frame(line){if(!line.trim())return;const obj=JSON.parse(line);frames++;if(obj.error)throw new Error('model-error');const text=obj.message?.content??'';if(text&&record.firstContentMs===null){record.firstContentMs=Date.now()-started;console.log('First content received: '+record.firstContentMs+'ms');}if(obj.message?.thinking&&record.firstThinkingMs===null)record.firstThinkingMs=Date.now()-started;content+=text;if(content.length>100000)throw new Error('oversize-output');if(obj.done){record.completed=true;record.modelStats=Object.fromEntries(['done_reason','total_duration','load_duration','prompt_eval_count','prompt_eval_duration','eval_count','eval_duration'].filter(k=>obj[k]!==undefined).map(k=>[k,obj[k]]));}}
for(;;){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);frame(line);}}
if(buffer.trim())frame(buffer);
if(record.completed){const parsed=analysisSchema.safeParse(JSON.parse(content));record.validated=parsed.success;if(parsed.success){record.itemCount=parsed.data.items.length;record.analysis=parsed.data;}}
}catch(error){record.failure=error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout-or-aborted':error?.message?.startsWith('http-')?error.message:'invalid-or-unavailable';}
record.durationMs=Date.now()-started;record.frames=frames;record.outputCharacters=content.length;
const name=model.replace(/[^A-Za-z0-9.-]/g,'-');fs.writeFileSync('docs/verification/streamed-closet-'+name+'-'+maxSide+'-009.json',JSON.stringify(record,null,2));console.log(JSON.stringify({...record,analysis:undefined}));
