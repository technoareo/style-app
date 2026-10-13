import { Pencil } from "lucide-react";
import type { Garment } from "../domain/types";
import { GarmentThumb } from "./GarmentThumb";

export function WardrobeCard({
  garment,
  onEdit,
}: {
  garment: Garment;
  onEdit: (g: Garment) => void;
}) {
  return (
    <article className="wardrobe-card">
      <div className="wardrobe-image">
        <GarmentThumb garment={garment} />
        <button
          className="edit-fab"
          onClick={() => onEdit({ ...garment })}
          aria-label={`Edit ${garment.name}`}
        >
          <Pencil size={14} />
        </button>
      </div>
      <div className="wardrobe-info">
        <b>{garment.name}</b>
        <span>
          {garment.category}
          {garment.color ? ` · ${garment.color}` : ""}
        </span>
        <span className="item-meta">
          {garment.brand || "Brand not set"}
          {garment.size ? ` · Size ${garment.size}` : " · Size not set"}
        </span>
        <span>
          {garment.available === false
            ? "Unavailable to wear"
            : garment.reviewed === false
              ? "Needs review"
              : "Ready to style"}
          {["1", "2", "3", "4"].includes(garment.id) ? " · Sample item" : ""}
        </span>
      </div>
    </article>
  );
}
