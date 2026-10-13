import sharp from "sharp";
import { limits } from "./limits";
import {
  analysisSchema,
  VISION_PROMPT,
  visionOutputSchema,
  type Analysis,
} from "../domain/analysis";

/** Thrown for any photo/model problem that should surface a safe, user-facing message. */
export class VisionError extends Error {
  /**
   * "unavailable": the model could not be reached, timed out or was aborted
   * (a server-side failure; the user's attempt is refundable).
   * "unverified": the model answered but its output failed validation (the
   * inference ran and is charged).
   */
  constructor(
    message: string,
    public kind: "unavailable" | "unverified" | "unreadable" = "unreadable",
  ) {
    super(message);
  }
}

const MODEL = "qwen3-vl:4b-instruct";

/**
 * Base URL of the local Ollama server. Server-only, trusted configuration —
 * never accepted from a request. Defaults to Ollama's standard local port.
 */
function ollamaUrl(): string {
  return process.env.OLLAMA_URL?.trim() || "http://127.0.0.1:11434";
}

/** Whether the configured vision model is currently reachable and loaded. */
export async function isModelAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${ollamaUrl()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const tags = await response.json();
    return Boolean(
      tags.models?.some((m: { name: string }) => m.name === MODEL),
    );
  } catch {
    return false;
  }
}

/**
 * Decodes and re-encodes an uploaded photo into the canonical form used for
 * both storage and inference: EXIF-rotated, capped at 1600px, JPEG. Bounds
 * decode cost against decompression bombs via limitInputPixels.
 */
export async function normalizePhoto(
  bytes: Buffer,
  maxPixels = 32_000_000,
): Promise<Buffer> {
  try {
    return await sharp(bytes, { limitInputPixels: maxPixels })
      .rotate()
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    throw new VisionError(
      "This image could not be read. Try a different JPEG, PNG or WebP.",
    );
  }
}

export type VisionResult = { analysis: Analysis; image: string };

/**
 * Runs garment detection on an already-normalized (1600px JPEG) photo and
 * returns the validated analysis plus that same photo as a data URL, so the
 * client can crop against the exact pixels the model saw.
 */
export async function analyzePhoto(
  normalized: Buffer,
  signal?: AbortSignal,
): Promise<VisionResult> {
  const visionImage = await sharp(normalized)
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  let response: Response;
  try {
    response = await fetch(`${ollamaUrl()}/api/chat`, {
      method: "POST",
      signal: AbortSignal.any([
        AbortSignal.timeout(limits().inferenceTimeoutMs),
        ...(signal ? [signal] : []),
      ]),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: visionOutputSchema,
        think: false,
        options: { temperature: 0, num_ctx: 4096, num_predict: 2048 },
        messages: [
          {
            role: "user",
            images: [visionImage.toString("base64")],
            content:
              VISION_PROMPT +
              " Keep evidence and warning concise. Do not detect drawings or prints on clothing as separate items.",
          },
        ],
      }),
    });
  } catch {
    throw new VisionError(
      "Photo analysis is temporarily unavailable. Your wardrobe was not changed.",
      "unavailable",
    );
  }
  if (!response.ok)
    throw new VisionError(
      "Photo analysis is temporarily unavailable. Your wardrobe was not changed.",
      "unavailable",
    );

  let result: { message?: { content?: string } };
  try {
    result = await response.json();
  } catch {
    // Connection dropped or aborted while the answer was streaming back.
    throw new VisionError(
      "Photo analysis is temporarily unavailable. Your wardrobe was not changed.",
      "unavailable",
    );
  }
  const text = result.message?.content || "";
  let parsed: Analysis;
  try {
    const raw = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    let needsCrop = false;
    raw.items = (raw.items ?? []).map((item: { box: number[] }) => {
      const b = item.box;
      const valid =
        Array.isArray(b) &&
        b.length === 4 &&
        b.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000) &&
        b[2] - b[0] >= 30 &&
        b[3] - b[1] >= 30;
      if (!valid) needsCrop = true;
      return {
        ...item,
        // Native model coordinates are 0..1000 integers; normalize to 0..1,
        // falling back to the full frame when the model's box is unusable.
        box: valid
          ? [
              b[0] / 1000,
              b[1] / 1000,
              (b[2] - b[0]) / 1000,
              (b[3] - b[1]) / 1000,
            ]
          : [0, 0, 1, 1],
      };
    });
    if (needsCrop)
      raw.warning =
        "Some item bounds could not be verified. The full photo is shown instead; adjust and check each affected crop before saving.";
    parsed = analysisSchema.parse(raw);
  } catch {
    throw new VisionError(
      "The analysis could not be verified. Try another photo.",
      "unverified",
    );
  }

  // Whole-garment photos do not establish a label's brand or size. Keep these
  // optional fields for user confirmation, even if the model guesses them.
  parsed.items = parsed.items.map((item) => ({ ...item, brand: "", size: "" }));

  return {
    analysis: parsed,
    image: `data:image/jpeg;base64,${normalized.toString("base64")}`,
  };
}
