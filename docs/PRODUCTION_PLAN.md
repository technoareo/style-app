> Historical roadmap. See PRODUCT_ANALYSIS.md and README.md for the implemented local beta and current release gates.

# Style Studio — Path to App Store & Google Play

## 1. Where the code is today

| Area | Current state | Gap for stores |
|---|---|---|
| Stack | Next.js 14 (App Router), React 18, TypeScript, lucide-react | Fine; needs static export for packaging |
| Structure | Whole app in one 20-line `src/app/page.tsx` (minified-style) + one CSS file | Split into components, state, data layer |
| Data | `localStorage` (profiles keyed by email, images as base64 data URLs) | ~5 MB quota, no migration, lost on cache clear/uninstall |
| Auth | Fake email "profile switcher" | No real auth needed if local-first (see §3) |
| Styling logic | `wardrobe.slice(0,4)` labeled as an outfit | No real recommendation engine |
| Photo "extraction" | Duplicates the source photo | No segmentation/recognition |
| Weather | Static label | Not implemented |
| Mobile | Responsive layout only | No native shell, icons, splash, permissions, offline handling |
| Build health | `next.config.mjs`, `layout.tsx` and README contain literal `\n` text | **Build is likely broken** — fix first |

## 2. Recommended architecture: local-first hybrid app

**Wrap the existing web UI with Capacitor** (one codebase → iOS + Android), not a rewrite.

- Next.js → `output: 'export'` (static) → `npx cap sync` → Xcode / Android Studio.
- Why not React Native/Expo? It gives a more native feel but means rewriting every screen. Choose it only if you later want heavy native UI.
- **Apple risk:** Guideline 4.2 rejects "thin website wrappers". Mitigate with real native features: camera/photo library, local notifications ("your outfit for today"), share sheet, haptics, offline-first storage, biometric lock, iCloud backup. The app must feel like an app, not a site.

```
UI (React)  →  Repository layer (interface)  →  SQLite (on device)
                                              →  Images in app file storage
                     BackupService  →  iCloud (iOS) / Google Drive (Android) / export file
```

## 3. Database & backup (your key requirement)

**Primary store: on the phone.**
- `@capacitor-community/sqlite` (SQLite, with versioned migrations). Tables: `profile`, `garment`, `outfit`, `outfit_item`, `settings`.
- Images as **files** in the app's data directory (resized to ~1600px, JPEG/HEIC → JPEG, thumbnails generated); DB stores only the file path. Never base64 in the DB.
- No account required. The "email profile" concept becomes either a plain local profile name, or is dropped. This removes server cost, auth security work, and account-deletion obligations.

**Backup/restore (user-initiated and automatic):**

| Option | iOS | Android | Notes |
|---|---|---|---|
| Platform backup | iCloud Backup includes app data automatically (set files to be backed up) | Android Auto Backup (`allowBackup`, backup rules; 25 MB limit) | Free, zero UI; Android limit is too small for photos |
| iCloud Drive / CloudKit | Yes — private container, user's own iCloud | — | Needs small native plugin (CloudKit or ubiquity container) |
| Google Drive | — | Drive **appDataFolder** scope (hidden, per-app, no broad Drive access) via Google Sign-In | Least-privilege scope avoids Google's restricted-scope verification |
| Export / import file | `.stylebackup` (zip: `db.sqlite` + `images/` + manifest with schema version) via share sheet / Files | same | **Build this first** — works everywhere, lets users move iOS↔Android |

Recommendation: ship v1 with **Export/Import + platform auto-backup**, then add iCloud Drive and Google Drive appData sync in v1.1.

**Optional later (v2): cloud sync** — Supabase/Firebase (Auth + Postgres + Storage) for multi-device and AI features. The repository interface keeps this a swap, not a rewrite.

## 4. Product work to make it "real"

