# Queue 004 notes: absolute photo expiry

Scope: `src/server/analysisJobs.ts`, `tests/queue.test.ts`. Not run by the author (no shell access); Codex to run tests and review.

## Problem
Temporary photos expire one hour after upload (`created_at + QUEUE_EXPIRE_MS`). Inference that started shortly before that deadline could finish after it, and `finishJob` would persist the result even though the photo was already past its lifetime, unless a GET or sweep happened to run first.

## Changes
- `runWorkerTick`: reads `created_at` with the photo. If the deadline has already passed, it skips inference. Otherwise the `analyzePhoto` signal is combined with `AbortSignal.timeout(remaining lifetime)`, alongside the caller's signal and the existing 4-minute inference timeout.
- `finishJob`: inside its `BEGIN IMMEDIATE` transaction, after the existing guards (status `running`, exact `lease_until`, worker lock owner and lease), compares `created_at + QUEUE_EXPIRE_MS` with the current clock. If expired, it writes `failed`, clears `result_json` and `input_image`, and sets the expiry message. It no longer depends on a concurrent GET or sweep. A cancelled job or a reassigned lease still matches no row, so those writes are still dropped.
- `expires_at` for expired failures is `now + RESULT_TTL_MS`, so the user can read the failure instead of getting a 404. Non-expired results keep `min(created_at + 1h, now + 1h)`.
- Wording: `QUEUE_EXPIRED_MESSAGE` now says the temporary photo expired one hour after upload and was deleted. The old text, "expired before it could be processed", was wrong for running and completed jobs. Comments on `QUEUE_EXPIRE_MS`, `RESULT_TTL_MS` and `sweepExpiredLocked` now describe an absolute from-upload lifetime, not a claim deadline.

## Regression test
`tests/queue.test.ts`: a job is claimed and held mid-inference by the mock model server. The test then moves `created_at` back by 3,600,001 ms directly in the DB, releases the response, and checks the raw row before any GET. The row must be `failed`, with null `result_json` and `input_image` and an "expired" error. A later GET must report the same failure and no result.

## Caveat
If the timeout aborts inference right at the deadline, the failure is converted to the expiry message by `finishJob`'s clock check. A timer firing marginally early could leave the generic failure message instead.

## Not claimed
No production-readiness claim. Public hosting, HTTPS, real email delivery and container capacity remain untested.
