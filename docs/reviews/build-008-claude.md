# Build 008 independent review (Claude)

Reviewer: Claude, second reviewer. Date: 12 October 2026.
Subject: `release-snapshots/build-008` (124 hashed source/config/test files per `SOURCE_MANIFEST.json`; root states zero hash changes after the final rebuild, BUILD_ID `wLWWk2aqUigZHF46vyzpE`).
Method: static reading only (Read/Glob/Grep). I ran no build, test, browser, server or network call. I did not open `.data`, `.runtime`, `.env`, secrets or photos. Every runtime statement comes from root's evidence or from reading code. To judge the SMTP path I also read the *installed* `nodemailer` 10.1.0 and `better-auth` 1.7.7 sources in the main `node_modules` (read-only). I did not verify they match the lockfile byte for byte.

Labels: **[Code-proven]** follows from code I read. **[Test-shown]** a snapshot test asserts it (read, not run by me). **[Hypothesis]** needs the named test. **[External gate]** needs real-world evidence.
Paths are relative to `release-snapshots/build-008`.

Read in full: `REVIEW_EVIDENCE.md`, `FINAL_BUILD_EVIDENCE.md`, `ROOT_REVIEW_OBSERVATIONS.md`, `implementation-008-notes.md`, `mail.ts`, `mailOutbox.ts`, `auth.ts`, `database.ts`, `limits.ts`, `scripts/mail-worker.ts`, `backup-database.ts`, `restore-database.ts`, `packaging-rules.ts`, `packaging-sanitize.ts`, `compose.yaml`, `Dockerfile`, `.dockerignore`, `package.json`, `tests/backup.test.ts`, the mock-relay half of `tests/mailOutbox.test.ts`. Read by search only: README, DEPLOYMENT, the account/upload/auth copy.
**Not read, so no claim made:** `packaging.test.ts`, `migration008.test.ts`, the second half of `mailOutbox.test.ts`, `verify-standalone.ts`, `ci-docker-smoke.ts`, `ci.yml`, `Caddyfile`, queue/vision/wardrobe code (untouched by 008 per the notes).

---

## 1. Verdict

**Not ready for public launch. I agree with root's "not approved".**

- Batch 008 did what it set out to do at code level: durable account mail, honest deletion copy, a physical packaging boundary.
- It also changes nothing for the 007 launch blockers it excluded: dense wardrobe, physical erasure, fresh-server restore, offsite encrypted backup, and every external gate.
- I found **two new P1 defects in the backup/restore path** (§3.1, §3.2). Neither needs Docker or SMTP to fix.
- The root heartbeat finding is **confirmed** (§4.1) and has a second, related defect in the same loop (§4.2).
- The custom SMTP socket path looks correct by reading, but no test has run TLS, STARTTLS or AUTH (§5).
- The P0 SMTP crash stays rejected. Root's probe disproved it; I re-read Better Auth `create-context.mjs` 215-224 and it catches and logs. In 008 the callback is awaited and caught the same way.

**Suggested status:** unchanged from 007. A closed, invite-only technical beta with the team on a real SMTP relay is reasonable once batch C (§8) is done. Anyone outside the team should wait for at least partial recovery of dense photos.

---

## 2. 007 items: closed, reopened, still open

