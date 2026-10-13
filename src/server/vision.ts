import sharp from "sharp";
import { limits } from "./limits";
import {
  analysisSchema,
  CROWDED_WARNING,
  MAX_DETECTED_ITEMS,
  VISION_PROMPT,
  visionOutputSchema,
  type Analysis,
} from "../domain/analysis";

/** Thrown for any photo/model problem that should surface a safe, user-facing message. */
export class VisionError extends Error {
  /**
   * "unavailable": the model could not be reached, timed out or was aborted
   * (a server-side failure; the user's attempt is refundable).
   * "timeout": the inference deadline passed before the model finished (the
   * photo is too slow to analyze here; the attempt is refundable like
   * "unavailable", but the user is told to send a simpler photo).
   * "unverified": the model answered but its output failed validation (the
   * inference ran and is charged).
   */
  constructor(
    message: string,
    public kind:
      | "unavailable"
      | "timeout"
      | "unverified"
      | "unreadable" = "unreadable",
  ) {
    super(message);
  }
}

const MODEL = "qwen3-vl:4b-instruct";

const UNAVAILABLE_MESSAGE =
  "Photo analysis is temporarily unavailable. Your wardrobe was not changed.";
export const TOO_SLOW_MESSAGE =
  "This photo took too long to analyze. Try a clearer photo of one to three items with space between them.";
export const TOO_MANY_ITEMS_MESSAGE =
  "This photo has too many items to read reliably. Upload a clearer photo of one to three items with space between them.";
/**
 * Output bound for one answer: six items at about 85 tokens each plus the
 * warning, with room to spare. A grammar-limited answer never reaches it; if a
 * model ignores the item limit, the answer is cut here instead of running for
 * minutes (see the "length" handling below).
 */
const MAX_OUTPUT_TOKENS = 1100;
/** A chat answer larger than this is refused instead of buffered. */
const MAX_ANSWER_CHARS = 2_000_000;

/**
 * Reads Ollama's streamed chat answer (one JSON object per line) and returns
 * the joined text. Streaming means response headers arrive with the first
 * token, so the 5-minute header wait of the HTTP client no longer ends a slow
 * CPU inference; the only deadline is the explicit inference timeout. A server
 * that ignores `stream` and answers with one JSON body is read the same way.
 */
async function readChatAnswer(
  response: Response,
): Promise<{ content: string; doneReason?: string }> {
  if (!response.body) throw new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let pending = "";
  let content = "";
  let doneReason: string | undefined;
  let failedLine = false;
  /** Returns false when the text is not a JSON object. */
  const take = (line: string): boolean => {
    let part: {
      error?: unknown;
      done_reason?: string;
      message?: { content?: string };
    };
    try {
      part = JSON.parse(line);
    } catch {
      failedLine = true;
      return false;
    }
    if (part.error) throw new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
    content += part.message?.content ?? "";
    if (part.done_reason) doneReason = part.done_reason;
    return true;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    if (raw.length > MAX_ANSWER_CHARS) {
      void reader.cancel().catch(() => {});
      throw new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
    }
    pending += text;
    for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
      const line = pending.slice(0, i).trim();
      pending = pending.slice(i + 1);
      if (line) take(line);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) take(pending.trim());
  if (failedLine && !content) {
    // Not line-delimited (for example a pretty-printed single object).
    if (!take(raw)) throw new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
  }
  return { content, doneReason };
}

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

  // One explicit deadline for the whole inference. Reaching it while the caller
  // has not aborted means the photo is too slow to analyze here; any other
  // failure (unreachable, reset, caller abort) stays "unavailable".
  const deadline = AbortSignal.timeout(limits().inferenceTimeoutMs);
  let text: string;
  let doneReason: string | undefined;
  try {
    const response = await fetch(`${ollamaUrl()}/api/chat`, {
      method: "POST",
      signal: AbortSignal.any([deadline, ...(signal ? [signal] : [])]),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        format: visionOutputSchema,
        think: false,
        options: {
          temperature: 0,
          num_ctx: 4096,
          num_predict: MAX_OUTPUT_TOKENS,
        },
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
    if (!response.ok)
      throw new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
    ({ content: text, doneReason } = await readChatAnswer(response));
  } catch (error) {
    if (deadline.aborted && !signal?.aborted)
      throw new VisionError(TOO_SLOW_MESSAGE, "timeout");
    throw error instanceof VisionError
      ? error
      : new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
  }
  // The answer was cut at the output bound, so its JSON is incomplete: the
  // model kept listing garments past the item limit. Say what to do instead of
  // a generic verification failure (the inference ran and is charged).
  if (doneReason === "length")
    throw new VisionError(TOO_MANY_ITEMS_MESSAGE, "unverified");
  let parsed: Analysis;
  try {
    const raw = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    // A photo that fills the item limit is treated as crowded; anything past
    // the limit (a model that ignored it) is dropped, never listed.
    const found: unknown = raw.items ?? [];
    if (!Array.isArray(found)) throw new Error("items is not a list");
    const crowded = found.length >= MAX_DETECTED_ITEMS;
    let needsCrop = false;
    raw.items = found.slice(0, MAX_DETECTED_ITEMS).map((entry) => {
      const item = entry as { box: number[] };
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
    if (crowded)
      raw.warning = [
        typeof raw.warning === "string" ? raw.warning : "",
        CROWDED_WARNING,
      ]
        .filter(Boolean)
        .join(" ");
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
