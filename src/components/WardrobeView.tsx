import { Plus, Search, SlidersHorizontal, Upload } from "lucide-react";
import { useMemo, useState } from "react";
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "ready" | "review" | "unavailable">("all");
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return wardrobe.filter((item) => {
      const matchesText = !normalized || [item.name, item.category, item.color, item.brand]
        .some((value) => value.toLowerCase().includes(normalized));
      const matchesFilter = filter === "all" ||
        (filter === "ready" && item.available !== false && item.reviewed !== false) ||
        (filter === "review" && item.reviewed === false) ||
        (filter === "unavailable" && item.available === false);
      return matchesText && matchesFilter;
    });
  }, [filter, query, wardrobe]);
  return (
    <>
      <div className="page-title">
        <span className="eyebrow">{collectionLabel}</span>
        <h1>Your closet</h1>
        <p>
          {wardrobe.length} {wardrobe.length === 1 ? "piece" : "pieces"}, ready for better everyday decisions.
        </p>
      </div>
      <div className="upload-banner">
        <div>
          <b>Upload a photo of each clothing item</b>
          <p>
            Use exactly one clothing item per photo. Local AI proposes its
            details, and you review and correct them.
          </p>
          <small>
            JPEG, PNG or WebP · Up to 6 MB · One item, fully visible, in good
            light.
          </small>
        </div>
        <button className="primary" onClick={onUpload}>
          <Upload size={16} /> Upload photos
        </button>
      </div>
      <div className="closet-tools">
        <label className="closet-search">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search closet</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search pieces" />
        </label>
        <div className="filter-row" aria-label="Filter closet">
          <SlidersHorizontal size={16} aria-hidden="true" />
          {(["all", "ready", "review", "unavailable"] as const).map((value) => (
            <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {value === "all" ? "All" : value === "review" ? "Needs review" : value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="wardrobe-grid full-grid">
        {visible.map((g) => (
          <WardrobeCard key={g.id} garment={g} onEdit={onEdit} />
        ))}
        {visible.length === 0 && wardrobe.length > 0 && (
          <div className="closet-no-results">
            <b>No pieces match</b>
            <span>Try another search or clear the filter.</span>
          </div>
        )}
        <button className="add-card" onClick={onAddBlank}>
          <Plus />
          <b>Add an item manually</b>
          <span>Create a piece and enter its brand and size</span>
        </button>
      </div>
    </>
  );
}
