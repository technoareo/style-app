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
/**
 * The answer hit the output bound and was cut off. A token bound does not prove
 * the photo holds too many items (verbose items can reach it too), so the
 * message names no cause.
 */
export const ANSWER_CUT_MESSAGE =
  "The analysis was cut short before it finished. Try a clearer photo of one to three items with space between them.";
/**
 * Output bound for one answer: six items at about 85 tokens each plus the
 * warning, with room to spare. A grammar-limited answer never reaches it; if a
 * model ignores the item limit, the answer is cut here instead of running for
 * minutes (see the "length" handling below).
 */
const MAX_OUTPUT_TOKENS = 1100;
/** A chat answer larger than this is refused instead of buffered. */
const MAX_ANSWER_CHARS = 2_000_000;

/** Longest wait for an upstream cancellation to settle during cleanup. */
const CANCEL_WAIT_MS = 1000;
/**
 * Longest unconsumed text (one NDJSON line, or a whole one-body answer): far
 * above any real answer (about 1100 tokens), far below MAX_ANSWER_CHARS.
 */
const MAX_PENDING_CHARS = 512_000;

const protocolError = () => new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Ends the upstream request. The abort comes FIRST and synchronously, so the
 * connection is closed even if cancelling the body would hang; the cancellation
 * is then awaited for at most CANCEL_WAIT_MS. Never throws, so it cannot
 * replace the failure that is being cleaned up after.
 */
