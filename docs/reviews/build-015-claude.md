# Build 015 independent source review (Claude)

Written for: root and the project owner, to decide what to fix before any execution, and what the next implementation batch contains.

This is a SOURCE review only. Nothing was executed: no shell, tests, type check, build, network, browser, Docker or Caddy. Nothing was compiled, so type and lint statements below are reading-only. This document makes no readiness claim.

Evidence classes: **Read** (I read it in the working tree), **Reasoning** (my inference from the code), **Unverified** (a recollection of external behaviour, or something that needs a run).

## 0. Reviewed files and deviations

Read in full: `docs/reviews/implementation-015-notes.md`, `docs/verification/BUILD015_VERIFICATION_PLAN.md`, `docs/verification/NEXT_BUILD_SOURCE_FINDINGS_015.md`, `docs/reviews/build-014-claude.md`, `compose.yaml`, `src/server/wardrobes.ts`, `src/app/api/wardrobe/route.ts`, `src/server/authDialect.ts`, `src/server/writeTransaction.ts`, `src/server/writeGate.ts`, `src/server/sqliteRetry.ts`, `src/domain/backup.ts`, `tests/wardrobeContention015.test.ts`, `tests/authDeadline015.test.ts`, `tests/proxyConfig.test.ts`, `tests/helpers/lockRecorder.ts`.

Read in part: `src/server/database.ts` (connections, WAL call, `photo_assets` DDL), `src/server/lockDiagnostics.ts` and `src/server/auth.ts` (only the build-015 comment hunks, via Grep), `docs/DEPLOYMENT.md` (lines 10-39 plus Grep), `tests/accounts.test.ts` (lines 1-180), `tests/lockDiagnostics.test.ts` (selected auth-path ranges), `tests/concurrency.test.ts` and `tests/bodyDeadline.test.ts` (Grep context only).

Deviations from the request:

- **Frozen copy not compared.** I did not open `../build-015-initial` or `docs/verification/build-015-initial-source-manifest.json`. I reviewed the working tree. I cannot confirm the working tree equals the frozen 200 files, and I cannot diff against build 014. Where I say "unchanged" or "as before" I am relying on the notes.
- **`deploy/Caddyfile` not read.** It is outside the permitted folders. What I know of it comes from `tests/proxyConfig.test.ts` (it has a `{$STYLE_DOMAIN} {` site header, a 404 `handle` for the counters, one `reverse_proxy app:3000`).
- **Original stress scripts not re-read.** I did not check "unchanged by diff" for the original stress tests, scripts or budgets.
- **`src/server/analysisJobs.ts`** was open in the IDE but I did not read it. A Grep of the analysis and photo route files found no `photo_assets` or `sourcePhoto` references. I could not search every file for other photo consumers.
- The one extra read beyond the named list is `src/server/database.ts`, `sqliteRetry.ts`, `writeGate.ts`, `backup.ts`, which the changed files depend on.

## 1. Verdicts

| Item | Source verdict |
|---|---|
| Wardrobe read-first path and reclamation (`wardrobes.ts`, GET) | **Accept with conditions.** The core race design is sound (section 2). Conditions: F3 (cost of the new read), F5 (GET awaits cleanup). |
| PUT prepare/commit split | **Accept with conditions.** Atomic part is correct. `PreparedWardrobeSave` is forgeable (F1), which must be closed before more callers exist. |
| Auth single deadline (`authDialect.ts`) | **Accept.** Arithmetic and failure paths are correct by reading. Tests are timer-bound (F9). Hashing still spans the transaction. |
| Proxy least privilege (`compose.yaml`) | **Accept the least-privilege change. Do not accept the substitution design as "fails clearly if missing"** (F4). |
| Static compose reader and new tests | **Accept with conditions** (F2, F7, F8). |
| Build 015 as a release candidate | **Not decided by this review.** No execution exists. The unchanged 014 full release (216 total, 211 pass, 1 fail, 4 skip) remains a FAILURE and is not evidence that 015 passes. |
| Public launch | **Not approved. No production-ready claim.** |

## 2. What I verified by reading (no finding)

