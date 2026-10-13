import { useEffect, useMemo, useRef, useState } from "react";
import type { Garment } from "../domain/types";
import { analysisSchema, MAX_DETECTED_ITEMS } from "../domain/analysis";
import { mergeShoePair, suggestShoePairs } from "../domain/pairs";
import { imageFromFile, cropImage, photoHash } from "../services/images";
import {
  describeProgress,
  discardJob,
  getJob,
  isActive,
  JobGoneError,
  listJobs,
  markDiscardPending,
  pendingDiscards,
  retryPendingDiscards,
  retryText,
  type JobSummary,
} from "../services/analysisClient";
import { Dialog } from "./Dialog";
import { GarmentThumb } from "./GarmentThumb";

type Draft = Garment & {
  box: number[];
  cropDirty?: boolean;
  /** What the model guessed. Never applied until the user chooses it. */
  aiFormality?: Garment["formality"];
};

const CATEGORIES = [
  "Tops",
  "Bottoms",
  "Dresses",
  "Outerwear",
  "Shoes",
  "Accessories",
  "Unsorted",
];
const FORMALITY = ["casual", "smart", "formal", "unknown"] as const;
const WARMTH = ["light", "medium", "warm", "unknown"] as const;

/*
 * Review progress is kept in this browser tab only (sessionStorage), keyed by
 * account and job, holding choices and crop bounds - never photos. It is
 * bounded, validated on read, bound to the signed-in account, and only used
 * after the server confirms the job still belongs to that account.
 */
const REVIEW_PREFIX = "style-review:";
const MAX_STORED_BYTES = 200_000;
type StoredReview = {
  hash: string;
  drafts: Omit<Draft, "image">[];
  dismissed: string[];
};
const reviewKey = (accountId: string, jobId: string) =>
  `${REVIEW_PREFIX}${accountId}:${jobId}`;

function purgeForeignReviews(accountId: string) {
  try {
    const own = `${REVIEW_PREFIX}${accountId}:`;
    const stale: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(REVIEW_PREFIX) && !key.startsWith(own))
        stale.push(key);
    }
    stale.forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // Storage can be unavailable; resume then relies on the server alone.
  }
}
function saveReview(accountId: string, jobId: string, data: StoredReview) {
  try {
    const text = JSON.stringify({ v: 1, accountId, jobId, ...data });
    if (text.length <= MAX_STORED_BYTES)
      sessionStorage.setItem(reviewKey(accountId, jobId), text);
  } catch {
    // Not critical: the server still holds the result.
  }
}
function clearReview(accountId: string, jobId: string) {
  try {
    sessionStorage.removeItem(reviewKey(accountId, jobId));
  } catch {
    // Ignore.
  }
}
const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.slice(0, max) : "";
function loadReview(accountId: string, jobId: string): StoredReview | null {
  try {
    const raw = sessionStorage.getItem(reviewKey(accountId, jobId));
    if (!raw || raw.length > MAX_STORED_BYTES) return null;
    const p = JSON.parse(raw);
    if (
      p?.v !== 1 ||
      p.accountId !== accountId ||
      p.jobId !== jobId ||
      !Array.isArray(p.drafts) ||
      p.drafts.length > 30
    ) {
      clearReview(accountId, jobId);
      return null;
    }
    const drafts: Omit<Draft, "image">[] = [];
    for (const d of p.drafts) {
      const box = d?.box;
      if (
        !d ||
        typeof d.id !== "string" ||
        !CATEGORIES.includes(d.category) ||
        !Array.isArray(box) ||
        box.length !== 4 ||
        !box.every((n: unknown) => typeof n === "number" && n >= 0 && n <= 1)
      )
        continue;
      drafts.push({
        id: d.id.slice(0, 64),
        name: str(d.name, 100),
        category: d.category,
        color: str(d.color, 60),
        brand: "",
        size: "",
        pattern: str(d.pattern, 60),
        sleeve: str(d.sleeve, 60) || undefined,
        neckline: str(d.neckline, 60) || undefined,
        closure: str(d.closure, 60) || undefined,
        length: str(d.length, 60) || undefined,
        formality: FORMALITY.includes(d.formality) ? d.formality : "unknown",
        aiFormality: FORMALITY.includes(d.aiFormality)
          ? d.aiFormality
          : "unknown",
        warmth: WARMTH.includes(d.warmth) ? d.warmth : "unknown",
        available: true,
        reviewed: d.reviewed === true,
        cropDirty: d.cropDirty === true,
        confidence: typeof d.confidence === "number" ? d.confidence : undefined,
        evidence: str(d.evidence, 250),
        photoHash: str(d.photoHash, 80) || undefined,
        box,
      });
    }
    return {
      hash: str(p.hash, 80),
      drafts,
      dismissed: Array.isArray(p.dismissed)
        ? p.dismissed.filter((x: unknown) => typeof x === "string").slice(0, 30)
        : [],
    };
  } catch {
    return null;
  }
}

