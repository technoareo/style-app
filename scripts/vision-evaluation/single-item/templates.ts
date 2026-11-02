import { DEFAULT_POLICY } from "./policy";

/**
 * Blank templates for the single-item workflow. They are deliberately INVALID
 * until a person fills them in: every value that needs a decision holds a
 * REPLACE-... placeholder or null, so validation refuses them. No label, hash,
 * licence or rights statement is guessed here.
 */

const TODO = (what: string) => `REPLACE-${what}`;

export const manifestTemplate = () => ({
  schemaVersion: 1,
  kind: "single-item-manifest",
  benchmarkId: "single-item-v1",
  split: "heldout",
  frozenAt: null,
  purpose: "Held-out single-prominent-item benchmark. Freeze with single-freeze BEFORE any model sees an image.",
  fixtures: [
    {
      id: TODO("lowercase-id"),
      file: TODO("file-name.jpg"),
      sha256: TODO("64-hex-from-inspect"),
      dimensions: null,
      addedAt: TODO("iso-timestamp"),
      sceneType: TODO("flat_lay|hanging|mannequin|worn|surface_or_floor|product_shot|other"),
      stratum: TODO("in_scope|rejection"),
      rejectionReason: null,
      sourceShootId: TODO("same-shoot-or-uploader-session-id"),
      garmentId: TODO("same-physical-garment-or-product-id"),
      priorInference: false,
      priorInferenceNote: null,
      rights: {
        sourceCollection: TODO("wikimedia-commons|open-images|self-owned-with-release|other-verified"),
        sourcePageUrl: TODO("https-page-a-person-opened"),
        originalUrl: TODO("https-file-url"),
        creator: TODO("creator-name"),
        license: { id: TODO("CC0|PDM|CC-BY|CC-BY-SA"), version: TODO("version"), url: TODO("https-licence-url") },
        retrievedAt: TODO("iso-date"),
        attribution: TODO("attribution-text"),
        modifications: [],
        originalSha256: TODO("64-hex"),
        distributedSha256: TODO("64-hex"),
        verifiedBy: TODO("person-who-checked-rights"),
        verifiedAt: TODO("iso-date"),
      },
      notes: null,
    },
  ],
});

export const goldTemplate = () => ({
  schemaVersion: 1,
  kind: "single-item-gold",
  benchmarkId: "single-item-v1",
  split: "heldout",
  labels: [
    {
      imageId: TODO("fixture-id"),
      imageSha256: TODO("64-hex"),
      outcome: TODO("single_item|reject"),
      rejectionReason: null,
      item: {
        category: TODO("top|bottom|dress|outerwear|shoe|accessory"),
        color: TODO("coarse-colour"),
        pattern: TODO("solid|striped|checked|floral|dotted|graphic|other_pattern"),
        fit: TODO("fitted|regular|relaxed|oversized|unknown"),
        material: TODO("visible-texture|none_visible|unknown"),
        box: null,
        seasons: [],
        occasions: [],
      },
      annotation: {
        status: TODO("single_human|double_human_adjudicated"),
        annotators: [{ id: TODO("person"), kind: "human" }],
        completedAt: TODO("iso-timestamp"),
        tool: null,
        modelAssisted: false,
        notes: null,
      },
    },
  ],
});

export const recordTemplate = () => ({
  schemaVersion: 1,
  kind: "analyze-photo-record",
  fixtureId: TODO("fixture-id"),
  imageSha256: TODO("64-hex-of-the-image-analysed"),
  model: TODO("model-name"),
  modelVersion: TODO("model-digest-or-version"),
  promptId: TODO("prompt-id"),
  startedAt: TODO("iso-timestamp"),
  elapsedMs: null,
  timeoutMs: null,
  outcome: TODO("ok|timeout|unavailable|unverified"),
  error: null,
  analysis: null,
});

/** The proposed policy, unsigned. Copy it, change what the owner decides, then add an approval record. */
export const policyTemplate = () => structuredClone(DEFAULT_POLICY);

export const templates = {
  manifest: manifestTemplate,
  gold: goldTemplate,
  record: recordTemplate,
  policy: policyTemplate,
} as const;