- **Reclamation race safety.** `reclaimExpiredPhotosInTransaction` takes no references from its caller. It re-reads the current `wardrobe_spaces` row inside the committing transaction and deletes only this user's photos that are older than 24 h and not referenced by that row. In-process, `runWriteTransaction` holds the gate and `BEGIN IMMEDIATE` and the body is synchronous. Across processes `BEGIN IMMEDIATE` serializes against any other writer. A save that attaches an old photo and commits before the reclamation body runs wins. A save that commits after it fails at the ownership check, inside its own transaction, with 400. There is no stale-snapshot path. The test "reclamation re-reads the CURRENT wardrobe" is deterministic (gate held) and would fail against a snapshot-based design.
- **Saved-look and `sourcePhoto` references.** `references()` flat-maps `wardrobe` plus every `looks[].items` and reads both `image` and `sourcePhoto`. The same function serves the hint, the reclamation and the save. So the source code counts them. The tests do not (F2).
- **Missing wardrobe.** `readWardrobe` returns revision 0 and creates no row. `commitWardrobeSave` treats a missing row as revision 0. The reclamation treats a missing row as an empty reference set and creates nothing. `bodyDeadline.test.ts` already expects `revision 0` and `wardrobe: []` after a timed-out PUT, which fits.
- **Fail closed.** `shapedReferences` returns null for a non-object, non-array `wardrobe` or `looks`, or a look without `items`, and for any throw while enumerating (null items, odd types). The reclamation then deletes nothing.
- **Transaction release.** A failing body rolls back in `runWriteTransaction` and in `inTransaction`; `release()` is in `finally`. Errors thrown by `commitWardrobeSave` (400/409) leave no open transaction or held gate. No `await` is inside any body.
- **Isolation by account.** Every photo statement carries `user_id`. `DELETE ... WHERE id=? AND user_id=?`.
- **Lost-acknowledgement retry.** A byte-identical document at a stale revision acknowledges with the stored revision. `backupSchema` is a plain `z.object`, so unknown keys (including `revision`) are stripped and the stored JSON does not contain the client's revision. Retries compare equal.
- **Connections.** The auth dialect uses its own connection (`getAuthDatabase`), journal mode is WAL, and the main connection's sync bodies never span turns. A lock-free read on the main connection therefore never sees a half-open auth transaction and is not blocked by one.
- **Direct callers.** Search of `src`, `tests`, `scripts` found `loadWardrobe`, `saveWardrobe` and the new functions only in the route, in `wardrobes.ts` and in the new test. No other direct caller exists to break. `loadWardrobe`/`saveWardrobe` keep their signatures.
- **Auth `begin()`.** `deadline` is set before the gate. The gate keeps the full budget as its own timeout. After the gate, `BEGIN IMMEDIATE` gets `max(0, deadline - now)`. With 0, `retryBusy` makes exactly one attempt (`Date.now() >= deadline` after the first busy failure) and rethrows. The gate is released on every failure path. The body is never replayed. Autocommit `executeQuery` keeps its own full budget, which the header comment says.

## 3. Findings, ranked

### Medium

**F1. `PreparedWardrobeSave` is a plain mutable object, and `commitWardrobeSave` trusts all of it.** (Read, Reasoning)

`prepareWardrobeSave` returns `{revision, json, references, photoIds}`. The type is exported. `readonly`/`ReadonlySet` are compile-time only; at runtime every field is mutable and `references` is a real `Set`. `commitWardrobeSave` uses `photoIds` for the ownership check, `json` for the write and `references` for reclamation, and never checks that they agree.

- A caller that builds the object by hand, or mutates one, can store a document that references photos it does not own (`photoIds: []`) with no 400.
- It can pass `references: new Set()` with a `json` that references live photos. The commit then deletes every photo older than 24 h plus every photo the replaced document referenced. That is data loss.
- The route today only passes the output of `prepareWardrobeSave`, so this is latent, not live. It is exactly the kind of invariant the next caller (backup import, a worker) will violate.
- It is not tested.

Fix, smallest first: keep a module-private `WeakSet` of objects that `prepareWardrobeSave` issued, freeze the object and copy `photoIds` to a frozen array and `references` to a frozen array, and make `commitWardrobeSave` throw a `TypeError` for anything not issued. Alternative: make the token opaque (a class with private fields and no public constructor). Do not re-derive `references` from `json` inside the commit unless measured; it adds a `JSON.parse` to the hold. Add a test that a forged object, a mutated issued object and a prepared object reused for a different user are each rejected or harmless.

