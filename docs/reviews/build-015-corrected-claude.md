# Build 015 corrected candidate: independent review with actual checks (Claude, Revision 2)

This review used Read, Glob and Grep only, plus this one Write. I ran no shell, tests, type check, build, network, browser, Docker or Caddy, and I edited no source. Every execution result below (typecheck, lint, the 41-test targeted run) is root's, taken from `docs/verification/BUILD015_CHECKS.md` and `targeted-015-corrected-default.log`. Nothing here is a readiness claim.

Evidence classes: **Read** (I read it in the working tree), **Log** (root's recorded run output), **Reasoning** (my inference from code), **Unverified** (needs a run or an external source).

## 0. Reviewed files and deviations

Read in full: `docs/verification/BUILD015_CHECKS.md`, `targeted-015-corrected-default.log`, `COMPOSE_ENV_RESEARCH_015.md`, `CADDY_CONTAINER_SOURCE_015.md`, `docs/reviews/implementation-015-notes.md` (Revision 2), `docs/reviews/build-015-claude.md` (prior review), `src/server/wardrobes.ts`, `src/app/api/wardrobe/route.ts`, `src/server/mailOutbox.ts`, `tests/wardrobeContention015.test.ts`, `tests/wardrobeRoutes015.test.ts`, `tests/authDeadline015.test.ts`, `tests/proxyConfig.test.ts`, `tests/helpers/wardrobeEnv.ts`, `tests/helpers/wardrobeFixtures.ts`, `compose.yaml`, `deploy/Caddyfile`, `.env.compose.example`, `docs/DEPLOYMENT.md` (lines 1 to 120).

Read in part: `build-015-corrected-source-manifest.json` (first 40 lines), `src/server/database.ts` (lines 100 to 200, schema), `src/domain/backup.ts` (lines 1 to 40), `scripts/packaging-rules.ts` (lines 40 to 100), `tests/concurrency.test.ts` (lines 355 to 395). Grep context only: `src/server/access.ts`, `src/server/mail.ts`, `tests/packaging.test.ts`.

Deviations:

- **Frozen copy not opened.** I reviewed the working tree under `style-app`, not `../build-015-corrected`. I cannot hash, so I cannot confirm the tree equals the 204 manifest entries. If root froze exactly this tree, the findings apply; otherwise they apply to what I read.
- **typecheck and lint logs not opened.** I rely on root's statement (PASS, exit 0). Whether `npm run typecheck` includes `tests/` is Unverified (I did not read `tsconfig`). The test runner (`tsx`) strips types without checking them, and lint does not cover tests, so type errors in the new test files are not excluded by anything recorded.
- **Not read** (outside the permitted set or not needed): `Dockerfile`, `.dockerignore`, `tests/helpers/mailCapture.ts`, `src/server/auth.ts`, Better Auth's `user` table definition, `writeGate.ts`/`writeTransaction.ts` (read in the prior review, not re-read), `analysisJobs.ts` (open in the IDE, unrelated to this batch as far as I searched).
- No `.env`, `.env.production`, `.data`, `.runtime`, `node_modules` or `sources/` content was read.

## 1. Three separate verdicts

| Question | Verdict |
|---|---|
| **Source acceptance** (`wardrobes.ts`, wardrobe route, authDialect change, compose/Caddy text) | **Accept with conditions** (section 7). The Revision 2 source closes the prior F1, F2 (source side), F4 (authored), F6 and F7 findings by reading. No source defect was found that the failing tests demonstrate. |
| **Validity of the 4 failing tests** | The four failures are **setup-precondition failures, not product failures, and not evidence for or against retention.** Every retention assertion after lines 132 and 497 never ran. The test design (hold the gate, assert exactly one waiter, then race a save) is sound and must be kept. The fixture that feeds it is not deterministic (section 2). Nothing may be loosened. |
| **Launch** | **Not approved.** Four retention cases are unverified, the old regression suites were not run against this tree, the 014 full release failure (216 total, 211 pass, 1 fail, 4 skip) stands, and G1, hashing/fairness, transport/H2, model correctness and human gold, SMTP, Docker/Linux, hosting/HTTPS, encrypted off-site recovery and real phones are all open. |

What root's checks do establish (Log): typecheck exit 0, source lint exit 0, 37 of 41 targeted tests pass, including all 6 real direct-handler route tests, the 4 auth-deadline tests and the 12 static proxy/compose tests. That is real evidence for the route behaviour under a held gate and a foreign SQLite lock, for the corrupt-document read/replace path and for the 413 path. It is not a network, proxy, browser or Docker result.

## 2. The extra queued writer: trace and correction

### 2.1 Trace (Read + Reasoning; the chain is consistent with the log, but no run has observed the identity of the second waiter)

1. `newUser` (`wardrobeFixtures.ts:15`) calls the real `auth.api.signUpEmail`. The test env has no `SMTP_URL` and is not public, so `usesLocalCapture()` is true (`mail.ts:30`).
2. Better Auth's verification callback reaches `enqueueMail` (`mailOutbox.ts:181`). Inside the sign-up transaction it inserts a `mail_outbox` row on the auth connection, then calls `kickLocalCapture()` (line 187). That sets a 15 ms `unref`'d timer (lines 647 to 652).
3. About 15 ms later the timer runs `drainLocalCapture` (line 655), which calls `processNextMail()`. That does `await runWriteTransaction(claim)` (line 513), which waits for the process write gate. After the local send it takes the gate again to record the outcome (line 555), and the loop then claims once more and finds nothing (a third gate acquisition).
4. In the failing test at `wardrobeContention015.test.ts:115`, the sequence is: `newUser`, two synchronous `addPhoto`, a synchronous `readWardrobe`, `await acquireWriteGate()`, `reclaimExpiredPhotos` (queue length 1), `await sleep(25)`. The 15 ms drain timer lands inside that 25 ms sleep, its claim queues behind the held gate, and the length becomes **2**. The F2 tests at line 482 have the identical shape. That explains exactly four failures with `2 !== 1` and nothing else.
5. The same cause makes some currently **passing** assertions schedule-dependent, not deterministic:
   - The first test (line 69 to 96) asserts `writeGateQueueLength() === 0` while the gate and a foreign write lock are held. It passes only because the read resolves before the 15 ms timer fires. A slower machine or a longer `newUser` tail could queue the drain's claim first and fail it.
   - The route tests assert exact queue lengths (0 or 1) right after `verifiedSession`. `waitForMail` returns once the capture file exists, but the drain still has a record transaction and a final empty claim ahead of it. The subsequent `verifyEmail` and `signInEmail` calls (hashing) usually outlast that, which is a timing margin, not a guarantee.

   These are the same hidden-writer defect. The four failures are where it shows today.

What is **not** proven: no one has observed the second waiter's identity. The A/B check in section 2.3 would settle it.

### 2.2 Correction I recommend (source-only; do not weaken counts)

Keep `assert.equal(writeGateQueueLength(), 1)` and the real product behaviour unchanged. Remove the hidden writer from repository-level fixtures instead:

1. **Repository tests (`wardrobeContention015.test.ts`): create accounts without sign-up.** Add a fixture, for example `newRepositoryUser(label)`, that calls `getReadyAuth()` once so the Better Auth migrations have created the `user` table, then inserts a `user` row directly. No mail, no outbox row, no timer. The wardrobe, photo and mutation tables reference `user(id)` only (`database.ts` lines 139 to 187), so a user row is all they need.
   - I could not verify the `user` column list (not in the permitted reading). The names `id, name, email, emailVerified, createdAt, updatedAt` are the usual Better Auth set and `emailVerified`, `createdAt`, `updatedAt` appear in other tests. Have the fixture read `PRAGMA table_info(user)` and throw with the column name if a NOT NULL column has no value, so a wrong guess fails at the fixture, not silently.
   - Add a guard in the fixture's callers, before any gate is held: `SELECT COUNT(*) FROM mail_outbox` for the user is 0 and `writeGateQueueLength() === 0`. This turns "no hidden writer" into an assertion rather than an assumption.
2. **Route tests (`wardrobeRoutes015.test.ts`): keep real sign-up, verification and captured mail.** They need a real session cookie. Add explicit quiescence after `verifiedSession` instead of relying on later hashing time:
   - Smallest honest seam: an additive, behaviour-neutral export in `mailOutbox.ts`, e.g. `settleLocalCapture(): Promise<void>` that resolves when `kickTimer` is null and `draining` is false (it can poll those two flags every few ms with a hard cap). Only tests call it. It changes no product path.
   - Call it **before** the test acquires the gate. The drain needs the gate to finish, so settling while holding the gate would wait forever.
   - A database-only poll ("no queued or sending rows") is not sufficient: the drain still takes one more gate acquisition for its final empty claim after the last row is recorded.
   - If root prefers no `src/` change, the fallback is a bounded poll on the same condition using a public signal. I know of none, so I recommend the seam.
3. **Preserve real coverage elsewhere.** `accounts.test.ts`, `mailCapture.test.ts`, `mailOutbox.test.ts` and `concurrency.test.ts` already exercise real sign-up with captured mail. Leave them untouched.
4. **Do not** introduce `>= 1`, `<= 2`, longer sleeps, an earlier `sleep(25)` before acquiring the gate, an `SMTP_URL` flip to silence the capture, or `unref`/timer clearing in the product. Each hides a real writer or changes product behaviour to suit a test.

### 2.3 Evidence needed from the next run

1. The four formerly failing tests with the direct-row fixture: record pass or the **first new** failure exactly. They have never reached their retention assertions, so a real defect may still be behind the queue count.
2. An A/B diagnostic to turn the hypothesis into a trace. Label it diagnostic, not a pass criterion: (a) direct-row user, hold the gate, `reclaimExpiredPhotos`, `sleep(100)`, record queue length (expect 1); (b) real sign-up, the same steps, no settling (expect 2); (c) real sign-up, `settleLocalCapture()`, then the same steps (expect 1). Also record the `mail_outbox` row count before the hold.
3. Repeat the corrected file at least 20 times and record the failure rate. A queue-length precondition that depends on a 15 ms timer is exactly what a single pass would not show.
4. Run the unmodified regression suites against this tree and record each result next to the 014 failure: `accounts`, `concurrency`, `bodyDeadline`, `lockDiagnostics`, `accountUpload`, `mailCapture`, `mailOutbox`, `packaging`. None was run in the corrected-candidate checks (the targeted run covered four files only).
5. Whether `npm run typecheck` covers `tests/` (read `tsconfig` include). If not, run a type check that does, or state that the new test files are untyped.

## 3. `WeakMap` plus frozen public arrays (prior F1)

Assessment: **consistent and sound by reading; accept.** Behaviour tests passed (Log): the F1 forgery, mutation and account-scoping tests.

- `prepareWardrobeSave` builds the private payload (`json`, `references` Set, `photoIds` frozen array) and the public view from the **same parse**, then registers only the frozen public object in a module-private `WeakMap` (`wardrobes.ts:294`, `346` to `361`). `commitWardrobeSave` looks the object up **by identity** and ignores every public field (`378` to `382`). Hand-built objects, spreads, `structuredClone`, JSON round trips, `Object.create(real)` and `Proxy` wrappers are different objects, so none is in the map. A `Proxy` has its own identity; it is not the target. All throw `TypeError` before `getDatabase()`, which the test proves with a foreign `BEGIN IMMEDIATE` held. The "mutate the issued object" test is meaningful: frozen assignment either throws (ES modules are strict) or is ignored, and the committed bytes equal the prepared bytes.
- **No `JSON.parse` inside the hold**, which is what the prior review asked for.
- **Ownership and idempotency.** The token is deliberately not account-bound. Ownership is decided per committing account inside the transaction for every id in `payload.photoIds` (`389` to `391`), so a token prepared with A's photo and committed by B gives 400 and rolls back, and nothing is reclaimed (the test checks `hanksOld` survives). Re-committing the same token for the same account acknowledges the stored revision when bytes are identical. A photo-free token is reusable across accounts with independent revision counters. I found no path where reuse crosses an account boundary.
- **Public view versus private payload.** The public `references` and `photoIds` are separate frozen arrays copied from the private values, so a consumer cannot mutate what the commit uses. A frozen `Set` would still be mutable, which is why none is exposed. Correct.

Low observations (no action required for acceptance):

- **L1. `photoIds` and `references` are two derivations of one set.** `checkPhoto` collects `photoIds`; `references()` re-derives the same ids with the same `pathId`. They are equal today. If one changes, ownership and reclamation would diverge silently. Derive `photoIds` from `referenceSet`, or add a test asserting equality.
- **L2. A `TypeError` from a forged token reaches `errorResponse` as a generic 503.** A 503 is retry-shaped, so an actual programming error would look transient to a client. The route cannot produce it today (it only passes `prepareWardrobeSave` output). Not a live defect; note it for the first additional caller.
- **L3. Registry is per module instance.** If a second bundle imported `commitWardrobeSave` with a token from another instance's `prepareWardrobeSave`, it would be refused. Today the route imports both from one module. Fail-closed, so safe.

## 4. Malformed stored documents (prior F6)

Source: **accept.** Read (`readWardrobe`, `storedReferences`, `commitWardrobeSave`):

- Read: a row that is not JSON or not wardrobe-shaped throws a fixed `RequestError(500)` with no echo and no repair, no empty wardrobe, no reclamation. Log: both the repository test and the route test passed (`GET` answers 500 with the fixed text, the stored text is never in the body, the row is unchanged, the expired photo survives).
- Save: an unreadable replaced document contributes an empty `old` set. The document being saved is authoritative for `keep`, the 24 h grace sweep still runs, and revision (409) and ownership (400) still apply and roll back. Log: passed for all six broken forms.
- `reclaimExpiredPhotosInTransaction` still fails closed (deletes 0) for an unreadable row.

Findings:

- **M1 (Medium, product): replacement of a corrupt document is operator-only in practice, and the notes and tests overstate it.** `GET` on a corrupt row answers a fixed 500 with no `revision`, and `PUT` needs the stored revision (`7` in the route test) or it answers 409. A real client has no way to learn the revision, so the "PUT with the right revision replaces it, readable again once the user saves" scenario is reachable only because the test seeded revision 7. This may be the intended "contact support" outcome (the message says so), but then say so. Decide: (a) document it as an operator repair path only, with the exact steps and who may run them, or (b) expose the integer revision in the 500 body (non-sensitive) knowing it lets a user overwrite the unreadable document. Do not describe the current behaviour as self-service recovery. Not verified: how the client UI treats a 500 on load (I did not read it), and whether it could then save an empty local state over the stored one with revision 0 (that would 409, which is the safe outcome).
- **L4.** The `{}` and `null` rows used to be returned as partial objects and now answer 500. `concurrency.test.ts:364` to `370` seeds `data_json='{}'` rows but, by reading, never reads or saves them through the wardrobe route afterwards. That is Reasoning, and `concurrency` has not been run against this tree.

## 5. Reference coverage (prior F2): `looks[].items[].image`, `sourcePhoto` on wardrobe items, `sourcePhoto` in looks

- **Source:** `references()` and `prepareWardrobeSave` handle all three through the same enumeration, and `storedReferences` requires `looks[].items` arrays. Accept by reading.
- **Test design (Read):** the three data-driven tests are well constructed. `bareGarment` gives `image: ""`, which `backupSchema` allows (a plain string with a max length, `backup.ts:2` to `10`) and `checkPhoto("")` accepts, so each kind is isolated. A regression that dropped `sourcePhoto` from `references()` would make the race reclaim `aged` (result 1, not 0) and the removal-save leave `young` behind, so the tests would catch it. Stranger-account safety is asserted. This is by reading only.
- **Status: NOT VERIFIED.** Log: all three failed at line 497, before the `saveWardrobe`-after-race, the later cleanups, the removal save and the stranger assertions. The `sourcePhoto` retention claims, and the original race test's retention claim, have not run. Do not report them as passing, and do not count the 37 passes as covering them.
- Gap (Low): there is no test where one photo is referenced by **two** kinds at once and one reference is removed. The fail-closed union logic makes this safe by reading; a test is cheap.

## 6. Status of every earlier review finding

| ID | Prior finding | Now |
|---|---|---|
| F1 | Forgeable prepared save | **Closed by reading** and by 3 passing tests (section 3). |
| F2 | Reference kinds and runtime route tests | Route half **closed**: 6 real-handler tests pass. Reference-kind half **written but unverified** (section 5). |
| F3 | Per-GET and per-PUT photo scan may read BLOBs | **Open, unchanged, unmeasured.** No index, no throttle, no measurement exists. Still a measurement gate. |
| F4 | Proxy substitution does not fail clearly; recreate hazard | **Authored** (section 8). Not run; no Docker evidence. |
| F5 | GET awaits best-effort cleanup | **Kept deliberately.** The stalled-cleanup route test (passed, 2.47 s) documents about 2 s of latency; its bounds are timer based. Record GET latency separately in stress evidence. |
| F6 | Malformed documents | **Closed in source** and passing; see M1 for the user-visible recovery gap. |
| F7 | Compose reader fails open | **Closed by reading** and by passing tests: the helpers now throw. Its limits (one file, no overrides or profiles, `{env.VAR}` not counted) are stated in the helper header. |
| F8 | Ownership checked before revision | **Open, unchanged**, never compared with 014. |
| F9 | Timer-bound auth tests; near-vacuous static test | Timer tests **passed** (695 ms, 509 ms, 153 ms). The static `doesNotMatch(... \* 2 ...)` is still near-vacuous. Low. |
| F10 | Prepare is event-loop CPU; two reads not one snapshot | Unchanged, as noted. |

## 7. Conditions on source acceptance, with severity

1. **High (verification blocker): fix the hidden-writer fixture as in section 2.2 and obtain the four retention tests running to completion.** Until then the core race claim (a save that attaches a photo after the read keeps it) has no passing evidence in the corrected candidate. This is a verification gap, not a demonstrated product defect.
2. **Medium: run the unmodified regression suites against this tree** (section 2.3, item 4). The prior review ordered `accounts`, `concurrency`, `bodyDeadline`, `lockDiagnostics` after the new files, and the GET and PUT behaviour they exercise changed.
3. **Medium: make the currently passing queue-length assertions deterministic** by the same fixture work (section 2.1, item 5), so they do not become the next flakes.
4. **Medium: M1.** Decide and document the corrupt-document recovery path.
5. **Low:** L1 to L4, the near-vacuous static auth test, F8 ordering decision, and a test for a photo referenced by two kinds.
6. **Open measurements:** F3 (hold time with a large photo set) and GET latency (F5).

## 8. Compose, Caddy and the deployment guide (static text only)

- **`compose.yaml` proxy (Read).** `env_file` is gone; `environment` is exactly `STYLE_DOMAIN: ${STYLE_DOMAIN:-}`; the `command` is `sh -c '<guard>; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile'`. `$$` correctly escapes Compose substitution so the container shell expands the variable. The `:-` default keeps `exec`, `run` and `logs` working with the variable unset, as the guide says. The Caddyfile reads only `{$STYLE_DOMAIN}` (the test asserts that). The other three services keep `env_file`.
- **Caddy image (research doc, not run).** `CADDY_CONTAINER_SOURCE_015.md` records an official Alpine 2.11 Dockerfile with a standard `CMD` and no `ENTRYPOINT`, so overriding `command` preserves the invocation. That is a source observation from the Dockerfile text. No container started; `/bin/sh` availability and the guard's behaviour were not observed. The `caddy:2` tag is mutable and not resolved to a digest, so an upgrade could change the base. Pin a tested digest before relying on this.
- **Compose research (research doc).** `COMPOSE_ENV_FILES` shell-exported support in v2.23.0 is recorded from official source, and the Perplexity 2.32.3 claim is correctly rejected. The guide makes no version claim and does not rely on the variable, which is the right call. The research also names unaudited points (earlier patches, `.env`-declared discovery), so keep the explicit-`.env` route as the documented default.
- **`.env.compose.example` and the guide (Read).** One non-secret assignment with a reserved `.example` domain. The guide puts `[ -e .env ] || cp .env.compose.example .env` before the first `docker compose build` and warns not to overwrite an existing `.env`. The restore procedure's bare `docker compose up -d` now keeps the domain because the project `.env` persists. This closes the recreate hazard on paper only.
- **Open, Unverified:**
  - A real run with `STYLE_DOMAIN` unset: the guard's log line, exit code and restart behaviour under `restart: unless-stopped`.
  - A run with `.env`, and with `--env-file`.
  - `docker compose exec proxy printenv STYLE_DOMAIN`.
  - The recreate scenario from a new shell.
  - Whether Docker's build context (`build: .` for app, worker and mailer) includes a project `.env`. I did not read `.dockerignore`. The file holds only a non-secret domain, so the impact is small, but confirm it is excluded or acceptable.
  - Whether `.env.compose.example` at the repo root trips any packaging check. `forbiddenReason` (`packaging-rules.ts:53` to `73`) would flag any `.env*` name other than `.env.example` if a scan reached it. Packaging scans the standalone output and bundle, so the root file should not be reached; `tests/packaging.test.ts` has not been run on this tree.
- The static tests prove text and order only. Root's log line says as much, and I agree.

## 9. Auth deadline (`authDeadline015`)

By Log, all four tests pass (695 ms, 509 ms, 153 ms, static). The 600 ms budget with a 350 ms gate hold gives about 250 ms margin on each side, which held once on this machine. It is timer based; keep it out of any claim of real-time bounds. Password hashing still runs inside the auth write transaction, and nothing in this batch addresses that or G1.

## 10. Next precise correction and the evidence it must produce

**Next correction (source only, one batch):**

1. Replace `newUser` in the repository tests with a direct-row fixture plus the "no mail row, empty gate queue" guard. Leave `verifiedSession` for the route tests and add `settleLocalCapture()` (or an equivalent additive, test-only seam) before any gate is held.
2. Do not change any expected queue count, sleep, timer or product mail behaviour.
3. Add a diagnostic A/B test for the hypothesis (section 2.3, item 2) and one test for a photo referenced by two kinds.
4. Resolve M1 in the docs (or the 500 body) and L1 in the source or a test.

**Evidence root must record afterwards, in this order:** typecheck and lint; the corrected wardrobe file run to completion, with the first failure exactly if any; the A/B diagnostic numbers; at least 20 repetitions with the failure rate; the unmodified regression suites; the Docker, Caddy and Compose items in section 8 on a real host; the F3 hold-time measurement with a large photo set; and the full release suite repeated with its flake rate beside the failing 014 result. None of these can substitute for another.

## 11. What remains open and untouched

G1 (the full suite has not passed in a way that explains the 014 failure), password hashing across the auth transaction and fairness, the transport and H2 candidate, large-photo scan measurement, actual vision correctness and human-labelled gold, real SMTP, Docker and Linux execution, hosting and trusted HTTPS, encrypted off-site recovery, real phones. The negative `--iou` decimal edge in the 014 CLI stays outside 015. No production build, compiled browser suite, full 015 `npm` run or deployment exists. Public launch is not approved and no readiness claim is made.
