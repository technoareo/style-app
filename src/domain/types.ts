export type Garment = {
  id: string;
  name: string;
  category: string;
  color: string;
  brand: string;
  size: string;
  /** Emoji placeholder, or an image data URL (becomes a file path after the SQLite migration). */
  image: string;
  sourcePhoto?: string;
  pattern?: string;
  sleeve?: string;
  neckline?: string;
  closure?: string;
  length?: string;
  /** Only a visibly identifiable texture (denim, knit, leather...). Empty/absent = not known. */
  material?: string;
  fit?: "fitted" | "regular" | "relaxed" | "oversized" | "unknown";
  /** Suggestions the user confirmed or edited at review. */
  seasons?: Array<"spring" | "summer" | "autumn" | "winter">;
  occasions?: Array<"everyday" | "work" | "evening" | "active" | "lounge" | "event">;
  formality?: "casual" | "smart" | "formal" | "unknown";
  warmth?: "light" | "medium" | "warm" | "unknown";
  available?: boolean;
  reviewed?: boolean;
  confidence?: number;
  evidence?: string;
  photoHash?: string;
};

export type SavedLook = {
  id: string;
  name: string;
  createdAt: string;
  items: Garment[];
  occasion: string;
  /** The season the user chose when the look was made. Absent = no season was chosen. */
  season?: "spring" | "summer" | "autumn" | "winter";
};

/** Everything stored for one local profile. */
export type Space = {
  name: string;
  wardrobe: Garment[];
  saved: boolean;
  looks?: SavedLook[];
};

export const isPhoto = (image: string) =>
  image.startsWith("data:") || /^\/api\/photos\/[a-zA-Z0-9-]+$/.test(image);
