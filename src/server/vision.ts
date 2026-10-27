import sharp from "sharp";
import { limits } from "./limits";
import {
  ANALYSIS_MODE,
  analysisSchema,
  cleanModelWarning,
  composeWarning,
  parseAnalysisMode,
  reviewAnalysisSchema,
  PROMPT_SUFFIX,
  usableBox,
  CROP_UNVERIFIED_WARNING,
  CROWDED_WARNING,
  MAX_DETECTED_ITEMS,
  evidencedShoePair,
  mostProminentIndex,
  MULTIPLE_ITEMS_WARNING,
  refineSingleItem,
  SHOE_PAIR_WARNING,
  SINGLE_ITEM_PROMPT,
  singleVisionOutputSchema,
  VISION_PROMPT,
  visionOutputSchema,
  type Analysis,
  type AnalysisMode,
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

/** Used when VISION_MODEL is unset or blank. docs/DEPLOYMENT.md and README pull this tag. */
export const DEFAULT_VISION_MODEL = "qwen3-vl:4b-instruct";
/**
 * An Ollama model reference: optional namespace path, a name and an optional
 * tag, ASCII letters, digits, dot, underscore and hyphen only. No whitespace,
 * quotes, slashes at the ends or control characters; at most 100 characters.
 * (Ollama's tag syntax is the same shape, for example qwen3-vl:4b-instruct or
 * library/llava:7b.)
 */
const MODEL_REFERENCE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/**
 * The vision model this process uses, from VISION_MODEL (trusted server
 * configuration; never taken from a request). Unset or blank gives the
 * default. A set but malformed value is NOT replaced by the default: silently
 * running a different model than the operator named would hide the mistake, so
 * the model is reported as unusable (analysis stays unavailable, refundable)
 * until it is fixed. The app, the AI worker and the readiness check all call
 * this, so they cannot disagree.
 */
export function configuredVisionModel(
  env: Record<string, string | undefined> = process.env,
): { ok: true; name: string } | { ok: false } {
  const raw = env.VISION_MODEL;
  if (raw === undefined || raw.trim() === "") return { ok: true, name: DEFAULT_VISION_MODEL };
  const name = raw.trim();
  if (name.length > 100 || !MODEL_REFERENCE.test(name)) return { ok: false };
  return { ok: true, name };
}

let reportedBadModel = false;
function visionModelOrNull(): string | null {
  const model = configuredVisionModel();
  if (model.ok) return model.name;
  if (!reportedBadModel) {
    reportedBadModel = true;
    // Fixed text only: the bad value is not echoed (it could hold anything).
    console.error(
      "[vision] VISION_MODEL is not a valid model name; photo analysis is unavailable until it is fixed",
    );
  }
  return null;
}

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
/**
 * One item with its attribute lists is about 200 tokens; the schema allows up
 * to MAX_SINGLE_CANDIDATES entries so a second item can be DETECTED (only the
 * first is ever shown). A single-item photo still normally produces one entry,
 * so latency is not meant to grow; a three-entry answer plus the warning fits.
 */
const MAX_SINGLE_OUTPUT_TOKENS = 900;
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
  const model = visionModelOrNull();
  if (!model) return false;
  // A malformed STYLE_ANALYSIS_MODE refuses new jobs (see enqueueAnalysisJob),
  // so readiness must say so instead of offering uploads that cannot be accepted.
  if (parseAnalysisMode(process.env.STYLE_ANALYSIS_MODE) === null) return false;
  // Ollama lists an untagged pull as "<name>:latest".
  const wanted = model.includes(":") ? model : `${model}:latest`;
  try {
    const response = await fetch(`${ollamaUrl()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const tags = await response.json();
    return Boolean(
      tags.models?.some(
        (m: { name: string }) => m.name === model || m.name === wanted,
      ),
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
  options: { mode?: AnalysisMode } = {},
): Promise<VisionResult> {
  const mode = options.mode ?? ANALYSIS_MODE;
  const single = mode === "single";
  const model = visionModelOrNull();
  // A malformed VISION_MODEL is a server configuration fault: refundable, and
  // no request is sent to Ollama.
  if (!model) throw new VisionError(UNAVAILABLE_MESSAGE, "unavailable");
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
        model,
        stream: true,
        format: single ? singleVisionOutputSchema : visionOutputSchema,
        think: false,
        options: {
          temperature: 0,
          num_ctx: 4096,
          num_predict: single ? MAX_SINGLE_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
        },
        messages: [
          {
            role: "user",
            images: [visionImage.toString("base64")],
            content:
              (single ? SINGLE_ITEM_PROMPT : VISION_PROMPT) + PROMPT_SUFFIX,
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
    // Drop empty placeholders and instruction echoes; keep every real finding.
    raw.warning = cleanModelWarning(raw.warning);
    const listed: unknown = raw.items ?? [];
    if (!Array.isArray(listed)) throw new Error("items is not a list");
    // Single-item mode: a model that lists several (or one that ignored the
    // schema) is cut to its most prominent item and the user is told; nothing
    // else is ever listed. Multi-item mode keeps the crowded-photo rule.
    // Two shoes listed separately are treated as one pair ONLY on robust
    // evidence (see evidencedShoePair); the user is told to check the crop.
    const pair = single ? evidencedShoePair(listed) : null;
    const multiple = single && listed.length > 1 && !pair;
    const found: unknown[] = pair
      ? [pair]
      : multiple
        ? [listed[mostProminentIndex(listed)]]
        : listed;
    const limit = single ? 1 : MAX_DETECTED_ITEMS;
    const crowded = !single && found.length >= MAX_DETECTED_ITEMS;
    let needsCrop = false;
    raw.items = found.slice(0, limit).map((entry) => {
      const item = (single ? refineSingleItem(entry) : entry) as {
        box: number[];
      };
      // The SAME rule that chose the item (usableBox: inside the frame, a slight
      // overshoot clamped, at least 30/1000 on each side).
      const b = usableBox(item.box);
      if (!b) needsCrop = true;
      return {
        ...item,
        // Native model coordinates are 0..1000 integers; normalize to 0..1,
        // falling back to the full frame when the model's box is unusable.
        box: b
          ? [
              b[0] / 1000,
              b[1] / 1000,
              (b[2] - b[0]) / 1000,
              (b[3] - b[1]) / 1000,
            ]
          : [0, 0, 1, 1],
      };
    });
    // Every notice is APPENDED to what the model said (already cleaned): a crop
    // notice must not hide a real finding such as "the photo is blurry".
    const notices = [
      needsCrop ? CROP_UNVERIFIED_WARNING : "",
      pair ? SHOE_PAIR_WARNING : "",
      multiple ? MULTIPLE_ITEMS_WARNING : "",
      crowded ? CROWDED_WARNING : "",
    ];
    raw.warning = composeWarning(
      typeof raw.warning === "string" ? raw.warning : "",
      notices,
    );
    // Single-item results may carry an unnamed item (the review makes the user
    // name it); multi-item verification is unchanged.
    parsed = (single ? reviewAnalysisSchema : analysisSchema).parse(raw);
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
