# Build 014 independent review (Claude)

Written for: root and the project owner, to decide what to freeze, what to reject and what Claude implements next.

Method: Read/Glob/Grep and this one Write only. I ran nothing: no shell, tests, network or Caddy. I did not open `.data`, `.env*`, runtime folders or any application source under `src/`. Two reads went slightly past the named list, to the files the named tests themselves read: `compose.yaml` (full) and a Grep of `docs/DEPLOYMENT.md`. No private data was involved.

Evidence classes used below:

- **Observed (root):** a number or result reported in the verification documents. I did not re-observe it and did not open the probe JSON or logs, so I cannot confirm they match the documents.
- **Reasoning:** my reading of the code or the numbers.
- **Unverified:** an assumption or a recollection of external behaviour that someone must check.

I could not compare the working tree with the frozen `build-014-corrected` snapshot or its hashes. "197 files unchanged" is root's observation, not mine. The prepared request (`docs/verification/CLAUDE014_REVIEW_REQUEST.md`) still says the firewall Cancel is pending and that it is "not dispatched". That is stale. This review is the actual dispatch, so do not cite that header as a pending state.

## 1. Verdicts

The scoped code verdicts and the launch verdict are separate.

| Item | Verdict |
|---|---|
| Offline evaluation harness (`scripts/vision-evaluation`) | **Accept with conditions, as development-only measurement tooling.** Do not use it for held-out claims until the conditions in 3.1 are met. |
| Shipped default diagnostics block (`deploy/Caddyfile`, 404 for `/api/health/uploads*`) | **Accept as scoped.** The evidence covers Windows HTTP/1.1 only. Named gaps are in 4. |
| Unshipped upstream `Connection: close` transport proposal (4xx/5xx) | **Reject as written. Do not ship.** The HTTPS/h2 result below contradicts it. |
| Build 014 as a release candidate | **Not accepted.** The unchanged full `npm test` failed (216 total, 211 pass, 1 fail, 4 skip). The isolated diagnostic pass does not cancel it. |
| Public launch | **Not approved. No production-ready claim is supported by any evidence in this build.** |

The harness and the Caddy block are scoped changes. Nothing in them touches the DB or gate path, which is why I can accept them separately. That does not rescue the build's red suite.

## 2. Transport

### 2.1 The h2 result decides it (Observed, root, supplemental)

The newest HTTPS candidate set `Connection: close` unconditionally on upstream 4xx/5xx. It used a task-local CA, strict certificate validation and ALPN h2.

- Initial health and concurrent health succeeded.
- Stalled auth returned 408 at 20.333 s.
- A GOAWAY arrived at 21.037 s and closed the whole h2 session.
- A follow-up health request on the same session failed with `ERR_HTTP2_INVALID_SESSION`.

**Reasoning:** I recall that Go's http2 server treats a response `Connection: close` as a request to shut the connection down gracefully. That matches the observed GOAWAY, but it is a recollection and has not been checked against the Caddy 2.11.7 source. The practical consequences, if it holds:

- Every upstream 401, 403, 404, 429 or 5xx would tear down that browser's multiplexed connection. Browsers reconnect, but each error costs a new TLS handshake. In-flight sibling streams are at risk. Logged-out polling and ordinary not-found pages become connection churn.
- In h2 the original problem may not exist in that form. A stalled body belongs to a stream, not a socket. The server resets the stream once the handler has answered. This is also reasoning, and the baseline (candidate removed) under TLS/h2 has not been measured.
- The 704 ms gap between the 408 and the GOAWAY is unexplained.

The earlier HTTP/1.1 results are valid for HTTP/1.1. They show that the close-after-408 mechanism works there, that normal keep-alive survives on health requests, and that 413 and early 401 close promptly. They do not carry over to h2, and production is h2 for browsers. `compose.yaml` publishes `443` as TCP only (`ports: ["80:80", "443:443"]`), so h3 is not in play, but h1 and h2 both are.

### 2.2 What to build instead (design proposal, UNVALIDATED)

I have not created or checked this. The automatic review limit blocked the earlier attempt, and I am not executing anything as a workaround. This is a sketch for the next batch, not a deliverable:

