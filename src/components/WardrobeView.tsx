import { Plus, Upload } from "lucide-react";
import type { Garment } from "../domain/types";
import { WardrobeCard } from "./WardrobeCard";

type Props = {
  wardrobe: Garment[];
  collectionLabel: string;
  onUpload: () => void;
  onAddBlank: () => void;
  onEdit: (g: Garment) => void;
};

export function WardrobeView({
  wardrobe,
  collectionLabel,
  onUpload,
  onAddBlank,
  onEdit,
}: Props) {
  return (
    <>
      <div className="page-title">
        <span className="eyebrow">{collectionLabel}</span>
        <h1>My wardrobe</h1>
        <p>
          Everything you love, all in one place. Brand and size can be added to
          every piece.
        </p>
      </div>
      <div className="upload-banner">
        <div>
          <b>Upload photos of your clothes</b>
          <p>
            One item or several in a photo. Local AI finds visible pieces and
            suggests their details for you to review.
          </p>
          <small>
            JPEG, PNG or WebP · Up to 6 MB · Photograph items fully visible in
            good light.
          </small>
        </div>
        <button className="primary" onClick={onUpload}>
          <Upload size={16} /> Upload photos
        </button>
      </div>
      <div className="wardrobe-grid full-grid">
        {wardrobe.map((g) => (
          <WardrobeCard key={g.id} garment={g} onEdit={onEdit} />
        ))}
        <button className="add-card" onClick={onAddBlank}>
          <Plus />
          <b>Add an item manually</b>
          <span>Create a piece and enter its brand and size</span>
        </button>
      </div>
    </>
  );
}