1. **Outfit engine:** rule-based first (category slots: top/bottom/outerwear/shoes, color harmony, season/weather, avoid repeats from last N days) → optional AI later.
2. **Weather:** Open-Meteo (free, no key) + coarse location permission.
3. **Photo flow:** camera/library picker, on-device background removal (iOS Vision / ML Kit) instead of fake extraction.
4. **AI (optional):** if using a cloud vision/LLM API, call it through your own backend (never ship API keys in the app), get explicit consent, disclose in privacy policy and store privacy labels.
5. **Settings:** backup status, export/import, delete all data, privacy policy link.
6. **Quality:** error boundaries, empty/loading states, accessibility (labels, 44pt targets, Dynamic Type), dark mode, offline everywhere.
7. **Monetization (decide early):** free + one-time/subscription Pro (cloud sync, unlimited items). Use RevenueCat over raw StoreKit/Billing.

## 5. Repo restructure

```
src/
  app/                 routes + layout only
  components/          Wardrobe, OutfitCard, ItemEditor, Settings...
  domain/              types, outfit engine (pure, unit-tested)
  data/                repository interface, sqlite impl, migrations
  services/            backup, camera, weather, notifications
  platform/            Capacitor wrappers (so web dev still works)
ios/  android/         generated by Capacitor
```
Add: ESLint + Prettier, Vitest (engine + migrations), Playwright (web smoke), GitHub Actions.

## 6. Store requirements checklist

**Accounts & cost**
- Apple Developer Program: $99/yr. Google Play Console: $25 one-time.
- Google: new *personal* developer accounts must run a closed test with ~12 testers for 14 days before production. Organization accounts (D-U-N-S) skip this.
- **You are on Windows:** iOS builds need macOS. Use Codemagic, Ionic Appflow, Expo-style cloud CI, GitHub Actions macOS runners, or a Mac.

**Both stores**
- Unique bundle/app ID (e.g. `com.technoareo.stylestudio`), semantic versioning + build numbers.
- App icon (1024×1024), adaptive icon (Android), splash screens, screenshots per device size, short + long description, keywords, support URL, **privacy policy URL**, age rating questionnaire.
- Permission strings with honest purpose text: camera, photo library, location (if weather), notifications.

**Apple**
- App Privacy "nutrition label"; `PrivacyInfo.xcprivacy` manifest; export-compliance (uses only standard HTTPS → exempt).
- Review notes + demo content; must work without a login.
- If you add accounts later: Sign in with Apple (if other social logins) and in-app account deletion.

**Google**
- Target the latest required API level (check Play's current requirement at submission time), build an **AAB**, Play App Signing.
- Data safety form; photos/location declarations; Photo Picker instead of broad media permissions.

## 7. Roadmap

| Phase | Scope | Outcome |
|---|---|---|
| 0 — Fix & refactor (days) | Repair `\n` corruption, split components, add lint/tests/CI | Healthy codebase |
| 1 — Data layer (1–2 wks) | Repository + SQLite + file images + migration from localStorage + export/import | Durable local data, backup |
| 2 — Native shell (1 wk) | Capacitor, icons/splash, camera, notifications, safe areas, haptics | Running on devices |
| 3 — Product (2–3 wks) | Outfit engine, weather, settings, onboarding, a11y, dark mode | Real value, passes 4.2 |
| 4 — Beta (2–3 wks) | TestFlight + Play closed test (the 14-day window), crash reporting (Sentry/Crashlytics) | Stability |
| 5 — Launch | Store listings, privacy policy, review submission | Published |
| 6 — v1.1+ | iCloud / Google Drive sync, Pro subscription, optional cloud + AI | Growth |

## 8. Decisions (confirmed)

- **Data:** local-only on device, with export/import + iCloud / Google Drive backup. No cloud accounts.
- **Shell:** Capacitor wrapper.
- **iOS builds:** a Mac is available.
- **Developer accounts:** individual, so Google's 12-tester / 14-day closed test applies. Start it as soon as a stable beta exists.
- **Pricing:** subscription with a 30-day free trial, using store-native introductory offers via RevenueCat. With no backend, entitlement comes from the store receipt. Policy: after the trial lapses the app should stay read-only and backup export must keep working, so users never lose access to their own data.

## Status

- [x] Phase 0: build repaired, components split, storage interface, lint, typecheck, CI
- [ ] Phase 1: SQLite + file images + export/import
- [ ] Phase 2: Capacitor shell (iOS on the Mac, Android)

