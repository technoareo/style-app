# Offline recognition evaluation harness (build 014)

Offline and model-agnostic. It never runs a model, opens a network connection or touches the app. It validates JSON that someone else produced and scores it. It alone does not show that recognition works, and it applies no launch threshold.

Run with `tsx scripts/vision-evaluation/run.ts <command>` (no npm script was added):

- `inspect <image>...` prints sha256 and stored width/height/EXIF orientation (JPEG/PNG headers), read-only. Use it to fill `originalDimensions`.
- `adapt-qwen --record R --fixture-id ID --manifest M --images-dir D --out NEW` converts the saved `docs/verification/qwen-compact-corners-013.json` into a prediction report. The operator asserts the image; no start time was recorded, so it cannot be used for held-out scoring.
- `score --manifest M... --annotations A... --predictions P --images-dir D --out NEW [--iou 0.5]` writes a new report. `--out` must not exist; the file is created with exclusive-create. Any problem below makes it refuse (exit 2) and write nothing.

`--iou` contract: text that is not a plain decimal is a usage error (exit 1); a number outside (0, 1], such as `0`, is a scoring refusal (exit 2). Neither writes output. `evaluate()` itself revalidates every typed manifest, annotation file and prediction report, so direct library calls get the same schema, contamination and split checks as file loading.

## What scoring refuses

Missing, unreadable or hash-mismatched images; unmeasured or differing dimensions; missing, unlabeled, draft, or model-made annotations; annotation/manifest split, hash or stratum inconsistencies; a prediction for another image or an unknown fixture; a held-out fixture that is a known development image, `priorInference: true`, listed in the development manifest, or has no `splitFrozenAt`; a held-out run with no `startedAt` or one before `splitFrozenAt`; unknown fields anywhere; truncated or invalid JSON files.

Hashes, `priorInference` and `splitFrozenAt` are self-reported provenance. The harness refuses contradictions; it cannot prove split history or that an image was never inferred.

## Output rules

Boxes are normalized corners `[x1,y1,x2,y2]` in 0..1 in display (EXIF-rotated) orientation, finite, with x2>x1 and y2>y1; nothing is clipped, swapped or widened. Categories are fixed: top, bottom, dress, outerwear, shoe, accessory. One invalid item makes its whole case `invalid_output`; truncated JSON is never repaired. Failed, timeout, truncated, invalid and missing cases keep their gold in every recall, count and attribute denominator and contribute no detections.

## Reading the report

Matching is deterministic one-to-one maximum matching at the IoU threshold (class-agnostic; maximum pairs, then maximum total IoU). Read these with care:

- `detection.precision` is null when nothing was predicted by a scored case; it is never 1 for a failure. `perImage.macroPrecision` covers scored images only; `failedImages` / `precisionUndefinedImages` sit next to it.
- `categoryAccuracyGivenGeometryMatch` is conditional on a match. `categoryCorrectOfAllGold` is not.
- Attribute `correct`/`wrong`/`notPredicted` are conditional on a match of a human-labelled gold value; `goldLabelledTotal` is the unconditional denominator. Only color and pattern exist; brand, size and material are never scored.
- Empty truth with empty prediction is `emptyTruthCorrect`, with null precision/recall.
- Development and held-out are separate; each is split into `single_item`, `crowded`, `no_garment`. A split with no case is null.

## Human labelling workflow

1. Choose images with a license that allows evaluation use. Do this before any model sees them.
2. Add them to `manifests/heldout.manifest.json` (or a new development manifest): file name, hash from `inspect`, dimensions, source/author/license, `stratum`, `priorInference: false`. Set `splitFrozenAt` to the time you freeze the list. Do not edit a fixture afterwards; a changed image is a new fixture.
3. Copy `templates/annotations-*.json`. For each image a person draws each visible garment box (display orientation), picks one category, `visibility` and `truncatedByFrame`, and sets `attributes` only if they labelled color/pattern themselves. Hangers and furniture are not garments. If nothing is visible set `emptyTruth: true`.
4. Set `labelStatus` to `single_human` (or `double_human_adjudicated` after two annotators resolve differences), list annotators as `human`, set `completedAt`.
5. Only after step 4 run models, record `run.startedAt`, then `score`.

Templates here are unlabeled on purpose; no label was created or guessed.
