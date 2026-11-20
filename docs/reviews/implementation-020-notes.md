# Implementation 020 notes

Written for: root and the next independent reviewer. Not committed, pushed or deployed. Not launch ready. This file is the single current description of build 020 (revisions 1 to 3 folded in). Earlier intermediate counts and wording are intentionally not kept; the history is in git once committed.

## What build 020 does: outfit suggestions use confirmed seasons and occasions

### Behaviour (`src/domain/outfit.ts`)
- `StyleContext.season` (optional): `"any"` | spring | summer | autumn | winter, chosen by the user in the **Season** select on Today. Default "Any season". Nothing is inferred from photos, dates or temperature. Omitted = "any", so older callers are unchanged.
- Plan to tag: everyday→`everyday`, work→`work`, evening→`evening`, formal event→`event`. Season tags only matter when a season is chosen.
- Per piece and per active dimension (occasion; season when chosen): **hit** (tags include the target), **near** (occasion only: a related tag), **unknown** (absent or empty tags: neutral, never excluded), **miss** (tags exclude the target).
- Related occasion tags (`near`): formal event accepts `evening` and `work`; evening accepts `event`; everyday and work have none. Near is never a mismatch and never counted as a confirmed fit. The formal plan still only considers pieces the user set to Formal, so a related tag cannot lift a casual piece; a formal piece tagged only `lounge`/`everyday`/`active` is a mismatch.
- Outfit order: fewest misses, most hits, most near, higher formality/colour score (unchanged rule), item ids. Each category is sorted by the same relevance (then formality points, then id) before the cap of 60, so the cap keeps the most relevant pieces regardless of the order they were added.
- Search: `bestOutfits` scans every base x shoe pair and keeps only the best 30 (never more than 31 entries at once); per-item numbers are precomputed, and an id key is built only for a stored entry or a full numeric tie. `rankOutfits(wardrobe, context, limit, stats?)` exposes the ranked id lists and optional counters (`examined`, `maxRetained`) for tests.
- Variation ("Another combination"): restricted to outfits with the fewest misses. It walks the strongest tier (same hits and near) first and uses that tier whole. Only if the strongest tier has fewer than `MIN_VARIETY` (3) outfits does it add entries from the next tier(s), **only as many as needed to reach 3**, in ranked order. So 2 strongest + 28 weaker gives a pool of 3, not 30.
- Suitability (`confirmed` / `partial` / `unconfirmed` / `mismatch`) describes the **main pieces only**. A cold-weather layer is chosen by the same order, never changes the verdict or title, and a mismatched layer gets its own note ("The layer is added for warmth at N°C and is not confirmed for <plan>: <name> (occasions: ...; seasons: ...)").
- Copy:
  - mismatch: "Closest match, not a confirmed fit for <plan>: <name> (seasons: summer, not winter)" naming the conflicting dimension(s); title "Closest <plan> combination".
  - confirmed: "Every piece (or: Every one of the main pieces) is tagged for <plan>."
  - partial with confirmed tags is **dimension-specific**: "1 of 3 pieces tagged for work, 0 of 3 pieces tagged for winter; the others have no matching tag yet, so their fit is unconfirmed." Season-only evidence is never described as supporting the occasion, and vice versa; with a layer it says "main pieces"; without a season only the occasion part appears.
  - partial with only related tags: "No piece is tagged for formal event itself; evening or work-tagged pieces suit it and are used."
  - unconfirmed (old wardrobes): "No piece is tagged for <plan> yet, so this is chosen by formality and colour only. ..."
- `seasonTemperatureWarning`: winter at 25°C or above, or summer at 10°C or below, shows an inline status message under the controls (a hint; nothing is changed or excluded). The hot-weather exclusion of `warm` items stays at 27°C.
- Saved looks store the chosen season (`SavedLook.season`, validated in `backupSchema`, shown as "occasion · season"); older looks without it validate and display as before.
- Unchanged and still tested: only owned items, `available`/`reviewed` filters, complete outfits (top+bottom or dress, plus shoes), formal requires `formality === "formal"`, hot-weather exclusion, cold-weather layer below 20°C.