1. Apply the close behaviour only where it is needed.
   - Scope by protocol with a request matcher (`protocol http/1.1`; the exact matcher syntax needs checking against the Caddy docs and `caddy validate`).
   - Scope by method (POST/PUT/PATCH/DELETE), because only a request with an unread body leaves a socket worth closing.
   - Scope by a short status list (408, 413, early 401/403 on body routes), not all of 4xx/5xx.
2. h2 traffic keeps the plain `reverse_proxy`.
3. Before any of it is shipped, run the same stalled/trickling/early-refusal matrix three ways: baseline (no close) under h1, baseline under TLS/h2, and the scoped candidate under both. The h2 baseline is the one currently missing, and it tells us whether h2 needs any change.
4. Re-run the HTTP/1.1 keep-alive and consumer browser suite against the final candidate. The 37-pass browser run was on the old candidate over loopback HTTP.

### 2.3 Operator budget alignment (Reasoning from the documents)

`docs/DEPLOYMENT.md` documents `STYLE_BODY_READ_TIMEOUT_MS` (default 20000) as operator-tunable. The candidate hard-codes `read_body 22s` and `read_header 10s`. If an operator raises the app budget to 30 s, the proxy cuts at 22 s first and the client gets a dropped connection instead of the app's JSON 408.

- The proxy values must be derived from, or checked against, the app value, with a margin.
- The production Caddyfile has no global options block today. `timeouts` is a server option and needs one. Use a placeholder with a default (for example an env-fed value) and document the rule.
- Add a static test that fails when the proxy budget is not above the app budget.
- Do not copy the probe's loopback bind, workspace storage or disabled admin/persistence into deployment config.

### 2.4 Slow real uploads (Unverified)

I could not tell from the evidence whether the app's 20 s limit is an idle limit or an absolute one. The trickling probe was answered at about 20.2 s while bytes were still arriving, which suggests an absolute limit. Caddy's `read_body` is also an absolute cap. A 10 MB body over a weak mobile uplink can exceed 20 s. This was never tested on a slow link. Treat it as a phone-gate item: measure real upload times and decide whether the limit should be idle-based.

## 3. Evaluation harness

Claims in the documents that I checked against the code:

- **Strict geometry, no repair:** confirmed in `geometry.ts`.
- **One-to-one maximum matching:** `matching.ts` is correct by my reading.
  - Each edge costs `-(min(n,m)+1 + IoU)`.
  - One extra pair therefore outweighs any possible IoU gain.
  - Sub-threshold pairs are dropped after assignment.
  - Root's independent 1200-case exhaustive oracle agreement (Observed) is consistent with this.
- **Failure denominators:** confirmed in `scoring.ts`. Failed, timed-out, truncated, invalid and missing cases keep gold in recall, count error and the attribute coverage total. Precision is null with no scored prediction. Micro precision excludes failed images, and the report says so.
- **Direct-API bypass:** `refusalProblems` now revalidates every typed input (`evaluate.ts`, top of `refusalProblems`). The regression test `direct typed calls cannot bypass schema or contamination checks` exercises it.
- **CLI exit contract:** non-decimal `--iou` gives 1; an out-of-range decimal gives 2; neither writes output. Consistent with the README and the tests.
- **Overwrite guard:** exclusive-create (`wx`) in `writeNewJson`, plus an early existence check. The race window is closed by `wx`.
- **Image headers:** the JPEG/PNG parsers are bounds-checked. The hash, not the header, is the integrity check.

### 3.1 Defects and gaps, by severity

**Medium**

- **M1: Held-out validity rests on self-reported fields.**
  - `evaluate.ts` (the held-out block in `refusalProblems`) accepts `imageHashSource: "asserted-by-operator"` for held-out predictions. The saved-evidence adapter always writes that value and copies the fixture hash into the prediction, so the "wrong image" check is trivially satisfied for adapted runs.
  - Nothing compares gold `completedAt` with `run.startedAt`. Labels written after predictions were seen would pass.
  - Exact-hash contamination only: a re-encoded, resized or cropped copy of a development image is not detected. `KNOWN_DEVELOPMENT_SHA256` holds six entries.
  - **Fix:** refuse held-out scoring unless `imageHashSource` is `computed-by-runner` and every held-out `completedAt` is before `run.startedAt`. Add a visible report statement about near-duplicates. Keep an append-only log of held-out evaluations so a held-out set that has influenced tuning is retired to development.