| 007 item | 008 status | Basis |
|---|---|---|
| §4.3 detached mail has no durability | **Closed at code level** | Outbox, lease, backoff, expiry, per-recipient caps, no SMTP in requests. [Code-proven][Test-shown]. Real relay, TLS, bounces: [External gate]. New defects in §4. |
| §4.4 deletion copy overstates | **Closed (copy only)** | `AccountDialog.tsx:100-109`, `UploadDialog.tsx:581-588` now say "not a secure wipe", backups unencrypted, 7 days. Matches code. |
| §4.4 physical erasure | **Open, unchanged** | No `secure_delete` or WAL truncate on the live DB (`database.ts`, only the backup copy sets it). |
| §4.2 fresh-server restore, ledger export | **Open, unchanged** | `restore-database.ts:20-23` still throws without a live `app.db`. Nothing produces a ledger. Lines 24-47 are now dead-code-shaped (`existsSync` already true). |
| §4.1 dense wardrobe | **Open, unchanged** | Root's own new fixture timed out at 240 s with zero items. |
| §5.5 packaging gate thin | **Closed at code level, with residuals** | `realpath` boundaries, exclusive temp manifest, junction canaries, trace-derived dependency closure, isolated-startup check. See §6. Docker not run. |
| §5.1 timeout refund | **Open** (not touched) | |
| §5.2 ETA/timeout headroom | **Open** | |
| §5.3 lost response then edit | **Open** | |
| §5.4 save retries re-upload | **Open** | |
| §5.6 free-text brand/material | **Open** | |
| §5.7 GET takes write lock | **Open**. 008 adds one more write per unverified sign-in (`enqueueMail` fallback). | |
| §5.8 compose: shared secrets, CSP, model readiness | **Open**; SMTP secret scope is now worse relative to need (§4.4). | |
| §6 autocommit lock-hold test | **Not addressed.** | |
| Build-007 "reopened" items | None reopened as regressions. | |

---

## 3. Confirmed P1 defects (new or newly visible)

### 3.1 P1: restoring an old backup revives credential hashes revoked after the backup [Code-proven; no test]

This is the case root asked me to assess.
- The backup keeps the `account` table, including credential password hashes (`backup-database.ts:18-34` deletes only `analysis_jobs`, `mail_outbox`, `verification`, `session`).
- `restore-database.ts:56-80` re-applies only deletions from the live `account_deletions` table, then clears jobs, sessions, `verification` and mail.
- Sequence: backup at T0, user resets a compromised password at T1 (Better Auth `revokeSessionsOnPasswordReset`, `auth.ts:138`), disaster, restore the T0 file. The T0 hash, which the attacker may know, is live again. Clearing sessions and reset tokens does not help: the attacker signs in with the old password.
- It also revives `emailVerified` state and any rate-limit state of that age. The password is the serious one.

