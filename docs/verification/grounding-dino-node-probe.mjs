import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import sharp from 'sharp';
const {AutoProcessor,AutoModelForZeroShotObjectDetection,RawImage,env}=await import(pathToFileURL(path.resolve('.runtime/vision-js/node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
const modelId='onnx-community/grounding-dino-tiny-ONNX',revision='ff690b0a8050566c290287545bd059350f3e9096';
env.cacheDir=path.resolve('.runtime/vision-js/model-cache');env.allowLocalModels=true;env.allowRemoteModels=false;
const localModel=path.join(env.cacheDir,modelId,revision);
const start=Date.now();const record={developmentOnly:true,heldOut:false,accuracyBenchmark:false,model:modelId,revision,libraryVersion:'4.3.1',dtype:'q8',cpuThreads:2,source:'tests/fixtures/candidates/natural-closet.jpg',runs:[]};
try{
console.log("Loading cached processor metadata offline.");const processor=await AutoProcessor.from_pretrained(localModel,{local_files_only:true});
console.log("Processor ready; loading the native inference session offline.");const model=await AutoModelForZeroShotObjectDetection.from_pretrained(localModel,{local_files_only:true,dtype:'q8',device:'cpu',session_options:{intraOpNumThreads:2,interOpNumThreads:1}});
record.loadIncludingDownloadMs=Date.now()-start;env.allowRemoteModels=false;console.log('Pinned Node detector loaded; inference will use local image bytes only.');
const normalized=await sharp(record.source).rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
const {data,info}=await sharp(normalized).removeAlpha().raw().toBuffer({resolveWithObject:true});const image=new RawImage(new Uint8Array(data),info.width,info.height,info.channels);
const query='shirt. dress. jacket. coat. trousers. skirt. shorts. shoes. handbag.';
const prep=Date.now();const inputs=await processor(image,query);record.preprocessMs=Date.now()-prep;record.imageSize=[info.width,info.height];record.modelTensorSize=inputs.pixel_values.dims;record.query=query;
for(let index=0;index<2;index++){
const begin=Date.now();const output=await model(inputs);const inferenceMs=Date.now()-begin;const run={index:index+1,inferenceMs,thresholds:[]};
for(const threshold of [0.25,0.35,0.45]){
const result=processor.post_process_grounded_object_detection(output,inputs.input_ids,{box_threshold:threshold,text_threshold:0.25,target_sizes:[[info.height,info.width]]})[0];
const proposals=result.boxes.map((b,i)=>{const [left,top,right,bottom]=b;const box=[left/info.width,top/info.height,(right-left)/info.width,(bottom-top)/info.height];return{label:result.labels[i],score:result.scores[i],box,structurallyValid:box.every(n=>Number.isFinite(n)&&n>=0&&n<=1)&&box[2]>=0.03&&box[3]>=0.03&&box[0]+box[2]<=1.01&&box[1]+box[3]<=1.01};});
run.thresholds.push({threshold,proposalCount:proposals.length,structurallyValidCount:proposals.filter(p=>p.structurallyValid).length,proposals});}
record.runs.push(run);console.log(JSON.stringify({index:index+1,inferenceMs,counts:run.thresholds.map(({proposals,...counts})=>counts)}));}
await model.dispose();
}catch(error){record.failure={name:error.name,category:'model-load-or-inference-error'};console.error(error.name,String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]').slice(0,250));}
record.totalMs=Date.now()-start;record.notes='No human gold labels or deduplication; counts are proposals, not recall or accuracy. No application implementation change. No external image upload.';fs.writeFileSync('docs/verification/grounding-dino-node-closet-009.json',JSON.stringify(record,null,2));

