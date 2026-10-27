# Next detector research

Root read the completed Perplexity answer in the native app. It recommends YOLO-World-S with fixed garment vocabulary and ONNX export, but explicitly did not locate a stable official prebuilt ONNX artifact. Thus its recommendation is not yet a runnable replacement on this Windows host. No model downloaded, installed or run from this answer.

Root primary-source checks:

- [YOLO-World README](https://github.com/AILab-CVC/YOLO-World/blob/master/README.md) confirms PyTorch implementation, pretrained weights, vocabulary reparameterization, ONNX export/demo and GPL-v3 with commercial usage supported. It links the online demo for ONNX downloads. This does not prove closet instance separation, a particular converted artifact's provenance or this host's runtime compatibility. Export still needs a usable environment or a verified artifact from the official demo.
- [Moondream 2 model card](https://huggingface.co/vikhyatk/moondream2/blob/main/README.md) labels the model Apache-2.0 and documents a pinned Transformers release. No verified ONNX/WASM detection-head implementation was established by this inspection.
- [Moondream 3 model card](https://huggingface.co/moondream/moondream3-preview) explicitly distinguishes competing paid model services from consumer photo-app use under its BUSL/additional grant. Perplexity's broad paid-hosted/embedded restriction wording needs that qualification: the card gives a consumer auto-tagging app as an allowed example. The actual license controls. Runtime suitability remains unverified; do not reject merely because the app might be commercial or assume a chat wrapper exposes detection heads.

Next actionable research is to inspect the official YOLO-World export/demo artifact path and runtime I/O before proposing a bounded public-fixture probe. Keep model work isolated from heartbeat handling. Independent human annotations and held-out evaluation remain missing; none of this is accuracy evidence or launch approval.

Follow-up primary inspection: [deployment guide](https://github.com/AILab-CVC/YOLO-World/blob/master/docs/deploy.md) documents config/checkpoint plus custom text export, optional removal of NMS/box decoder, and an opset/einsum compatibility caveat. The [officially linked Space](https://huggingface.co/spaces/stevengrove/YOLO-World) currently reports a runtime error, memory limit exceeded (14 GiB). No artifact obtained; a stable downloadable model and its tensor contract remain unverified. This is a model-probe dependency, not a reason to stop unrelated app fixes.
