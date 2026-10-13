# Perplexity consultation: garment-specific detector candidates

12 October 2026. Root sent public model/benchmark facts through the Perplexity Windows app, in a new research conversation titled beginning `Research primary sources only for a free AI wardrobe app`. No private photo, account data or project files were supplied. Response completed; root separately checked the primary sources below.

Perplexity did not identify an option proven suitable across code/weights/image rights AND the current CPU/WASM runtime. This is a limitation of this research, not proof that no suitable model exists anywhere. It recommended evaluating a garment-trained full-frame detector rather than repeating the failed general-detector tile experiment. That recommendation has not been benchmarked locally and is not an app integration decision.

Verified primary-source facts:

- https://github.com/simaiden/Clothing-Detection documents clothing-trained YOLOv3, Faster R-CNN and RetinaNet for DeepFashion2/ModaNet, with weights/configs linked from Google Drive. The repository displays GPL-3.0. Its README does not establish a separately verified commercial weight/data grant or this checkpoint's ONNX/WASM compatibility and local CPU latency. No weights were downloaded or executed as part of this consultation.
- https://fashionpedia.github.io/home/Model_and_API.html links Attribute Mask R-CNN code and checkpoints to the TensorFlow TPU project's Fashionpedia implementation. Its API repository's BSD license must not be substituted for the model code's license.
- https://fashionpedia.github.io/home/data_license.html distinguishes CC BY 4.0 annotations/ontology from images whose copyrights Fashionpedia does not own; image use is governed by their original source terms. Those annotations do not establish blanket rights for every image.
- https://github.com/eBay/modanet describes an educational research benchmark using PaperDoll images and garment annotations. Its repository license and image source must be checked separately before training/distribution; no commercial clearance is claimed here.

Perplexity's other lead is `tomsebastiank/Clothing-detection-and-attribute-identification-using-YoloV3-and-DeepFashion`; root has not independently examined it yet. It remains a lead, not a validated option.

Next decision: use the offline evaluation harness to compare actual independently labelled crowded scenes and single-item controls; retain the whole-wardrobe requirement, record failures/count errors/crop usefulness, and do not claim production usability from more proposals or a code license alone. A clothing-specific architecture experiment may be informative, but retraining, runtime export, weights provenance and held-out performance remain required evidence. Public fixture acquisition/annotation and the existing deployment/security work can proceed while model suitability is unresolved.
