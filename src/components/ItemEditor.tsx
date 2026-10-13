import { useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { isPhoto, type Garment } from "../domain/types";
import { Dialog } from "./Dialog";

type Props = {
  garment: Garment;
  onSave: (g: Garment) => void;
  onRemove: (id: string) => void;
  onAddFromPhoto: (photo: string) => void;
  onClose: () => void;
};

type TextField =
  | "name"
  | "category"
  | "color"
  | "brand"
  | "size"
  | "pattern"
  | "sleeve"
  | "neckline"
  | "closure"
  | "length";

export function ItemEditor({
  garment,
  onSave,
  onRemove,
  onAddFromPhoto,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(garment);
  const field = (key: TextField, label: string, placeholder?: string) => (
    <>
      <label htmlFor={`edit-${key}`}>{label}</label>
      <input
        id={`edit-${key}`}
        placeholder={placeholder}
        value={draft[key] || ""}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </>
  );

  return (
    <Dialog title="Edit item details" onClose={onClose}>
      <span className="eyebrow">WARDROBE ITEM</span>
      {isPhoto(draft.image) && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="edit-preview"
          src={draft.image}
          alt="Wardrobe item preview"
        />
      )}
      {field("name", "Item name")}
      <label htmlFor="edit-category">Category</label>
      <select
        id="edit-category"
        value={draft.category}
        onChange={(e) => setDraft({ ...draft, category: e.target.value })}
      >
        {[
          "Tops",
          "Bottoms",
          "Dresses",
          "Outerwear",
          "Shoes",
          "Accessories",
          "Unsorted",
        ].map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      {field("color", "Color", "e.g. Navy")}
      {field("pattern", "Pattern", "e.g. Solid, striped, floral")}
      {field("sleeve", "Sleeve", "e.g. Short, long, sleeveless")}
      {field("neckline", "Neckline", "e.g. Crew, V-neck, collared")}
      {field("closure", "Closure", "e.g. Pullover, buttons, zip")}
      {field("length", "Length", "e.g. Cropped, hip, knee, full")}
      {field("brand", "Brand", "e.g. COS")}
      {field("size", "Size", "e.g. M, 8, 30x32")}
      <label htmlFor="edit-formality">Dress code</label>
      <select
        id="edit-formality"
        value={draft.formality || "unknown"}
        onChange={(e) =>
          setDraft({
            ...draft,
            formality: e.target.value as Garment["formality"],
          })
        }
      >
        {["unknown", "casual", "smart", "formal"].map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <label htmlFor="edit-warmth">Warmth (confirm from experience)</label>
      <select
        id="edit-warmth"
        value={draft.warmth || "unknown"}
        onChange={(e) =>
          setDraft({ ...draft, warmth: e.target.value as Garment["warmth"] })
        }
      >
        {["unknown", "light", "medium", "warm"].map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <label className="check-row">
        <input
          type="checkbox"
          checked={draft.available !== false}
          onChange={(e) => setDraft({ ...draft, available: e.target.checked })}
        />
        Available to wear
      </label>
      {draft.evidence && <p>{draft.evidence}</p>}
      <div className="modal-actions">
        <button className="danger-button" onClick={() => onRemove(draft.id)}>
          <Trash2 size={15} /> Remove
        </button>
        <button
          className="primary"
          disabled={!draft.name.trim() || draft.category === "Unsorted"}
          onClick={() => onSave({ ...draft, reviewed: true })}
        >
          <Check size={15} /> Save details
        </button>
      </div>
      <small>
        Unknown details are fine. Confirm category before using this item in an
        outfit.
      </small>
    </Dialog>
  );
}
