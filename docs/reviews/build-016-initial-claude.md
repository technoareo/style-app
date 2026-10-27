# Build 016 initial: fresh independent review (Claude)

Written for: root and the owner, as the review of the 016 initial candidate (part 1 cap/stream, part 2 same-turn write transaction).

I used Read, Glob and Grep, plus this one Write. I ran no shell, tests, type check, build, network or browser, started no subagent, edited no source and committed nothing. I did not repeat the prior author's shell deviation.

Evidence classes: **Read** (I read it in the working tree), **Log** (root's recorded output, which I read), **Arithmetic** (my calculation from Log numbers), **Reasoning** (my inference from code, not run), **Author** (a claim in the author's notes that no root log backs), **Unverified**.

## 0. Reviewed material and deviations

Read in full: `BUILD016_ROOT_CHECKS.md`, `implementation-016-notes.md` (parts 1 and 2), `build-015-fixture-corrected-claude.md` (first 60 lines: the verdict structure and evidence classes), `writeTransaction.ts`, `vision.ts`, `lockDiagnostics.ts`, `sqliteRetry.ts`, `lockRecorder.ts`, `visionCap016.test.ts`, `stream-protocol-probe-016.mjs` and `.json`, `targeted-lock-016-initial.log`, `concurrency-016-initial-runs.json`, and `lockDiagnostics.test.ts` lines 200 to 620.

