import json,time,inspect,platform
from pathlib import Path
import torch,transformers
from PIL import Image,ImageOps
from transformers import AutoProcessor,AutoModelForZeroShotObjectDetection
MODEL='IDEA-Research/grounding-dino-tiny'
REVISION='a2bb814dd30d776dcf7e30523b00659f4f141c71'
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
start=time.perf_counter()
processor=AutoProcessor.from_pretrained(MODEL,revision=REVISION,trust_remote_code=False,token=False)
model=AutoModelForZeroShotObjectDetection.from_pretrained(MODEL,revision=REVISION,trust_remote_code=False,use_safetensors=True,token=False,disable_custom_kernels=True).to('cpu').eval()
load_seconds=time.perf_counter()-start
print('Pinned local detector loaded; starting public-fixture inference.',flush=True)
image=ImageOps.exif_transpose(Image.open('tests/fixtures/candidates/natural-closet.jpg')).convert('RGB')
image.thumbnail((1600,1600))
query='shirt. dress. jacket. coat. trousers. skirt. shorts. shoes. handbag.'
prep_start=time.perf_counter()
inputs=processor(images=image,text=query,return_tensors='pt')
prep_seconds=time.perf_counter()-prep_start
runs=[]
for i in range(2):
 begin=time.perf_counter()
 with torch.inference_mode(): outputs=model(**inputs)
 infer_seconds=time.perf_counter()-begin
 report={'run':i+1,'inferenceSeconds':infer_seconds,'thresholds':[]}
 parameters=inspect.signature(processor.post_process_grounded_object_detection).parameters
 threshold_name='threshold' if 'threshold' in parameters else 'box_threshold'
 for threshold in [0.25,0.35,0.45]:
  kwargs={threshold_name:threshold,'text_threshold':0.25,'target_sizes':[image.size[::-1]]}
  result=processor.post_process_grounded_object_detection(outputs,inputs.input_ids,**kwargs)[0]
  labels=result.get('text_labels',result.get('labels',[]))
  records=[]
  for box,score,label in zip(result['boxes'].tolist(),result['scores'].tolist(),labels):
   left,top,right,bottom=box
   normalized=[left/image.width,top/image.height,(right-left)/image.width,(bottom-top)/image.height]
   valid=all(0<=v<=1 for v in normalized) and normalized[2]>=.03 and normalized[3]>=.03 and normalized[0]+normalized[2]<=1.01 and normalized[1]+normalized[3]<=1.01
   records.append({'label':str(label),'score':score,'box':normalized,'structurallyValid':valid})
  report['thresholds'].append({'threshold':threshold,'proposalCount':len(records),'structurallyValidCount':sum(r['structurallyValid'] for r in records),'proposals':records})
 runs.append(report)
 print(json.dumps({'run':i+1,'inferenceSeconds':infer_seconds,'counts':[{k:v for k,v in r.items() if k!='proposals'} for r in report['thresholds']]}),flush=True)
evidence={'developmentOnly':True,'heldOut':False,'accuracyBenchmark':False,'model':MODEL,'revision':REVISION,'modelCard':'https://huggingface.co/IDEA-Research/grounding-dino-tiny','license':'Apache-2.0 (model card)','weightsFormat':'safetensors','remoteCodeAllowed':False,'torchVersion':torch.__version__,'transformersVersion':transformers.__version__,'cpuThreads':2,'loadIncludingDownloadSeconds':load_seconds,'preprocessSeconds':prep_seconds,'canonicalImageSize':list(image.size),'modelTensorSize':list(inputs.pixel_values.shape),'query':query,'runs':runs,'notes':'Raw detector proposals, no deduplication or human gold labels. Counts are not recall/precision. Hidden attributes not inferred. First model run and repeated warm run are reported separately.'}
Path('docs/verification/grounding-dino-closet-009.json').write_text(json.dumps(evidence,indent=2),encoding='utf8')
