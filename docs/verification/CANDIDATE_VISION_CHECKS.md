# Additional real-model development checks — 12 October 2026

The existing `normalizePhoto` / `analyzePhoto` pipeline with the local `qwen3-vl:4b-instruct` model was run directly on two CC0 fixtures after visually inspecting and recording expected objects, categories and color alternatives. These are development samples, not held-out launch evidence or an end-to-end test of the latest queue changes.

| Fixture | Observed result | Time |
| --- | --- | --- |
| Handmade shoes in difficult sunlight, next to a shoemaking last | Two shoe records, both Shoes/beige; shoemaking last and background not detected as clothing. Bounds roughly correspond to the two visible shoes. | 86.288 seconds |
| Two overlapping bags on a red background | Two Accessories records, white and beige; background and decoration did not become extra garment records. | 85.257 seconds |

Brand and size remained blank as required. The shoe pair was represented by two records, so pair grouping still needs a product decision; users should not have to catalogue the left and right shoe separately. Attribute confidence is model-generated and uncalibrated. Material/formality guesses have not been validated by these checks.

Raw bounded metadata is in `candidate-handmade-shoes.json` and `candidate-handbag.json`; image licenses, checksums and blind labels are in `tests/fixtures/candidates/`. No private user images were used. The second sample overlapped CPU work from the integration tests, so these times are individual observations under this computer's load, not clean latency measurements, percentiles or capacity estimates. Broader category, negative-image, crop and real multi-item wardrobe coverage remains incomplete.
