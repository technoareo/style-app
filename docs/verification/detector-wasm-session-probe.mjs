import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve('.runtime/vision-js/node_modules/onnxruntime-web/dist');
const ort=await import(pathToFileURL(path.join(root,'ort.wasm.min.mjs')).href);
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={mjs:pathToFileURL(path.join(root,'ort-wasm-simd-threaded.mjs')).href,wasm:pathToFileURL(path.join(root,'ort-wasm-simd-threaded.wasm')).href};
const model=path.resolve('.runtime/vision-js/model-cache/onnx-community/grounding-dino-tiny-ONNX/ff690b0a8050566c290287545bd059350f3e9096/onnx/model_quantized.onnx');
const evidence={developmentOnly:true,applicationChange:false,network:false,backend:'wasm',threads:1,inferencePerformed:false};
const begin=Date.now();
try {console.log('Creating offline WebAssembly session.');const session=await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(model)),{executionProviders:['wasm']});evidence.sessionCreated=true;evidence.inputNames=session.inputNames;evidence.outputNames=session.outputNames;await session.release();}
catch(error){evidence.sessionCreated=false;evidence.error=String(error.message).slice(0,600);}
evidence.elapsedMs=Date.now()-begin;
fs.writeFileSync('docs/verification/detector-wasm-session-010.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
