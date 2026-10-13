# Inference research after build 007

Perplexity was consulted in its desktop app on 12 October 2026. Its recommendation is an experiment, not a measured improvement: instrument the existing local stack before replacing it; compare cold and warm runs separately; test compact detection versus detection plus crop attributes on a frozen set of naturally photographed wardrobes. No paid API, new account or user-image upload was used for this research.

Codex verified these limited facts against primary sources:

- [Ollama chat API](https://docs.ollama.com/api/chat) returns model loading, prompt evaluation and generated-token timings/counts, total duration and a completion reason. It supports a keep-alive duration and a JSON schema. These let an experiment separate loading/generation from queue, resize and browser/save overhead; they do not directly isolate grammar overhead or every image-encoder phase.
- [Qwen3-VL-4B-Instruct model card](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct) identifies the current model and Apache 2.0 license. Its general model capabilities do not establish wardrobe recall or CPU latency.
- [Florence-2-base model card](https://huggingface.co/microsoft/Florence-2-base) lists MIT licensing, a 0.23B model and object-detection/region tasks. The documented Transformers example requires remote custom code; any experiment must pin and inspect that code. Neither its size nor general detection benchmarks prove that it finds 30 garments in a consumer wardrobe.
- [SmolVLM2-500M model card](https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct) lists Apache 2.0 and a multimodal architecture. Treat it as a crop-attribute experiment, not a proven replacement or bounding-box detector.

## Next experiment

Keep the current model as a baseline and record per-call counts/durations, completion reason, timeout/cancellation, image dimensions and queue/normalization/review/save times without storing private image content or identity in metrics. Record cold versus warm state rather than calling one slow run a percentile. Current observed smoke times are 214.303 seconds after cancellation and 242.586 seconds through the browser; historical shirt checks were faster, and the difference is not yet explained.

Compare the current full schema with a bounded compact detection schema. Preserve validated item/category/color/pattern/bounds and unknown hidden attributes. Detect token exhaustion explicitly. Do not silently drop items or accept an arbitrary malformed JSON prefix as a complete wardrobe. Bounded multi-step/tile work must reserve its whole work budget in queue admission, expose progress, persist validated sub-results and preserve cancellation/account isolation/one-hour retention. Duplicate overlap proposals must remain recoverable without silently merging distinct owned items.

Perplexity proposed a 60-photo decision set, repeated under documented warm-up conditions, including individual items and natural photos with 10/20/30 visible garments. Keep annotations independent of outputs and licensed/consented. Measure precision/recall, box IoU, duplicate/merge errors, category/color/pattern, unsupported attributes, schema/truncation rate, cold/warm latency, peak memory and consumer correction time. A smaller development experiment does not replace the separate held-out launch evaluation in VISION_EVALUATION.md. Synthetic collages can test plumbing but cannot stand in for natural dense wardrobes.

Try another local detector or small crop classifier only after baseline instrumentation supports the change. No alternative has been installed, measured or selected. External free APIs require separate key, quota, retention and availability checks; they are not the selected privacy-preserving path. No faster performance, complete dense detection or production readiness is claimed.

## Natural-closet development baseline

An attributed CC BY-SA 4.0 closet photograph was downloaded with provenance in tests/fixtures/candidates/NATURAL_CLOSET_SOURCE.md. Codex visually recorded a provisional lower bound of ten distinguishable garments before inference; no exact-count or category gold standard is claimed. The scene has heavy overlap and low light. It is a development example, not a held-out benchmark.

The unchanged build-007 vision pipeline resized/re-encoded the source and tried the local model. It timed out after 240.063 seconds, returning no validated result (`failureKind: unavailable`). No completion/timing metadata arrived before cancellation, so loading versus generation cannot be diagnosed from this run. See docs/verification/natural-closet-baseline-007.json. This observed failure supports the need for a bounded dense-image experiment; it does not prove an alternative is faster or accurate.

## Compact locate-only development probe008

Using the same attributed natural closet fixture and local Qwen3-VL4B CPU, a shorter locate-only schema (category/color/box arrays, up to30, outputbudget1200 vsbaseline2048,768px image,4096context, keepalive30min) also timed out:240149ms, no validated items or completion timing metadata. Evidence: docs/verification/compact-closet-experiment-008.json and repeatable verification probe. This is not an application implementation, held-out test or accurate count benchmark. It did not establish a speed improvement; failed baseline and failed compact request do not isolate loading/prefill/generation. Next experiment needs streamed first-output timing or smaller-image/model comparison, with actual recognition quality checks and no silent truncation. Do not ship compact-only as a solved dense-wardrobe feature based on this result.
