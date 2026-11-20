# Implementation 036: quota refund day defect behind the Linux CI failures

Status: implemented and tested locally on Windows 11. **Not committed, not pushed** (as instructed). Not re-run on Linux CI. Build 035 changes are untouched. The product is not launch-ready.

## Evidence recorded from outside this session

GitHub Actions run **43987593655** (reported by the requester; this session did not fetch or re-verify it): Linux full suite 787 tests, 783 pass, 2 fail, 2 skip. Both failures are in `tests/queue007.test.ts`:

- "quota refunds are one-time, fair, and bounded by a separate attempts counter" (~line 251), assertion at line 319: actual `{count: 1, attempts: 1}`, expected `{count: 0, attempts: 1}`.
- "cancelling, deleting the account or expiry aborts running model work promptly and the next job starts" (~line 416), assertion at line 484 ("expiry is refunded"): same actual vs expected.

They also reproduced locally and on unchanged Build 034, so they were not a Linux-only problem.

## Root cause

`refundLocked` (src/server/analysisJobs.ts) decided which `usage_daily` row to decrement by **recomputing the day from `jobs.created_at`**. A job is charged on the UTC day of the moment it was enqueued, so the two agree in production. The failing tests move `created_at` back one hour plus a millisecond to simulate expiry. During the **first hour of a UTC day (00:00-01:00 UTC)** that lands on the previous day, so the refund decremented yesterday's (nonexistent) row, the `refunded` marker flipped to 1, and today's charged row stayed at `count: 1`. Both failures sit on the expiry path (sweep and expiry mid-inference). The local check at the start of this session was 00:31 UTC, which matches; the CI run was presumably inside the same window (not verified from the run logs).

This is a real defect, not only a test artefact. Any refund whose charge day and recomputed day differ (a `created_at` that was rewritten, restored from a backup, or skewed) silently loses the refund, and the one-time marker then prevents a retry.

## Fix

| File | Change |
|---|---|
| src/server/database.ts | Additive migration `analysis_jobs.usage_day TEXT`; existing rows are backfilled to the UTC day of `created_at` (what they were charged on). Added to the schema-current check so older databases are migrated. |
| src/server/analysisJobs.ts | `enqueueAnalysisJob` stores the charged day (`usage_day`) in the same transaction as the `usage_daily` increment. `refundLocked` decrements `usage_daily` for `COALESCE(usage_day, day-of-created_at)`. The conditional `refunded=0 -> 1` flip, the never-below-zero clamp and the untouched `attempts` counter are unchanged, so one-time refunds, the finite attempt cap, transaction safety and privacy (no new data, a date string only) are preserved. |
| tests/queue007.test.ts | New test "refunds target the day that was charged, whatever created_at says (UTC-midnight independent)". It moves `created_at` a full day or more back, so it does not depend on wall-clock time. It covers the expiry sweep (run twice, refunded once), queued cancel (cancelled twice, refunded once), and a legacy row with `usage_day = NULL` (falls back to the upload day). |
| tests/migration007.test.ts | The build 006 rewind now drops `usage_day` and the migrated database must have it again. |

No assertion was weakened; the two failing tests are unchanged.

## Results (local, Windows 11, run at about 00:3x UTC, inside the failing window)

- `tests/queue007.test.ts` + `tests/migration007.test.ts`: 10 tests, 10 pass, 0 fail.
- `npm run typecheck`: clean.
- `npm run lint`: clean.
- `npm test` (full suite): 788 tests, 782 pass, 0 fail, 6 skipped (platform skips on Windows; CI reported 2 skips).

Before the fix the two named tests failed in this same window. Not mutation-tested: the new test was not run against the old code, but its skewed-`created_at` setup is exactly the condition that makes the old day recomputation target the wrong row.

## Not verified

- Linux CI has not run this change. The run must be repeated on the pushed commit.
- The two original tests still use `Date.now() - 3_600_001`; they pass at any time of day now that the refund uses the stored day, and the new test guards the exact path independently of the clock.

## Follow-up: independent rerun, `queue007` alone failed 5 worker-driven tests

Reported by the requester after the first completion: running `queue007` alone gave 5 failures (condition not reached at the quota-refund test, "took too long" expected but "unavailable" received, owner discovery expected `completed` but got `failed`, and two more "condition not reached" in the cancel/expiry and shutdown tests). The `usage_day` regression test passed.

**Reproduction.** In this environment `queue007` passed on every plain run: alone (three times), combined with `migration007`, and three concurrent fresh processes. No leaked test processes or listening ports were found (the running `node` processes were the Codex runtime and PDF MCP servers). A full-suite run did not poison later runs.

**Root cause: test isolation, not the refund fix.** `queue007` pins `OLLAMA_URL` but inherits every other model and queue setting from the launching shell. `analyzePhoto` returns "unavailable" before sending any request when `VISION_MODEL` is invalid (src/server/vision.ts `visionModelOrNull`). Running the unchanged test with `VISION_MODEL="bad model!"` reproduced **exactly the five reported failures with the same messages** and left the `usage_day` test passing. So the requester's shell or parent process most likely carried a bad or different `VISION_MODEL` (or a similar setting); that is inferred from the matching failure signature, not observed in their environment. A stale `STYLE_INFERENCE_TIMEOUT_MS`, `STYLE_ANALYSIS_MODE` and the like would break the same tests in other ways. Five sibling files had the same weakness: under the same pollution 47 tests in `queue`, `analysisMode018`, `singleItem018`, `visionCap016` and `contention` failed.

**Fix (no timeouts raised, no assertions changed).**
- tests/queue007.test.ts: clears the model/queue settings (`VISION_MODEL`, `VISION_PROMPT`, `STYLE_ANALYSIS_MODE`, `STYLE_ANALYSIS_ESTIMATE_MS`, `STYLE_DAILY_ANALYSES`, `STYLE_DAILY_ATTEMPTS`, `STYLE_INFERENCE_TIMEOUT_MS`, `STYLE_JOB_WATCH_MS`, `STYLE_QUEUE_MAX_ACTIVE`, `STYLE_REVIEW_BUDGET_MS`) before anything is imported and again in every `reset()`. Also removes its per-run data directory in `after()` (it left one behind per run; `.data/tests` had accumulated about 6,200 directories from the suite as a whole).
- tests/helpers/hermeticModelEnv.ts (new), imported first by `queue`, `analysisMode018`, `singleItem018`, `visionCap016` and `contention`, clears the same list. Tests that need a value still set it themselves.

**Results.**
- Polluted environment (`VISION_MODEL="bad model!"`, `STYLE_ANALYSIS_MODE=singel`, `STYLE_INFERENCE_TIMEOUT_MS=10000`): `queue007` 9/9 pass (was 4 pass, 5 fail), and the six queue/vision files together 72/72 pass.
- `queue007` in fresh processes: three plain runs plus two after the change, all 9/9. Combined with `migration007`: 10/10.
- Typecheck and lint clean. Full suite: 788 tests, 782 pass, 0 fail, 6 skipped.

**Not done.** Other test files that spawn their own servers (for example `matrixConfig`, which tests configuration on purpose) were left alone. `npx tsx --test` run directly does not get any runner-level protection, which is why the clearing lives inside the files. Linux CI has still not run this change.