Read in part: `concurrency-016-initial-01.log` (the full `CONCURRENCY_TIMING` line); logs 02 to 05 by Grep only (pass/fail summary, `problems`, and the `bodyMs`/`commitMs` series); `analysisJobs.ts` 920 to 995 plus Grep; `analysis.ts` and `database.ts` by Grep; `contention.test.ts` 236 to 280; `wardrobeFixtures.ts` around the `settleLocalCapture` call; the manifest by count only (208 `"path":` entries, matching root's number).

Deviations:

- **Frozen copy not opened.** I read the working tree, not `../build-016-initial`, and I cannot hash. Whether the tree equals the manifest is root's check. The git status I was given shows the Part 2 files as modified and uncommitted, consistent with the freeze.
- **Not read:** `authDialect.ts`, `writeGate.ts` (so how many microtask ticks `acquireWriteGate` takes is Unverified), `Dockerfile`, the full-suite logs, the lint and typecheck logs (I rely on root's PASS statements), `UploadDialog.tsx` beyond one Grep hit, and `LOCK_NEXT_FINDINGS_016.md` / `PERPLEXITY_VISION_RESEARCH_016.md`.
- The decomposition numbers in section 3 come from logs 01 to 05 and are the only measurement of the hold in this build. For logs 02 to 05 I read only the Grep-extracted series, not the whole line.
- No `.env*`, `.data`, `.runtime`, `node_modules` or `sources/` content was read.

## 1. Verdicts (kept separate)

| Question | Verdict |
|---|---|
| **Scoped acceptance: part 2 source** (same-turn BEGIN, body, COMMIT; tagged outcome; observers after release; beginMs/backoffMs/bodyMs/commitMs) | **ACCEPT the source, with the conditions in section 9 (P1, P2).** By reading, the replay-safety and identity claims hold. |
| **Scoped acceptance: the new same-turn test** | **REJECT as written; accept after correction.** The failing assertion is invalid, not a product regression (section 2). The causal assertions are good and must stay. |
| **Scoped acceptance: part 1 stream parser** | **REJECT (fail-open).** The protocol is not validated, and a failed stream is not cancelled upstream (section 4). Root's probe is correct. |
| **Scoped acceptance: six-item cap as the owner's decision** | **ACCEPT as a bound on time and output, with message and refund conditions** (section 5). Not an accuracy claim. |
| **Release verdict for build 016 initial** | **FAIL / NOT RELEASABLE.** The focused lock suite has one failing test (30/31, Log), the parser accepts malformed streams (Log + Read), and the 015 full-suite failure is unresolved. No full suite or production build of 016 exists. |
| **Launch** | **NOT READY.** Nothing here closes G1, vision correctness, transport/H2, hosting/HTTPS/SMTP, Linux/container execution, off-site recovery or real-phone acceptance (section 8). |

## 2. The failing hold assertion: test validity versus native commit cost

**Log:** `targeted-lock-016-initial.log`, 31 tests, 30 pass, 1 fail. The failure is `lockDiagnostics.test.ts:331`, "the 100 ms microtask is outside the hold (114 ms)". The assertions at lines 310 to 330 ran first and passed: the body ran first, it ran before the blocker, `isTransaction` was false when the blocker ran, acquire precedes hold, and `holdMs` equals `bodyMs + commitMs` within 0.3 ms.

**Read/Arithmetic:** the body busy-waits 10 ms and then inserts a row; `holdMs` is exactly body plus COMMIT (line 328 passed). So 114 ms means roughly 10 ms of body and about 100 ms of native COMMIT. The 100 ms blocker cannot be inside that interval: `BEGIN`, body, `COMMIT` and the tagged return are one synchronous block, and a queued microtask cannot run inside it. The `isTransaction === false` assertion (which passed) is the direct proof.

**Log (all five concurrency runs):** the committed hold on this host is dominated by native COMMIT, not the body.

| Role (run 01) | bodyMs p50 | commitMs p50 / p95 / max |
|---|---|---|
| 3 writer children (150 writes each) | 0.1 | 70.1 / 154.7 / 216.5; 79.6 / 173.3 / 272.2; 80.9 / 133.2 / 192.6 |
| parent | 0.2 | 19.0 / 19.9 / 65.1 |
| worker | 0.2 | 17.6 / 105.5 / 205.6 |

Runs 02 to 05 show the same shape (writer commitMs p50 59.9 to 82.8, max 213.6 to 248.3; parent p50 18.8 to 19.2; body p50 0.1 to 0.3). **Arithmetic:** across writers, commit is about 99.7 % of the hold.

**Conclusion (Reasoning from Log):** a single COMMIT of 100 ms is inside the observed distribution on this machine (p95 about 130 to 175, max about 270). `holdMs < 90` is therefore a test of the disk, not of the code. The failure is a **test-validity defect**, and the product behaved as designed. It is not a product regression, and the product's hold being long is a separate, real fact (section 3).

**Do not** raise the threshold (for example to 150 or 300): that leaves a flaky bound that still depends on fsync latency and hides the point of the test. **Do not** delete the assertion without a replacement and do not hide the failed run; keep `targeted-lock-016-initial.log` as recorded.

**Precise correction (Reasoning):**

1. Replace line 331 with an assertion on a quantity that does not contain COMMIT: `h.bodyMs` (the body plus the work before it) must be below the blocker, for example `h.bodyMs < 50` with a 10 ms busy body and a 100 ms blocker. `bodyMs` cannot include the blocker or the disk; if a microtask ever ran inside the block it would show here. Keep `holdMs ≈ bodyMs + commitMs`.
2. Make the causal proof independent of microtask counts. At present the blocker is queued after the call and the test asserts `body` precedes `blocker` (lines 310 to 311). That holds only while `acquireWriteGate` resolves in one tick. I did not read `writeGate.ts` (Unverified), but any extra `await` there would run the blocker before BEGIN, which is legal and would fail the test with no product change. Instead queue the blocker, and a `setTimeout(0)` marker, **from inside the body** with `queueMicrotask`, and assert both observed `db.isTransaction === false` when they ran. That is the real invariant ("nothing runs between BEGIN and COMMIT") and it does not depend on the gate's tick count.
3. Add `commitMs` as a documented, host-dependent number: assert only `commitMs >= 0` and `holdMs` consistency (already present). Never assert an absolute hold.
4. Add a **real-commit-cost-independent** variant: wrap `exec` (the same override the COMMIT-failure test uses) to add a deterministic synchronous 120 ms busy-wait before `COMMIT`, and assert `commitMs >= 100`, `bodyMs < 50`, `holdMs ≈ sum`, and that a microtask queued from inside the body ran after. That proves the decomposition attributes a slow commit to `commitMs` rather than to the body, with no dependence on the disk.

The old test's deliberate replacement is justified by the new contract (the previous version asserted that microtasks ran inside the hold, which is exactly the gap that closed). The auth-path microtask test is unchanged and passed, so the dialect's asynchronous gap remains covered and documented.

## 3. What part 2 does and does not change (so nobody calls it a fix)

**Read:** `runWriteTransaction` now does BEGIN (retried), the body, the Promise check and COMMIT or ROLLBACK in one synchronous callback, returns `{ok, value}` or `{ok:false, error}`, and rethrows after `retryBusy` with identity intact. `fn` runs at most once; a busy-shaped body or COMMIT error cannot be replayed.

**Log + Arithmetic:** the hold is about COMMIT, not the body (section 2). With `synchronous` left unchanged (no `synchronous` pragma found by Grep in `database.ts`; only `journal_mode = WAL`), the 20 to 270 ms commit is most likely fsync latency on this Windows host (**Reasoning, not measured**). In the three writer children `beginMs` p50 about 21.5 ms with `attempts` p50 1 means the first BEGIN already waits inside SQLite's native 50 ms busy wait for another process's COMMIT. So the G1 contention is fundamentally "writers queue behind each other's COMMIT". The same-turn change removes only the gap between BEGIN and the body; it cannot shorten the COMMIT. The author's note ("expected effect on the G1 refusal is negligible") is **confirmed by the logs**. Do not call part 2 a G1 fix.

**Next decision (Reasoning):** the numbers support evaluating `synchronous=NORMAL` under WAL (durability trade: a power loss may lose the last committed transactions but cannot corrupt the database) and batching. That is an owner/operator durability decision and is not made here. Do not change it without a stated recovery-point objective.

## 4. Stream parser (part 1): fail-open protocol

**Log:** `stream-protocol-probe-016.json` (synthetic mock, no model): a valid terminal control is accepted; `done:false` then EOF, valid content then a malformed trailing line, and a malformed leading line then valid content are **all accepted** with an analysis.

**Read (`vision.ts:60` to `112`), why:**

- `take()` only records `failedLine = true` for an unparseable line and returns false. The caller ignores the result inside the loop, and the final check is `if (failedLine && !content)`. Any malformed line is tolerated whenever some content arrived.
- `done` is never read. Only `done_reason` is captured, and there is no requirement that a terminal `done:true` exists, that it is last, or that it appears once.
- Parsed values are not shape-checked: `null`, numbers, arrays and strings parse as JSON and are accepted as "valid" lines (`null` actually throws a TypeError at `part.error`, which becomes "unavailable" only by accident); `message.content` that is not a string is coerced by `+=` into text such as `[object Object]`.
- Lines after the terminal line are accepted and their content is appended.

**Read: resource / cancellation defects (Reasoning, not run):**

- On an `error` line (`take` throws) the reader is neither cancelled nor released, and the underlying request is not aborted. If the server keeps the connection open (or keeps generating), the CPU inference continues until the deadline. The oversize path does `reader.cancel()` but does not abort the fetch either.
- Nothing aborts the fetch on protocol failure, because the only controllers are the deadline and the caller's signal.

**Proposed correction (precise):**

1. One internal `AbortController` combined with the deadline and caller signal (`AbortSignal.any`). On any protocol failure call `await reader.cancel().catch(()=>{})`, `controller.abort()`, then throw. Because the deadline classifier uses `deadline.aborted && !signal?.aborted`, an internal abort must not set either of those, so the thrown `VisionError` is what surfaces. Release the reader lock in `finally`.
2. Decide the mode from the first non-empty line, then validate strictly:
   - **NDJSON mode** (first non-empty line parses as a JSON object): every non-empty line must parse as a plain object (not `null`, array or primitive). Fail at the first bad line, immediately, so a corrupt stream stops early.
   - **Whole-body mode** (first non-empty line does not parse, as with a pretty-printed single object): keep buffering up to the cap and at EOF require `JSON.parse(raw)` of the whole body, allowing only surrounding whitespace, to be a plain object. This preserves pretty-printed compatibility and rejects both "BROKEN JSON\n{valid}" and "{valid}\nBROKEN" (neither is a single JSON value).
3. Envelope rules, applied to each part: `error` falsy else "unavailable" (as today); `message` absent or an object; `message.content` absent or a string; `done` absent or boolean; `done_reason` a string if present. Reject (kind `"unavailable"`) any part that arrives after one with `done === true`.
4. At EOF require exactly one part with `done === true`, and it is the last. No terminal marker means a truncated stream: `"unavailable"` (refundable, not a model verdict). Take `doneReason` only from the terminal part.
5. Keep `"unverified"` for content-level failures (`JSON.parse(text)`, schema, boxes) and the `done_reason:"length"` path, unchanged. Keep `MAX_ANSWER_CHARS`; consider `new TextDecoder("utf-8", {fatal:true})` so invalid UTF-8 is rejected rather than silently replaced (low).
6. Compatibility to preserve (all already covered by the second existing test): chunked NDJSON, compact single body, pretty single body, **each with `done:true`**. A terminal marker is not a regression for these, since all three tests include it. A server that omits `done` entirely (non-Ollama) would now be refused; Ollama always sends it. State this in the notes.

**Regression tests to add** (additions only; do not delete or weaken the existing eight):

- `done:false` then clean EOF, in both NDJSON and compact single-body shapes → `unavailable`.
- valid terminal then malformed trailing line; malformed leading line then valid terminal → `unavailable` (these are root's two probes).
- junk between valid lines; a second `done:true`; any content after `done:true`; two JSON objects on one line.
- a line that is `null`, `[]`, `5` or a string; `message.content` as a number or object; `done` as a string.
- empty body; blank lines only; terminal with no content (still reaches content-level `unverified`, not accepted as success).
- final line without trailing newline and CRLF endings (must be accepted); a multi-byte UTF-8 character split across chunk boundaries (must round-trip).
- pretty single object with `done:true` (accepted); pretty single object without `done` (rejected); pretty with trailing garbage (rejected).
- oversize answer (> 2,000,000 chars) → `unavailable`, and the mock records that the request was closed.
- **Cancellation**: with a server that writes an `{error}` line, or a malformed line, or an extra line after `done`, and then **keeps the socket open** (write without `end`), assert `analyzePhoto` rejects within a short bound (for example 2 s, far below the 10 s minimum deadline) and that the mock saw the request close. Do the same for the caller abort mid-stream and for the deadline (`kind: "timeout"`, server saw close). Also an abrupt `res.destroy()` mid-stream → `unavailable`. These are the tests that prove no orphaned inference.
- Keep the existing "caller abort is unavailable, deadline is timeout" test as is.

## 5. The six-item cap: the owner's decision, reviewed

I did not re-argue the decision. Review of how it is implemented:

- **Read:** `MAX_DETECTED_ITEMS = 6` is used in the schema (`maxItems`), the prompt, the post-parse `slice`, the crowded warning and the UI tips. The stored-result schema keeps `.max(30)`, so old rows still parse. `num_predict` 1100 bounds the answer. This does bound time and output size.
- **Author, not independently reproduced:** the real-model measurement (255 s, 6 items, warning present; previous 508 s and failed job) is in the notes only. Root's Log for part 1 is the **mock** suite (8/8, 10.664 s), which uses a synthetic image and says nothing about recognition quality or speed.
- **Condition 1 (message accuracy, Medium).** `done_reason: "length"` is reported as `TOO_MANY_ITEMS_MESSAGE`, charged as a model result. The output may also hit 1100 tokens with six or fewer verbose items (optional `sleeve`, `neckline`, `closure`, `length` and 250-character evidence). Then the user is told the photo has too many items when it does not, and the attempt is charged. Reword to a cause-neutral message, or only name item count when the partial JSON visibly holds six or more items, and review whether a length cut should be charged.
- **Condition 2 (refund loop, Medium; Reasoning).** `timeout` is recorded as `failure_kind: 'server'`, so the attempt is not counted. A photo that is systematically too slow can be resubmitted without cost, and each try holds the worker for up to the inference deadline (240 s default). Check the admission and rate limits in `analysisJobs.ts` bound this (I did not trace them). The notes say 255 s exceeds the 240 s default, so the owner's own crowded photo still times out at defaults.
- **Condition 3 (crowded flag, Low).** `crowded = found.length >= 6` flags a photo that has exactly six real items as "may show more than 6". Acceptable and conservative; the wording says "may".
- **Condition 4 (ordering, Low).** Items past six are silently dropped, and "the most prominent" is only a prompt hint; there is no ordering guarantee. The warning discloses truncation only when the count reaches six.
- **Not established:** detection quality (the notes report six "printed shirt" entries and five filed as Shoes on the crowded photo, Author). The cap does not close the whole-wardrobe requirement and I make no claim that it does. The browser flow for the warning and tips text is not exercised (Author).

## 6. Part 2 deep checks

All Reasoning from Read unless noted.

- **Same-turn transaction.** `retryBusy` calls `op()` synchronously on its first attempt (`await op()` with no earlier await), and the callback contains no `await`, so BEGIN, body and COMMIT are one turn. Retried attempts re-enter the callback after a timer, and each is again one block.
- **Only-BEGIN retry and tags.** The inner `try` rethrows only a failed `db.exec("BEGIN IMMEDIATE")`; the body/COMMIT block never throws (it returns a tag). So `retryBusy` can only retry BEGIN. A body error of errcode 5, 6, 261 or 517 is returned as `{ok:false}`, rethrown by identity (not wrapped), and the test loops all four codes with one body run and one BEGIN. COMMIT failure is covered for 5 and 517 by an `exec` override. **Gap (Low):** 6 and 261 are not covered for COMMIT, and a non-error primitive thrown by the body is not tested.
- **Refusal path.** A BEGIN that exhausts the budget becomes `WriteContentionError` with `acquire` detail (same keys); a non-busy BEGIN error is rethrown as is with outcome `"error"`. The safety-net ROLLBACK is guarded by `began`, so a refused BEGIN never rolls anything back.
- **Rollback failures (Medium, P2).** If the body or COMMIT fails and the in-block `ROLLBACK` also throws (swallowed), and the safety-net `ROLLBACK` also fails (swallowed), `release()` still runs while `db.isTransaction` may still be true. Then `inTransaction` (`if (db.isTransaction) return fn()`) would join that stale transaction for the next caller, and a later `BEGIN IMMEDIATE` would throw a non-busy error. I could not tell from the files whether an earlier design had the same hole (it probably did), and there is no test that makes ROLLBACK fail. Recommend: if both rollbacks fail, mark the connection poisoned (close and reopen it, or fail every later write loudly) rather than releasing the gate with an open transaction, and add a test that forces `exec("ROLLBACK")` to throw. Report the original error.
- **Promise body.** `result instanceof Promise` does not catch a non-native thenable (Low, pre-existing). The synchronous block has already committed in that case, since the Promise check is before COMMIT only for native Promises.
- **Observer placement.** Observers run after `release()` and after the native transaction ended, acquire before hold, both through the contained `invoke`. The test proves this: not in a transaction, a second connection can take the SQLite lock, the gate queue is empty. **Caveat (Low):** `release()` only hands the gate to the next waiter by resolving its promise; the waiter cannot run until the current synchronous code returns. A *slow synchronous observer* therefore still delays the next writer's start. The notes' wording ("a slow observer lengthens neither") is true of the SQLite lock and the gate's *ownership*, not of event-loop latency. Production has no observer, so this affects diagnostics only; either defer observer calls (`queueMicrotask` or `setImmediate`) or word the comment precisely. The author already notes that no slow-observer test exists.
- **Numeric fidelity.** `beginMs` = summed time in native BEGIN calls; `backoffMs` = summed real gaps between a refused attempt and the next one (timer lateness included); `holdMs` = BEGIN return to COMMIT/ROLLBACK return. All use the monotonic clock and `ms()` (0.1 ms rounding, clamp at 0). `sqliteMs` = `beganAt − gateAcquiredAt` additionally contains a few microseconds before the first attempt, so the test slack `begin + backoff <= sqliteMs + 1` (three separately rounded numbers) is reasonable. In the logs, `beginMs`/`backoffMs` for the parent write role fits `sqliteMs` (parent: sqliteMs mean 51.6 vs begin 33.6 + backoff 18.0 = 51.6; writer: 105.2 vs 69.1 + 36.1 = 105.2). **Arithmetic: additive.**
- **Aggregate precision (needs comments).** `beginMs` and `backoffMs` are per-call *sums over attempts*. They cannot tell one 200 ms native wait from five 40 ms waits (the first hits the 50 ms native wait cap per attempt, so a sum above 50 ms with attempts 1 would be a bug, which is a useful check but not a field). Percentiles of per-call sums are not percentiles of attempts. `bodyMs` for a rolled-back call ends at the throw. `commitMs` for a rolled-back call is ROLLBACK time (documented). Add short comments on `AcquireEvent.beginMs` / `backoffMs` saying "sum over attempts; not per-attempt", and record `attempts` alongside when quoting them. Do not claim per-attempt latencies.
- **Optional fields and old metrics.** The new fields are optional on the types, the auth path does not set them, and the recorder adds a sample only when `typeof === "number"`, so auth shows count 0 for the new series (Log: auth `beginMs.count` 0). All old keys keep their meaning and shape; `AcquireDetail` is unchanged (`detailOf` copies the same seven keys). No consumer breaks by reading. **Low:** `truncated` in the summary ignores the four new series, so a truncated `commitMs` could read as complete; add them to the flag.
- **Bounded `heldResponse` and quiescence.** `heldResponse` now throws after 30 s with a message naming the request count, hold flag and URL, and the existing `finally` releases everything (Read, 244 to 258). That is a harness bound only. `newRepositoryUser` now awaits `settleLocalCapture({ timeoutMs: 1000 })` before its precondition checks (Read, `wardrobeFixtures.ts:87`), which closes F-L1 from my 015 review. It fails loudly after 1 s rather than hiding a stuck drain. Residual hidden-writer risks (non-mail writers) are as in my 015 review. The `exec` override in the COMMIT test is restored in `finally` by deleting the instance property (Read), which is correct for a prototype method.
- **Block-order observation (Low).** Events from different calls may interleave slightly differently than before (the notes say so). I found no assertion that depended on the old order.

## 7. Concurrency repetitions

**Log (root-owned session, read once):** `concurrency-016-initial-runs.json` lists runs 1 to 5, each `exit 0`. Logs 01 to 05 each show `tests 1, pass 1, fail 0, cancelled 0, skipped 0`, durations 38.557, 38.294 (02), 39.000 (03), 37.652 (04), 37.522 (05) s, and `"problems":0` in each timing line. **All five repetitions are complete and passed**; none is partial. I extracted `failures`/`failed`/`rollback` counts by Grep and found none non-zero.

**Limits (Arithmetic/Reasoning):**

- Five passes with zero failures bound the true failure rate only to roughly 1 in 2 (a 95 % upper bound of about 45 %), so this shows no gross flake, not reliability. The 015 history is two failures in three full-suite observations of this scenario, with the reviewed 015 full-suite failure still the nearest comparison.
- These are **standalone** runs of the mixed scenario, not the full `npm test` that failed in 014/015, which also has other files competing for the machine. I do not treat them as a G1 resolution. They are the first five of 016 and carry the first decomposition data; the pass is consistent with part 2 changing nothing material about contention (section 3).
- Hold p99 under writers was 185 to 270 ms and acquisition p95 up to about 530 ms in run 01 against the 10 s budget, so the budget margin in this scenario is large. A refusal is a tail event under heavier load (full suite), which these runs did not reproduce.

**Root update incorporated (read after the first draft):** `concurrency-016-initial-writer-summary.json` (15 rows: 5 runs x 3 writers) and the updated `BUILD016_ROOT_CHECKS.md` (Log). Root states all five runs PASS with session terminal exit 0 and that all 208 frozen hashes were unchanged after the checks (root's statement; I cannot hash). The summary agrees with my independent extraction from the logs: body mean 0.1 to 0.2 ms, commit mean 57.6 to 70.2 ms, hold mean 57.8 to 70.3 ms, so commit is about 99.7 % of the hold in every row (Arithmetic). Max acquisition per writer is 886 to 1994.1 ms, at most about 20 % of the 10 s budget (Arithmetic). Per-writer `beginMean` (62.8 to 70.7) plus `backoffMean` (30.1 to 38.0) is about 95 to 108 ms per write, matching the acquisition means, so the decomposition is additive here. Root's own caveat is correct and I adopt it: these selected standalone runs do not reproduce full-suite parallel load and do not close G1. They also show no instance where body time matters, which reinforces section 3 (commit/fsync, not the body, is the lock-hold cost).

## 8. Unresolved gates (explicit)

- **G1 (mixed multi-process acquisition refusal in the full suite):** OPEN. The 015 full suite remains 261/256/1/4 FAIL (root). No 016 full suite has been run. Five standalone passes do not close it.
- **Vision:** real recognition correctness and gold labels OPEN; the cap bounds time only; the real-model result is Author-reported; the crowded-photo browser flow is unexercised.
- **Stream/protocol:** the parser is fail-open and has no upstream cancellation on protocol failure (this review, section 4).
- **Transport:** H2/HTTP proxy behaviour and request-body handling under a real front end are not exercised.
- **Deployment:** actual hosting, HTTPS, SMTP, Linux/container execution, off-site encrypted recovery and real-phone acceptance are all OPEN.
- Do not quote "8/8 part 1 mock tests" or "5/5 concurrency runs" as launch readiness.

## 9. Prioritised corrections (not implemented here)

1. **P0 for the 016 candidate: fix the parser** per section 4 (strict envelope, terminal `done:true` required and last, mode decided from the first line, fail-fast, internal abort and reader cancel on any protocol failure), with the regression list including the stalled-socket cancellation tests. Keep all current tests.
2. **P1: repair the invalid hold assertion** per section 2: assert on `bodyMs`, move the blocker to the body, add the injected 120 ms commit test. Keep the causal and replay-safety assertions. Record the failed run as history.
3. **P1: re-run** `lockDiagnostics.test.ts` and the other focused files after (2), then a full `npm test` at the reviewed permissions, to give G1 a 016 observation. State the result separately.
4. **P2: rollback-failure handling** (poison or reopen the connection; test a failing ROLLBACK).
5. **P2: cap messaging and refunds:** make the `length` message cause-neutral (or conditional on the partial item count) and check how refundable `timeout` failures are rate limited.
6. **P2: durability decision** (`synchronous=NORMAL` vs FULL, with a stated recovery objective) informed by the commit-dominated hold. Not a code change to make silently.
7. **P3:** comment `beginMs`/`backoffMs` as per-call sums; add the four new series to `truncated`; consider deferring observer calls; add COMMIT tests for errcodes 6 and 261; fatal UTF-8 decoding.
8. **P3 (process):** the notes' part 2 header still says "NOT executed"; point it at `BUILD016_ROOT_CHECKS.md` and the failed focused run, and record the shell-append deviation as root already did.
