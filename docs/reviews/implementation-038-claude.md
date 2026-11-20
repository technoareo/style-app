# Build 1 close-out review — Claude

Reviewed in the persistent `Style Studio MVP product plan` chat on 2026-11-20.

## Verdict

**REVISE — short foundation close-out, not a new feature build.** Claude accepted
the mobile navigation, redesigned Closet, design system, privacy-safe static-only
PWA cache, multi-user isolation, disabled FashionCLIP provider, and the fully
green Linux CI run 43. It requested evidence or implementation for:

1. additive Build 2 schema plus existing-item backfill and staging rollback;
2. a capture rollout flag;
3. a remotely controlled PWA cache kill switch and real iPhone/Android install;
4. target-size light/dark screenshots, loading/empty/error states, axe,
   Lighthouse and a CI contrast check;
5. an offline FashionCLIP run on a rights-cleared image from an empty cache, and
   a named phone-test host.

Claude allowed item-detail editing, first-party analytics and the rights-cleared
demo closet to move to Build 2. It recommended Build 2a as a flag-protected,
background capture and human-review flow; provider benchmarking remains Build 2b.

## Close-out implementation

- Migration `038-capture-foundation`: `extraction_jobs`, `field_edits`,
  `consents`, exact JSON safety copies, additive item defaults, idempotence and a
  staging-only rollback that restores byte-identical wardrobe JSON. Safety copies
  cascade on account deletion.
- Server flags: `STYLE_CAPTURE_V2_ENABLED` (off by default) and
  `STYLE_PWA_CACHE_ENABLED` (on by default); malformed values fail closed.
- `/api/runtime-config` is `no-store`. Disabling PWA caching unregisters Style
  Studio service workers and deletes only `style-studio-*` caches on next visit.
- Axe screenshot suite covers 390×844 and 360×800, light/dark, loading/empty/error;
  CI uploads the package. A dependency-free WCAG AA token test runs in the unit
  suite. Lighthouse is installed for the remaining production-host report.
- Optional-image CI now prepares the pinned model in a fresh cache, deletes that
  cache and runs the rights-cleared public-shirt image in a network-less container.
- Phone-test host is the Linux Compose+Caddy stack. Real-device installation is
  honestly retained as an owner acceptance step.

## Local evidence

- Typecheck: pass.
- Lint: pass.
- Six focused migration, flags, PWA, contrast and Docker-contract tests: pass.
- Production dependency audit: zero known vulnerabilities.
- Windows production build and the isolated browser capture could not complete on
  this host; Linux CI is the authoritative build/browser environment.
