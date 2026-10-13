# Clothing recognition launch evaluation

Status: plan, not a passed benchmark. Perplexity proposed a versioned 120–200-photo evaluation covering garment categories, real capture conditions and difficult cases. Its numerical targets are suggestions, not an industry standard or measured model performance.

Create a separate development set and a held-out, versioned launch set of at least 120 licensed or consented real photos. Include all app categories (tops, bottoms, dresses, outerwear, shoes, accessories), single items and genuinely photographed multiple-item wardrobes, phone/hanger/floor/worn photos, light and dark garments, patterns, varied lighting, folding, overlap, partial crops and negative photos with no clothes. Keep a 60/25/15 easy/medium/hard split as a starting proposal and report results by slice, not just an aggregate.

Annotate visible item count, category, acceptable dominant-color synonyms, pattern where clear, bounding boxes, and which optional attributes are genuinely visible. Do not treat guessed material, warmth, fit, brand or size as ground truth. Reviewers must label images before viewing the model output, resolve disagreements, and preserve source licenses/consent. Keep personal faces and identifying backgrounds out of distributable fixtures.

Measure raw recognition separately from the confirmation workflow. A correct result after a person fixes every field does not prove automatic extraction accuracy. Suggested candidate launch gates for review:

- At least 90% raw category accuracy on clear single items; report multi-item detection precision/recall separately with target recall at least 85% on clearly visible garments.
- At least 80% dominant-color accuracy using an agreed synonym mapping, and 75% pattern accuracy on visibly annotated cases.
- Schema failures at most 2%; every failure must preserve the wardrobe and provide recovery.
- Measure duplicate/false detections and usable crop rate. Every candidate must remain reviewable and correctable; unconfirmed clothes must never enter outfit generation.
- Unsupported or obscured attributes must remain unknown. Report visible-evidence errors rather than hiding them in an overall accuracy figure.
- All generated outfit items must be owned, reviewed, available, and present in the current wardrobe. Required outfit categories and explicit formal/hot-weather constraints must pass every deterministic regression.
- Record upload, queue, inference, review and save times separately; report median and p95 on the actual launch server at the proposed concurrency. Do not apply Perplexity's background-removal-only latency proposal to the full vision pipeline.
- Record how often consumers must change categories, crops or colors, how many edits/time are needed to enter a useful wardrobe, and whether the resulting daily/event looks are usable. A model benchmark alone does not prove the consumer goal.

Existing shirt/hoodie/collage/empty-image smoke checks are useful regression examples and remain far below this coverage. No broad apparel accuracy or full-wardrobe detection claim is currently supported. A benchmark runner and annotation manifest remain to be implemented and populated; public release cannot be declared based on this plan.
