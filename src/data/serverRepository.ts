import type { Garment, SavedLook } from "../domain/types";
import { backupSchema } from "../domain/backup";
import { fitDataUrl } from "../services/images";
export type AccountWardrobe = {
  version: 1;
  name: string;
  wardrobe: Garment[];
  looks: SavedLook[];
  revision: number;
};
/** A refused request; `message` is exactly what the server said. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
async function request(
  url: string,
  method = "GET",
  body?: unknown,
  userId?: string,
) {
  const r = await fetch(url, {
    method,
    headers: body
      ? { "Content-Type": "application/json", "X-Style-Account": userId || "" }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok)
    throw new ApiError(
      data.error || "Your wardrobe could not be saved.",
      r.status,
      typeof data.code === "string" ? data.code : undefined,
      typeof data.retryAfterSeconds === "number"
        ? data.retryAfterSeconds
        : undefined,
    );
  return data;
}
/**
 * The server processes one photo per account at a time (shared with photo
 * analysis). If another upload from this same account is still being read, it
 * says so with a retryable 429 and nothing was stored, so waiting the hinted
 * time and repeating the same upload is safe (the server de-duplicates photos
 * by content hash). Only this refusal is retried, a few times; every other
 * error, including an account switch (409), is reported at once.
 */
const SAME_ACCOUNT_RETRIES = 3;
async function postPhoto(image: string, userId: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await request("/api/photos", "POST", { image }, userId))
        .image as string;
    } catch (e) {
      if (
        !(e instanceof ApiError) ||
        e.code !== "upload-in-progress" ||
        attempt >= SAME_ACCOUNT_RETRIES
      )
        throw e;
      const seconds = Math.min(5, Math.max(1, e.retryAfterSeconds ?? 3));
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  }
}
export async function loadAccountWardrobe(): Promise<AccountWardrobe> {
  return request("/api/wardrobe");
}
async function upload(image: string, userId: string) {
  if (!image.startsWith("data:")) return image;
  // The server accepts only what this client's own normalization produces
  // (JPEG/PNG/WebP up to 2400 px, 2.5 MB). Older or imported backups can hold
  // larger images, so shrink them here first.
  const fitted = await fitDataUrl(image);
  return postPhoto(fitted, userId);
}
export async function saveAccountWardrobe(
  space: AccountWardrobe,
  userId: string,
): Promise<AccountWardrobe> {
  const cache = new Map<string, string>();
  async function item(g: Garment) {
    let image = cache.get(g.image);
    if (!image) {
      image = await upload(g.image, userId);
      cache.set(g.image, image);
    }
    return { ...g, image, sourcePhoto: undefined };
  }
  const wardrobe: Garment[] = [];
  for (const g of space.wardrobe) wardrobe.push(await item(g));
  const looks: SavedLook[] = [];
  for (const l of space.looks) {
    const items: Garment[] = [];
    for (const g of l.items) items.push(await item(g));
    looks.push({ ...l, items });
  }
  const normalized = { ...space, wardrobe, looks };
  const result = await request("/api/wardrobe", "PUT", normalized, userId);
  return { ...normalized, revision: result.revision };
}
export async function portableBackup(space: AccountWardrobe) {
  const images = new Map<string, string>();
  async function portable(g: Garment) {
    if (!g.image.startsWith("/api/photos/")) return g;
    let image = images.get(g.image);
    if (!image) {
      const r = await fetch(g.image, { cache: "no-store" });
      if (!r.ok)
        throw new Error("A photo could not be exported. Please retry.");
      image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        r.blob()
          .then((b) => reader.readAsDataURL(b))
          .catch(reject);
      });
      images.set(g.image, image);
    }
    return { ...g, image };
  }
  const wardrobe: Garment[] = [];
  for (const g of space.wardrobe) wardrobe.push(await portable(g));
  const looks: SavedLook[] = [];
  for (const l of space.looks) {
    const items: Garment[] = [];
    for (const g of l.items) items.push(await portable(g));
    looks.push({ ...l, items });
  }
  return backupSchema.parse({ ...space, wardrobe, looks });
}
