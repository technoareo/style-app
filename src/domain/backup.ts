import { z } from "zod";
import { FITS, OCCASIONS, SEASONS } from "./analysis";
const image = z
  .string()
  .max(9_000_000)
  .refine(
    (s) =>
      !s.startsWith("data:") ||
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s),
    "Invalid photo",
  );
const garment = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  category: z.string().max(60),
  color: z.string().max(60),
  brand: z.string().max(80),
  size: z.string().max(40),
  image,
  sourcePhoto: image.optional(),
  pattern: z.string().max(60).optional(),
  sleeve: z.string().max(60).optional(),
  neckline: z.string().max(60).optional(),
  closure: z.string().max(60).optional(),
  length: z.string().max(60).optional(),
  material: z.string().max(60).optional(),
  fit: z.enum(FITS).optional(),
  seasons: z.array(z.enum(SEASONS)).max(4).optional(),
  occasions: z.array(z.enum(OCCASIONS)).max(4).optional(),
  formality: z.enum(["casual", "smart", "formal", "unknown"]).optional(),
  warmth: z.enum(["light", "medium", "warm", "unknown"]).optional(),
  available: z.boolean().optional(),
  reviewed: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().max(250).optional(),
  photoHash: z.string().max(100).optional(),
});
export const backupSchema = z.object({
  version: z.literal(1),
  name: z.string().max(100),
  wardrobe: z
    .array(garment)
    .max(2000)
    .refine(
      (items) => new Set(items.map((g) => g.id)).size === items.length,
      "Duplicate item IDs",
    ),
  looks: z
    .array(
      z.object({
        id: z.string().max(100),
        name: z.string().max(100),
        occasion: z.string().max(60),
        season: z.enum(SEASONS).optional(),
        createdAt: z.string().datetime(),
        items: z.array(garment).max(10),
      }),
    )
    .max(1000),
});