### Tests
- `tests/outfitMetadata020.test.ts` (11): season and occasion change the choice; match > untagged > mismatch; deterministic order; old untagged and empty-tag wardrobes; mismatch-only wording; confirmed vs partial; formal + `event`; exclusions that tags cannot override; layer follows season; late match survives the cap; owned-only across all combinations.
- `tests/outfitRepair020.test.ts` (10): formal related tags and their limits; layer does not downgrade the core and is reported; dimension wording of mismatches; variation tiers (strong tier fills the pool, one strong outfit still gives variety); **top-up only to `MIN_VARIETY`** (2 strongest + 28 weaker, 1 + 29, and 3+ whole; verified to fail if the whole next tier is appended); **dimension-specific partial copy** (season-only, occasion-only, no season, with layer); **full-ordering property test**: the complete `rankOutfits` list (top 5 and top 30) equals a brute-force ranking on 40 random wardrobes x 4 occasions, with a guard that more than 20 rounds really had more than 30 combinations; **deterministic max-size contract**: with 600 tops/bottoms/shoes and 100 dresses it asserts exactly (60 + 60x60) x 60 = 219,600 pairs scanned, at most 31 entries retained, 30 returned, and the late-added relevant top is the winner (wall time is only a `t.diagnostic` line plus a 10 s sanity bound; it measured about 16 ms on the author's machine, which proves nothing about other machines); season/temperature warning; saved-look season in the schema.
- `tests/e2e/outfitMetadata020.spec.ts` (3 x desktop and mobile) and `tests/e2e/outfitRepair020.spec.ts` (4 x desktop and mobile): tagged wardrobe restored from a backup file; look changes with season and occasion and shows the dimension-specific partial note; closest-match wording; untagged sample wardrobe unchanged and honest; formal gown tagged evening; layer wording with title kept; season-only conflict wording; winter at 30°C warning and the saved look's season surviving a reload.

### Last recorded results (Windows, Node 24)
| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npm run lint` | passed |
| `npm test` | 389 tests: 384 passed, 0 failed, 5 skipped (skips not investigated) |
| New/changed outfit unit files | 21 tests passed |
| Browser: new 020 specs, desktop and mobile | 14 passed |
| Browser: full suite (before the revision-3 copy and test changes, which only touch the partial note, its regex and unit tests) | 65 passed, 1 skipped (mobile cross-browser sign-up, as before) |
Not run: `npm run build`, the standalone check, Docker, any real-model check. Running Playwright starts `next dev`, which rewrites `.next`; **the production build and standalone check must be rerun after this build.** The e2e run rewrites `docs/verification/desktop.png` and `mobile.png`; restore them with `git checkout`.

### Remaining risks
1. The per-category cap of 60 still exists. It keeps the most relevant pieces, but 60 equally relevant tops cannot reach the 61st. Removing it needs a smarter search.
2. Ranking weights are a judgement, not user-tested: relevance outranks colour balance, so a matching but clashing outfit beats a pleasing untagged one.
3. Strict mismatches: a piece tagged only `everyday` is a mismatch for work or evening. The related-tag rules (and the 25°C / 10°C warning thresholds) are product judgements.
4. Tags may be unreviewed AI suggestions saved with one tick (a build 018 risk); ranking now amplifies them. Notes say "tagged", never "verified".
5. `active` and `lounge` are never a plan target; there is no separate "event" option beyond Formal event. The chosen season/occasion/temperature are not persisted across reloads.
6. A server on the previous build would drop `SavedLook.season` in a mixed deployment.
7. Performance is covered by a deterministic work-bound contract, not by a timing guarantee; measured time here was roughly 11 to 36 ms for the maximum case, against roughly 400 ms for the earlier version.
8. No real-model evidence is involved in this build.
