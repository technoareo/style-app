import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const {AutoProcessor,Tensor,env}=await import(pathToFileURL(path.resolve('.runtime/vision-js/node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
env.allowLocalModels=true;env.allowRemoteModels=false;
const model=path.resolve('.runtime/vision-js/model-cache/onnx-community/grounding-dino-tiny-ONNX/ff690b0a8050566c290287545bd059350f3e9096');
const processor=await AutoProcessor.from_pretrained(model,{local_files_only:true});
const inputs=await processor(null,'shirt. dress.');
const logits=new Float32Array(256).fill(-Infinity);logits[1]=2;
const output={logits:new Tensor('float32',logits,[1,1,256]),pred_boxes:new Tensor('float32',new Float32Array([.5,.5,.5,.5]),[1,1,4])};
const record={synthetic:true,inference:false,applicationChange:false,network:false,cases:[]};
for(const variant of ['native-int64','converted-int32']) {
const ids=variant==='native-int64'?inputs.input_ids:new Tensor('int32',Int32Array.from(inputs.input_ids.data,Number),inputs.input_ids.dims);
try{record.cases.push({variant,result:processor.post_process_grounded_object_detection(output,ids,{box_threshold:.25,text_threshold:.25,target_sizes:[[800,800]]})});}
catch(error){record.cases.push({variant,error:String(error.message)});}
}
fs.writeFileSync('docs/verification/detector-postprocess-control-010.json',JSON.stringify(record,null,2));console.log(JSON.stringify(record));
