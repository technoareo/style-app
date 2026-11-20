"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { starterWardrobe } from "../domain/starter";
import type { Garment, SavedLook } from "../domain/types";
import { backupSchema } from "../domain/backup";
import {
  loadAccountWardrobe,
  saveAccountWardrobe,
  portableBackup,
  type AccountWardrobe,
} from "../data/serverRepository";
import { authClient } from "../services/authClient";
export const pickImages = (multiple: boolean) =>
  new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files || []));
    input.oncancel = () => resolve([]);
    input.click();
  });
export function useStyleStore(user: { id: string; name: string }) {
  const [space, setSpace] = useState<AccountWardrobe>({
    version: 1,
    name: user.name,
    wardrobe: [],
    looks: [],
    revision: 0,
  });
  const [ready, setReady] = useState(false),
    [loadFailed, setLoadFailed] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("Opening your wardrobe…"),
    [toast, setToast] = useState(""),
    // Explicit boolean the UI can trust for the sign-out guard; never inferred
    // from the human-readable status string, which can change wording freely.
    [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [generation, setGeneration] = useState(0);
  const revision = useRef(0),
    latestGeneration = useRef(0),
    tail = useRef(Promise.resolve()),
    alive = useRef(true),
    failed = useRef(false),
    // Callers that need the server's acknowledgement of a specific change
    // (see commitGarments) wait here; keyed by the change's generation.
    waiters = useRef<
      {
        generation: number;
        resolve: () => void;
        reject: (e: Error) => void;
      }[]
    >([]),
    latest = useRef(space);
  latest.current = space;
  const settleWaiters = (upTo: number, error?: Error) => {
    const keep: typeof waiters.current = [];
    for (const w of waiters.current) {
      if (error) w.reject(error);
      else if (w.generation <= upTo) w.resolve();
      else keep.push(w);
    }
    waiters.current = keep;
  };
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  }, []);
  useEffect(() => {
    alive.current = true;
    loadAccountWardrobe()
      .then((data) => {
        if (!alive.current) return;
        revision.current = data.revision;
        setSpace(data);
        setReady(true);
        setStatus("All changes saved");
      })
      .catch(() => {
        if (alive.current) {
          setLoadFailed(true);
          setError(
            "Your wardrobe could not be opened. Please reload to try again.",
          );
        }
      });
    return () => {
      alive.current = false;
      clearTimeout(toastTimer.current);
      // Nothing is written for this account after unmount or an account
      // switch (the save effect checks `alive`); callers are told it failed.
      settleWaiters(0, new Error("Your account changed before this was saved."));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);
  // Serial writes preserve the draft on conflict instead of overwriting another device.
  useEffect(() => {
    if (!ready || !generation) return;
    const captured = generation;
    tail.current = tail.current.then(async () => {
      if (
        !alive.current ||
        failed.current ||
        captured !== latestGeneration.current
      )
        return;
      setStatus("Saving changes…");
      try {
        const result = await saveAccountWardrobe(
          { ...latest.current, revision: revision.current },
          user.id,
        );
        revision.current = result.revision;
        // The server acknowledged everything up to `captured`.
        if (alive.current) settleWaiters(captured);
        if (alive.current && captured === latestGeneration.current) {
          setSpace(result);
          setStatus("All changes saved");
          setError("");
          setHasUnsavedChanges(false);
        }
      } catch (e) {
        failed.current = true;
        settleWaiters(
          0,
          e instanceof Error ? e : new Error("Your wardrobe could not be saved."),
        );
        if (alive.current) {
          setStatus("Changes have not been saved");
          setHasUnsavedChanges(true);
          setError(
            e instanceof Error
              ? e.message
              : "Could not save. Export your draft before reloading.",
          );
        }
      }
    });
  }, [generation, ready, user.id]);
  function change(update: (s: AccountWardrobe) => AccountWardrobe) {
    if (!ready) return;
    setSpace(update);
    latestGeneration.current++;
    setGeneration(latestGeneration.current);
    setHasUnsavedChanges(true);
  }
  const addGarment = (g: Garment) =>
    change((s) => ({ ...s, wardrobe: [g, ...s.wardrobe] }));
  const addGarments = (items: Garment[]) =>
    change((s) => ({ ...s, wardrobe: [...items, ...s.wardrobe] }));
  /**
   * Adds items and resolves only after the server has acknowledged the saved
   * wardrobe that contains them (photos uploaded, revision accepted). Rejects
   * with the save error otherwise; the items stay in the draft wardrobe and
   * the unsaved-changes protections stay on. Safe to call again after a
   * failure: items are upserted by id (latest values win, no duplicates), a
   * prior failure is cleared, and the save is retried.
   */
  const commitGarments = (items: Garment[]) =>
    new Promise<void>((resolve, reject) => {
      if (!ready || !alive.current)
        return reject(new Error("Your wardrobe is not open for saving."));
      failed.current = false;
      // Upsert by stable id: a retry carries the user's latest reviewed
      // values (name, colour, crop, dress code ...) and replaces an earlier
      // attempt's copy instead of keeping it or duplicating it; unrelated
      // wardrobe items and edits are left exactly as they are.
      change((s) => {
        const incoming = new Map(items.map((i) => [i.id, i]));
        const replaced = new Set<string>();
        const existing = s.wardrobe.map((g) => {
          const next = incoming.get(g.id);
          if (!next) return g;
          replaced.add(g.id);
          return next;
        });
        return {
          ...s,
          wardrobe: [...items.filter((i) => !replaced.has(i.id)), ...existing],
        };
      });
      waiters.current.push({
        generation: latestGeneration.current,
        resolve,
        reject,
      });
    });
  const updateGarment = (g: Garment) =>
    change((s) => ({
      ...s,
      wardrobe: s.wardrobe.map((x) => (x.id === g.id ? g : x)),
    }));
  const removeGarment = (id: string) =>
    change((s) => ({ ...s, wardrobe: s.wardrobe.filter((g) => g.id !== id) }));
  const removeLook = (id: string) =>
    change((s) => ({ ...s, looks: s.looks.filter((l) => l.id !== id) }));
  const saveLook = (
    items: Garment[],
    name: string,
    occasion: string,
    season?: SavedLook["season"],
  ) => {
    if (!items.length) return;
    change((s) => ({
      ...s,
      looks: [
        {
          id: crypto.randomUUID(),
          name,
          occasion,
          ...(season ? { season } : {}),
          createdAt: new Date().toISOString(),
          items: items.map((g) => ({ ...g })),
        },
        ...s.looks,
      ],
    }));
    notify("Look added. Saving to your account…");
  };
  const loadSample = () => {
    change((s) => ({
      ...s,
      wardrobe: [
        ...starterWardrobe.map((g) => ({
          ...g,
          id: crypto.randomUUID(),
          reviewed: true,
          available: true,
          formality: "casual" as const,
          warmth: "unknown" as const,
        })),
        ...s.wardrobe,
      ],
    }));
    notify("Example items added to your wardrobe.");
  };
  const exportBackup = async () => {
    try {
      const data = await portableBackup(latest.current);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "style-wardrobe-backup.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Backup could not be exported.");
    }
  };
  const importBackup = async (file: File) => {
    try {
      if (file.size > 150_000_000) throw new Error("Backup is too large.");
      const data = backupSchema.parse(JSON.parse(await file.text()));
      const items = data.wardrobe.map((g) => ({
        ...g,
        id: crypto.randomUUID(),
      }));
      const looks = data.looks.map((l) => ({
        ...l,
        id: crypto.randomUUID(),
        items: l.items.map((g) => ({ ...g, id: crypto.randomUUID() })),
      }));
      const merged = backupSchema.parse({
        ...latest.current,
        wardrobe: [...items, ...latest.current.wardrobe],
        looks: [...looks, ...latest.current.looks],
      });
      change((s) => ({ ...s, ...merged }));
      notify("Backup items added to your account. Saving…");
    } catch {
      notify(
        "Could not restore this backup. Your current wardrobe is unchanged.",
      );
    }
  };
  return {
    wardrobe: space.wardrobe,
    looks: space.looks,
    profileId: user.id,
    profileName: user.name,
    ready,
    loadFailed,
    error,
    status,
    toast,
    hasUnsavedChanges,
    notify,
    addGarment,
    addGarments,
    commitGarments,
    updateGarment,
    removeGarment,
    saveLook,
    removeLook,
    loadSample,
    exportBackup,
    importBackup,
    signOut: () => authClient.signOut(),
    retrySave: () => {
      failed.current = false;
      latestGeneration.current++;
      setGeneration(latestGeneration.current);
      setHasUnsavedChanges(true);
    },
  };
}
export type StyleStore = ReturnType<typeof useStyleStore>;