const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });

export function UploadDialog({
  wardrobe,
  accountId,
  onSave,
  onClose,
}: {
  wardrobe: Garment[];
  accountId: string;
  /** Resolves once the server acknowledged the saved wardrobe; rejects otherwise. */
  onSave: (items: Garment[]) => Promise<void>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [capacityNote, setCapacityNote] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const [progress, setProgress] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const hashRef = useRef("");
  // The job whose cancel or discard request is pending (ref for the guard,
  // state so the buttons disable).
  const ending = useRef<string | null>(null);
  const [endingJob, setEnding] = useState<string | null>(null);

  // Resume: ask the server (never storage) for this account's active or
  // recent job, then follow or show it. Leaving the dialog never cancels.
  useEffect(() => {
    purgeForeignReviews(accountId);
    const ac = new AbortController();
    fetch("/api/analyze", { cache: "no-store", signal: ac.signal })
      .then((r) => r.json())
      .then((r) => {
        setConfigured(r.ready ?? r.configured ?? false);
        const cap = r.capacity;
        if (cap && cap.accepting === false && cap.reason)
          setCapacityNote(`${cap.reason}${retryText(cap.retryAfterSeconds)}`);
      })
      .catch(() => {
        if (!ac.signal.aborted) setConfigured(false);
      });
    // Results already saved to the wardrobe but not yet discarded on the
    // server are retried here and never offered for review again.
    void retryPendingDiscards(accountId);
    const skip = new Set(pendingDiscards(accountId));
    listJobs(ac.signal)
      .then((all) => {
        const jobs = all.filter((j) => !skip.has(j.id));
        if (ac.signal.aborted || controller.current) return;
        const job =
          jobs.find(isActive) ??
          jobs.find((j) => j.status === "completed") ??
          jobs.find((j) => j.status === "failed");
        if (!job) return;
        if (job.status === "failed") {
          setError(job.error || "Photo analysis could not finish.");
          void discardJob(job.id, accountId).catch(() => {});
          return;
        }
        setNotice(
          job.status === "completed"
            ? "Your photo results are ready to review."
            : "Your earlier photo is still being analyzed.",
        );
        controller.current = new AbortController();
        void follow(job.id, "", controller.current);
      })
      .catch(() => {});
    return () => {
      ac.abort();
      // Stop watching only. The job keeps running and can be resumed.
      controller.current?.abort();
    };
    // The account is fixed for this dialog's lifetime; the parent remounts on sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // Persist review choices (not photos) so a reload in this tab can resume.
  useEffect(() => {
    if (!jobId || !drafts.length || !source) return;
    saveReview(accountId, jobId, {
      hash: hashRef.current,
      drafts: drafts.map((d) => {
        const { image, ...rest } = d;
        void image;
        return rest;
      }),
      dismissed,
    });
  }, [drafts, dismissed, jobId, source, accountId]);

  /**
   * Publishes a finished result into the dialog. `ac` is the controller of the
   * flow that produced it; a newer flow, a cancel, a discard or unmount aborts
   * it, and a result from an aborted flow is never published (checked before
   * every state write and after every async stage: hash and crops).
   */
  async function showResult(
    id: string | null,
    result: unknown,
    hash: string,
    ac: AbortController,
  ) {
    const superseded = () => ac.signal.aborted;
    if (superseded()) return;
    const analysis = analysisSchema.parse(result);
    const image = (result as { image: string }).image;
    setWarning(analysis.warning);
    setSource(image);
    if (!analysis.items.length) {
      setError(
        "No clothing was detected. Try a clear photo with the item fully visible.",
      );
      if (id) {
        clearReview(accountId, id);
        void discardJob(id, accountId).catch(() => {});
        setJobId(null);
      }
      return;
    }
    const stored = id ? loadReview(accountId, id) : null;
    const resolvedHash = hash || stored?.hash || (await photoHash(image));
    if (superseded()) return;
    if (stored?.drafts.length) {
      const restored = await Promise.all(
        stored.drafts.map(async (d) => ({
          ...d,
          image: await cropImage(image, d.box),
          // A crop edited but never regenerated needs a fresh look.
          reviewed: d.cropDirty ? false : d.reviewed,
          cropDirty: false,
        })),
      );
      if (superseded()) return;
      hashRef.current = resolvedHash;
      setDismissed(stored.dismissed);
      setDrafts(restored as Draft[]);
      setNotice("Welcome back. Your review choices on this device were restored.");
      return;
    }
    const items = await Promise.all(
      analysis.items.map(async (item, index) => ({
        ...item,
        // Stable per job and position, so saving the same result twice (a
        // retry, or a lost success response followed by a resume on another
        // tab) updates the same wardrobe item instead of adding a duplicate.
        // A merged pair keeps its first detection's id.
        id: id ? `${id}-${index}` : crypto.randomUUID(),
        image: await cropImage(image, item.box),
        photoHash: resolvedHash,
        // The model's guess is shown as a suggestion; it only becomes the
        // item's dress code if the user chooses it.
        formality: "unknown" as const,
        aiFormality: item.formality,
        warmth: "unknown" as const,
        available: true,
        reviewed: false,
      })),
    );
    if (superseded()) return;
    hashRef.current = resolvedHash;
    setDismissed([]);
    setDrafts(items);
  }

  /** Polls one job against the server's own deadline until it finishes. */
  async function follow(id: string, hash: string, ac: AbortController) {
    setJobId(id);
    setBusy(true);
    let failures = 0;
    try {
      for (;;) {
        ac.signal.throwIfAborted();
        let job: JobSummary;
        try {
          job = await getJob(id, ac.signal);
          ac.signal.throwIfAborted();
          failures = 0;
        } catch (e) {
          if (ac.signal.aborted || isAbort(e)) throw e;
          if (e instanceof JobGoneError) {
            clearReview(accountId, id);
            setJobId(null);
            throw e;
          }
          if (++failures >= 5)
            throw new Error(
              "Connection lost. Your photo is still being analyzed; reopen Add photos to continue.",
            );
          await wait(Math.min(10_000, 1000 * 2 ** failures), ac.signal);
          continue;
        }
        if (job.status === "completed") {
          setProgress("");
          await showResult(id, job.result, hash, ac);
          return;
        }
        if (job.status === "failed" || job.status === "cancelled") {
          clearReview(accountId, id);
          setJobId(null);
          throw new Error(
            job.error || "Photo analysis could not finish. Please try again.",
          );
        }
        setProgress(describeProgress(job));
        // The server's absolute deadline, corrected for clock skew.
        const skew = (job.serverNow ?? Date.now()) - Date.now();
        if (job.expiresAt && Date.now() + skew > job.expiresAt + 30_000)
          throw new Error(
            "This photo expired before analysis finished. Upload it again.",
          );
        await wait(job.status === "queued" ? 3000 : 2000, ac.signal);
      }
    } catch (err) {
      // A superseded flow reports nothing: the newer one owns the dialog.
      if (!isAbort(err) && !ac.signal.aborted) setError((err as Error).message);
    } finally {
      if (controller.current === ac) setBusy(false);
    }
  }

  async function analyze(file: File) {
    setError("");
    setNotice("");
    setWarning("");
    setDrafts([]);
    setBusy(true);
    setProgress("Sending your photo…");
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    try {
      const photo = await imageFromFile(file);
      ac.signal.throwIfAborted();
      const hash = await photoHash(photo);
      ac.signal.throwIfAborted();
      if (wardrobe.some((g) => g.photoHash === hash))
        throw new Error(
          "This exact photo is already in your wardrobe. Edit its existing items instead.",
        );
      const response = await fetch("/api/analyze", {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Style-Account": accountId,
        },
        body: JSON.stringify({ image: photo, consent }),
      });
      const data = await response.json();
      ac.signal.throwIfAborted();
      if (response.status === 409 && data.code === "active-job" && data.jobId) {
        setNotice("Showing the photo you already have in progress.");
        await follow(data.jobId, "", ac);
        return;
      }
      if (!response.ok)
        throw new Error(
          `${data.error || "Analysis failed."}${retryText(data.retryAfterSeconds)}`,
        );
      if (response.status === 202) {
        hashRef.current = hash;
        saveReview(accountId, data.id, { hash, drafts: [], dismissed: [] });
        await follow(data.id, hash, ac);
        return;
      }
      // Immediate result (no queue).
      await showResult(null, data, hash, ac);
    } catch (err) {
      if (!isAbort(err) && !ac.signal.aborted) setError((err as Error).message);
    } finally {
      if (controller.current === ac) setBusy(false);
    }
  }

  /**
   * Cancels the photo this dialog is following. The request names the job and
   * the flow (its AbortController) that existed when the user pressed the
   * button. Whatever happens while the request is out, only THAT flow is
   * touched afterwards: if a newer upload has replaced it in the meantime, the
   * newer flow keeps its controller, its job and its busy state (a late answer
   * used to abort the newer flow's controller). A second press while the first
   * request is pending does nothing (the button is disabled and the guard
   * holds even if something else calls this again).
   */
  async function cancelAnalysis() {
    const flow = controller.current;
    const id = jobId;
    if (!id) {
      flow?.abort();
      setBusy(false);
      return;
    }
    if (ending.current === id) return;
    ending.current = id;
    setEnding(id);
    try {
      await discardJob(id, accountId);
      // The job is gone on the server either way.
      clearReview(accountId, id);
      if (controller.current !== flow) return; // superseded: not ours any more
      flow?.abort();
      setJobId(null);
      setBusy(false);
      setProgress("");
      setError("");
      setNotice("Analysis cancelled.");
    } catch (e) {
      if (controller.current === flow)
        setError(`Could not cancel: ${(e as Error).message}`);
    } finally {
      if (ending.current === id) {
        ending.current = null;
        setEnding(null);
      }
    }
  }
  async function discardResults() {
    if (!jobId) {
      setDrafts([]);
      return;
    }
    const id = jobId;
    if (ending.current === id) return;
    ending.current = id;
    setEnding(id);
    try {
      await discardJob(id, accountId);
      clearReview(accountId, id);
      setJobId(null);
      setDrafts([]);
      setSource("");
      setNotice("Photo results discarded.");
    } catch (e) {
      setError(`Could not discard: ${(e as Error).message}`);
    } finally {
      if (ending.current === id) {
        ending.current = null;
        setEnding(null);
      }
    }
  }

  const patch = (id: string, changes: Partial<Draft>) =>
    setDrafts((items) =>
      items.map((g) => (g.id === id ? { ...g, ...changes } : g)),
    );
  const adjustBox = (id: string, index: number, value: number) =>
    setDrafts((items) =>
      items.map((g) => {
        if (g.id !== id) return g;
        const box = [...g.box];
        box[index] = Math.max(
          index > 1 ? 0.03 : 0,
          Math.min(index < 2 ? 0.97 : 1, value),
        );
        box[2] = Math.min(box[2], 1 - box[0]);
        box[3] = Math.min(box[3], 1 - box[1]);
        return { ...g, box, reviewed: false, cropDirty: true };
      }),
    );

  const pairs = useMemo(
    () =>
      suggestShoePairs(drafts).filter(
        ([a, b]) => !dismissed.includes(`${a}|${b}`),
      ),
    [drafts, dismissed],
  );
  async function mergePair(aId: string, bId: string) {
    const a = drafts.find((g) => g.id === aId);
    const b = drafts.find((g) => g.id === bId);
    if (!a || !b) return;
    try {
      const merged = mergeShoePair(a, b);
      const image = await cropImage(source, merged.box);
      setDrafts((items) =>
        items.flatMap((g) =>
          g.id === aId
            ? [{ ...merged, image, cropDirty: false, reviewed: false }]
            : g.id === bId
              ? []
              : [g],
        ),
      );
    } catch {
      setError("These could not be merged. Keep them separate or adjust the crops.");
    }
  }

  /**
   * Saves the reviewed items and only then lets go of the server result and
   * the tab's review data. `onSave` resolves after the server acknowledged the
   * saved wardrobe; if it rejects, the job, the review data and the drafts are
   * all kept, the error is shown, and pressing the button again retries (the
   * items keep their ids, so a retry cannot create duplicates).
   */
  async function finishAndSave() {
    if (saving) return;
    setSaving(true);
    setError("");
    const items = drafts.map(
      ({ box, cropDirty, aiFormality, ...garment }) => garment,
    );
    try {
      await onSave(items);
    } catch (e) {
      setSaving(false);
      setError(
        `Your items were not saved: ${(e as Error).message} Your photo results are kept here; press the button again to retry.`,
      );
      return;
    }
    // Durably saved. Now the temporary results can go.
    if (jobId) {
      clearReview(accountId, jobId);
      try {
        await discardJob(jobId, accountId);
      } catch (e) {
        markDiscardPending(accountId, jobId);
        setSaving(false);
        setDrafts([]);
        setSource("");
        setJobId(null);
        setNotice(
          `Saved to your wardrobe. The temporary photo result could not be removed yet (${(e as Error).message}); it will be removed automatically within an hour, and we will try again next time.`,
        );
        return;
      }
    }
    onClose();
  }

  return (
    <Dialog title="Turn photos into your wardrobe" onClose={onClose} wide>
      <p>
        Photograph one item or several clearly separated pieces. We’ll identify
        visible details and create an item for each detected garment.
      </p>
      <p className="photo-tips">
        For the best results, photograph one to three items at a time, laid
        flat or hung apart on a plain background in good light, with nothing
        overlapping. We list up to {MAX_DETECTED_ITEMS} items per photo, so a
        full rack, shelf or closet will not work well.
      </p>
      <p className="privacy-note">
        Free AI runs on our private server. Your photo is held there for
        analysis and review until you save or discard it, and for at most one
        hour after upload; no external AI service receives it. You can close
        this window while it is processed; the result waits for you. Your review
        choices (not the photo) are kept in this browser tab until you finish.
        When you save, discard or cancel, or after the hour, the temporary
        photo is removed from the live database. That is not a secure wipe:
        removed data can remain in unused database space until it is
        overwritten, and server backups never include temporary photos. Crops
        are approximate, and hidden items may be missed. Size, fabric and fit
        stay unknown unless confirmed.
      </p>
      {configured === false && (
        <p role="status" className="notice">
          Photo analysis is temporarily unavailable. Please try again later. You
          can still add wardrobe items manually.
        </p>
      )}
      {capacityNote && !busy && !drafts.length && (
        <p role="status" className="notice">
          {capacityNote}
        </p>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        Allow the server to analyze this photo.
      </label>
      <label className="upload-picker">
        Choose a clothing photo
        <input
          aria-label="Choose a clothing photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={!consent || busy || !configured || drafts.length > 0}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void analyze(file);
            e.target.value = "";
          }}
        />
      </label>
      {busy && (
        <div role="status">
          <p>
            {progress} The first photo may take several minutes while the model
            loads.
          </p>
          <button type="button" className="outline-button" onClick={onClose}>
            Continue in background
          </button>{" "}
          <button
            type="button"
            className="danger-button"
            disabled={endingJob !== null}
            onClick={() => void cancelAnalysis()}
          >
            Cancel analysis
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {warning && <p className="notice">{warning}</p>}
      {!!drafts.length && (
        <>
          <h3>Review {drafts.length} detected items</h3>
          <p>
            Confirm the category, visible details and crop for every item before
            styling.
          </p>
          {pairs.map(([a, b]) => {
            const first = drafts.find((g) => g.id === a);
            const second = drafts.find((g) => g.id === b);
            if (!first || !second) return null;
            return (
              <div
                key={`${a}|${b}`}
                className="notice pair-suggestion"
                role="group"
                aria-label="Possible pair of shoes"
              >
                <p>
                  “{first.name}” and “{second.name}” may be the two shoes of one
                  pair. Merge them into one item?
                </p>
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => void mergePair(a, b)}
                >
                  Merge as one pair
                </button>{" "}
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => setDismissed((d) => [...d, `${a}|${b}`])}
                >
                  Keep separate
                </button>
              </div>
            );
          })}
          <div className="review-grid">
            {drafts.map((g) => (
              <article key={g.id} className="review-card">
                <div className="review-image">
                  <GarmentThumb garment={g} />
                </div>
                <details className="crop-controls">
                  <summary>Adjust item crop</summary>
                  {/* Local data URL; the original is only retained during review. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="crop-source"
                    src={source}
                    alt="Original wardrobe photo for crop adjustment"
                  />
                  <p>
                    Bounds in percent of the original image. Confirm the updated
                    thumbnail before saving.
                  </p>
                  <div className="crop-fields">
                    {["Left", "Top", "Width", "Height"].map((label, index) => (
                      <label key={label}>
                        {label}
                        <input
                          type="number"
                          min={index > 1 ? 3 : 0}
                          max={index < 2 ? 97 : 100}
                          value={Math.round(g.box[index] * 100)}
                          onChange={(e) =>
                            adjustBox(g.id, index, Number(e.target.value) / 100)
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    className="outline-button"
                    onClick={async () => {
                      try {
                        const image = await cropImage(source, g.box);
                        setDrafts((items) =>
                          items.map((item) =>
                            item.id === g.id
                              ? {
                                  ...item,
                                  image,
                                  cropDirty: false,
                                  reviewed: false,
                                }
                              : item,
                          ),
                        );
                      } catch {
                        setError(
                          "This crop could not be created. Try different bounds.",
                        );
                      }
                    }}
                  >
                    Update crop
                  </button>
                </details>
                <label>
                  Item name
                  <input
                    aria-label={`Name ${g.name}`}
                    value={g.name}
                    onChange={(e) => patch(g.id, { name: e.target.value })}
                  />
                </label>
                <label>
                  Category
                  <select
                    value={g.category}
                    onChange={(e) => patch(g.id, { category: e.target.value })}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Color
                  <input
                    value={g.color}
                    onChange={(e) => patch(g.id, { color: e.target.value })}
                  />
                </label>
                {/* Explicit htmlFor/id association: the accessible name is
                    exactly "Dress code", not the label plus every option. */}
                <div className="field">
                  <label htmlFor={`dress-code-${g.id}`}>Dress code</label>
                  <select
                    id={`dress-code-${g.id}`}
                    value={g.formality || "unknown"}
                    onChange={(e) =>
                      patch(g.id, {
                        formality: e.target.value as Garment["formality"],
                      })
                    }
                  >
                    <option value="unknown">Not sure</option>
                    <option value="casual">Casual</option>
                    <option value="smart">Smart</option>
                    <option value="formal">Formal</option>
                  </select>
                </div>
                {g.aiFormality &&
                  g.aiFormality !== "unknown" &&
                  g.aiFormality !== g.formality && (
                    <small>
                      AI guessed “{g.aiFormality}”; it is not applied unless you
                      choose it.{" "}
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => patch(g.id, { formality: g.aiFormality })}
                      >
                        Use this
                      </button>
                    </small>
                  )}
                <div className="field">
                  <label htmlFor={`warmth-${g.id}`}>Warmth (optional)</label>
                  <select
                    id={`warmth-${g.id}`}
                    value={g.warmth || "unknown"}
                    onChange={(e) =>
                      patch(g.id, {
                        warmth: e.target.value as Garment["warmth"],
                      })
                    }
                  >
                    <option value="unknown">Not sure</option>
                    <option value="light">Light</option>
                    <option value="medium">Medium</option>
                    <option value="warm">Warm</option>
                  </select>
                </div>
                <p>{g.evidence}</p>
                <small>AI suggestion · confirm the visible details</small>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={g.reviewed}
                    disabled={g.cropDirty}
                    onChange={(e) =>
                      patch(g.id, { reviewed: e.target.checked })
                    }
                  />
                  Details checked
                </label>
                <button
                  className="danger-button"
                  onClick={() =>
                    setDrafts((items) => items.filter((i) => i.id !== g.id))
                  }
                >
                  Discard detection
                </button>
              </article>
            ))}
          </div>
          <button
            className="primary modal-submit"
            disabled={
              saving ||
              drafts.some(
                (g) =>
                  !g.name.trim() ||
                  !g.reviewed ||
                  g.cropDirty ||
                  g.category === "Unsorted",
              )
            }
            onClick={() => void finishAndSave()}
          >
            Add {drafts.length} items to my wardrobe
          </button>
          {saving && <p role="status">Saving to your account…</p>}
          {jobId && (
            <p>
              <button
                type="button"
                className="danger-button"
                disabled={saving}
                onClick={() => void discardResults()}
              >
                Discard these photo results
              </button>
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
