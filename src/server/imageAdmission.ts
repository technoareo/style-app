import type { NextRequest } from "next/server";
import sharp, { type Metadata } from "sharp";
import { readJson, RequestError } from "./access";
import { limits } from "./limits";
import type { UploadRoute } from "./uploadMetrics";

/**
 * Admission rules for uploaded photos. The app's own client always sends a
 * canvas-normalized JPEG of at most 1600 px (src/services/images.ts), so the
 * limits here are tight around that and refuse everything else early:
 *
 *  1. Content-Length is checked before any body is read.
 *  2. The body is read with a size cap and a stall timeout.
 *  3. Size is checked on the decoded bytes; the claimed MIME type is never
 *     trusted, only the sniffed format.
 *  4. Raster dimensions are read from the file header (no pixel decode), so a
 *     small compressed file that expands to a huge raster is refused before
 *     sharp allocates anything for it.
 *
 * Callers wrap these steps in withImageWork() so only a few run at once.
 */

const UNREADABLE =
  "This image could not be read. Try a different JPEG, PNG or WebP.";

export type UploadInfo = { format: "jpeg" | "png" | "webp"; width: number; height: number };

/** Refuses an oversized request from its declared length, before reading it. */
export function assertDeclaredLength(req: NextRequest): void {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limits().maxBodyBytes)
    throw new RequestError(413, "This photo is too large to upload.");
}

/**
 * Decodes the base64 payload of a data URL. Only the prefix is matched with a
 * regular expression; the claimed MIME type is informational because the
 * format is sniffed from the bytes afterwards.
 */
export function decodeDataUrl(image: unknown): Buffer {
  const { maxUploadBytes, maxBodyBytes } = limits();
  if (typeof image !== "string" || image.length > maxBodyBytes)
    throw new RequestError(
      typeof image === "string" ? 413 : 400,
      typeof image === "string"
        ? "This photo is too large to upload."
        : "Use a JPEG, PNG or WebP photo.",
    );
  const match = /^data:image\/(?:jpeg|png|webp);base64,/.exec(
    image.slice(0, 40),
  );
  if (!match) throw new RequestError(400, "Use a JPEG, PNG or WebP photo.");
  const payload = image.slice(match[0].length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload))
    throw new RequestError(400, UNREADABLE);
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > maxUploadBytes)
    throw new RequestError(
      413,
      `Photo must be under ${(maxUploadBytes / 1_000_000).toFixed(1)} MB. The app shrinks photos automatically; try again from the upload dialog.`,
    );
  if (bytes.length < 16) throw new RequestError(400, UNREADABLE);
  return bytes;
}

/**
 * Reads only the container header. Rejects unsupported or animated files and
 * anything larger than the configured side or pixel budget, without decoding.
 */
export async function inspectUpload(bytes: Buffer): Promise<UploadInfo> {
  const { maxUploadSide, maxUploadPixels } = limits();
  let meta: Metadata;
  try {
    // metadata() reads the container header only; no pixels are decoded.
    meta = await sharp(bytes).metadata();
  } catch {
    throw new RequestError(400, UNREADABLE);
  }
  const { format, width, height, pages } = meta;
  if (
    (format !== "jpeg" && format !== "png" && format !== "webp") ||
    !width ||
    !height
  )
    throw new RequestError(400, UNREADABLE);
  if ((pages ?? 1) > 1)
    throw new RequestError(400, "Animated images are not supported.");
  if (
    Math.max(width, height) > maxUploadSide ||
    width * height > maxUploadPixels
  )
    throw new RequestError(
      413,
      `Photo dimensions are too large (${width}×${height}). Use a photo up to ${maxUploadSide}px on its longest side.`,
    );
  return { format, width, height };
}

/**
 * Body read -> data URL decode -> header inspection, as one unit of image work.
 * Returns the raw image bytes plus any other JSON fields of the request.
 */
export async function readUploadRequest(
  req: NextRequest,
  validate?: (body: Record<string, unknown>) => void,
  route: UploadRoute = "other",
): Promise<{ body: Record<string, unknown>; bytes: Buffer; info: UploadInfo }> {
  const body = (await readJson(req, limits().maxBodyBytes, {
    timeoutMs: limits().bodyReadTimeoutMs,
    route,
  })) as Record<string, unknown>;
  if (!body || typeof body !== "object")
    throw new RequestError(400, "The request could not be read.");
  validate?.(body);
  const bytes = decodeDataUrl(body.image);
  const info = await inspectUpload(bytes);
  return { body, bytes, info };
}
