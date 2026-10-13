// Research-only SDK/runtime adapter. Original installed packages are unchanged.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
const out='docs/verification/vision-sdk-wasm-probe-011.json';
if(fs.existsSync(out))throw new Error('Refusing to overwrite probe evidence');
const base=path.resolve('.runtime/vision-js/node_modules');
const local=path.resolve('.runtime/vision-js/model-cache/onnx-community/grounding-dino-tiny-ONNX/ff690b0a8050566c290287545bd059350f3e9096');
const dist=path.join(base,'onnxruntime-web/dist');
const ort=await import(pathToFileURL(path.join(dist,'ort.wasm.min.mjs')).href);
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={mjs:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.mjs')).href,wasm:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.wasm')).href};
const record={researchOnly:true,applicationChange:false,network:false,modelDirectory:'Pinned previously verified public Grounding DINO fp32 cache',complete:false,sessionsCreated:0};
// The installed SDK exposes this custom-runtime hook in src/backends/onnx.js.
// `auto` plus explicit providers avoids its empty custom-runtime device list.
globalThis[Symbol.for('onnxruntime')]={...ort,InferenceSession:{create:async(buffer,options)=>{
 if(typeof buffer==='string'){
  const resolved=fs.realpathSync(buffer);
  if(!resolved.toLowerCase().startsWith((fs.realpathSync(local)+path.sep).toLowerCase()))throw new Error('Model load escaped the known public cache');
  buffer=new Uint8Array(fs.readFileSync(resolved));
 }
 const session=await ort.InferenceSession.create(buffer,{...options,executionProviders:['wasm']});
 record.sessionsCreated++;
 return session;
}}};
let model;const start=performance.now();
try{
 const {AutoModelForZeroShotObjectDetection,AutoProcessor,RawImage,env}=await import(pathToFileURL(path.join(base,'@huggingface/transformers/dist/transformers.node.mjs')).href);
 env.allowLocalModels=true;env.allowRemoteModels=false;env.useWasmCache=false;
 model=await AutoModelForZeroShotObjectDetection.from_pretrained(local,{local_files_only:true,dtype:'fp32',device:'auto',session_options:{executionProviders:['wasm']}});
 const processor=await AutoProcessor.from_pretrained(local,{local_files_only:true});
 record.loadMs=performance.now()-start;
 const {data,info}=await sharp('tests/fixtures/public-shirt.jpg').rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const inputs=await processor(new RawImage(new Uint8Array(data),info.width,info.height,info.channels),'shirt. dress. jacket. coat. trousers. skirt. shorts. shoes. handbag.');
 const inferAt=performance.now();const outputs=await model(inputs);record.inferenceMs=performance.now()-inferAt;
 const result=processor.post_process_grounded_object_detection(outputs,inputs.input_ids,{box_threshold:0.25,text_threshold:0.25,target_sizes:[[info.height,info.width]]})[0];
 record.proposals=result.boxes.map((box,i)=>({label:result.labels[i],score:result.scores[i],corners:box}));
 record.complete=true;
}catch(error){record.failure={name:error.name,message:String(error.message).slice(0,600)};process.exitCode=1;}
finally{if(model)await model.dispose();record.totalMs=performance.now()-start;fs.writeFileSync(out,JSON.stringify(record,null,2));console.log(JSON.stringify(record));}
