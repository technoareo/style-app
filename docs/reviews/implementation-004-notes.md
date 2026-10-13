# Implementation 004 notes: guarded sign-out while a save is pending or failed

Scope: `src/hooks/useStyleStore.ts`, `src/app/page.tsx`, `src/components/AccountDialog.tsx`, `tests/e2e/consumer.spec.ts`. Not run by the author (no shell access); Codex to run build/type/lint and the Playwright suite.

## Problem
`AccountDialog` called `authClient.signOut()` immediately on "Sign out", regardless of whether the serial write queue in `useStyleStore` had an in-flight or failed save. A sign-out mid-save (or after a save failed) could discard the only copy of a draft, since the queue is per-tab and not persisted anywhere else.

## Changes

### `src/hooks/useStyleStore.ts`
- Added a `hasUnsavedChanges` boolean state, set/cleared explicitly at the points that already know the true save state, never derived from the human-readable `status` string:
  - `change()` (the single entry point for every mutation: add/update/remove garment, save/remove look, load sample, import backup) sets it `true` synchronously.
  - The save effect clears it `false` only in the success branch that already applies (same `captured === latestGeneration.current` guard the existing status text uses), so a newer queued change keeps it `true`.
  - The failure branch sets it `true` explicitly.
  - `retrySave()` sets it `true` (a failed save is unsaved by definition until a retry succeeds).
- Exposed `hasUnsavedChanges` on the returned store object.

### `src/components/AccountDialog.tsx`
- New required props: `hasUnsavedChanges: boolean`, `onExportBackup: () => void | Promise<void>`.
- When `hasUnsavedChanges` is `false` (saved wardrobe): unchanged simple "Sign out" button, now also checking the `signOut()` result for an `error` and surfacing it via the existing `role="alert"` paragraph, with `busy` disabling the button while in flight.
- When `hasUnsavedChanges` is `true`: the plain "Sign out" button is replaced (not just disabled) by:
  - Clear wording: "Some wardrobe changes have not finished saving yet. Signing out now could lose this draft."
  - An "Export draft" button wired to the existing `exportBackup` flow (passed down as `onExportBackup`).
  - A "Discard unsaved changes and sign out…" button that only *reveals* a second step (explicit confirmation copy plus "Discard and sign out" / "Cancel" buttons) rather than signing out itself. Only the final "Discard and sign out" click calls `authClient.signOut()`.
  - Ordinary "Sign out" is never rendered in this state, so it cannot be clicked accidentally.
- `remove()` (delete account) now also checks the `signOut()` result after deletion for consistency with the new error handling.

### `src/app/page.tsx`
- Passes `store.hasUnsavedChanges` and `store.exportBackup` into `AccountDialog`.
- Added a `beforeunload` listener, justified because a reload/close is the other way an unsaved or failed save can be silently discarded, exactly the same condition the sign-out guard reacts to. It is installed only while `store.hasUnsavedChanges` is `true` and removed either when that flips back to `false` or on unmount, via the effect's cleanup function (`window.removeEventListener` in the returned callback), so there is never more than one listener attached and it is not left behind after the condition clears.

### `tests/e2e/consumer.spec.ts`
- New test "sign-out is guarded while a save is delayed and then fails": routes `PUT **/api/wardrobe` to delay 300 ms and then return a 500, adds the sample wardrobe (triggering a save), waits for the footer to show `CHANGES HAVE NOT BEEN SAVED`, opens the account dialog, and asserts inside the dialog (scoped with `page.getByRole("dialog", ...)` to avoid colliding with the identically-labelled "Export draft" button in the page's own error banner):
  - the unsaved-changes wording is visible,
  - no plain "Sign out" button is rendered (`toHaveCount(0)`),
  - "Export draft" triggers a real download,
  - signing out requires clicking "Discard unsaved changes and sign out…" and then the separate "Discard and sign out" confirmation,
  - after that, the auth screen's "Sign in" button is visible again.
- No existing test was weakened; all prior assertions and flows are untouched.

## Database initialization fix (reviewed, not modified)
Confirmed `src/server/database.ts` still sets `PRAGMA journal_mode = WAL;` inside `runReady()`, after acquiring the `proper-lockfile` migration mutex (`schema.lock`) and before migrations run. This is unchanged.

## `scripts/restore-database.ts` review
Walked the ordering around the live database's `wal_checkpoint(TRUNCATE)` and the sidecar deletion:
1. `PRAGMA wal_checkpoint(TRUNCATE)` runs on the *current* live `app.db` first, and the script throws if `busy !== 0` (a writer/reader is still active), so the live WAL is always fully folded into the main file before anything else happens.
2. The current connection is closed before the backup (`source`) is copied into the staging file and validated (`integrity_check`, deletion-ledger carry-forward, `foreign_key_check`, `VACUUM`).
3. Only after the staging file is fully validated does the script delete the live database's `-wal`/`-shm` sidecars and rename staging over the destination.
Because the checkpoint has already zeroed the live WAL by the time its sidecars are deleted, and that deletion happens immediately before the atomic rename (not before validation), a crash at any point leaves either the original, fully-checkpointed live database or the new validated one — never a half-restored or data-losing state. No concrete defect was found in this ordering, so **no change was made to `scripts/restore-database.ts`**, per the instruction to fix only a concrete issue.

## Not claimed
No production-readiness claim. Public hosting, HTTPS, real email delivery and container capacity remain untested.
