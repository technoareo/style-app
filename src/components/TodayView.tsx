import { Heart, Plus, Shuffle, Sparkles } from "lucide-react";
import type { Garment } from "../domain/types";
import {
  seasonTemperatureWarning,
  type LookResult,
  type StyleContext,
} from "../domain/outfit";
import { GarmentThumb } from "./GarmentThumb";
import { WardrobeCard } from "./WardrobeCard";
type Props = {
  wardrobe: Garment[];
  result: LookResult;
  context: StyleContext;
  onContext: (context: StyleContext) => void;
  onSave: () => void;
  onAddPhotos: () => void;
  onSample: () => void;
  onEdit: (g: Garment) => void;
};
export function TodayView({
  wardrobe,
  result,
  context,
  onContext,
  onSave,
  onAddPhotos,
  onSample,
  onEdit,
}: Props) {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">LESS DECIDING. MORE YOU.</div>
          <h1>
            Get dressed.
            <br />
            <em>Feel like you.</em>
          </h1>
          <p>
            Discover fresh combinations of the clothes you already own. One
            photo is all it takes to begin.
          </p>
          <button className="primary" onClick={onAddPhotos}>
            <Plus size={16} /> Add my clothes
          </button>
        </div>
        <div className="hero-art">
          <div className="sun-disc" />
          <div className="editorial-card">
            <span className="look-tag">THE DAILY EDIT</span>
            <div className="outfit-emoji">
              👕
              <br />
              👖
              <br />
              👞
            </div>
            <span className="card-caption">More from what you own</span>
          </div>
          <span className="art-star star-one">✳</span>
        </div>
      </section>
      <div className="section-heading" id="look">
        <div>
          <span className="eyebrow">MADE FOR YOUR PLANS</span>
          <h2>What are we dressing for?</h2>
        </div>
      </div>
      <div className="style-controls">
        <label htmlFor="style-occasion">
          Occasion
          <select
            id="style-occasion"
            aria-label="Occasion"
            value={context.occasion}
            onChange={(e) =>
              onContext({
                ...context,
                occasion: e.target.value as StyleContext["occasion"],
                variation: 0,
              })
            }
          >
            <option value="everyday">Everyday</option>
            <option value="work">Work</option>
            <option value="evening">Evening out</option>
            <option value="formal">Formal event</option>
          </select>
        </label>
        <label htmlFor="style-season">
          Season
          <select
            id="style-season"
            aria-label="Season"
            value={context.season ?? "any"}
            onChange={(e) =>
              onContext({
                ...context,
                season: e.target.value as NonNullable<StyleContext["season"]>,
                variation: 0,
              })
            }
          >
            <option value="any">Any season</option>
            <option value="spring">Spring</option>
            <option value="summer">Summer</option>
            <option value="autumn">Autumn</option>
            <option value="winter">Winter</option>
          </select>
        </label>
        <label htmlFor="style-temperature">
          Temperature · °C
          <input
            id="style-temperature"
            type="number"
            min="-10"
            max="45"
            value={context.temperature}
            onChange={(e) =>
              onContext({
                ...context,
                temperature: Math.max(
                  -10,
                  Math.min(45, Number(e.target.value)),
                ),
              })
            }
          />
        </label>
        <button
          className="outline-button"
          disabled={!result.complete}
          onClick={() =>
            onContext({ ...context, variation: context.variation + 1 })
          }
        >
          <Shuffle size={15} /> Another combination
        </button>
      </div>
      {seasonTemperatureWarning(context) && (
        <p className="styling-warning" role="status">
          {seasonTemperatureWarning(context)}
        </p>
      )}
      <div className="outfit-panel">
        <div className="outfit-top">
          <div>
            <div className="look-name">
              {result.complete ? result.message : "Let’s build your first look"}
            </div>
            <p className="look-description">
              {!result.complete
                ? result.message
                : result.suitability === "mismatch"
                  ? "The closest combination from your wardrobe. It is not confirmed for this plan."
                  : "A combination from your wardrobe, ready to make your own."}
            </p>
          </div>
          {result.complete && (
            <button className="save-button" onClick={onSave}>
              <Heart size={16} />
              Save look
            </button>
          )}
        </div>
        {!!result.items.length && (
          <>
            <div className="look-items">
              {result.items.map((g) => (
                <button
                  className="look-item look-item-button"
                  key={g.id}
                  onClick={() => onEdit(g)}
                >
                  <div className="item-visual">
                    <GarmentThumb garment={g} />
                  </div>
                  <div className="item-info">
                    <small>{g.category.toUpperCase()}</small>
                    <b>{g.name}</b>
                    <span>{g.color || "Color unconfirmed"}</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="styling-note">
              <Sparkles size={16} />
              <div>
                <b>Why this combination</b>
                {result.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            </div>
          </>
        )}
        {!wardrobe.length && (
          <div className="onboarding">
            <p>Start with a top, a bottom and shoes—or a dress and shoes.</p>
            <button className="primary" onClick={onAddPhotos}>
              Upload my first photo
            </button>
            <button className="text-link" onClick={onSample}>
              Explore a clearly labeled sample wardrobe
            </button>
          </div>
        )}
      </div>
      <div className="section-heading wardrobe-head">
        <div>
          <span className="eyebrow">PIECES WITH POSSIBILITIES</span>
          <h2>
            In your wardrobe <span className="count">{wardrobe.length}</span>
          </h2>
        </div>
        <button className="outline-button" onClick={onAddPhotos}>
          <Plus size={16} />
          Add photos
        </button>
      </div>
      <div className="wardrobe-grid">
        {wardrobe.slice(0, 4).map((g) => (
          <WardrobeCard key={g.id} garment={g} onEdit={onEdit} />
        ))}
      </div>
    </>
  );
}
