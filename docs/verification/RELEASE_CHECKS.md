# Release verification status

Latest verified candidate: corrected build009, frozen as release-snapshots/build-009-corrected. NOT approved for public launch by root or Claude. Build010 is frozen (155 hashes), with typecheck, production packaging and isolated startup passed. Its full regression had one write-budget failure under combined load; the unchanged two-file-parallelism run passed115checks/4skips, browser33checks/1skip passed, and Claude independently reviewed it without launch approval. Default full-suite write-budget failure remains open. Build011 diagnostics are now being implemented by Claude. See BUILD010_CHECKS.md.

Corrected009: full backend 88 passed / 1 Windows symlink skip; browser 33 passed / 1 duplicate-mobile-signup skip. Typecheck, production build, sanitized packaging and isolated standalone startup passed. Build ID uQcx9u-SKHj4_wfgHvJQQ. The 133 source/config/test hashes matched after verification. The exact 80-second live-owner backup probe passed with the process-held SQLite coordinator lock. Browser checks use controlled recognition responses; they do not establish AI accuracy.

Claude independent review: docs/reviews/build-009-corrected-claude.md. No new P0/P1 defect in the targeted corrected009 changes; fresh-server recovery, idle-writer coordination, backup durability/privacy details, mail health and SMTP remain findings. See BUILD009_CORRECTED_CHECKS.md and frozen REVIEW_EVIDENCE.md. Earlier failed009 results below remain historical and are superseded by corrected009 for that candidate only.

Dense wardrobe recognition remains unproven: natural closet 4B timed out; 2B produced invalid or incomplete output. Experimental GroundingDINO Python failed before inference; Node offline processor loaded but native session creation exited without results. Neither is application functionality or accuracy evidence.

Open launch gates include whole-wardrobe recognition and held-out evaluation, physical SQLite/WAL cleanup, latest deletion-ledger disaster recovery, encrypted offsite scheduled backups, real TLS email delivery, Docker/Linux/target capacity, hosting/domain/HTTPS, monitoring and actual consumer phones. No public deployment exists.

## Historical build009 and build008 status

Latest working tree: build009. NOT approved; backend82pass/1fail/1skip, browser29pass/2fail/1skip, compiled isolated startup passed. Confirmed live-owner backup lease failure; see BUILD009_FINDINGS.md. Build008 below is the last independently reviewed frozen candidate, also not approved.

Frozen124 source/test/config files are SHA256-verified, with zero source changes after final build. Production build wLWWk2aqUigZHF46vyzpE passed compile, lint/types, pages, trace sanitization and packaging. Final isolated standalone startup/account/photo routes passed with no ancestor project dependencies.

Backend61pass/1Windows file-symlink skip before final mail correction; afterward mail14pass, packaging10pass/1skip and typecheck passed. Browser31pass/1duplicate-mobile-signup skip against unchanged UI/account/save flows in the initial008 compiled bundle. Do not add overlapping suites to fabricate a total. Independent Claude review of frozen008 is running. See BUILD008_CHECKS.md and release-snapshots/build-008 review evidence.

Durable mail now retries separately from AI, uses bounded cancellable connections, clears terminal bodies and protects tenants. Plain local fake SMTP proves protocol behaviour only; TLS/auth/provider delivery and worker sustained-heartbeat evidence remain incomplete. Root identified heartbeat false-health risk for20serialsends vs60s freshness.

Whole natural closet development fixture timed out240seconds with no validated detections. Physical SQLite/WAL cleanup, fresh-server restore/latest exported deletion ledger, credential revocation after old backup restore, encrypted off-server scheduled backups, real SMTP, Docker/target capacity, hosting/domain/HTTPS and actual consumer phones remain release gates. No public deployment exists.

---
# Release verification — 12 October 2026

Status: release review continues. The app is not approved for public production launch.

## Historical candidate: build 007

The frozen sibling release-snapshots/build-007 contains 107 SHA256-verified source/test/config files. The hashes matched after verification. Next production build ID: `PQG-84PY1wvI9z1arnstb`. Typecheck and production compile/lint/type/page generation passed.

Mandatory packaging verification passed after removing private references and generated copies from standalone output. Windows Next glob exclusions alone failed. The build now sanitizes only generated output, then checks manifests and standalone; startup refuses unclean output. The actual project runtime data remains separate. No artifact was exported or published.

The last full backend suite passed 40/40 in 42.989 seconds; a separate concurrency run passed 7/7 in 37.155 seconds after earlier reproducible signup lock-acquisition failures. Later changes were browser recovery/accessibility and packaging. This does not prove target-server capacity or strict fairness.

The final desktop and emulated-mobile browser suite passed 31 checks, with one duplicate mobile signup check intentionally skipped, in approximately 1.5 minutes. It covers the prior consumer workflows plus dress-code review, confirmed shoe pairing, failed-save recovery across reload, corrected-value retries, lost-response duplicate prevention, honest discard failure, late-response suppression and background resume.

A real local Qwen 4B browser upload passed photo normalization, detection, review, acknowledged save and reload in 242.586 seconds. A separate real inference cancellation started the next account's job in 2.610 seconds; cancelled results were absent and the next shirt analysis completed after 214.303 seconds. These are repeated shirt smoke fixtures and observed timings, not a recognition benchmark or latency percentile. Independent Claude review of the frozen build is in progress.

Dense natural wardrobe recognition, representative held-out evaluation, durable mail/failure handling, physical deletion/WAL/retention, and fresh-server restoration preserving deletions remain required. Docker/Linux, public hosting/domain/TLS/proxy/cookies, real SMTP, target capacity, offsite encrypted recovery, operational alerts and non-team consumer/real-device acceptance have not passed. No public production launch is approved.

See BUILD007_FINDINGS.md, live-cancel-007.json, live-browser.json and the frozen manifest/review evidence. The history below is superseded by this candidate; implementation notes and smoke tests are not launch sign-off.

## Historical build 005

The production build compiled successfully and passed its source type/lint checks. All 13 browser checks passed against the compiled app (desktop/mobile); one duplicate mobile account flow was intentionally skipped. Coverage includes public signup with private development email capture, verification, genuine second-browser login, recovery/reset/deletion, wardrobe editing, outfit saving, private backup import/export, upload review/crop confirmation, account request bounds, and deliberate sign-out with a failed save.

The preceding real local-model browser upload passed recognition, review, save and reload in 80.115 seconds. That is one observed latency, not a percentile or capacity measurement.

Running a new real-photo check concurrently with the browser suite exposed a runtime SQLite database-lock failure during account creation. Claude inside Visual Studio Code implemented an immediate-transaction dialect and separate auth connection. Initial verification of that change found 14/16 integration tests passing, with failures in the parallel worker-writer stress test and stopped-database restore drill. Full-project typecheck also exposed a queue test callback typing error. These failures were returned to Claude in the editor; this changed source is not yet a passing release.

## Evidence limits

Browser recognition responses in the ordinary suite are controlled. Existing actual vision fixtures cover a shirt, a hoodie, a constructed two-item collage and an empty image; they do not establish accuracy across consumer wardrobes, overlapping garments, accessories or difficult lighting.

Private development mail capture is not real email-delivery evidence. No public server/domain, live HTTPS deployment, Docker container cold-start/capacity run, off-server backup restoration or live SMTP verification/recovery delivery has been completed. Reviewer implementation notes are not a launch sign-off. The next passing build must be frozen with a source manifest and independently reviewed before release.





