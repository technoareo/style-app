# Next lock-path findings — evidence, not a fix

## Latest actual release failure

The reviewed-permission unchanged full `npm test` completed as session26593, exit1:261total,256pass,1fail,4skip,69.654s. The failing mixed scenario took56.218s. Direct-write child5 refused one write before its body after a10s budget: gate0.1ms, SQLite10001.5ms,53attempts, sinceStart10367ms. The expected450 direct-writer rows became449. This is a refused operation and failed invariant, not evidence of a silent write or a replay. Earlier14 worker-lease refusal remains separate evidence.

## Observed main-transaction scheduling gap

`write-turn-gap-probe-015.mjs/.json` ran against a disposable database using normal permissions, exit0. It wraps only that database's exec method and schedules a synthetic75ms microtask immediately after successful BEGIN returns. Events show:

- BEGIN return: transaction active, body calls0.
- Queued task start and end: transaction still active, body calls0.
- Body starts after that task, then commits once; exactly1row.

Source hash `7039eeb1c9d04c709e4363b357bc4bbe3bb0733411e98ffa7628464dd9def8c2`. The current `runWriteTransaction` awaits `retryBusy` after its callback takes BEGIN, so queued work can run with SQLite already locked before the nominal synchronous body starts. The diagnostic demonstrates an avoidable scheduling gap; synthetic75ms work does NOT prove it caused the full-suite refusal.

Review a design that executes the body and COMMIT/ROLLBACK in the same synchronous callback as successful BEGIN, retrying ONLY failures to acquire BEGIN. Body failures, including a busy-shaped error, must NEVER replay the body. Preserve promise-body refusal, rollback/gate release and numeric observer contracts; measure hold at actual commit/rollback return rather than a later continuation. This remains an unimplemented proposal.

The existing3ms courtesy pause comes after `release()`, which immediately grants a queued in-process writer. Consider keeping the process gate during a post-COMMIT pause, so SQLite is free for other processes while local successors wait. Auth finish has separate async-driver/release semantics and requires its own careful design. Neither a fixed pause nor this microtask fix proves cross-process FIFO fairness.

## Signup hash placement — primary installed-library source

Read-only inspection of installed Better Auth1.7.7 `dist/api/routes/sign-up.mjs` shows `runWithTransaction` wraps validation, duplicate-user lookup and both duplicate-timing and new-user password hashing. `dist/api/dispatch.mjs` runs before hooks before invoking the endpoint and merges returned per-call context. That identifies a possible request-scoped prehash hook outside the transaction, NOT a verified implementation. Preserve the same secure hash parameters, duplicate-response/timing safeguards, atomic token/reset operations and bounded hashing memory/concurrency. Do not patch dependencies, use a global plaintext/hash cache or disable transactions. Verify hook types/order and isolation before deciding to implement it.

## Large-photo scans

`PHOTO_SCAN_FINDINGS_015.md` records two completed independent probes. Covering metadata indexes substantially reduce synthetic query cost, but a production index requires reviewed migration/startup and end-to-end hold measurements. Those tests do not explain the empty/small-photo full workload's entire contention failure or close G1.
