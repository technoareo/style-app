import type { SavedLook } from "../domain/types";
import { GarmentThumb } from "./GarmentThumb";
export function SavedView({
  looks,
  onRemove,
  onExplore,
}: {
  looks: SavedLook[];
  onRemove: (id: string) => void;
  onExplore: () => void;
}) {
  return (
    <div className="page-title">
      <span className="eyebrow">YOUR PERSONAL EDIT</span>
      <h1>Saved looks</h1>
      <p>Keep a snapshot of a combination you love.</p>
      {!looks.length ? (
        <div className="empty-state">
          <h2>Your favorites belong here.</h2>
          <p>Build a look and save it for another day.</p>
          <button className="primary" onClick={onExplore}>
            Explore today’s look
          </button>
        </div>
      ) : (
        looks.map((look) => (
          <article className="outfit-panel saved-look" key={look.id}>
            <div className="outfit-top">
              <div>
                <h2>{look.name}</h2>
                <p>
                  {new Date(look.createdAt).toLocaleDateString()} ·{" "}
                  {look.occasion}
                </p>
              </div>
              <button
                className="danger-button"
                onClick={() => onRemove(look.id)}
              >
                Remove saved look
              </button>
            </div>
            <div className="look-items">
              {look.items.map((g) => (
                <div className="look-item" key={g.id}>
                  <div className="item-visual">
                    <GarmentThumb garment={g} />
                  </div>
                  <b>{g.name}</b>
                </div>
              ))}
            </div>
          </article>
        ))
      )}
    </div>
  );
}
