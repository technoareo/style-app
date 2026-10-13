import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import sharp from 'sharp';
const base=path.resolve('.runtime/vision-js/node_modules');
const {AutoProcessor,RawImage,Tensor,env}=await import(pathToFileURL(path.join(base,'@huggingface/transformers/dist/transformers.node.mjs')).href);
const ort=await import(pathToFileURL(path.join(base,'onnxruntime-web/dist/ort.wasm.min.mjs')).href);
env.allowLocalModels=true;env.allowRemoteModels=false;
ort.env.wasm.numThreads=1;
const dist=path.join(base,'onnxruntime-web/dist');
ort.env.wasm.wasmPaths={mjs:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.mjs')).href,wasm:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.wasm')).href};
const revision='ff690b0a8050566c290287545bd059350f3e9096';
const local=path.resolve('.runtime/vision-js/model-cache/onnx-community/grounding-dino-tiny-ONNX',revision);
const control=process.env.DETECTOR_CONTROL==='shirt';
const fp32=process.env.DETECTOR_FP32==='1';
const evidenceFile=fp32?`docs/verification/detector-wasm-fp32-${control?'shirt':'closet'}-010.json`:control?'docs/verification/detector-wasm-shirt-control-010.json':'docs/verification/detector-wasm-inference-010.json';
const record={developmentOnly:true,heldOut:false,accuracyBenchmark:false,backend:'wasm',dtype:fp32?'fp32':'q8',threads:1,network:false,revision,source:control?'tests/fixtures/public-shirt.jpg':'tests/fixtures/candidates/natural-closet.jpg',runs:[]};
const start=Date.now();let session;
try {
const processor=await AutoProcessor.from_pretrained(local,{local_files_only:true});
session=await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(path.join(local,fp32?'onnx/model.onnx':'onnx/model_quantized.onnx'))),{executionProviders:['wasm']});
record.loadMs=Date.now()-start;
const normalized=await sharp(record.source).rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
const {data,info}=await sharp(normalized).removeAlpha().raw().toBuffer({resolveWithObject:true});
const image=new RawImage(new Uint8Array(data),info.width,info.height,info.channels);
record.query='shirt. dress. jacket. coat. trousers. skirt. shorts. shoes. handbag.';
const prep=Date.now();const inputs=await processor(image,record.query);record.preprocessMs=Date.now()-prep;record.tensorShape=inputs.pixel_values.dims;record.imageSize=[info.width,info.height];
const feeds=Object.fromEntries(session.inputNames.map(name=>{const t=inputs[name];if(!t)throw new Error('Missing processor input '+name);return[name,new ort.Tensor(t.type,t.data,t.dims)];}));
for(let index=0;index<(control||fp32?1:2);index++){
console.log('Starting offline inference '+(index+1));const begin=Date.now();const raw=await session.run(feeds);const output=Object.fromEntries(Object.entries(raw).map(([name,t])=>[name,new Tensor(t.type,t.data,t.dims)]));
const run={index:index+1,inferenceMs:Date.now()-begin,thresholds:[]};
run.outputs=Object.fromEntries(Object.entries(raw).map(([name,t])=>{let min=Infinity,max=-Infinity,nonFinite=0;for(const v of t.data){if(Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);}else nonFinite++;}return[name,{type:t.type,dims:t.dims,min,max,nonFinite}];}));
record.runs.push(run);
fs.writeFileSync(evidenceFile,JSON.stringify(record,null,2));
fs.writeFileSync(evidenceFile.replace('.json','-raw.json'),JSON.stringify({inputIds:inputs.input_ids.tolist().map(row=>row.map(Number)),outputs:Object.fromEntries(Object.entries(raw).map(([name,t])=>[name,{type:t.type,dims:t.dims,data:Array.from(t.data)}]))}));
for(const threshold of [0.25,0.35,0.45,0.05,0.10,0.15]){
try {
const result=processor.post_process_grounded_object_detection(output,inputs.input_ids,{box_threshold:threshold,text_threshold:0.25,target_sizes:[[info.height,info.width]]})[0];
const proposals=result.boxes.map((b,i)=>{const [x1,y1,x2,y2]=b;const box=[x1/info.width,y1/info.height,(x2-x1)/info.width,(y2-y1)/info.height];return{label:result.labels[i],score:result.scores[i],box,structurallyValid:box.every(n=>Number.isFinite(n)&&n>=0&&n<=1)&&box[2]>=.03&&box[3]>=.03&&box[0]+box[2]<=1.01&&box[1]+box[3]<=1.01};});
run.thresholds.push({threshold,count:proposals.length,structurallyValid:proposals.filter(p=>p.structurallyValid).length,proposals});
} catch(error) {run.thresholds.push({threshold,error:String(error.message).slice(0,150)});}
}
fs.writeFileSync(evidenceFile,JSON.stringify(record,null,2));console.log(JSON.stringify({index:run.index,inferenceMs:run.inferenceMs,outputs:run.outputs,counts:run.thresholds.map(t=>({threshold:t.threshold,count:t.count,error:t.error}))}));}
}catch(error){record.failure={name:error.name,message:String(error.message).slice(0,600)};console.error(record.failure);}
finally{if(session)await session.release();record.totalMs=Date.now()-start;record.notes='Public development fixture only. Counts are raw proposals, not validated garment counts, recall or accuracy. No application changes.';fs.writeFileSync(evidenceFile,JSON.stringify(record,null,2));}
