# Photo scan measurement — independent SQL probes

Both probes executed with normal workspace permissions. They use synthetic bytes, not real images, in a task-owned disposable SQLite database. No application index, migration or account data changed. The main table follows the relevant column order: id, user_id, data BLOB, sha256, created_at; the baseline index covers user_id only. There are50rows,40owned rows,2.4MB per BLOB,96MB owned payload. Twenty owned rows are expired. This is a SQL microbenchmark, not app GET/PUT latency, transaction hold time, concurrency or target-host acceptance.

## First probe

`photo-scan-probe-015.mjs/.json`, session98518 terminal exit0,20 repetitions per query:

| Query | Owner-index median / p95 | Candidate covering-index median / p95 |
|---|---|---|
| Expired-photo hint |87.588 /89.873ms|0.0176 /0.0276ms|
| All-owned photo metadata sweep |88.961 /96.073ms|0.0244 /0.0369ms|

Only the disposable database received `(user_id,created_at,id)`. Creating that index took152.868ms on these50rows. Plans changed from an owner-index search to a covering-index search; returned counts stayed20 and40. Covering measurements followed baseline, and OS caches were not cleared, so the next control checks order sensitivity.

## Alternating control

`photo-scan-control-015.mjs/.json`, terminal exit0. It opens the original synthetic database read-only, creates a small128-byte-BLOB table TEMP in memory, and runs12 rounds in deterministically shuffled order with explicit index selection. Each query checks its result count.

| Query | Large BLOB, owner index median / max | Large BLOB, covering median / max | Small TEMP BLOB, owner index median / max |
|---|---|---|---|
| Expired-photo hint |87.220 /98.193ms|0.0377 /0.0549ms|0.0237 /0.0379ms|
| Metadata sweep |85.997 /93.794ms|0.0495 /0.0759ms|0.0462 /0.5034ms|

The large-table comparison holds storage, dataset and connection constant while alternating forced owner and covering plans. The observed gap persists despite order changes. The small control is in memory while the large table is file-backed, so it is not a sole-variable proof of BLOB-size causality. No physical page-read or overflow-traversal counters were captured. These timings do not establish precisely which storage pages were fetched, but they contradict treating the metadata scan as negligible in this large-payload scenario.

## Next decision

Consider a separately reviewed covering-index migration, then verify an actual large-photo account's GET and PUT transaction timing, migration/startup safety on existing data, original race tests, and the unchanged release workload. Do not infer a universal speedup ratio or close G1/F3 from these microbenchmarks. No production schema change is part of the currently running fixture correction.
