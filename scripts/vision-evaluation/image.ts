import { createHash } from "node:crypto";
import type { Dimensions } from "./types";

/** Lowercase hex SHA-256 of the exact bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function exifOrientation(b: Buffer, start: number, end: number): number | null {
  if (start + 14 > end || b.toString("latin1", start, start + 6) !== "Exif\0\0") return null;
  return tiffOrientation(b, start + 6, end);
}

/** Orientation tag of a bare TIFF block (a JPEG APP1 payload after "Exif", or a WebP EXIF chunk). */
function tiffOrientation(b: Buffer, tiff: number, end: number): number | null {
  if (tiff + 8 > end) return null;
  const order = b.toString("latin1", tiff, tiff + 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(tiff + 2) !== 42) return null;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const entries = u16(ifd);
  for (let k = 0; k < entries; k++) {
    const e = ifd + 2 + 12 * k;
    if (e + 12 > end) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/**
 * Stored pixel size and EXIF orientation of a WebP (RIFF container: lossy VP8, lossless VP8L or
 * extended VP8X). Header reads only; a truncated or inconsistent container is null.
 */
function inspectWebp(b: Buffer): Dimensions | null {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const riffEnd = 8 + b.readUInt32LE(4);
  if (riffEnd > b.length || riffEnd < 20) return null;
  let width = 0;
  let height = 0;
  let orientation = 1;
  let sawFrame = false;
  let i = 12;
  while (i + 8 <= riffEnd) {
    const tag = b.toString("latin1", i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const body = i + 8;
    if (body + len > riffEnd) return null;
    if (tag === "VP8X" && len >= 10) {
      width = 1 + (b[body + 4] | (b[body + 5] << 8) | (b[body + 6] << 16));
      height = 1 + (b[body + 7] | (b[body + 8] << 8) | (b[body + 9] << 16));
      sawFrame = true;
    } else if (tag === "VP8 " && len >= 10 && !sawFrame) {
      if (b[body + 3] !== 0x9d || b[body + 4] !== 0x01 || b[body + 5] !== 0x2a) return null;
      width = b.readUInt16LE(body + 6) & 0x3fff;
      height = b.readUInt16LE(body + 8) & 0x3fff;
      sawFrame = true;
    } else if (tag === "VP8L" && len >= 5 && !sawFrame) {
      if (b[body] !== 0x2f) return null;
      const bits = b.readUInt32LE(body + 1);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
      sawFrame = true;
    } else if (tag === "EXIF") {
      const o = b.toString("latin1", body, body + 6) === "Exif\0\0" ? body + 6 : body;
      orientation = tiffOrientation(b, o, body + len) ?? orientation;
    }
    i = body + len + (len % 2);
  }
  return sawFrame && width > 0 && height > 0 ? { width, height, exifOrientation: orientation } : null;
}

/**
 * Stored pixel size and EXIF orientation of a JPEG, PNG or WebP, read from headers
 * only. Returns null for anything else or for a damaged header. This gives the
 * manifest's "originalDimensions" a way to be measured, not guessed.
 */
export function inspectImageBytes(b: Buffer): Dimensions | null {
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF") return inspectWebp(b);
  if (b.length >= 24 && PNG_SIGNATURE.every((v, i) => b[i] === v)) {
    if (b.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = b.readUInt32BE(16);
    const height = b.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height, exifOrientation: 1 } : null;
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = b[i + 1];
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // ended before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    if (marker === 0xe1) orientation = exifOrientation(b, i + 4, i + 2 + len) ?? orientation;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (len < 8) return null;
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height, exifOrientation: orientation } : null;
    }
    i += 2 + len;
  }
  return null;
}
