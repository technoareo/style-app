// Research-only local SDK/WASM benchmark, no app dependency or source changes.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';import sharp from 'sharp';
const out='docs/verification/owlv2-wasm-probe-014.json';if(fs.existsSync(out))throw Error('Preserve existing evidence');
const provenance=JSON.parse(fs.readFileSync('docs/verification/owlv2-download-014.json','utf8'));
const local=path.resolve('.runtime/vision-js/model-cache/onnx-community/owlv2-base-patch16-ONNX/'+provenance.revision),base=path.resolve('.runtime/vision-js/node_modules'),dist=path.join(base,'onnxruntime-web/dist');
const ort=await import(pathToFileURL(path.join(dist,'ort.wasm.min.mjs')).href);ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths={mjs:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.mjs')).href,wasm:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.wasm')).href};
globalThis[Symbol.for('onnxruntime')]={...ort,InferenceSession:{create:async(buffer,options)=>{if(typeof buffer==='string'){const file=fs.realpathSync(buffer),root=fs.realpathSync(local)+path.sep;if(!file.toLowerCase().startsWith(root.toLowerCase()))throw Error('Load escaped public model cache');const relative=path.relative(local,file).replaceAll('\\','/'),expected=provenance.files.find(x=>x.file===relative);if(!expected?.upstreamLfsHashVerified)throw Error('Unverified weight file');const bytes=fs.readFileSync(file);if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw Error('Weight digest changed');buffer=new Uint8Array(bytes);}return ort.InferenceSession.create(buffer,{...options,executionProviders:['wasm']});}}};
const labels=['shirt','t-shirt','jacket','coat','dress','trousers','jeans','skirt','shorts','shoe','handbag'];
const record={researchOnly:true,applicationChange:false,networkInference:false,heldOut:false,model:provenance.model,revision:provenance.revision,dtype:'q8',threshold:.2,labels,cases:[],complete:false};let detector;const start=performance.now();
try{
 const {pipeline,RawImage,env}=await import(pathToFileURL(path.join(base,'@huggingface/transformers/dist/transformers.node.mjs')).href);env.allowLocalModels=true;env.allowRemoteModels=false;env.useWasmCache=false;
 detector=await pipeline('zero-shot-object-detection',local,{local_files_only:true,dtype:'q8',device:'auto',session_options:{executionProviders:['wasm']}});record.loadMs=performance.now()-start;
 for(const [name,file] of [['single-shirt','tests/fixtures/public-shirt.jpg'],['natural-closet','tests/fixtures/candidates/natural-closet.jpg']]){
  const sourceBytes=fs.readFileSync(file);const {data,info}=await sharp(sourceBytes).rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  // Explicit black square padding BEFORE the model processor resizes, preserving
  // aspect ratio. Model boxes are relative to that square; convert back without clipping.
  const side=Math.max(info.width,info.height),square=new Uint8Array(side*side*info.channels);
  for(let y=0;y<info.height;y++)square.set(data.subarray(y*info.width*info.channels,(y+1)*info.width*info.channels),y*side*info.channels);
  const at=performance.now(),proposals=await detector(new RawImage(square,side,side,info.channels),labels,{threshold:.2,percentage:true});
  const result=proposals.map(p=>{const b=[p.box.xmin*side/info.width,p.box.ymin*side/info.height,p.box.xmax*side/info.width,p.box.ymax*side/info.height];return {label:p.label,score:p.score,normalizedOriginalCorners:b,geometryValid:b.every(x=>Number.isFinite(x)&&x>=0&&x<=1)&&b[2]>b[0]&&b[3]>b[1]};});
  const row={name,imageSha256:crypto.createHash('sha256').update(sourceBytes).digest('hex'),displayWidth:info.width,displayHeight:info.height,paddedSide:side,padding:'black on bottom/right before model resize',inferenceMs:performance.now()-at,proposalCount:result.length,validGeometryCount:result.filter(x=>x.geometryValid).length,proposals:result};record.cases.push(row);console.log(JSON.stringify({...row,proposals:undefined}));
 }record.complete=true;
}catch(e){record.failure={name:e.name,message:String(e.message).slice(0,600)};process.exitCode=1;}finally{if(detector)await detector.dispose();record.totalMs=performance.now()-start;fs.writeFileSync(out,JSON.stringify(record,null,2),{flag:'wx'});console.log(JSON.stringify({...record,cases:record.cases.map(({proposals,...rest})=>rest)}));}