async function abandonUpstream(
  upstream: AbortController,
  body: { cancel(): Promise<void> } | null | undefined,
): Promise<void> {
  upstream.abort();
  if (!body) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      body.cancel().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CANCEL_WAIT_MS);
      }),
    ]);
  } catch {
    // Cleanup only.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads Ollama's streamed chat answer and returns the joined text. Streaming
 * means response headers arrive with the first token, so the 5-minute header
 * wait of the HTTP client no longer ends a slow CPU inference; the only
 * deadline is the explicit inference timeout.
 *
 * The protocol is validated completely; anything else is "unavailable":
 *  - chunked NDJSON: every non-blank line (CRLF allowed, a missing final
 *    newline allowed) is one JSON object;
 *  - one JSON body (compact or pretty-printed), for a server that ignores
 *    `stream`. Chosen from the first non-blank line: a line that is a whole
 *    JSON object selects NDJSON; a first line that is exactly `{` (a
 *    pretty-printed object) selects the one-body path, which is buffered
 *    (bounded) and must be one JSON object at the end; anything else is
 *    refused at once. An `application/x-ndjson` response never takes the
 *    one-body path;
 *  - every object has an object `message` with a string `content`, a boolean
 *    `done` and a string `done_reason` where present, and no truthy `error`;
 *  - exactly one object has `done: true`, it is the LAST one (only whitespace
 *    may follow), and a stream that ends without it is truncated;
 *  - the bytes are valid UTF-8, and at most MAX_ANSWER_CHARS arrive.
 * On any failure the request is aborted and the body cancelled (see
 * abandonUpstream) and the reader lock is released.
 */
async function readChatAnswer(
  response: Response,
  upstream: AbortController,
): Promise<{ content: string; doneReason?: string }> {
  if (!response.body) {
    await abandonUpstream(upstream, null);
    throw protocolError();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const declaredNdjson = /ndjson|jsonl/i.test(
    response.headers.get("content-type") ?? "",
  );
  let mode: "auto" | "ndjson" | "whole" = declaredNdjson ? "ndjson" : "auto";
  let pending = "";
  let received = 0;
  let content = "";
  let doneReason: string | undefined;
  let terminal = false;
  const take = (value: unknown): void => {
    if (!isPlainObject(value) || terminal) throw protocolError();
    if (value.error) throw protocolError();
    const { message, done, done_reason: reason } = value;
    const envelope: Record<string, unknown> | null =
      message === undefined ? {} : isPlainObject(message) ? message : null;
    if (!envelope) throw protocolError();
    const piece = envelope.content;
    if (piece !== undefined && typeof piece !== "string") throw protocolError();
    if (done !== undefined && typeof done !== "boolean") throw protocolError();
    if (reason !== undefined && typeof reason !== "string")
      throw protocolError();
    content += piece ?? "";
    if (content.length > MAX_ANSWER_CHARS) throw protocolError();
    if (done === true) {
      terminal = true;
      doneReason = reason;
    }
  };
  const takeText = (text: string): void => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw protocolError();
    }
    take(value);
  };
  /** Consumes complete lines; `final` also consumes an unterminated rest. */
  const drain = (final: boolean): void => {
    let cursor = 0;
    while (mode !== "whole") {
      if (mode === "auto") {
        // Leading text that cannot start an object is refused at once.
        const lead = pending.slice(cursor).search(/\S/);
        if (lead >= 0 && pending[cursor + lead] !== "{") throw protocolError();
      }
      const end = pending.indexOf("\n", cursor);
      if (end < 0) break;
      const line = pending.slice(cursor, end).trim();
      if (!line) {
        cursor = end + 1;
        continue;
      }
      if (mode === "auto") {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          // A pretty-printed single object opens with a line that is only
          // "{". Any other first line that is not a whole object is refused
          // now, not buffered until the stream ends.
          if (line !== "{") throw protocolError();
          mode = "whole";
          break;
        }
        mode = "ndjson";
        take(value);
      } else takeText(line);
      cursor = end + 1;
    }
    pending = pending.slice(cursor);
    if (pending.length > MAX_PENDING_CHARS) throw protocolError();
    if (!final) return;
    const rest = pending.trim();
    pending = "";
    if (!rest) return;
    // An unterminated last line (NDJSON) or the whole one-body answer.
    takeText(rest);
  };
  let failed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let text: string;
      try {
        text = decoder.decode(value, { stream: true });
      } catch {
        throw protocolError();
      }
      received += text.length;
      if (received > MAX_ANSWER_CHARS) throw protocolError();
      pending += text;
      drain(false);
    }
    try {
      pending += decoder.decode();
    } catch {
      throw protocolError();
    }
    drain(true);
    // No terminal object: the stream was cut short (or never a model answer).
    if (!terminal) throw protocolError();
    return { content, doneReason };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) await abandonUpstream(upstream, reader);
    try {
      reader.releaseLock();
    } catch {
      // Already released or errored: nothing left to do.
    }
  }
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
  // Aborted by us (never by the deadline or the caller) when the answer is
  // refused, so a server that keeps the connection open stops generating. It is
  // a third, separate signal: it cannot change the classification below.
  const upstream = new AbortController();
  let text: string;
  let doneReason: string | undefined;
  try {
    const response = await fetch(`${ollamaUrl()}/api/chat`, {
      method: "POST",
      signal: AbortSignal.any([
        deadline,
        upstream.signal,
        ...(signal ? [signal] : []),
      ]),
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
    if (!response.ok) {
      await abandonUpstream(upstream, response.body);
      throw new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
    }
    ({ content: text, doneReason } = await readChatAnswer(response, upstream));
  } catch (error) {
    upstream.abort(); // idempotent; also covers a failure before any body
    // A refusal raised here already carries its kind and wins over a deadline
    // that happened to pass while the stream was being closed. A read that was
    // interrupted by the deadline or the caller arrives as a plain error.
    if (error instanceof VisionError) throw error;
    if (deadline.aborted && !signal?.aborted)
      throw new VisionError(TOO_SLOW_MESSAGE, "timeout");
    throw new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
  }
  // The answer was cut at the output bound, so its JSON is incomplete. The
  // bound does not say why (too many items, or verbose ones), so the message
  // names no cause (the inference ran and is charged).
  if (doneReason === "length")
    throw new VisionError(ANSWER_CUT_MESSAGE, "unverified");
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
