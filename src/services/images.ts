export async function imageFromFile(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("Choose a JPEG, PNG or WebP image. Convert HEIC first.");
  if (file.size > 6_000_000)
    throw new Error("Choose a photo smaller than 6 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 32_000_000)
      throw new Error("Choose a photo under 32 megapixels.");
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image processing is not available.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
/**
 * Returns an upload-safe version of an image data URL: unchanged when it is
 * already small (at most `maxSide` px and about 1.3 MB), otherwise re-encoded
 * as a JPEG no larger than `maxSide` on its longest side. Used before saving
 * photos and when importing backups, so the server's tight limits are met
 * without rejecting legitimate old data.
 */
export async function fitDataUrl(image: string, maxSide = 1600) {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(await (await fetch(image)).blob());
  } catch {
    throw new Error("A photo could not be read. Remove it and try again.");
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && image.length <= 1_800_000) return image;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image processing is not available.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
export async function cropImage(image: string, box: number[]) {
  const bitmap = await createImageBitmap(await (await fetch(image)).blob());
  try {
    const [x, y, w, h] = box;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * bitmap.width));
    canvas.height = Math.max(1, Math.round(h * bitmap.height));
    canvas
      .getContext("2d")!
      .drawImage(
        bitmap,
        x * bitmap.width,
        y * bitmap.height,
        w * bitmap.width,
        h * bitmap.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
export async function photoHash(image: string) {
  const bytes = new TextEncoder().encode(image);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
