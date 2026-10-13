import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const out='docs/verification/detector-shape-probe-011.json';
if(fs.existsSync(out))throw new Error('Refusing to overwrite evidence');
const root=path.resolve('.runtime/vision-js/node_modules/onnxruntime-web/dist');
const ort=await import(pathToFileURL(path.join(root,'ort.wasm.min.mjs')).href);
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={mjs:pathToFileURL(path.join(root,'ort-wasm-simd-threaded.mjs')).href,wasm:pathToFileURL(path.join(root,'ort-wasm-simd-threaded.wasm')).href};
const model=path.resolve('.runtime/vision-js/model-cache/onnx-community/grounding-dino-tiny-ONNX/ff690b0a8050566c290287545bd059350f3e9096/onnx/model.onnx');
let session;
const evidence={developmentOnly:true,applicationChange:false,network:false,inferencePerformed:false};
try{
 session=await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(model)),{executionProviders:['wasm']});
 evidence.inputs=session.inputMetadata;
 evidence.outputs=session.outputMetadata;
}catch(error){evidence.error=String(error.message).slice(0,400);process.exitCode=1;}
finally{if(session)await session.release();fs.writeFileSync(out,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
