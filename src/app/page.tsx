"use client";
import { useEffect, useMemo, useState } from "react";
import { Check, Download, UserRound } from "lucide-react";
import { ItemEditor } from "../components/ItemEditor";
import { AccountDialog } from "../components/AccountDialog";
import { AuthScreen } from "../components/AuthScreen";
import { authClient } from "../services/authClient";
import { SavedView } from "../components/SavedView";
import { Sidebar, type Tab } from "../components/Sidebar";
import { TodayView } from "../components/TodayView";
import { WardrobeView } from "../components/WardrobeView";
import { UploadDialog } from "../components/UploadDialog";
import { AnalysisBanner } from "../components/AnalysisBanner";
import { useAnalysisJobs } from "../hooks/useAnalysisJobs";
import { buildLook, type StyleContext } from "../domain/outfit";
import type { Garment } from "../domain/types";
import { useStyleStore } from "../hooks/useStyleStore";
export default function Home() {
  const { data: session, isPending, error } = authClient.useSession();
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (!isPending) setBooted(true);
  }, [isPending]);
  if (isPending && !booted)
    return (
      <main className="loading-screen" role="status">
        Opening Style Studio…
      </main>
    );
  if (error)
    return (
      <main className="loading-screen">
        <p>Style Studio is temporarily unavailable.</p>
        <button onClick={() => window.location.reload()}>Try again</button>
      </main>
    );
  if (!session) return <AuthScreen />;
  return <WardrobeApp key={session.user.id} user={session.user} />;
}
function WardrobeApp({
  user,
}: {
  user: { id: string; name: string; email: string };
}) {
  const store = useStyleStore(user);
  const [tab, setTab] = useState<Tab>("Today");
  const [profileOpen, setProfileOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState<Garment | null>(null);
  const analysisJobs = useAnalysisJobs(uploadOpen, user.id);
  const [context, setContext] = useState<StyleContext>({
    occasion: "everyday",
    season: "any",
    temperature: 25,
    variation: 0,
  });
  useEffect(() => {
    const date = new Date();
    const day = Math.floor(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000,
    );
    setContext((current) => ({ ...current, variation: day }));
  }, []);
  // Warn before a reload/close silently discards a save that is still
  // pending or has failed, mirroring the explicit sign-out guard below.
  useEffect(() => {
    if (!store.hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [store.hasUnsavedChanges]);
  const result = useMemo(
    () => buildLook(store.wardrobe, context),
    [store.wardrobe, context],
  );
  const collectionLabel = store.profileName
    ? `${store.profileName}’S COLLECTION`
    : "YOUR PERSONAL COLLECTION";
  const addBlank = () =>
    setEditing({
      id: crypto.randomUUID(),
      name: "",
      category: "Unsorted",
      color: "",
      brand: "",
      size: "",
      image: "👚",
      available: true,
      reviewed: false,
      warmth: "unknown",
      formality: "unknown",
    });
  const saveEdit = (g: Garment) => {
    if (store.wardrobe.some((x) => x.id === g.id)) store.updateGarment(g);
    else store.addGarment(g);
    setEditing(null);
    store.notify("Item updated. Saving to your account…");
  };
  if (!store.ready)
    return (
      <main className="loading-screen" role="status">
        {store.loadFailed ? (
          <>
            <p>{store.error}</p>
            <button onClick={() => window.location.reload()}>Try again</button>
          </>
        ) : (
          "Opening your wardrobe…"
        )}
      </main>
    );
  return (
    <main>
      <Sidebar
        tab={tab}
        onTab={setTab}
        profileId={store.profileId}
        profileName={store.profileName || "My wardrobe"}
        onSignIn={() => setProfileOpen(true)}
        onSignOut={store.signOut}
      />
      <section className="main">
        {store.error && (
          <div role="alert" className="save-warning">
            <p>{store.error} Export your draft before reloading.</p>
            <button onClick={() => void store.exportBackup()}>
              Export draft
            </button>
            <button onClick={store.retrySave}>Retry save</button>
          </div>
        )}
        <header className="topbar">
          <div className="mobile-brand">✦ style studio</div>
          <span className="date">YOUR WARDROBE. YOUR POSSIBILITIES.</span>
          <button
            className="profile-button"
            onClick={() => setProfileOpen(true)}
          >
            <UserRound size={17} />
            {store.profileName || "My wardrobe"}
          </button>
        </header>
        {!uploadOpen && (
          <AnalysisBanner
            jobs={analysisJobs}
            onOpen={() => setUploadOpen(true)}
          />
        )}
        {tab === "Today" && (
          <TodayView
            wardrobe={store.wardrobe}
            result={result}
            context={context}
            onContext={setContext}
            onSave={() =>
              store.saveLook(
                result.items,
                result.message,
                context.occasion,
                context.season && context.season !== "any"
                  ? context.season
                  : undefined,
              )
            }
            onAddPhotos={() => setUploadOpen(true)}
            onSample={store.loadSample}
            onEdit={setEditing}
          />
        )}
        {tab === "My wardrobe" && (
          <WardrobeView
            wardrobe={store.wardrobe}
            collectionLabel={collectionLabel}
            onUpload={() => setUploadOpen(true)}
            onAddBlank={addBlank}
            onEdit={setEditing}
          />
        )}
        {tab === "Saved looks" && (
          <SavedView
            looks={store.looks}
            onRemove={store.removeLook}
            onExplore={() => setTab("Today")}
          />
        )}
        <footer>
          <span>PRIVATE TO YOUR ACCOUNT · {store.status.toUpperCase()}</span>
          <button className="text-link" onClick={store.exportBackup}>
            <Download size={13} /> Export backup
          </button>
          <label className="backup-import">
            Restore backup
            <input
              aria-label="Restore backup"
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void store.importBackup(file);
                e.target.value = "";
              }}
            />
          </label>
        </footer>
      </section>
      {store.toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {store.toast}
        </div>
      )}
      {profileOpen && (
        <AccountDialog
          name={user.name}
          email={user.email}
          hasUnsavedChanges={store.hasUnsavedChanges}
          onExportBackup={store.exportBackup}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {uploadOpen && (
        <UploadDialog
          accountId={user.id}
          wardrobe={store.wardrobe}
          // Resolves only after the server acknowledged the saved wardrobe;
          // the dialog closes itself afterwards. A rejection keeps the dialog,
          // the photo results and the review choices.
          onSave={async (items) => {
            await store.commitGarments(items);
            setTab("My wardrobe");
            store.notify(`${items.length} items added and saved`);
          }}
          onClose={() => setUploadOpen(false)}
        />
      )}
      {editing && (
        <ItemEditor
          key={editing.id}
          garment={editing}
          onSave={saveEdit}
          onRemove={(id) => {
            store.removeGarment(id);
            setEditing(null);
          }}
          onAddFromPhoto={() => setUploadOpen(true)}
          onClose={() => setEditing(null)}
        />
      )}
    </main>
  );
}
