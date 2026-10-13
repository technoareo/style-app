// Offline public-fixture diagnostic; no application dependency or implementation change.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
const out='docs/verification/detector-letterbox-fp32-011.json';
if(fs.existsSync(out))throw new Error('Refusing to overwrite experiment evidence');
const base=path.resolve('.runtime/vision-js/node_modules');
const {AutoProcessor,RawImage,Tensor,env}=await import(pathToFileURL(path.join(base,'@huggingface/transformers/dist/transformers.node.mjs')).href);
const ort=await import(pathToFileURL(path.join(base,'onnxruntime-web/dist/ort.wasm.min.mjs')).href);
env.allowLocalModels=true;env.allowRemoteModels=false;ort.env.wasm.numThreads=1;
const dist=path.join(base,'onnxruntime-web/dist');
ort.env.wasm.wasmPaths={mjs:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.mjs')).href,wasm:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.wasm')).href};
const revision='ff690b0a8050566c290287545bd059350f3e9096';
const local=path.resolve('.runtime/vision-js/model-cache/onnx-community/grounding-dino-tiny-ONNX',revision);
const record={developmentOnly:true,heldOut:false,accuracyBenchmark:false,complete:false,network:false,backend:'wasm',dtype:'fp32',threads:1,revision,
 source:'tests/fixtures/candidates/natural-closet.jpg',query:'shirt. dress. jacket. coat. trousers. skirt. shorts. shoes. handbag.',boxThreshold:0.25,textThreshold:0.25,
 preprocessing:'Preserve 1600x1200 proportions at 800x600, pad bottom to 800x800, mark padding with pixel_mask=0 and normalized pixel_values=0. Does not change the model static spatial shape.',
 notes:'Experimental preprocessing, not accuracy proof. Same development fixture; returned regions require visual review. No returned invalid box is repaired.'};
const start=performance.now();let session;
try{
 const processor=await AutoProcessor.from_pretrained(local,{local_files_only:true});
 const bytes=fs.readFileSync(path.join(local,'onnx/model.onnx'));
 record.modelSha256=createHash('sha256').update(bytes).digest('hex');
 if(record.modelSha256!=='267c8b00d269dc2dda0d8592812d3027abd5fb59f1cabf8e3d56f8fdf07f68ec')throw new Error('Pinned model hash mismatch');
 session=await ort.InferenceSession.create(new Uint8Array(bytes),{executionProviders:['wasm']});
 record.loadMs=performance.now()-start;
 const normalized=await sharp(record.source).rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).toBuffer();
 const dimensions=await sharp(normalized).metadata();
 if(dimensions.width!==1600||dimensions.height!==1200)throw new Error('Unexpected public fixture geometry');
 const {data,info}=await sharp(normalized).resize(800,600,{fit:'fill'}).extend({top:0,left:0,right:0,bottom:200,background:{r:124,g:116,b:104}}).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const inputs=await processor(new RawImage(new Uint8Array(data),info.width,info.height,info.channels),record.query);
 record.tensorShape=inputs.pixel_values.dims;
 const mask=inputs.pixel_mask, pixels=inputs.pixel_values;
 if(mask.type!=='int64'||mask.data.length!==640000||pixels.data.length!==1920000)throw new Error('Unexpected processor tensor layout');
 mask.data.fill(0n,480000);
 for(let channel=0;channel<3;channel++)pixels.data.fill(0,channel*640000+480000,(channel+1)*640000);
 record.validMaskPixels=Array.from(mask.data).filter(x=>x===1n).length;
 record.maskedPixels=Array.from(mask.data).filter(x=>x===0n).length;
 if(record.validMaskPixels!==480000||record.maskedPixels!==160000)throw new Error('Padding mask verification failed');
 const feeds=Object.fromEntries(session.inputNames.map(name=>{const t=inputs[name];if(!t)throw new Error('Missing processor input');return[name,new ort.Tensor(t.type,t.data,t.dims)];}));
 const begin=performance.now();const raw=await session.run(feeds);record.inferenceMs=performance.now()-begin;
 const outputs=Object.fromEntries(Object.entries(raw).map(([name,t])=>[name,new Tensor(t.type,t.data,t.dims)]));
 const result=processor.post_process_grounded_object_detection(outputs,inputs.input_ids,{box_threshold:0.25,text_threshold:0.25,target_sizes:[[800,800]]})[0];
 record.proposals=result.boxes.map((box,i)=>{
  const sourceCorners=[box[0]/800,box[1]/600,box[2]/800,box[3]/600];
  return{label:result.labels[i],score:result.scores[i],canvasCorners:box,normalizedSourceCorners:sourceCorners,
   structurallyValid:sourceCorners.every(n=>Number.isFinite(n)&&n>=0&&n<=1)&&sourceCorners[2]>sourceCorners[0]&&sourceCorners[3]>sourceCorners[1]};
 });
 record.rssBytes=process.memoryUsage().rss;record.complete=true;
}catch(error){record.failure={name:error.name,message:String(error.message).slice(0,600)};process.exitCode=1;}
finally{if(session)await session.release();record.totalMs=performance.now()-start;fs.writeFileSync(out,JSON.stringify(record,null,2));console.log(JSON.stringify(record));}