**Fix (smallest safe, matches root's "force self-service recovery"):** inside the restore transaction, make every credential unusable: set `account.password` to a fresh random, unmatchable value (or NULL if a sign-in test shows Better Auth rejects it cleanly) for `providerId='credential'`. Users then use the existing email reset flow. Better Auth `resetPassword` updates or creates the credential row (`password.mjs:165-167`), so the flow still works. The restore message must tell the operator that all users must reset and that real SMTP must be up.
**Later refinement:** a `credential_changes(user_id, changed_at)` ledger exported next to the deletion ledger, so only users who changed their password after the backup are forced to reset.

**Smallest test:** sign up, back up, reset the password, restore the old backup. Assert (a) the old password is refused, (b) the new password is also refused, (c) the reset flow works and sets a working password, (d) a user who never reset is also forced to reset until the refinement ships.

### 3.2 P1 (small fix): an unsanitised backup is left under its final name if sanitising fails [Code-proven]

- `backup-database.ts:18` writes the raw copy to `style-<ts>.db`, then lines 21-34 delete photos, jobs, sessions, tokens and mail and `VACUUM`. The `main().catch` at 47 prints a message and sets the exit code. It never removes the half-processed file.
- The leftover name matches the restore pattern and the retention pattern (`/^style-[0-9TZ.-]+\.db$/`). It holds the temporary analysis photos, live session tokens, reset tokens and queued mail bodies, unencrypted, for 7 days, and any offsite copy job picks it up.
- Realistic triggers: `VACUUM` needs roughly twice the file size in free disk (a small VPS with a photo-heavy DB), a kill, or a locked copy. If the raw copy is in WAL mode (the backup API copies the header), a crash can also leave a `-wal` beside it.
- The README and UI claim "backups never include temporary photos". That is false in this case.

**Fix:** back up to `style-<ts>.db.partial` (not matching the restore or retention patterns), sanitise, run `integrity_check`, close, then `rename` to the final name; on any error delete the partial and its sidecars. Prune old backups only after success.
**Smallest test:** inject a failure after `backup()` (for example a read-only copy or an env fault hook) and assert no `style-*.db` exists and no photo bytes remain in the backups directory.

### 3.3 P1 (carried, unchanged): fresh-server restore and ledger export
Same as 007 §4.2. Restore requires the live DB (`restore-database.ts:20-23`), the error text says a ledger is needed, and no command writes one. There is still no scheduled or encrypted offsite backup. Listed as required in §8 batch C.

---

## 4. Mail findings

### 4.1 P2: heartbeat is outer-loop only, so a healthy slow worker reports unhealthy [Code-proven; root finding confirmed]
- `mail-worker.ts:60-67` touches the heartbeat once per outer pass. Lines 71-74 then run up to 20 `processNextMail()` calls back to back. `HEALTH_FRESH_MS` is 60 s (line 28).
- One send is bounded at 45 s (`limits.ts:83`), plus up to a 3 s abort grace for a non-cooperating sender (`mailOutbox.ts:350`), plus the outcome record, which can retry up to 8 times at 5 s acquire plus 0.5 s sleep (`mailOutbox.ts:431-448`). A single slow-relay message nears the limit; two exceed it. Twenty slow sends can go roughly 15 minutes with no heartbeat.
- Effect: during a relay slowdown, when the worker is making progress, `--check` fails. Compose does not restart on unhealthy, so nothing is killed, but any alert on that signal is wrong in exactly the situation operators care about. The reverse failure is also possible: a loop truly wedged between heartbeats looks healthy for up to 60 s only, which is fine.
- `compose.yaml:78-84`: the check starts a second `tsx` process that imports the whole auth stack in a 512 MB container; its cost on the target host is unmeasured.

**Required behaviour (no implementation in this review):** heartbeat progresses independently of sends (a timer in the worker process, or a touch before and after each message), and the freshness bound must cover the longest single send plus record plus contention. Alerting should also use oldest-pending age, which `--status` already reports.
**Regression test required:** run the real `scripts/mail-worker.ts` as a child against the fake relay in `hang` mode with at least 3 queued messages. Sample `--check` every 5 s for 3 minutes and assert it stays healthy; then freeze the process (SIGSTOP or an injected infinite loop) and assert it turns unhealthy within the bound. Exercise the real loop, not `processNextMail` alone.

### 4.2 P2: shutdown cannot cancel a send, and compose gives 10 s [Code-proven for the loop; compose behaviour Hypothesis]
- SIGTERM only sets `stopping` (`mail-worker.ts:31-36`). `processNextMail` takes no external signal (`mailOutbox.ts:407`), so an in-flight send runs to its 45 s deadline. Docker's default stop timeout is 10 s and `compose.yaml` sets no `stop_grace_period`. The container is then SIGKILLed mid-send. The row stays `sending` and is re-sent after the 105 s lease, which is the documented duplicate case, now triggered by every deploy that happens during a send.
- **Fix:** pass a shutdown `AbortSignal` into `deliverWithDeadline`; on SIGTERM, abort, record `queued` with code `timeout` (or leave it for lease reclaim), exit. Set `stop_grace_period` above the longest bounded record step.
- **Test:** SIGTERM the real worker during a `slow` send; assert exit within N seconds, the relay saw the close, and the row is `queued` with `attempts` unchanged apart from the claim.

### 4.3 P2: silent drops can be exhausted by an attacker and are invisible to operators [Code-proven; capacity Hypothesis]
- Global bounds are 600 accepted per trailing hour and 1000 pending (`limits.ts:111-113`, `mailOutbox.ts:117-128`). Better Auth's per-IP sign-up limit is 5 per minute (`auth.ts:175`), so two or three IPs can create 600 unverified accounts to throwaway addresses in an hour. From then on legitimate verification and reset mail is dropped silently. The responses stay generic by design, and the UI says "on its way" (`AuthScreen.tsx:32,44`).
- The only signal is a log line with a reason code and no counter in `--status` or `/api/health`.
- **Fix, bounded:** persist drop counts by reason (a small table or counters) and print them in `--status`; reserve a share of the hourly budget for reset and for resends to existing accounts; cap sign-up-triggered mail separately from reset mail. Soften the copy where it says "is on its way".
- **Test:** fill the hourly cap with sign-up mail and assert a reset for an existing verified account still queues and the drop counter increments.
- Lower risk, **[Hypothesis]**: an attacker who knows a victim's address can use up that address's 4 per hour per kind. The mails that were queued still reach the victim, so this delays rather than blocks recovery.

### 4.4 P2: SMTP credentials are still given to containers that do not send mail [Code-proven; 007 §5.8 carried]
- `compose.yaml:5,46,66,101`: `env_file: .env.production` goes to `app`, `worker`, `mailer` and `proxy`. After 008 only `mailer` speaks SMTP, but all four receive `SMTP_URL` (with credentials) and `AUTH_SECRET`. The web process still needs a "mail configured" check (`mail.ts:42-47`, called from `auth.ts:104`), which is why it holds the URL. Split that check from the credential, and give `proxy` no env_file.

### 4.5 P3 mail items
- **One sequential sender.** `mail-worker.ts:71-74`: a relay that takes 45 s per message handles about 80 messages an hour against a 600 per hour admission cap, and the 45-minute window then expires the rest. Allow 2-3 concurrent sends or a circuit breaker. Wait for real-relay latency numbers first.
- **Expiry relies on the mail worker.** `sweepMailLocked` runs only inside `claimNextMailLocked` (`mailOutbox.ts:216,250`). If the mailer is down, addresses and one-time links stay in `app.db` past their 45 minutes. Add a sweep to a web-side tick or document it.
- **`recipient_key` is an unsalted SHA-256 of the address** (`mailOutbox.ts:68`). It is kept 24 hours after the address is cleared and can be reversed by dictionary. Use an HMAC with a key derived from `AUTH_SECRET`.
- **Sign-up atomicity is only partly proven**, as the notes admit. I read `sign-up.mjs:144-250`: `createUser`, `linkAccount`, then the awaited callback sit inside `runWithTransaction`, and `runInBackgroundOrAwait` catches any callback error (`create-context.mjs:215-224`). So an enqueue failure leaves a user with no mail, as documented. A failure *after* the callback should roll back both. **Test required:** make a step after the callback fail (for example an after-hook that throws) and assert no user, no credential and no mail row remain. A1 (the ALS probe) is indirectly supported because the passing account tests would stall for 10 s and drop mail if it failed; that is inference, not a direct assertion of which connection was used.
- **Local capture in a public-looking deployment.** With `STYLE_PUBLIC_DEPLOYMENT` unset and no `SMTP_URL`, mail is written to disk and never sent (`mail.ts:30,283`), whatever `APP_URL` says. Not new.

---

## 5. SMTP socket, STARTTLS, SMTPS and URL options

**Per-send abort lifecycle: sound by reading. Root's `Promise.race` defect is genuinely fixed for the real path.**
- `nodemailer.js:60-76` merges the object's other keys with the parsed `url` (URL wins where it sets a key), so `getSocket` and the explicit timeouts survive `createTransport({ url, … })`.
- `smtp-transport/index.js:147-165` calls `getSocket` per send and merges `connection` and `secured` into that connection's options. `smtp-connection/index.js:252-268` then skips its own connect and uses our socket. For STARTTLS, `_upgradeConnection` (`1085-1111`) wraps our plain socket with `tls.connect({ socket })`, so destroying the tracked plain socket tears down the TLS wrapper's transport.
- `mail.ts:132-178`: sockets are tracked after connect (no microtask gap with the abort timer); abort destroys all, a failure destroys all again, `transport.close()` plus a 2 s unref'd straggler destroy; `ABORT_GRACE_MS` is only a seam backstop. Per-attempt transports share nothing. `parseConnectionUrl` sets `secure` from the protocol and does not let a query override it (`shared/index.js:328-337,380`), which matches `mail.ts:131`. Default ports agree (587 plain, 465 secure).
- Abort after the relay has the full body can still deliver: the documented at-least-once case. I agree the tests assert it rather than hide it.

**What is not proven, and what differs from plain nodemailer** (all **[Hypothesis]** until tested):
1. **No TLS, STARTTLS or AUTH has run anywhere.** The fake relay in `mailOutbox.test.ts:43-112` is plain TCP: no `STARTTLS` or `AUTH` advertisement, no TLS server. Root agrees. The `smtps` branch (`openSocket`, `mail.ts:74-80`) and the STARTTLS upgrade on a pre-opened socket have zero execution evidence. DEPLOYMENT line 21 recommends `smtps://…:465`, the path with the least coverage.
2. **`smtps://` ignores TLS and socket options in the URL.** Our own `tls.connect({ host, port, servername })` skips `?tls.servername`, `?tls.minVersion`, `?servername`, `localAddress`, `family` and nodemailer's DNS handling and timeouts. A relay whose certificate name differs from the connect host fails closed (cert error), which is safe but silent in the config. STARTTLS keeps `options.tls` (`smtp-connection/index.js:1085-1088`), so the two modes behave differently. Either pass the parsed `tls` options through or document and reject them.
3. **Nothing forces TLS.** `assertMailConfigured` (`mail.ts:42-47`) accepts `smtp://host:25` with credentials. Without `requireTLS=true`, a network attacker who strips `STARTTLS` from the EHLO reply gets the AUTH credentials in cleartext (nodemailer upgrades only if offered). In public mode require `smtps://` or `requireTLS=true`, and refuse a plaintext relay unless an explicit override is set.
4. **Cert validation relies on defaults** (`rejectUnauthorized` true). That is right, but no test shows a bad cert is refused.
5. DNS and connect now use the OS resolver via `net.connect` with the 10 s timer instead of nodemailer's resolver. Fine, but behind IPv6-broken hosts the behaviour is untested.

**Tests required (local TLS relay with a throwaway CA trusted through `NODE_EXTRA_CA_CERTS`):**
- smtps happy path with AUTH PLAIN/LOGIN and a received message;
- smtps with a certificate for the wrong name is refused and the code is `conn` or `error`, not `sent`;
- STARTTLS happy path with AUTH; STARTTLS stripped with `requireTLS=true` is refused before AUTH is sent; stripped without it is refused by the new startup guard;
- abort during the TLS handshake and during the STARTTLS upgrade: the relay sees the close, no reconnect;
- `?tls.servername=` on `smtps://` either works or is rejected at startup.
Then the real provider run (§7).

---

## 6. Packaging boundary (accepted with residuals)

Reading `packaging-rules.ts` and `packaging-sanitize.ts`: the physical checks do what the notes claim. `.next` and `.next/standalone` must be plain directories whose `realpath` equals the lexical path; every manifest is validated before any write; the temp manifest uses an unpredictable name, `wx` create and a same-folder rename; deletions go through `assertSafeToTouch`; links are removed as links; dependency closure is derived from the build's own traces rather than a hand list. Root's evidence (10 pass, 1 skip, decoy and junction canaries, isolated standalone start without ancestor `node_modules`, sharp upload and download) supports this. **007 §5.5 is closed at code level.**

Residuals, none blocking:
- **P3:** a stale `*.sanitizing` file left by a crash is not reported by `collectPackagingProblems`. It holds paths only. Report it.
- **P3:** `entries()` does not look inside `node_modules` (`packaging-rules.ts:213`), so a private file name placed there would not be flagged. The isolated-startup run is the real guard.
- **P3:** `tracedPackages` can only demand what the tracer lists; a package loaded by `tsx` workers comes from the Docker `node_modules` overlay, which nothing here checks.
- **Not verified:** the Linux excludes, `COPY . .` followed by the sanitiser inside Docker, `tsx` as the non-root user, and the CI Docker job. All **[External gate]**.
- The windowed copy of real `.data` into `.next/standalone` before the sanitiser runs (007 §5.5) is unchanged. `.dockerignore` keeps `.data` out of the Docker build context.

---

## 7. Evidence limits and external gates

- Root's results are the only execution evidence. Backend 61 pass, 1 skip ran before the final mail correction; the final mail suite (14) and packaging (10 pass, 1 skip) ran after; browser tests (31 pass, 1 skip) ran against the earlier compiled bundle. These overlap and must not be summed. The final rebuild and isolated startup passed.
- The mail tests are meaningful for socket cancellation, retries, isolation and cleanup, but they use a plain fake relay. They are not TLS, AUTH or provider evidence.
- `tests/backup.test.ts` covers one happy path with one canary. It has no failure path (§3.2), no credential-revival case (§3.1), no fresh-server case (§3.3).
- **Absent, unchanged:** Docker run, real SMTP and SPF/DKIM/DMARC deliverability, target host and TLS, capacity, recognition benchmark on a held-out set, real-phone consumer tests, offsite encrypted backup and recovery drill, monitoring and alerts, privacy and terms.
- **Dense wardrobe:** the natural-closet development fixture timing out at 240 s with zero items means the core "whole wardrobe photo" promise has no passing evidence at all. That file is a development fixture, not a held-out benchmark.
- **Physical deletion, free pages, WAL:** unresolved. The 008 copy is honest about it. The backup copy is vacuumed with `secure_delete`; the live database never is.

---

## 8. Bounded next implementation batch (batch C)

Keep C small and independent of the vision work:
1. **C1 mail worker health and shutdown** (§4.1, §4.2): independent heartbeat, abortable shutdown, `stop_grace_period`, the two real-loop tests.
2. **C2 backup atomicity** (§3.2): partial file, sanitise, verify, rename, cleanup; failure-injection test.
3. **C3 restore safety** (§3.1, §3.3): force credential reset on restore, deletion-ledger export written by the backup command, fresh-server restore taking the ledger file, tests for revoked-password and deleted-after-backup on an empty data dir. Leave the later `credential_changes` ledger as a follow-up.
4. **C4 SMTP hardening and proof** (§5, §4.4): require `smtps://` or `requireTLS=true` in public mode, decide the `smtps` URL-options policy, local TLS relay tests, split secrets so only `mailer` holds `SMTP_URL`.
5. **C5 drop visibility** (§4.3): persisted drop counters in `--status`, reserved budget for reset, softened copy.

Then separate batches: **D** dense wardrobe (salvage, compact schema, tiling, 10/20/30 fixtures, timeout and refund policy), **E** physical erasure (`secure_delete`, checkpoint, vacuum, temporary photos off `app.db`, marker-byte test), **F** save robustness and read paths (007 §5.3, §5.4, §5.7).

## 9. Independent launch verdict and tests still needed

**Not approved for public launch.** I will re-review after batch C plus a clean target-host run.

Tests still needed before I would approve:
- every test named in §3, §4.1-4.3 and §5, passing and run by root;
- the dense-wardrobe fixtures from 007 §9 on the target host;
- a restore drill on a clean machine with the ledger and a post-backup password reset and deletion;
- Docker build and cold start including `mailer`, the worker round trip and the mail health check;
- real SMTP to two providers with SPF, DKIM, DMARC and a blocked-relay case;
- target-host capacity, real-device consumer acceptance, monitoring and policy items from 007 §7.

Code-only review is not execution evidence. Nothing in this document should be read as a pass of any test I did not see root run.
