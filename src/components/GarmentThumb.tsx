import { isPhoto, type Garment } from "../domain/types";

export function GarmentThumb({ garment }: { garment: Garment }) {
  return isPhoto(garment.image) ? (
    // Local data URLs are already resized; they are never fetched remotely.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={garment.image} alt={garment.name} />
  ) : (
    <span>{garment.image}</span>
  );
}
