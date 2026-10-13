"use client";
import { useState } from "react";
import { Dialog } from "./Dialog";
import { authClient } from "../services/authClient";
export function AccountDialog({
  name,
  email,
  hasUnsavedChanges,
  onExportBackup,
  onClose,
}: {
  name: string;
  email: string;
  hasUnsavedChanges: boolean;
  onExportBackup: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmDiscard, setConfirmDiscard] = useState(false);
  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result?.error) throw new Error(result.error.message);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Sign out could not be completed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.deleteUser({ password });
      if (result.error) throw new Error(result.error.message);
      const signedOut = await authClient.signOut();
      if (signedOut?.error) throw new Error(signedOut.error.message);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Account could not be deleted.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Your account" onClose={onClose}>
      <p>
        {name} · {email}
      </p>
      <p>
        Your wardrobe and photos are private to this account. Export a backup
        before deleting your account.
      </p>
      {hasUnsavedChanges ? (
        <div className="save-warning" role="alert">
          <p>
            Some wardrobe changes have not finished saving yet. Signing out now
            could lose this draft.
          </p>
          <button disabled={busy} onClick={() => void onExportBackup()}>
            Export draft
          </button>
          {!confirmDiscard ? (
            <button disabled={busy} onClick={() => setConfirmDiscard(true)}>
              Discard unsaved changes and sign out…
            </button>
          ) : (
            <>
              <p>
                This signs out now and discards the wardrobe changes that have
                not been saved.
              </p>
              <button disabled={busy} onClick={() => void signOut()}>
                Discard and sign out
              </button>
              <button disabled={busy} onClick={() => setConfirmDiscard(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      ) : (
        <button disabled={busy} onClick={() => void signOut()}>
          Sign out
        </button>
      )}
      <details>
        <summary>Delete account and all saved photos</summary>
        <p>
          Deleting your account immediately removes your sign-in, wardrobe,
          saved looks, photos and any emails still waiting to be sent from the
          live service. It is not a secure wipe of the server&apos;s storage:
          deleted data can remain in unused database space until it is
          overwritten, and in server backups made before you deleted, which are
          kept for up to 7 days by default. Backups are not encrypted by the
          app itself. We keep a pseudonymous deletion record (an internal ID
          and date, not your name or email) so a restored backup cannot bring
          the account back.
        </p>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Type DELETE to confirm
          <input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        <button
          disabled={busy || confirmation !== "DELETE" || !password}
          onClick={() => void remove()}
        >
          Delete my account
        </button>
      </details>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
