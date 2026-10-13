# Build 011 independent verification

Status: work in progress; not approved for launch. Build 010's default-suite contention failure remains open. These diagnostics do not change acquisition budgets, stress workloads or scheduling policy.

## Original candidate

The original build-011 source snapshot contains 162 hashed files and is preserved. It has not been compiled or independently approved.

- Typecheck passed after the environment typing correction.
- Lock diagnostics and matrix configuration: 17/17 passed. The six matrix configuration checks were rerun after the final environment typing correction and passed.
- The independent hostile-observer probe no longer reproduced escaped getter exceptions or unhandled asynchronous rejections.
- Two isolated matrix stress runs passed 7/7 checks each, with zero recorded integrity problems and all tracked children stopped. These passes do not close the prior build-010 failure.
- The default matrix run (`--scenario default --reps 1 --timeout-sec 300`) completed with 136 tests: 131 passed, one failed, four skipped. Authoritative output: `matrix-011-default-initial/summary.json`, `default-1.log`, and `default-1.json`.
- All seven concurrency children returned code zero. Registrars completed four operations each; writers completed 150 each; the worker completed 60. The concurrency report recorded zero integrity problems and zero failed acquisitions. Write acquisition maximum was 9079.8 ms; maximum per-process write p99 was 3904.9 ms; auth acquisition maximum was 5930 ms; auth hold maximum was 225.8 ms. Percentiles are per process, not a merged population.

The failed test was the new diagnostic fixture in `tests/lockDiagnostics.test.ts`: the expected SQLite wait was at least 300 ms, but the measured value was 166.9 ms. Source inspection confirmed that the foreign connection's 400 ms hold timer began before the first lazy application connection initialization. Initialization consumed part of the timer and was counted in `gateMs`. The successful BEGIN timestamp was also taken after awaiting the retry result, rather than immediately after the successful SQL statement.

On 2026-10-12, root requested a source-only correction through Claude in VS Code: warm/synchronize the fixture without loosening its causal lower bound; report connection initialization separately from gate wait; capture successful BEGIN timestamps inside the retry callback on write and auth paths; preserve control flow and budgets; update types, recorder, tests and implementation notes. Claude's active Stop control and source-edit activity were observed. No root application implementation edits were made.

## Corrected candidate: initial retest

Claude completed the source-only correction and returned to its idle input state. Root preserved `build-011-corrected`: 162 hashed source/config/test/reference files. The original snapshot remains intact.

- `npx tsc --noEmit`: exit zero.
- `node --import tsx --test tests/lockDiagnostics.test.ts tests/matrixConfig.test.ts`: 21 passed, zero failed or skipped, 10.3595 seconds. The original causal SQLite-wait lower bound remains unchanged; cold initialization and both successful-BEGIN timing boundary tests passed.
- Corrected default matrix (`--scenario default --reps 1 --timeout-sec 300 --out docs/verification/matrix-011-corrected-default`): exit zero, completed one of one runs, no timeout, all tracked children stopped. Runner reports 136 passed, zero failed, maximum write acquisition 7402.8 ms, maximum auth hold 626.1 ms and zero concurrency integrity problems; approximately 115 seconds. Consult its `summary.json` for exact totals and structured evidence. This is one passing observation, not evidence that the cross-process starvation risk is fixed.
- Exact test total: 140, including four skipped tests. Root checked all 162 candidate hashes after this run: zero source changes.
- Full review-requested matrix started with `--scenario all --out docs/verification/matrix-011-corrected-complete`: ten isolated stress runs, three serial full suites, three default full suites and three CPU-load stress runs. Session 82084 was confirmed live at startup. Completion and results are not yet claimed; use its authoritative summary and live session before deciding whether to resume or restart.
- Interim authoritative result: all ten isolated stress runs completed with exit zero, 7/7 tests each, zero reported integrity problems, no failed child operations and all tracked children stopped. Maximum write acquisition across these ten runs was 6563.9 ms. The runner then started serial run 1/3 and was confirmed live again. This does not imply that the remaining nine planned runs passed.
- Subsequent interim result: serial runs 1 and 2 passed 136 tests each with four skips and zero failures/integrity problems. Durations were 378.6 and 241.3 seconds; maximum write acquisition 4088.6 and 2127.4 ms. Session 82084 started serial run 3/3 and remains live. Default/load groups have not yet completed.
- Serial run 3 also passed 136 tests with four skips, zero failures/integrity problems, 242.7 seconds and maximum write acquisition 1728.6 ms. All three serial runs are now complete; default run 1/3 began. No default/load completion claim yet.
- Default runs 1 and 2 passed 136 tests each with four skips and zero failures/integrity problems, taking 67.1 and 63.8 seconds. Maximum write acquisition was 4003.6 and 3306.3 ms respectively. The live runner began default run 3/3; load results are still pending.
- Final matrix: all 19/19 completed, exit zero, no timeout, all tracked children stopped, no runner problems. Default run 3 passed 136 tests/four skips, maximum write acquisition 4446 ms. Three load runs each passed 7/7, with maximum write acquisition 2789.7, 4521.4 and 5424.3 ms. Maximum across the complete matrix: 6563.9 ms. Twelve inline CPU burners were configured per load run; no spawn/stop failure was reported. A subsequent attempted utilization sample matched zero burners because the matrix was already terminal. Therefore no measured whole-run CPU utilization is claimed; these are synthetic burner scenarios, not proven target-host saturation.
- Production compilation (`npm run build`) passed compile, lint, types, page generation, sanitization and packaging. Build ID: `9AXAtEvfYWrnQHgdTnLSz`. Sanitization removed 81200 trace entries from 16 manifests and one generated private path/escaping-link entry; it did not modify actual runtime data. All 162 source hashes remained unchanged after the matrix and compilation.
- `npm run verify:standalone`: exit zero, isolated OS temporary copy with no ancestor `node_modules` served real auth, wardrobe and photo routes.
- Compiled browser checks, matching fresh `.data/release-011-browser` in server and fixture processes, loopback-only, private development mail capture: 33 passed, one duplicate mobile signup skipped, 1.2 minutes. Log: `browser-011-corrected.log`. Mobile here means emulated viewport in desktop Chrome, not an actual phone. Controlled recognition responses remain a limitation. Cold Better Auth emitted an initial missing-schema diagnostic before automatic migrations; signup, verification and all subsequent assertions passed.
- Root direct-handler auth upload probe: still pending and body not cancelled after 21013.3 ms; cleanup of only its synthetic input returned 503. Evidence: `auth-body-deadline-probe-011.json`. This confirms absence of an application-level twenty-second body deadline, not absence of upstream HTTP deadlines. No real credentials/data were used.

## Remaining verification


Inspect the completed changes, run typecheck and meaningful diagnostic tests, preserve a corrected source snapshot, and rerun comparable stress/default scenarios. Compile and verify the corrected candidate, then obtain a fresh independent Claude review. Production readiness additionally requires resolving concurrency capacity, dense wardrobe recognition, deployment, real mail delivery and the other open review findings; passing these diagnostic tests alone cannot prove readiness.