**F2. The tests do not cover saved-look or `sourcePhoto` references, and the route-level claims are static only.** (Read)

- `sourcePhoto` appears in no test file. `looks` is `[]` in every new fixture. The plan lists "saved-look and sourcePhoto references count" as required behaviour. The code handles it (section 2), but nothing would catch a regression in `references()` or in the `shapedReferences` shape check for looks. Add: a photo referenced only by `looks[0].items[0].image`, one referenced only by `sourcePhoto` on a wardrobe item, and one only by `sourcePhoto` inside a look, each aged past the grace period, each surviving the deterministic race test and a `reclaimExpiredPhotos` run; and the same three removed by a save and deleted.
- "GET does not use the write path" and "PUT prepares before the gate" are regexes over route source. They would pass for code that is wrong at runtime and fail for harmless reformatting. The runtime evidence for the route is `accounts.test.ts`, which is unchanged and does not hold the gate. Add runtime route tests, using the `accounts.test.ts` session fixture: (a) hold the write gate and a foreign write lock, call the real `GET`, and assert a 200 inside a deadline with an empty gate queue; (b) with the gate held, a `PUT` with an invalid body answers 400 inside a deadline (pure rejection precedes acquisition), while a `PUT` with a valid body queues; (c) `GET` where the reclamation cannot start (gate held) still answers 200 within about the 2 s bound and leaves the photo.
- Missing: the 413 path and its changed precedence (oversize plus unavailable photo now 413), and a corrupt stored document through GET and PUT (F6).
- Fixture risk (the notes' item 3, confirmed as plausible): the new wardrobe test does not set `process.env.APP_URL`, which `accounts.test.ts` sets before importing `auth`. Whether `getReadyAuth` and `signUpEmail` work without it is Unverified. If they do not, every test in that file fails at `newUser`, which would hide all the others.

**F3. The new per-GET photo scan likely reads photo bytes, and the same scan runs inside every PUT's hold.** (Reasoning, Unverified)

`photo_assets` is `(id, user_id, data BLOB, sha256, created_at)` with an index on `user_id` only. `created_at` is stored after the BLOB. The notes say "one extra indexed SELECT id (blobs are not read)". The index finds the rows, but the filter on `created_at` needs a column that sits after `data` in the record. My recollection of the SQLite record layout is that a column after a large BLOB can require walking the row's overflow pages. If that holds, one GET reads about every photo byte the account has, up to the stored page cache. That recollection is not verified here; it needs a measurement with, say, 50 photos of a few MB.

- The same pattern exists in `reclaimPhotos` (`SELECT id,created_at ... WHERE user_id=?`), which runs inside the committing transaction of every PUT. That makes it a candidate contributor to the write hold in the G1 workload, which this batch claims to shorten.
- Options, none implemented: a covering index `(user_id, created_at, id)` (needs a schema migration batch); or avoid the scan on GET with a per-account in-memory throttle (for example at most one hint check per hour per account) since the grace period is 24 h; or reorder nothing and measure first. Root should measure GET and PUT hold time with a large photo set before and after, not rely on the notes' claim.

**F4. The proxy substitution does not "fail clearly if missing", and a later bare compose command can silently break the proxy.** (Read, Reasoning, Unverified)

The verification plan requires the documented invocation to supply the value "and fail clearly if missing". `compose.yaml` uses `${STYLE_DOMAIN:-}`, so Compose never fails and does not warn (the "variable is not set" warning only appears for a variable with no default).

- The only failure signal left is Caddy's. With the value empty, the Caddyfile site header `{$STYLE_DOMAIN} {` becomes ` {`. My expectation is that Caddy reads this as a global-options block and rejects the directives inside it, or rejects a keyless block that is not first. Either way it should refuse to start. Both are Unverified, and I did not read the Caddyfile. The notes already ask root to run it once with the variable unset; keep that as a gate and record the exact message.
- **Recreate hazard.** `export COMPOSE_ENV_FILES=...` lasts for one shell. A later `docker compose up -d` in a new shell (the restore step 4 in the guide does this) sees a changed proxy configuration and recreates the proxy with an empty domain, with no error from Compose.
- `COMPOSE_ENV_FILES` support is the author's recollection of Compose v2.24+. I recall the same, but I have not verified it. The guide must not rest on it alone.
- The `docker compose` code block still shows the bare commands. The `export` instruction is in a paragraph below the block ("before the commands above"), which is easy to miss.

Suggested direction, for the next batch (not implemented): (1) document a project-level `.env` next to `compose.yaml` containing only `STYLE_DOMAIN=...`. Compose loads that file with no flag in every version, no secret goes in it, and it survives new shells; keep `--env-file` as the alternative; (2) put the required guard in the container: make the proxy command a short `sh -c 'test -n "$STYLE_DOMAIN" || { echo "STYLE_DOMAIN is not set" >&2; exit 1; }; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile'`, so the failure is a clear log line and a restart loop that `docker compose ps` shows. Both need a Docker run to confirm; (3) put the variable in the code block, not in prose.

### Low

**F5. GET awaits the best-effort cleanup (flagged by the author; I agree it is acceptable but not ideal).** (Read, Reasoning)

The route `await`s `reclaimAfterRead`. Under contention a GET that sees an expired photo can wait up to the 2 s `RECLAIM_ACQUIRE_MS` plus the retry overshoot, and if the cleanup times out, the photo stays, so the next GET waits again. So read latency becomes bimodal in exactly the conditions G1 is about. The response never depends on the outcome, which is correct. The reason given (an existing test asserts immediate deletion) is real (`accounts.test.ts` line 156-160). Prefer response-first cleanup plus a test that polls, or the throttle in F3. If it stays awaited, record GET latency separately in the stress evidence. Also note `inflight` is per module instance; the route is the only importer so it is fine today, but Next bundles routes separately, so a second importer would not share it.

**F6. Malformed stored documents are handled inconsistently.** (Read, Reasoning)

The reclamation fails closed, which is right. Elsewhere:

- `readWardrobe` does `JSON.parse(row.data_json)` unguarded. Invalid JSON throws `SyntaxError`, GET answers 500.
- `commitWardrobeSave` parses the replaced document and calls `references(old)` unguarded, after the upsert but inside the transaction. For `"not json"` or a document with no `wardrobe` array it throws, the transaction rolls back, and PUT answers 500. The account can neither read nor save until the row is repaired. (The idempotent branch returns before this, so only a stale-revision-free path is hit.) I cannot tell whether the same was true before 015; I could not diff.
- `readWardrobe` of a stored `null` or a document without arrays returns a "wardrobe" with no `wardrobe`/`looks` fields, although `WardrobeView` types them as arrays.

Suggested: in the commit, treat an unreadable replaced document as an empty `old` set (the current document is authoritative for `keep`, and the 24 h sweep still applies); decide deliberately whether GET should answer a fixed 500 or repair. Add tests for both. Note `concurrency.test.ts` seeds `data_json='{}'` rows for the deletion test; those accounts are not read or saved afterwards, but it shows such rows are considered possible.

**F7. Compose reader limits.** (Read)

The reader is honest that it is not a YAML parser, and it fails closed for the real file because the test asserts the `app` and `proxy` services are found. Remaining gaps:

- The helper API fails open: if indentation changes, `composeServiceNames` returns `[]` and `servicesPublishing` returns `[]`. The tests are protected only because they separately require `composeService(compose, "app")` to exist. Make `servicesPublishing` throw when no services are found.
- It sees only `compose.yaml`. `network_mode: host` publishes the app port with no `ports` key. `compose.override.yaml`, `include:` and `extends:` are invisible. A port range such as `2000-4000:80` does not contain the token `3000`. Quoted service names (`"app":`) are not matched.
- `stripYamlComments` removes anything after ` #`, including inside a quoted string. Harmless for this file.
- The proxy-environment test reads Caddy `{$VAR}` only. A Caddy `{env.VAR}` placeholder would not be counted, so a Caddyfile that read a secret that way would pass.
- Static text only: nothing here shows a running proxy, Docker or Compose substitution works.

**F8. Ownership is checked before the revision.** (Read)

A stale or retried write whose photo has since been reclaimed answers 400 "A wardrobe photo is unavailable", not 409. Scenario: save A commits, its response is lost, another device then removes the photo, the retry of A hits the ownership check first. Both are failures and no data is lost, but the client's recovery text differs. Confirm the order against build 014 (I could not). If the 014 order was revision first, keep that order.

**F9. Auth tests are timer-bound and one static test is near-vacuous.** (Read)

- `authDeadline015` asserts a refusal between about 540 ms and 850 ms for a 600 ms budget, with the gate held 350 ms. Margins of about 250 ms are reasonable, but a loaded Windows machine can break them. Native `exec`, timers and the up-to-50 ms backoff sleep mean overshoot beyond the nominal budget is expected and the header comment says so ("plus one BEGIN attempt"); no test should be read as a hard real-time bound. The test titles and comments do not claim one; keep it that way.
- The static test's `doesNotMatch(begin, /acquireTimeoutMs \* 2|10_000\s*\*\s*2/)` matches nothing that could plausibly be written. Source-regex checks here (and in the wardrobe route static test) are brittle and are not evidence of runtime behaviour.
- Existing auth-path assertions in `lockDiagnostics.test.ts` use a free gate, so the changed meaning of `budgetMs` should not affect them. Not run.
- `docs/reviews/implementation-011-notes.md` line 47 still states the old meaning; the author said it is historical. Fine.

**F10. Smaller observations.**

- `prepareWardrobeSave` is outside the gate, but it is still synchronous CPU (zod parse and `JSON.stringify` for up to 3 MB) on the single event loop. It shortens the hold; it does not remove event-loop time. Measure before claiming a latency gain.
- The two SELECTs in `readWardrobe` are not one snapshot. Harmless in-process; across processes the hint may be momentarily stale. It is only a hint.
- A `PUT` that is refused for ownership or revision still takes the gate and `BEGIN IMMEDIATE` to be refused. This is required for atomicity.
- Uncompiled type reading: I found no type error or unused import in `wardrobes.ts`, `route.ts`, `authDialect.ts` or the three test files. This is reading only; typecheck and lint still decide.

## 4. Source verdict versus execution and launch approval

Source verdict: the architecture of the wardrobe and auth changes is correct by reading and the least-privilege compose change is correct. Fix F1 and the test gaps in F2, decide F3 and F4, and then root can freeze and run. I am not approving any behaviour, only the source.

Execution approval: not given by this review, and not mine to give. No execution has occurred. Do not run anything as a workaround for the approval-review usage failure.

Public launch: **not approved.**

Open and untouched by this build: G1 (the full suite has never passed in a way that explains the 014 failure; this build removes avoidable gate traffic but proves no fairness or hold-time fix), password hashing spanning the auth transaction, the rejected `Connection: close` h2 transport candidate (the h2 baseline is still unmeasured), no human-labelled gold and no held-out recognition result, SMTP with a real provider, Docker and Linux execution, hosting and trusted HTTPS, encrypted off-site recovery, and real phones.

The negative `--iou` decimal contract edge in the unchanged 014 CLI stays open and outside 015 scope, as root asked.

## 5. Concrete next steps

For the next Claude batch (source only):

1. Make `PreparedWardrobeSave` unforgeable (F1) and add the forgery tests.
2. Add the `looks`/`sourcePhoto` reclamation and save tests, the runtime GET/PUT-under-held-gate route tests, the 413 test and the corrupt-document tests (F2, F6). Set `APP_URL` in the new wardrobe fixture the way `accounts.test.ts` does.
3. Make the replaced-document parse in the commit tolerant (F6).
4. Replace the static compose and route regex checks with runtime checks where one exists; make the compose helper throw when it finds no services (F7).
5. Prepare, but do not run, the proxy guard and `.env` documentation change (F4), with the Docker run listed as a root gate.
6. Decide, with root, between awaited and response-first cleanup, or a per-account throttle (F5, F3).

For root, when execution approval exists, in this order:

1. Typecheck and lint (nothing was compiled).
2. The two new test files, then `accounts`, `concurrency`, `bodyDeadline`, `lockDiagnostics`, `proxyConfig`. Record the first failure of the new files exactly; do not fix tests to match.
3. Measure GET and PUT hold time with a large photo set (F3), separately recording BEGIN wait and COMMIT time.
4. The unchanged full release suite, repeated several times, with the flake rate recorded. The failing 014 result must be reported next to it, not replaced by it.
5. On a Docker host: run the proxy with `STYLE_DOMAIN` unset and record what Caddy does; run with the documented flag; confirm `COMPOSE_ENV_FILES` version support; run the recreate scenario in F4.
6. The compiled original consumer browser suite, since application source changed.
