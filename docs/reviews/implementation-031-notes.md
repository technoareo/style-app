# Implementation 031: consumer-facing truthfulness corrections

Status: implemented; validated by root on Windows and by a successful Linux CI run of the committed tree (see Validation; the builder ran nothing and did not read the CI logs). The product is **not launch-ready**; the external gates at the end are untouched by this build.

## Product decision this build enforces

The supported workflow is **easy single-item detection**: one clothing item per photo. Crowded and multi-item photos are deferred. The old multi-item mode (`STYLE_ANALYSIS_MODE=multi`) exists only as an operator rollback to earlier code, documented in `docs/DEPLOYMENT.md`; it is not a supported consumer feature. Default consumer copy must therefore never invite several items in a photo.

## Problem

Three user-facing statements contradicted the product or the facts:

1. The upload banner in `WardrobeView` promised "One item or several in a photo. Local AI finds visible pieces and suggests their details for you to review." That invited exactly the photos the single-item path does not support (it lists only the most prominent item and warns).
2. The timeout and cut-short messages in `vision.ts` told the user to try "a clearer photo of one to three items with space between them", again inviting several items.
3. The delete-account text in `AccountDialog` ended its backup sentence with the blanket claim "Backups are not encrypted by the app itself." That is stale: operators can create encrypted portable backup packages (Build 021), so the blanket statement is wrong, and the opposite blanket claim would be equally wrong.

## Changes (user-facing strings only; no behaviour changed)

- `src/components/WardrobeView.tsx`: the banner heading is now "Upload a photo of each clothing item"; the paragraph is "Use exactly one clothing item per photo. Local AI proposes its details, and you review and correct them." (deliberately not "AI suggests ...": that phrase belongs to the transient review-suggestion line, and `tests/e2e/singleItem018.spec.ts` asserts `getByText(/AI suggests/)` has count 0 after a suggestion is accepted or cleared, which a permanent banner containing it would break); the small print is "JPEG, PNG or WebP · Up to 6 MB · One item, fully visible, in good light." The limits match the real client-side rules in `src/services/images.ts` (JPEG, PNG, WebP; a photo of 6 MB or more is refused) and the file picker's `accept` list. No accuracy is claimed; none has been measured. The nearby upload dialog already said "Photograph one clothing item per photo" and "If several items are visible we list only the most prominent one", so it is consistent and was left as it was.
- `src/server/vision.ts`: `TOO_SLOW_MESSAGE` and `ANSWER_CUT_MESSAGE` now say "Try a clearer photo with one clothing item clearly visible." Their error kinds (`timeout`, `unverified`), the request, the verification and every other behaviour are unchanged.
- `src/components/AccountDialog.tsx`: the sentence now reads "The operator can create encrypted backup packages, and plain local backups may also exist; we do not promise that every backup is encrypted, stored away from the server or tested by restoring it." Kept as before: deletion is immediate in the live account (sign-in, wardrobe, saved looks, photos, queued emails), it is not a secure wipe of the server's storage, server backups made before deletion are kept for up to 7 days by default, and a pseudonymous deletion record is kept so a restored backup cannot bring the account back.
- **Search of the rest of the default consumer UI** (`src/components`, `src/app`) for other promises of multi-item or crowded photo support found none beyond the three above. `TodayView`'s "One photo is all it takes to begin" is a statement about starting, not about several items. Left unchanged on purpose: `CROWDED_WARNING` in `src/domain/analysis.ts` (it still says "one to three items") and `MULTIPLE_ITEMS_WARNING`, because they belong to the multi-item rollback path (`crowded` is only computed when `!single`) and the build brief says not to change the documented rollback behaviour. That text is shown only if an operator enables the rollback.

## Tests (`tests/consumerCopy031.test.ts`, new)

Source assertions on whitespace-normalised, comment-stripped text, not snapshots: the banner heading, paragraph and small print; no "One item or several" and no accuracy wording in the banner; the stated limits agree with `services/images.ts` and the file picker; the upload dialog's single-item guidance is intact; the two messages are exactly the new text, contain no "one to three", "several" or "space between them", and still raise `timeout` / `unverified`; the rollback guards (`!single` crowded rule, `MULTIPLE_ITEMS_WARNING`) are still present; the account dialog no longer contains the stale sentence, contains the new qualified one, keeps the 7-day and deletion-record facts, and has no blanket "every backup is encrypted / copied off-server / restore-tested" wording; a scan of every component and app `.tsx` for wording that invites several items in a photo, with a check that the detector would have caught the old banner; and that these notes keep the scope and launch caveats.

## Validation

The builder could not run any command in its sessions; **every result below was produced by root and is recorded as reported.** The first group was run by root on a Windows workspace; the Linux CI result follows it.

### Windows (root)

- Focused consumer-copy + single-item (`analysisMode018`) + vision-cap tests: **36/36 pass**, after the over-broad backup regular expression in the consumer test was corrected (it had matched the required negated disclaimer "we do not promise that every backup is encrypted...").
- Final consumer-copy tests (`tests/consumerCopy031.test.ts`): **8/8 pass**.
- `npm run typecheck`: pass. `npm run lint`: pass.
- Optimized production build, build-output sanitization and packaging verification: pass.
- First full Playwright run: **63 pass, 1 expected mobile-auth skip, 2 failures** (desktop and mobile `tests/e2e/singleItem018.spec.ts`): the permanent upload banner reused the transient review phrase "AI suggests", which that spec asserts has count 0 once a suggestion is accepted or cleared.
- Fix: the banner now reads "Local AI proposes its details, and you review and correct them." without weakening the existing review-flow assertion. The targeted desktop/mobile single-item spec file then passed **14/14**.
- Final complete Playwright run: **65 pass, 1 expected mobile-auth skip, 0 fail.**
- Housekeeping: `docs/verification/desktop.png` and `docs/verification/mobile.png` were rewritten as incidental Playwright side effects. They are not Build 031 evidence and are not cited here. Root restored both to HEAD, and they were not committed as Build 031 evidence (they are absent from the diff).

### Linux CI (GitHub Actions, as reported by root; the builder did not read the logs)

Workflow run **42956230760** completed successfully for Build 031 commit **`171db2e76c69a9bb977557253ab1cdb8a3b544c6`**: both the Linux `build` job and the dependent `docker` job passed. Narrowly, this proves that **this exact committed tree passed the repository's Linux build workflow and its Docker / live-container workflow** (including the `npm audit --omit=dev` gate and the strict install policy from Build 030, which the same workflow runs). It does not add to or replace the Windows results above, and it does not turn any gate below into a pass. Its limits are those of the workflow: a GitHub-hosted runner, the CI **mock model** (no real vision model, so no recognition result and no accuracy), and **no real SMTP relay** (mail is locally captured).

## Remaining external launch gates (unchanged by this build)

This build does **not** make the product launch-ready. Still open: a representative, **rights-cleared**, human-labelled real-photo benchmark that passes an approved policy (recognition quality is unmeasured, which is why the copy claims no accuracy); **hosting**, a real **domain** and publicly trusted **TLS**; a **real SMTP** relay with delivered account mail; an **off-server** backup with a restore tested on a different machine; **capacity** measured on the operator host under load; and the operator's **privacy/legal identity and contact details** for the privacy notice. Crowded-photo support remains deferred.
