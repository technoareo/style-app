# Build009 root verification findings (pending Claude corrections)

TypeScript passed. Full backend:84total,82passed,1failed,1Windows file-symlink skip,58.264seconds.
Failed tests/backupSafety.test.ts:268 killed-backup case at291 Missing expected rejection /Another backup is running/. Helper backupChild.ts simulates crash with process.exit(9); proper-lockfile installs a normal-exit cleanup callback, so lock is removed. This is a test fixture mismatch, not evidence that a live backup lock was stolen. Use a real parent-initiated abrupt termination after a stage IPC signal, without child normal exit hooks; prove partial remains, fresh lock untouched, stale-lock takeover, and active living process holding lock separately. Existing passing same-stamp concurrency proof remains relevant.

Further code-review risk (not yet reproduced): backupDatabase.ts proper-lockfile lease is60s with10s update, but synchronous SQLite VACUUM blocks same eventloop. For a sufficiently slow/large backup, lease can appear stale and another process may sweep the still-active partial. onCompromised callback also cannot run while synchronously blocked; yielding only microtasks before final publish may not execute pending lock timers first. Do not claim lock proves owner death merely by age. Need live-owner/child-work strategy or bounded off-eventloop VACUUM plus lease update, and meaningful regression using blocked owner beyond shortened lease. Keep no-overwrite publication and own-path guards.

New real worker tests passed sustained slow delivery, frozen loop unhealthy/recovery and shutdown connection close. Revoked-password restore test passed: old/new/unchanged credentials rejected after restore and email reset recovered valid users; deleted user stayed deleted and owned data kept. TLS/provider/Docker evidence remains absent.

Computer control approval service hit its usage limit submitting the Perplexity research follow-up; action was not executed. Do not bypass. Claude feedback/review needs functioning approval service; build009 remains unapproved until correction and independent review.

## Confirmed live-owner lease failure

The disposable production-module probe docs/verification/backup-lease-probe.mjs deliberately blocked only the first owned child eventloop for80seconds at raw-copy stage (simulating a long synchronous operation). At65seconds the first child was still alive and its partial existed. Second createBackup acquired the60second stale lease, succeeded, and removed the still-active first partial. First owner subsequently failed, exit1. Recorded evidence live-owner-backup-lock-009.json. This confirms stale lease is not proof of owner death and active-partial protection is incomplete under a long synchronous pause. It does not measure how long a real target-host VACUUM takes. Treat as P1 until actual native work and ownership are coordinated safely across processes. Do not fix by changing the test expectation or increasing lease without a defensible bound.

Production compile, lint/types, pages, sanitization/packaging and isolated standalone startup passed. Browser suite running. These checks do not override the backup blocker or failing crash-fixture test. Independent Claude review pending functioning computer-control approval service.

## Browser failures

Build009 compiled browser suite:29pass,2fail (same superseded/cancelled-result test desktop/mobile),1duplicate-mobile-signup skip,1.4minutes. Both failed tests/e2e/review007.spec.ts:378 waiting for Review1 detected items after cancel then immediate setInputFiles; error snapshot remains Analysis cancelled with no result. UploadDialog.tsx was unchanged009, so do not label this a new009 implementation regression without evidence.

Fixture sets oldDiscarded=true in DELETE mock before cancellation handler completes; Playwright setInputFiles can target a disabled file input, whereas normal user cannot choose while busy. Thus it can start the new flow before old cancellation finishes, and cancelAnalysis then aborts controller.current after await (possibly the newer flow). Need deterministic ordering in the stale-response test: wait for the real cancellation completion and enabled picker, while controlling old GET completion with a latch instead of fixed sleeps. Also guard cancellation/discard against superseding flows by capturing job/controller and checking identity; meaningful separate delayed duplicate-cancel scenario can test actual user-accessible overlap. Do not simply skip the test, increase timeout or erase failure. No root implementation edits performed.

Build009 compiled ID uy0aH_42IGda7qFt1GgP7, isolated standalone passed. Backend82pass/1fail/1skip and browser29pass/2fail/1skip mean candidate is not green, notwithstanding passing compile/startup. Independent Claude feedback/review remains pending.

## Coordination update

12October2026: the separate Claude VSCode correction prompt was successfully submitted through normal computer-control approval; Claude is working (observed Stop/working and source reads). Earlier automatic-review usage failure was on the Perplexity follow-up submission, not proof that every app submission was blocked. No approval check was bypassed. Corrections and independent re-review remain pending. Frozen009 preserves the failed candidate; use a distinct corrected snapshot for the new code.

## Correction read-in-progress: directory takeover race reproduced

New directoryLock.ts keeper thread addresses main-thread-only lease starvation, but takeOverIfLapsed uses an earlier lstat result then renames the current canonical path without proving it is still that stale owner. Disposable probe directory-lock-takeover-probe.mjs paused only contenderB after observing stale lock; A then acquired a new fresh lock (age2.726ms) and refreshed independently. B later renamed/replaced A's fresh lock using its old observation; A.assertHeld failed. Evidence directory-lock-takeover-009.json. Lease500ms/refresh100ms are accelerated options exercising the same algorithm; not a real target-host timing claim. The child-only fs wrapper provides deterministic scheduling between observation and rename; no application source or private user data was changed. Need a process-held OS lock or coordination strategy with authoritative ownership/fencing, not a hand-written stale filesystem rename based on time. Independent future review must examine this before acceptance.

## Corrected ownership checks and new fixture failures

Exact80second live-owner probe rerun against process-held coordinator lock passed: secondbackup refused while firstwasalive; activepartial survived; firstowner completed exit0. Evidence live-owner-backup-lock-009-corrected.json. Original failed evidence retained in frozen009 and original JSON.

Fullbackend with corrected lock and concurrent local2B inference:89total85pass3fail1Windows symlink skip,164.278seconds. All OSownership safety tests passed. Failures:
1 tests/backup.test.ts:94 no such table analysis_jobs: fixture uses first filename ending.db, now selects .backup-coordinator.db. Select production FINAL_BACKUP regex rather than arbitrary.db; do not delete coordinator or mask missingtables.
2 mailWorker.test.ts:478 firstheartbeat wait failed underheavyload (testscaled heartbeat200ms/fresh1500ms, waitsforage<500); test coldstartup/load timing needs deterministic startup acknowledgement and clearly controlled workload, with justified scaled windows, not unexplained extra sleeps.
3 mailWorker.test.ts:531 midfreeze CLI returnedhealthy: coldtsx check completed after fixed9second freeze. Need parent-controlled test-only freeze/release or event-order latch so worker stays frozen until check actually reads; bounded safety cap, own fixture files only, no production freeze hooks. Do not treat this as proof production falsely reports healthy during an actual ongoing freeze.

The simultaneous dense-model probe timedout240169ms before complete output. This is concurrent-load evidence, not isolated latency/accuracy comparison. Keep distinctions in future launch review.
