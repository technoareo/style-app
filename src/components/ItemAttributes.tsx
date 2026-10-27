import {
  FITS,
  OCCASIONS,
  SEASONS,
  VISIBLE_MATERIALS,
  type Occasion,
  type Season,
} from "../domain/analysis";
import type { Garment } from "../domain/types";

type Attributes = Pick<Garment, "material" | "fit" | "seasons" | "occasions">;

import { isShoeCategory } from "../domain/pairs";

const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const union = <T extends string>(a: readonly T[] | undefined, b: readonly T[]): T[] => [
  ...(a ?? []),
  ...b.filter((x) => !a?.includes(x)),
];

/**
 * Material, fit, seasons and occasions of one garment. Everything is optional
 * and editable; "Not sure" / empty is a normal answer. The AI only suggests
 * these from one photo, so nothing here is presented as fact. Seasons and
 * occasions are subjective: they start UNCHECKED, the AI's guess is shown on its
 * own line, and nothing is applied until the user presses "Use these" or ticks
 * a box themselves.
 */
export function ItemAttributes({
  idPrefix,
  value,
  uncertain = [],
  suggested,
  onChange,
}: {
  idPrefix: string;
  value: Attributes;
  /** Attributes the AI flagged as unsure; shown as "please check". */
  uncertain?: readonly string[];
  /** The AI's subjective guesses, not part of the item until the user applies them. */
  suggested?: { seasons?: readonly Season[]; occasions?: readonly Occasion[] };
  onChange: (patch: Partial<Attributes>) => void;
}) {
  const toggle = <T extends string>(list: readonly T[] | undefined, entry: T) =>
    list?.includes(entry) ? list.filter((x) => x !== entry) : [...(list ?? []), entry];
  const check = (key: string) => uncertain.includes(key);
  const pending = <T extends string>(guess: readonly T[] | undefined, chosen: readonly T[] | undefined) =>
    (guess ?? []).filter((x) => !chosen?.includes(x));
  const seasonGuess = pending(suggested?.seasons, value.seasons);
  const occasionGuess = pending(suggested?.occasions, value.occasions);
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-material`}>Material (only if clearly visible)</label>
        <input
          id={`${idPrefix}-material`}
          list={`${idPrefix}-materials`}
          placeholder="Leave blank if unsure"
          maxLength={60}
          value={value.material ?? ""}
          onChange={(e) => onChange({ material: e.target.value })}
        />
        <datalist id={`${idPrefix}-materials`}>
          {VISIBLE_MATERIALS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {check("material") && <small>Please check the material.</small>}
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-fit`}>Fit</label>
        <select
          id={`${idPrefix}-fit`}
          value={value.fit ?? "unknown"}
          onChange={(e) => onChange({ fit: e.target.value as Garment["fit"] })}
        >
          {FITS.map((f) => (
            <option key={f} value={f}>
              {f === "unknown" ? "Not sure" : title(f)}
            </option>
          ))}
        </select>
        {check("fit") && <small>Please check the fit.</small>}
      </div>
      <fieldset className="field">
        <legend>Seasons (optional)</legend>
        {SEASONS.map((s) => (
          <label key={s} className="check-row">
            <input
              type="checkbox"
              checked={value.seasons?.includes(s) ?? false}
              onChange={() => onChange({ seasons: toggle(value.seasons, s) })}
            />
            {title(s)}
          </label>
        ))}
        {!!seasonGuess.length && (
          <p className="ai-suggestion">
            <small>AI suggests: {seasonGuess.map(title).join(", ")}. </small>
            <button
              type="button"
              className="text-link"
              onClick={() => onChange({ seasons: union(value.seasons, seasonGuess) })}
            >
              Use these seasons
            </button>
          </p>
        )}
        {check("season") && <small>Please check the seasons.</small>}
      </fieldset>
      <fieldset className="field">
        <legend>Occasions (optional)</legend>
        {OCCASIONS.map((o) => (
          <label key={o} className="check-row">
            <input
              type="checkbox"
              checked={value.occasions?.includes(o) ?? false}
              onChange={() => onChange({ occasions: toggle(value.occasions, o) })}
            />
            {title(o)}
          </label>
        ))}
        {!!occasionGuess.length && (
          <p className="ai-suggestion">
            <small>AI suggests: {occasionGuess.map(title).join(", ")}. </small>
            <button
              type="button"
              className="text-link"
              onClick={() => onChange({ occasions: union(value.occasions, occasionGuess) })}
            >
              Use these occasions
            </button>
          </p>
        )}
        {check("occasion") && <small>Please check the occasions.</small>}
      </fieldset>
    </>
  );
}

/**
 * Shoes are normally photographed as a pair, but the model often boxes one shoe
 * (a real 4B run named one leather shoe in a photo of a pair and cropped only
 * that one). Nothing can tell from the answer which was meant, so the review
 * says so for every shoe item, whatever the model returned or the user chose.
 */
export function ShoeCropNote({ category }: { category: string }) {
  if (!isShoeCategory(category)) return null;
  return (
    <p role="note" className="notice">
      Shoes: please check the crop. If this is a pair, the picture should show
      both shoes and the name should say so (use “Adjust item crop”). The AI may
      have outlined only one.
    </p>
  );
}

const UNCERTAIN_LABELS: Record<string, string> = {
  category: "category",
  color: "color",
  pattern: "pattern",
  material: "material",
  fit: "fit",
  season: "seasons",
  occasion: "occasions",
};

/** "category, color and material"; unknown keys are skipped. Empty string when nothing is flagged. */
export function uncertaintyList(keys: readonly string[] | undefined): string {
  const names = [...new Set((keys ?? []).map((k) => UNCERTAIN_LABELS[k]).filter(Boolean))];
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The model's own score is only four self-reported steps and is NOT calibrated
 * (a small real model answered 1 while unsure of four attributes), so a high
 * score is never shown as reassurance or as a measure of accuracy. Only the two
 * low steps produce a note, worded as the AI's own statement.
 */
export function confidenceLabel(confidence: number | undefined): string {
  if (confidence === undefined) return "";
  if (confidence <= 0.25) return "The AI called this a poor guess (its scores are unverified): please check everything.";
  if (confidence <= 0.5) return "The AI reported doubts about this item (its scores are unverified): please check the details.";
  return "";
}
