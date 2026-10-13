// Isolated public-fixture experiment; never imported by the application.
// Run only after the contention matrix is terminal, to avoid changing its load.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const evidenceFile = 'docs/verification/detector-tiles-fp32-011.json';
if (fs.existsSync(evidenceFile)) throw new Error('Refusing to overwrite existing experiment evidence');
const source = 'tests/fixtures/candidates/natural-closet.jpg';
const revision = 'ff690b0a8050566c290287545bd059350f3e9096';
const base = path.resolve('.runtime/vision-js/node_modules');
const local = path.resolve('.runtime/vision-js/model-cache/onnx-community/grounding-dino-tiny-ONNX', revision);
const record = {
  developmentOnly: true, heldOut: false, accuracyBenchmark: false,
  complete: false, network: false, backend: 'wasm', dtype: 'fp32', threads: 1,
  source, sourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'), revision,
  query: 'shirt. dress. jacket. coat. trousers. skirt. shorts. shoes. handbag.',
  boxThreshold: 0.25, textThreshold: 0.25, nmsIou: 0.5, tiles: [],
  notes: 'Raw proposals and class-aware overlap suppression are not garment counts or accuracy. Same development closet fixture; no human gold set. No application changes.'
};
const save = () => fs.writeFileSync(evidenceFile, JSON.stringify(record, null, 2));
const iou = (a, b) => {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  const area = (x) => (x[2] - x[0]) * (x[3] - x[1]);
  return intersection / (area(a) + area(b) - intersection);
};
let session;
const startedAt = performance.now();
try {
  const { AutoProcessor, RawImage, Tensor, env } = await import(pathToFileURL(path.join(base, '@huggingface/transformers/dist/transformers.node.mjs')).href);
  const ort = await import(pathToFileURL(path.join(base, 'onnxruntime-web/dist/ort.wasm.min.mjs')).href);
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  ort.env.wasm.numThreads = 1;
  const dist = path.join(base, 'onnxruntime-web/dist');
  ort.env.wasm.wasmPaths = {
    mjs: pathToFileURL(path.join(dist, 'ort-wasm-simd-threaded.mjs')).href,
    wasm: pathToFileURL(path.join(dist, 'ort-wasm-simd-threaded.wasm')).href
  };
  const processor = await AutoProcessor.from_pretrained(local, { local_files_only: true });
  const modelBytes = fs.readFileSync(path.join(local, 'onnx/model.onnx'));
  record.modelSha256 = createHash('sha256').update(modelBytes).digest('hex');
  if (record.modelSha256 !== '267c8b00d269dc2dda0d8592812d3027abd5fb59f1cabf8e3d56f8fdf07f68ec') throw new Error('Pinned fp32 model hash mismatch');
  session = await ort.InferenceSession.create(new Uint8Array(modelBytes), { executionProviders: ['wasm'] });
  record.loadMs = performance.now() - startedAt;
  const normalized = await sharp(source).rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
  const metadata = await sharp(normalized).metadata();
  if (metadata.width !== 1600 || metadata.height !== 1200) throw new Error('Unexpected fixture dimensions; protocol must be revised explicitly');
  record.normalizedSize = [1600,1200];
  // Fixed before inference: three full-height strips, 35.7% horizontal overlap.
  const plans = [0,450,900].map(left => ({left, top:0, width:700, height:1200}));
  for (const [index, tile] of plans.entries()) {
    const prepAt = performance.now();
    const {data,info} = await sharp(normalized).extract(tile).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const inputs = await processor(new RawImage(new Uint8Array(data),info.width,info.height,info.channels), record.query);
    const feeds = Object.fromEntries(session.inputNames.map(name => {
      const tensor = inputs[name];
      if (!tensor) throw new Error('Missing processor input '+name);
      return [name,new ort.Tensor(tensor.type,tensor.data,tensor.dims)];
    }));
    const entry = {index, tile, preprocessMs:performance.now()-prepAt, tensorShape:inputs.pixel_values.dims};
    const inferAt = performance.now();
    const raw = await session.run(feeds);
    entry.inferenceMs = performance.now()-inferAt;
    const outputs = Object.fromEntries(Object.entries(raw).map(([name,t])=>[name,new Tensor(t.type,t.data,t.dims)]));
    const result = processor.post_process_grounded_object_detection(outputs,inputs.input_ids,{
      box_threshold:record.boxThreshold, text_threshold:record.textThreshold, target_sizes:[[1200,700]]
    })[0];
    entry.proposals = result.boxes.map((box,i) => {
      const valid = box.length===4 && box.every(Number.isFinite) && box[0]>=0 && box[1]>=0 && box[2]<=700 && box[3]<=1200 && box[2]>box[0] && box[3]>box[1];
      return {label:result.labels[i],score:result.scores[i],localCorners:box,structurallyValid:valid,
        normalizedSourceCorners:[(box[0]+tile.left)/1600,box[1]/1200,(box[2]+tile.left)/1600,box[3]/1200]};
    });
    entry.rssBytes = process.memoryUsage().rss;
    record.tiles.push(entry);
    save();
    console.log(JSON.stringify({tile:index,inferenceMs:entry.inferenceMs,proposals:entry.proposals.length,rssBytes:entry.rssBytes}));
  }
  const proposals = record.tiles.flatMap(t=>t.proposals.map(p=>({...p,tile:t.index}))).filter(p=>p.structurallyValid && Number.isFinite(p.score));
  const kept=[];
  for (const candidate of proposals.sort((a,b)=>b.score-a.score)) {
    if (!kept.some(p=>p.label===candidate.label && iou(p.normalizedSourceCorners,candidate.normalizedSourceCorners)>record.nmsIou)) kept.push(candidate);
  }
  record.rawProposals = proposals.length;
  record.survivingProposals = kept;
  record.complete = true;
} catch(error) {
  record.failure = {name:error.name,message:String(error.message).slice(0,600)};
  process.exitCode = 1;
} finally {
  if (session) await session.release();
  record.totalMs = performance.now()-startedAt;
  save();
}
