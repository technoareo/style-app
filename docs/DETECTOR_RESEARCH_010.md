# Local dense-wardrobe detector research — 12 October 2026

Perplexity consulted in the existing native wardrobe thread at 15:20 Singapore time. Submission accepted after the earlier approval-service quota reset. No garment image was transmitted. Its answer is research guidance, not review approval or evidence that an alternative works. Its table incorrectly described two dense closets: root tested one closet fixture twice. Preserve that distinction.

Observed development evidence: Python Torch import failed before inference; Node native ONNX import succeeds but native session creation exits1 without a JavaScript exception. Offline WebAssembly loads the pinned q8 detector and runs. Two runs of the SAME natural closet fixture return zero proposals at thresholds .25/.35/.45, 57.171 and73.724 seconds. These are local Windows observations, not target Linux capacity or accuracy. The simple-shirt control eventually returns one proposal at those thresholds; its lower-threshold empty-phrase decoder errors are retained per threshold. The first diagnostic serialization failed on BigInt token IDs; corrected diagnostic conversion records numeric IDs. Synthetic postprocessing passes with both int64 and int32 IDs, so BigInt is not established as the model decoder defect.

Perplexity advises: validate an ordinary positive control and capture raw logits/token IDs/boxes before changing the engine; compare full precision and quantized exports on identical inputs; distinguish Windows-native runtime failure from detection misses; compare fixed overlapping tiles only after a sound baseline, with duplicate merging and a human garment manifest; compare Florence2 detection/proposals using the same crop-attribute stage. These are proposed experiments, not established fixes.

Root decision: retain the whole-wardrobe goal. No detector is integrated yet. Do not lower thresholds and call extra proposals correct. Current inference probe records raw proposals and strict structural bounds; no human gold set or held-out benchmark exists. A positive control proves output is possible, not closet recall. Attribute inference must retain unknown for hidden brand, size, fabric and fit.

A frozen consented/licensed held-out set should cover single garments, shoes/accessories, 2–5-item photos, dense10/20/30-garment photos, occlusion, low light and varied backgrounds. Measure box matching/recall/precision, duplicate and invalid rates, category/color/pattern correctness, invented hidden attributes, review burden, complete response rate, cold/warm latency, per-tile/per-crop cost, memory and queue behavior on the actual host. Final numeric consumer acceptance targets remain to be established; no passing launch claim.

Primary references checked independently or already pinned in the prior research:
- https://huggingface.co/onnx-community/grounding-dino-tiny-ONNX (Apache2.0 model conversion), pinned ff690b0a8050566c290287545bd059350f3e9096.
- https://huggingface.co/IDEA-Research/grounding-dino-tiny and https://huggingface.co/docs/transformers/model_doc/grounding-dino.
- https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html (local WASM paths/thread settings).
- https://onnxruntime.ai/docs/get-started/with-javascript/node.html (Windows x64 CPU binding support; does not diagnose this crash).
- Florence2 tasks cited by Perplexity: https://huggingface.co/docs/transformers/en/model_doc/florence2 (alternative remains untested).

All .runtime/vision-js dependencies belong to an isolated research runtime; app package/lock and vision implementation are unchanged. Model/source fixture provenance remains in existing fixture notices. Raw output is from public attributed development photos only.

## Native runtime follow-up

Approved hardware read: Intel i7-9750H,6physical cores/12logical,x64,Node24.20x64. An ARM/x64 mismatch is ruled out. Installed System32 VC runtime files are14.28.29913; workspace bundled Poppler files14.51.36247. An isolated copy of the existing Node executable with those eight newer bundled Microsoft runtime files still exits1 at native session creation, with no JavaScript error. No Windows DLLs, registry, security settings, installed apps or application dependencies were modified. Provenance: native-runtime-provenance-010.json. This did not prove or solve the runtime cause; do not present a VC update as a verified fix.

Pinned q8 weights hash matches public upstream LFS metadata:70bf2d3310d1ae73769c96a71e00cbf2861eb33a1f4d97d84a108a7bf02c03c9,203824675bytes. Full-precision weights downloaded from same pinned revision and SHA256 verified:267c8b00d269dc2dda0d8592812d3027abd5fb59f1cabf8e3d56f8fdf07f68ec,718761381bytes. Fp32 offline WebAssembly positive-control run started after browser/backend checks completed, no application integration or accuracy claim.

## Full-precision and threshold experiment

Offline full-precision positive-control shirt:1 proposal at.25/.35/.45,49.499s inference. Full-precision same dense closet:25.790s inference,0proposals at.25/.35/.45; maximum actual logit -1.1740123 (sigmoid about.236). This is a measured development miss, not evidence that a particular architecture cannot work. Different fixture/timings are not a performance comparison or target-host capacity.

Complete numerical-output replay validates every actual tokenizer score and reconstructs only uniformly masked padding (JSON null encoding of non-finite padding), not a malformed LLM prefix. With consistent lower text threshold.10: box threshold.10 yields21 raw proposals;.15 yields4;.20 yields1;.25 yields0. Many high-ranked boxes cover most of the closet and combine unrelated labels (shirt/jacket/shorts/handbag); counts are not garment recall. Lowering the thresholds did not establish usable dense recognition. A three-tile or fashion-specific detector comparison must preserve this original development failure and be followed by frozen held-out evaluation. No application engine change.
