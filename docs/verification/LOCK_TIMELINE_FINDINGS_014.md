# Independent native transaction timing experiment

The unchanged full build-014 `npm test` failed: 211 pass, one concurrency failure, four skips. Worker child 6 exhausted its 10000 ms acquire budget at initial `acquireWorkerLockAsync`, before its heartbeat/cleanup loop. That failure remains authoritative release evidence. No database/gate/auth scheduling implementation changed in build 014.

Root then ran the unchanged mixed concurrency scenario in isolation with a diagnostic native-exec preload, retaining workload counts and budgets. This is an instrumented reproduction, not the full release command: instrumentation and isolated scheduling can change timings. It passed one scenario in 33.370 seconds, with setup 3.615 seconds, release wait 8.008 seconds and stress 21.434 seconds. This does not close G1 or erase the original failure.

Eight process trace files were captured, covering three registration children, three writer children, worker and test parent. No trace truncated and no paired transaction remained open at exit. Traces contain operation kinds, native active-transaction flags, anonymous connection numbers, PID/role and times only—no SQL text, database paths, account identifiers, secrets or body data.

685 successful BEGIN/COMMIT-or-ROLLBACK pairs:

| Role | Pairs | Sum of lower intervals | Sum of upper brackets | Maximum lower interval |
|---|---:|---:|---:|---:|
| Worker | 122 | 36.87 ms | 6767.47 ms | 1.69 ms |
| Registrars | 21 | 882.85 ms | 1450.94 ms | 93.47 ms |
| Parent | 92 | 1018.36 ms | 2775.51 ms | 113.11 ms |
| Writers | 450 | 91.36 ms | 28047.31 ms | 1.30 ms |

The **lower interval** starts after a successful `BEGIN IMMEDIATE` returns with the connection in a transaction and ends immediately before `COMMIT`/`ROLLBACK` is invoked while still in that transaction. The **upper bracket** starts before BEGIN and ends after COMMIT/ROLLBACK returns; it includes acquisition waiting and possible post-unlock native work. Upper-bracket overlaps are expected and do not establish overlapping write ownership. The summary found no lower-interval overlaps larger than two milliseconds; it found 765 upper overlaps above that tolerance. Neither statement proves exact SQLite occupancy or fairness.

Epoch alignment uses `performance.timeOrigin + performance.now()` on the same host. Clock/scheduling uncertainty and the assumption that these scenario connections share the disposable database remain explicit. Native call brackets reached 173.17 ms; this is a measured duration, not a claim that a configured busy wait changed. Exact native acquisition/unlock instants, auth-driver mutex wait, actual CPU saturation, full-suite interference and the failed worker's aligned timeline remain unmeasured.

Evidence: `native-lock-timeline-preload-014.mjs`, `native-timeline-014/native-*.json`, `native-lock-timeline-summary-014.mjs`, `native-timeline-summary-014.json`, and `concurrency-native-timeline-014.log`. Original full failure: `backend-014-corrected-npm.log`. Application source and existing test workload were not edited by root.

Next implementation/review decision belongs to Claude after reviewing both failure and bounded timing evidence: read-only common paths and validation before write acquisition can reduce avoidable work; pre-hashing/auth transaction scope and cross-process fairness require separate measured changes. Do not raise timeouts, serialize the release suite, shrink stress counts or call these bounds exact occupancy to turn the gate green.
