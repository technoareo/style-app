# Corrupt stored wardrobe: what happens and what is NOT available (build 015, revision 3)

Written for: operators and the next reviewer. Status: **limitation documented; repair OPEN, nothing here was run.**

## Decision (review finding M1)

This batch keeps the safe behaviour and adds no repair, no recovery screen and no new response field.

- `GET /api/wardrobe` for an account whose stored wardrobe row cannot be read answers a fixed `500` ("Your saved wardrobe could not be read. Nothing was changed. Please contact support."). It never echoes stored content, never repairs, never substitutes an empty wardrobe and never reclaims photos.
- `PUT /api/wardrobe` still requires the stored revision. The `500` does not reveal it, so an ordinary client cannot learn it. A `PUT` with a wrong revision answers `409`.
- Exposing the revision in the `500` body was considered and **rejected for this batch**: it would let a client overwrite an unreadable document without any review. Not decided as permanent; it is open for a later batch together with a user-visible recovery design.

## Honest statement of the limitation

- Saving from the app does **not** by itself let a user recover a corrupt server row while the revision is unknown. Do not tell a user that it does. The route test that replaces a corrupt document seeds revision 7 on purpose; a real client has no way to know that number.
- Recovery of an account in this state is **operator-assisted**. No operator tool, command or tested procedure for it exists in this repository. Any repair step is therefore **OPEN / not implemented / not verified**. This document deliberately gives no commands.
- Not affected (stated from the existing behaviour, not re-verified in this batch): a user who has no corrupt row signs up, signs in, uses the app, resets a password and deletes the account by self-service as before.
- Not verified: how the browser client behaves after the `500` on load, and whether it can offer the user an export of unsaved local state.

## Prerequisites any future controlled recovery must meet (requirements, not working steps)

1. A current backup of the whole data directory exists first, and the person doing the work has shown that the backup can be restored. The backup and restore procedure itself is covered by the deployment guide and is not re-verified here.
2. The affected row is preserved byte for byte before anything is changed, so the original can be examined afterwards.
3. Writers to that account are stopped or the app is stopped for the duration, so a concurrent save cannot interleave.
4. The replacement document is validated by the application's own schema before it is stored, and the account's photo references are checked against that account's own photos.
5. The user is told what was and was not recovered. Nothing is silently overwritten.

## OPEN

- An operator repair tool or documented procedure (not written, not tested).
- A user-visible recovery path (not designed).
- Whether to expose the revision, or an explicit "replace from export" flow, with an explicit confirmation.
- Client behaviour on the `500` (not read, not run).