- **M2: The orientation convention is declared but never enforced.**
  - Boxes are defined in the EXIF-rotated display frame (`README.md`, `types.ts`). `evaluate.ts` compares stored dimensions and EXIF tags only. The Qwen adapter assumes its native corners are in the display frame.
  - The `handbag` fixture has an EXIF orientation. Whether the model runtime applied it is not recorded, and the OWLv2 probe converts "to original display coordinates" without a stated orientation check.
  - **Fix:** add a declared `orientationHandling` to `RunInfo` and refuse fixtures with orientation other than 1 unless it is declared, or add a test fixture with a non-1 orientation.
- **M3: No sample size or uncertainty in the report.**
  - There are three development images and zero labels. The statements say "measurements, not an approval", but a rate from a handful of items still reads as a result.
  - **Fix:** put image and item counts next to every rate and add interval estimates. Fix the intended held-out size before any model run.

**Low**

- **L1:** `predictions.ts` coerces a non-string attribute to `null` without a problem, so a malformed attribute is silently reported as "not predicted". Gold labels reject the same input.
- **L2:** A typed caller with an uppercase hash fails closed with a misleading message. The cross-manifest map and the per-fixture comparisons use the raw string. The test `manifests reject unknown fields…` is named for an uppercase check, but its final assertion (`hashFor("a")` is already lowercase) exercises nothing.
- **L3:** The matching oracle lives only as a root probe. Port a small seeded comparison against exhaustive enumeration into `tests/visionEvaluation.test.ts`.
- **L4:** The scoring ignores `visibility` and `truncatedByFrame`. Heavily occluded closet garments count the same as fully visible ones, with no breakdown.
- **L5:** `report.inputs` records `path.basename` only. Two files with the same name in different directories look identical; the hash does disambiguate.
- **L6:** If a held-out manifest has fixtures but the predictions contain none of them, the run-start check is skipped. Every held-out case is then "missing" and the report still has a held-out section. Harmless, but it should say so.

### 3.2 What the harness cannot yet score (blocks the next model work)

- **No confidence field.** `PredictedItem` has no score, so a threshold choice such as OWLv2's fixed 0.2 cannot be swept and no precision-recall view is possible.
- **No place for declared transformations.** The OWLv2 research found 8 of 9 raw proposals slightly outside the frame (about -0.003 to 1.022). Under "any invalid item voids the case" with no clipping, every such case would score as `invalid_output`. A real adapter will need a documented, bounded tolerance and a recorded count of items it clipped or merged. The schema rejects unknown fields today, so this needs a deliberate schema addition. The tolerance must be chosen on development data and reported, not tuned on held-out data.
- **Alias duplicates.** The same box labelled `coat`, `trousers`, `dress` and `jacket` must not count as recall. The metrics already count extra boxes as duplicate false positives, which is the right behaviour. The adapter must state its alias policy rather than hiding it.
- **Gold labels come first.** There is no human gold anywhere, and several model experiments have now been judged by eye. Labelling the three development images and acquiring licensed held-out images should precede further model probing.

## 4. Diagnostics block (`deploy/Caddyfile`)

