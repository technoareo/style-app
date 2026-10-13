import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const {AutoProcessor,Tensor,env}=await import(pathToFileURL(path.resolve('.runtime/vision-js/node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
env.allowLocalModels=true;env.allowRemoteModels=false;
const model=path.resolve('.runtime/vision-js/model-cache/onnx-community/grounding-dino-tiny-ONNX/ff690b0a8050566c290287545bd059350f3e9096');
const processor=await AutoProcessor.from_pretrained(model,{local_files_only:true});
const source='docs/verification/detector-wasm-fp32-closet-010-raw.json';
const raw=JSON.parse(fs.readFileSync(source,'utf8'));
assert.equal(raw.inputIds.length,1);const ids=raw.inputIds[0];assert.ok(ids.every(v=>Number.isSafeInteger(v)&&v>=0));
const logits=raw.outputs.logits,boxes=raw.outputs.pred_boxes;
assert.deepEqual(logits.dims,[1,900,256]);assert.deepEqual(boxes.dims,[1,900,4]);assert.equal(logits.data.length,900*256);assert.equal(boxes.data.length,900*4);
assert.ok(boxes.data.every(Number.isFinite));
// JSON encoded non-finite padding as null. Reconstruct ONLY verified padding;
// refuse any missing/non-finite value in the actual tokenizer sequence.
let padding=0;for(let row=0;row<900;row++)for(let col=0;col<256;col++){
const index=row*256+col;if(col<ids.length){assert.ok(Number.isFinite(logits.data[index]),'invalid unmasked token score');}
else {assert.equal(logits.data[index],null,'padding was not uniformly masked');logits.data[index]=-Infinity;padding++;}}
const output={logits:new Tensor('float32',Float32Array.from(logits.data),logits.dims),pred_boxes:new Tensor('float32',Float32Array.from(boxes.data),boxes.dims)};
const inputIds=new Tensor('int32',Int32Array.from(ids),[1,ids.length]);
const record={developmentOnly:true,heldOut:false,accuracyBenchmark:false,applicationChange:false,source,paddingRestored:padding,unmaskedValuesValidated:true,thresholds:[]};
for(const threshold of [.10,.15,.20,.25]){
const textThreshold=Math.min(.10,threshold);
try {
const result=processor.post_process_grounded_object_detection(output,inputIds,{box_threshold:threshold,text_threshold:textThreshold})[0];
const proposals=result.boxes.map((b,i)=>({label:result.labels[i],score:result.scores[i],corners:b,strictlyInFrame:b.every(n=>Number.isFinite(n)&&n>=0&&n<=1)&&b[2]>b[0]&&b[3]>b[1]}));
record.thresholds.push({threshold,textThreshold,count:proposals.length,proposals});
console.log(JSON.stringify({threshold,textThreshold,count:proposals.length,top:proposals.slice(0,8)}));
}catch(error){record.thresholds.push({threshold,textThreshold,error:String(error.message).slice(0,180)});}}
record.notes='Complete numerical inference output replay only, not partial generated JSON salvage. Lower threshold proposals require human matching and duplicate evaluation; not accuracy evidence.';
fs.writeFileSync('docs/verification/detector-threshold-replay-011.json',JSON.stringify(record,null,2));
