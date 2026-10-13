# Build 007 verification in progress

Codex verification, 12 October 2026. This is not launch approval.

Claude completed Batch A in VS Code, then addressed compilation errors, conservative admission and lease bounds, SQLite row assertion shapes, and signup lock acquisition. The last complete backend run passed 40/40 checks in 42.989 seconds. A separate concurrency run passed 7/7 in 37.155 seconds. Earlier signup acquisition failures were reproduced twice; one was localized to refused `BEGIN IMMEDIATE`, not the migration or signup body. Passing these runs does not establish target-host capacity or strict cross-process fairness.

Two further source findings were sent to Claude for repair:

1. Upload review clears its stored choices and discards the server analysis job before the asynchronous wardrobe save is acknowledged. Failed asset uploads, a wardrobe conflict or a server error can therefore remove the resumable result. Save acknowledgement, recoverable failure and duplicate-safe retry need browser verification.
2. Production compilation returned success, but Next file tracing included private runtime data. A path-only check counted 6,608 `.data` entries across 14 NFT manifests (counts include repeated references), and `.next/standalone/.data` existed. A copy warning referenced a temporary test SQLite shared-memory file. No private contents were inspected for this finding. The build must exclude runtime databases, secrets and mail, and a fresh packaging check must pass before any artifact is exported or deployed. No artifact has been published.

The production build initially stalled while the previous local test server held its output files. Stopping the owned test server and worker allowed compilation to proceed. Both remain stopped pending the corrected build.

Next checks: a stable source revision, backend suite, sequential production compile with packaging exclusions, NFT and standalone checks, desktop/mobile browser flows, actual free-model queued processing/resume/cancel, then another Claude review. Dense wardrobe recognition, durable mail, physical deletion/retention, fresh-server recovery and real deployment gates remain open.

## Subsequent verification

Claude fixed the save ordering with acknowledged wardrobe commits, stable item IDs, upsert retries with the latest reviewed values, and retained results on failure. Browser checks also exposed ambiguous implicit select labels, late results resetting review, and Escape failing after focus was removed. These were repaired without forcing clicks or weakening save assertions.

The final compilation and its mandatory packaging check passed (build ID `PQG-84PY1wvI9z1arnstb`). Windows Next exclusions failed to match native paths, so the documented fallback removes only private copies in generated standalone output and private entries in generated NFT manifests, then verifies the result. Compilation alone is insufficient. The final sanitizer removed 13,840 repeated trace entries from 16 manifests and one generated private folder. The real project database and auth-secret still exist; no private file contents were inspected for this verification. No output has been deployed or exported.

The final browser suite passed 31 checks, with one intentionally duplicate mobile signup check skipped, in approximately 1.5 minutes. Both desktop and mobile passed formal-review defaults, explicit shoe pairing, failed-save recovery across reload, latest-value retries, lost-response duplicate prevention, honest discard failures, late-response suppression and background job resume. The 107 recorded source hashes matched after the run. This is desktop Chrome and emulated mobile coverage, not real-device acceptance.

Two disposable accounts also tested real local inference cancellation: the next job started 2,610 ms after cancellation, the cancelled result was absent, and the next real shirt analysis completed with one top after 214.303 seconds. See `live-cancel-007.json`; backend code did not change during the subsequent browser repairs. This is a smoke check, not a performance percentile or recognition benchmark.

Stopping the npm-launched worker on Windows left a five-minute ownership lease. No owned worker process remained. Its lease was allowed to expire rather than forcibly clearing it; the worker then restarted successfully. Production supervisor and shutdown behavior still need real container testing.

The final real-browser upload/review/save/reload check passed in 242.586 seconds. All 107 source hashes still matched afterward. A read-only source snapshot and the final evidence are in the sibling release-snapshots/build-007 directory. Independent Claude review and the remaining launch blockers are still pending. No public launch is approved.