- The `@upload_counters path …` matcher and the `handle` ordering (block first, catch-all second, one `reverse_proxy`) are correct in the file as written.
- Observed (root): real Caddy on Windows over HTTP/1.1 returned 404 with no diagnostic body for exact, trailing-slash, query and percent-encoded forms, and `/` and `/api/health` stayed 200 with security headers. Not stated: whether the 404 carries the security headers.
- Not tested (Unverified): case variants, `//` and dot segments, `;` parameters, non-GET methods and the h2 `:path` form. I believe Caddy's `path` matcher is case-insensitive and cleans the path, but I have not verified either. Add these to the next root probe.
- The proxy is the only barrier for an unauthenticated counters endpoint. Cheap defence in depth is for the route itself to refuse requests that carry forwarding headers (Caddy adds them). I did not read the route source, so this is a suggestion only.
- **Test weakness (Reasoning).** `tests/proxyConfig.test.ts` line 92 uses `/ports:\s*\[?[^\n]*3000/`. A multi-line YAML `ports:` list with `3000` on a second entry would evade it. It passes today only because the proxy uses the one-line form. The other tests in that file are static text checks and say so.
- **Least privilege (Observed from `compose.yaml`).** The `proxy` service loads the whole `env_file: .env.production`, including SMTP and other app secrets, only to read `STYLE_DOMAIN`. Pass `STYLE_DOMAIN` through `environment:` instead.
- Linux, Docker and HTTPS remain unproven for this block.

## 5. Lock contention (G1)

Observed (root): the unchanged full suite failed. Worker child 6 spent 10145 ms and 57 attempts on its initial worker lease against a 10000 ms budget. Isolated, the same workload passed with instrumentation (685 transaction pairs, no lower-interval overlap above 2 ms, 765 broad upper overlaps).

Reasoning:

- The failure is not erased by the isolated pass. With no history of repeated full runs, a regression cannot be told apart from a flake, and no source change in 014 explains it.
- The lower interval starts after `BEGIN IMMEDIATE` returns and stops before `COMMIT`. It leaves out the commit itself, which on Windows with full sync may be the longest part of the hold. The finding that holds are "short" is therefore not established.
- The numbers point at waiting, not at long holds. Writers' lower intervals sum to 91 ms over 450 transactions, while their upper brackets sum to 28 s. 57 attempts in 10.1 s is about 178 ms per attempt, which looks like retry sleeps. If the lease retry sleeps while other processes retry tightly, the lease can starve by construction. I have not read the retry code, so this is a hypothesis.
- Windows file locking and fsync do not transfer to Linux/Docker. The compose topology is app, worker and mailer all writing to one SQLite volume, which is the shape of this test.

## 6. Next Claude implementation batch (015), in priority order

1. **Contention (G1).** Read the failing log, `concurrency-child.ts` near line 177 and the gate/lease code. Then:
   - Add timing that separates the `BEGIN` wait from the `COMMIT` duration, so hold time is measured instead of bracketed.
   - Remove avoidable work from write transactions (reads, validation, hashing before the lock).
   - Test whether the worker lease can leave the contended write path, for example in its own tiny lock file or database, or get fair queuing.
   - Do not raise the 10 s budget, shrink the stress counts or serialize the suite. Root should repeat the unchanged suite several times to record a flake rate.
2. **Transport redesign** per 2.2 and 2.3: the scoped candidate, global `timeouts` with a derived value, the static budget test, and probe scripts for root to run across h1 and h2. Keep it unshipped until both protocols pass.
3. **Harness hardening:** M1, M2, M3, L1, L2, L3, plus the `confidence` and declared-transformation schema additions from 3.2.
4. **Compose and test fixes:** the proxy environment, the stronger `ports` test, and the extra diagnostic-path probe cases.

## 7. Gates that stay open

None of these is closed by build 014:

- **G1 contention:** the full suite failed.
- **G5/G15** read and validation work.
- **G16–G20** evidence and cold startup (a cold-schema warning was observed in a probe; not a migration verdict).
- **G22** transport: h2 evidence contradicts the current proposal.
- Many-account slow-body saturation.
- Model correctness: no human gold, no held-out success, no app integration. Geometry-valid JSON is not recognition success. The OWLv2 probe produced 5 unique geometries from 9 proposals, with aliases and rack-wide regions and 37 s per image.
- SMTP with a real provider.
- Encrypted off-site recovery and physical retention.
- Target hosting, domain and trusted HTTPS.
- Docker and Linux execution.
- Real consumer phones. The browser runs were controlled AI, captured mail and a mobile viewport only.

No evidence in this build supports calling the product production-ready.
