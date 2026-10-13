// Isolated public-fixture experiment; no app/package changes or remote inference.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import sharp from 'sharp';
const out=process.argv[2]??'docs/verification/florence-wasm-012.json';if(fs.existsSync(out))throw new Error('Refusing to overwrite evidence');
const revision='e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f';
const base=path.resolve('.runtime/vision-js/node_modules'),local=path.resolve('.runtime/vision-js/model-cache/onnx-community/Florence-2-base-ft',revision);
const dist=path.join(base,'onnxruntime-web/dist');const ort=await import(pathToFileURL(path.join(dist,'ort.wasm.min.mjs')).href);
ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths={mjs:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.mjs')).href,wasm:pathToFileURL(path.join(dist,'ort-wasm-simd-threaded.wasm')).href};
const provenance=JSON.parse(fs.readFileSync('docs/verification/florence-download-012.json','utf8'));
const record={developmentOnly:true,heldOut:false,accuracyBenchmark:false,applicationChange:false,network:false,model:'onnx-community/Florence-2-base-ft',revision,dtype:'q8',threads:1,sessionsCreated:0,runs:[],complete:false};
globalThis[Symbol.for('onnxruntime')]={...ort,InferenceSession:{create:async(buffer,options)=>{
 if(typeof buffer==='string'){
  const resolved=fs.realpathSync(buffer),root=fs.realpathSync(local)+path.sep;
  if(!resolved.toLowerCase().startsWith(root.toLowerCase()))throw new Error('Model path escaped public cache');
  const relative=path.relative(local,resolved).replaceAll('\\','/'),expected=provenance.files.find(x=>x.file===relative);
  if(!expected?.upstreamLfsVerified)throw new Error('No verified weight provenance');
  const bytes=fs.readFileSync(resolved);if(createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw new Error('Weight checksum mismatch');
  buffer=new Uint8Array(bytes);
 }
 const session=await ort.InferenceSession.create(buffer,{...options,executionProviders:['wasm']});record.sessionsCreated++;return session;
}}};
let model;const start=performance.now();
try{
 const {Florence2ForConditionalGeneration,AutoProcessor,RawImage,env}=await import(pathToFileURL(path.join(base,'@huggingface/transformers/dist/transformers.node.mjs')).href);
 env.allowLocalModels=true;env.allowRemoteModels=false;env.useWasmCache=false;
 model=await Florence2ForConditionalGeneration.from_pretrained(local,{local_files_only:true,dtype:'q8',device:'auto',session_options:{executionProviders:['wasm']}});
 const processor=await AutoProcessor.from_pretrained(local,{local_files_only:true});record.loadMs=performance.now()-start;
 const eos=JSON.parse(fs.readFileSync(path.join(local,'generation_config.json'),'utf8')).eos_token_id;
 const specifications=process.argv[3]==='grounding'
  ? [{source:'tests/fixtures/candidates/natural-closet.jpg',task:'<CAPTION_TO_PHRASE_GROUNDING>',query:'shirts, dresses, jackets, coats, trousers, skirts, shorts, shoes, and handbags'}]
  : process.argv[3]==='regions'
  ? ['<DENSE_REGION_CAPTION>','<REGION_PROPOSAL>'].map(task=>({source:'tests/fixtures/candidates/natural-closet.jpg',task}))
  : ['tests/fixtures/public-shirt.jpg','tests/fixtures/candidates/natural-closet.jpg'].map(source=>({source,task:'<OD>'}));
 for(const {source,task,query} of specifications){
  const {data,info}=await sharp(source).rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const image=new RawImage(new Uint8Array(data),info.width,info.height,info.channels);
  const inputs=await processor(image,processor.construct_prompts(task+(query??'')));
  const run={source,task,query,imageSize:image.size,tensorShape:inputs.pixel_values.dims};record.runs.push(run);
  console.log('Starting public '+(source.includes('shirt')?'shirt control':'closet')+' inference');
  const began=performance.now();const generated=await model.generate({...inputs,max_new_tokens:512,num_beams:1,do_sample:false});run.inferenceMs=performance.now()-began;
  const ids=generated.tolist()[0].map(Number);run.tokenCount=ids.length;run.endedWithEos=(Array.isArray(eos)?eos:[eos]).includes(ids.at(-1));
  run.generatedText=processor.batch_decode(generated,{skip_special_tokens:false})[0];
  if(run.endedWithEos){
   run.parsed=processor.post_process_generation(run.generatedText,task,image.size);
   const detection=run.parsed[task];if(!Array.isArray(detection?.bboxes)||(detection.labels!==undefined&&(!Array.isArray(detection.labels)||detection.bboxes.length!==detection.labels.length)))throw new Error('Invalid complete detection structure');
   run.proposals=detection.bboxes.map((b,i)=>({label:detection.labels?.[i]??null,corners:b,normalizedCorners:[b[0]/info.width,b[1]/info.height,b[2]/info.width,b[3]/info.height],structurallyValid:b.length===4&&b.every(Number.isFinite)&&b[0]>=0&&b[1]>=0&&b[2]<=info.width&&b[3]<=info.height&&b[2]>b[0]&&b[3]>b[1]}));
  }else run.failure='Output reached cap without EOS; no partial detections accepted';
  run.rssBytes=process.memoryUsage().rss;fs.writeFileSync(out,JSON.stringify(record,null,2));
  console.log(JSON.stringify({source,inferenceMs:run.inferenceMs,tokenCount:run.tokenCount,eos:run.endedWithEos,proposals:run.proposals?.length}));
 }
 record.complete=true;
}catch(error){record.failure={name:error.name,message:String(error.message).slice(0,700)};process.exitCode=1;}
finally{if(model){try{await model.dispose();}catch(error){record.disposeError=String(error.message).slice(0,200);process.exitCode=1;}}record.totalMs=performance.now()-start;fs.writeFileSync(out,JSON.stringify(record,null,2));console.log(JSON.stringify({complete:record.complete,totalMs:record.totalMs,failure:record.failure}));}
