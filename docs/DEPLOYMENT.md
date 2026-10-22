# Single-server launch deployment

Status: implementation and release review in progress. No public service has been provisioned or launched. The local account integration tests pass; this is not evidence of a tested internet deployment.

The chosen initial setup is one self-hosted server: Next.js, Better Auth, SQLite with WAL, a private photo store in the database, one Ollama worker, and Caddy for HTTPS. Software and model inference have no API fee. Hosting, electricity, a domain and mail delivery are separate operator costs; this is not a promise of permanently free public hosting. Ordinary users register, verify email, recover passwords and delete accounts without administrator assistance.

## Server requirements

Use a supported Linux server with Docker Compose, a persistent local disk (not an ephemeral filesystem or network-mounted SQLite file), and sufficient RAM for the 4B vision model. Begin with 16 GB RAM, 4 CPU cores and at least 30 GB free storage, then measure actual capacity. CPU inference is supported but may take minutes. Optional GPU acceleration needs a separately tested configuration. This release is one server, not an automatically scaling deployment.

The domain must point to that server and allow inbound ports 80 and 443. Only the proxy publishes ports. Keep the app, worker and Ollama internal. No model control API is exposed publicly.

## Configuration and first start

Create an untracked `.env.production` containing:

```dotenv
APP_URL=https://your-real-domain.example
STYLE_DOMAIN=your-real-domain.example
AUTH_SECRET=generate-a-unique-random-secret-at-least-32-characters
SMTP_URL=smtps://your-mail-provider-credentials@your-mail-host:465
MAIL_FROM=Style Studio <your-verified-sender@your-real-domain.example>
VISION_MODEL=qwen3-vl:4b-instruct
```

These are examples, not functioning credentials. Generate the secret privately and retain it in your password manager. Configure a real verified mail sender; test verification and recovery delivery to independent email providers. The public application refuses to initialize accounts without an HTTPS origin, an authentication secret and mail configuration. Its public mode is forced on in Compose.

**Proxy domain file (build 015 revision 2; the commands have not been run in Docker).** The `proxy` service no longer loads `.env.production`; it receives only `STYLE_DOMAIN`, so the public-facing container never holds `AUTH_SECRET` or the SMTP credentials. Docker Compose substitutes `${STYLE_DOMAIN}` in `compose.yaml` from the shell, from a `.env` file next to `compose.yaml`, or from `--env-file`; it does **not** take it from a service's `env_file`. So, once, in the directory that contains `compose.yaml` and BEFORE the commands below, create the domain-only Compose file from the template:

```sh
# Creates .env only if it does not exist yet. Never overwrites an existing .env.
[ -e .env ] || cp .env.compose.example .env
# Then edit .env so its single line reads STYLE_DOMAIN=<your real domain>,
# the same domain as STYLE_DOMAIN and APP_URL in .env.production.
```

`.env.compose.example` holds one non-secret variable (`STYLE_DOMAIN`, with a public placeholder value). Keep every secret in `.env.production`, never in `.env`. If a `.env` already exists on that machine for another purpose, do not overwrite it: use the `--env-file` alternative below. Compose reads `.env` in every shell and every version, so the later commands (including the restore procedure's `docker compose up -d` in a fresh shell) keep the same proxy domain.

```sh
docker compose build
docker compose up -d ollama
docker compose exec ollama ollama pull qwen3-vl:4b-instruct
docker compose up -d
```

**Alternative without `.env`:** put the flag on every compose command that can create or recreate the proxy, for example `docker compose --env-file .env.production up -d`. A command run without it (a new shell, the restore step) sees a different proxy configuration, recreates the proxy with an empty domain and, because of the guard below, leaves it restarting until you fix that. Prefer the `.env` file for that reason. `COMPOSE_ENV_FILES` (an environment variable that points Compose at env files) can do the same for one shell, but it lasts only as long as that shell, and the Compose version that first supports it is **not established** here; do not rely on it.

**Startup guard.** The proxy command first checks that `STYLE_DOMAIN` is non-empty and otherwise prints `STYLE_DOMAIN is not set` to its log and exits with code 1 before `caddy` starts, then runs the standard `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`. With `restart: unless-stopped` a missing value shows as a restarting proxy in `docker compose ps` and as that message in `docker compose logs proxy`. The guard has been written but **never run**. The `:-` default in `compose.yaml` is deliberate: with `:?` every compose command, including the documented `exec` and `run` recovery commands, would fail when the variable is missing. After the first start, check `docker compose exec proxy printenv STYLE_DOMAIN` (prints only the domain), `docker compose logs proxy`, and that the proxy answers on your domain before announcing the service. The guard checks that the value is non-empty, not that it is correct. `tests/proxyConfig.test.ts` reads `compose.yaml` and this guide as text and cannot show that Docker substitutes or Caddy starts.

Compose starts the app schema before serving requests. The worker and proxy wait for the app's authenticated-database health check. A shared, heartbeating filesystem lock serializes schema migrations across processes; three simultaneous cold-start processes have passed a local test. The worker and app share only their persistent account volume. The actual container cold start remains untested here because Docker is unavailable. An accidentally started second worker is prevented from claiming work by the database ownership lock.

## Release checks before inviting users

Create two real accounts using the public sign-up form. Verify their emails. Upload clothing, review the crops, save an outfit, then sign in from another browser and confirm the same private wardrobe appears. Attempt to access the other account's photo URL and confirm it is denied. Reset a password and confirm previous sessions stop working. Delete an account and confirm its active wardrobe and photos are removed. No administrator should be needed for these user flows.

Test concurrent uploads, cancellation, worker downtime and restart, and daily account limits. Verify HTTPS, secure cookies, proxy headers and unauthenticated responses on the actual domain. Measure queue time and inference time with the intended server. Run the automated checks and obtain Claude's independent review of the exact built source and evidence. Passing local tests does not replace these release checks.

## Runtime limits (build 007)

All are optional environment variables in `.env.production`; invalid or out-of-range values are ignored and the default is used. Defaults are conservative starting values, not measured capacity. The target-server load test must confirm or replace them, and Docker has not been run here, so `mem_limit` and `NODE_OPTIONS` in `compose.yaml` are untested starting points.

| Variable | Default | Meaning |
|---|---|---|
| `STYLE_MAX_UPLOAD_BYTES` | 2500000 | Largest decoded photo accepted (the app's own client sends a 1600 px JPEG, usually under 1 MB) |
| `STYLE_MAX_UPLOAD_SIDE` | 2400 | Longest side allowed, read from the file header before decoding |
| `STYLE_MAX_UPLOAD_PIXELS` | 6000000 | Raster size allowed, read from the header before decoding |
| `STYLE_BODY_READ_TIMEOUT_MS` | 20000 | A stalled upload is dropped after this |
| `STYLE_IMAGE_CONCURRENCY` | 2 | Process-wide photo reads/decodes at once (photo and analysis routes share it) |
| `STYLE_IMAGE_QUEUE` | 6 | Callers allowed to wait for a slot; more are refused with 503 and `Retry-After` |
| `STYLE_IMAGE_WAIT_MS` | 15000 | Longest wait for a slot |
| `STYLE_QUEUE_MAX_ACTIVE` | 20 | Queued + running analyses across all accounts |
| `STYLE_ANALYSIS_ESTIMATE_MS` | 120000 | Work time per photo for the displayed ETA, and a floor for admission (which also assumes at least the full inference timeout + 10 s). Measured recent durations (+25%, capped at the timeout) can only raise it |
| `STYLE_REVIEW_BUDGET_MS` | 600000 | A photo is refused unless its estimated ready time plus this review time fits inside its one-hour lifetime |
| `STYLE_INFERENCE_TIMEOUT_MS` | 240000 | Model request timeout |
| `STYLE_JOB_WATCH_MS` | 1000 | How often the worker checks a running job for cancel, account deletion or expiry |
| `STYLE_DAILY_ANALYSES` | 20 | Chargeable analyses per account per UTC day (refunds restore these) |
| `STYLE_DAILY_ATTEMPTS` | 40 | Accepted attempts per account per UTC day; never refunded, bounds refund abuse |

Set `STYLE_ANALYSIS_ESTIMATE_MS` from the measured p95 inference time on the target server. Admission is guaranteed against the worst case, not the estimate: each job ahead is assumed to take the full inference timeout plus 10 s (`max(estimate, STYLE_INFERENCE_TIMEOUT_MS + 10 s)`), while the ETA shown to users uses the estimate. With the defaults that is 250 s per job ahead and a 10-minute review budget, so a new photo is refused once 12 jobs are ahead of it (11 are admitted), well under the global cap of 20. The job lease is `max(10 min, inference timeout + 2 min)`. A job re-run after a worker crash waits for its lease and is not covered by the guarantee; if it then misses the hour it is expired and refunded.

## Backups and operations

Use `docker compose exec app ./node_modules/.bin/tsx scripts/backup-database.ts` for a consistent SQLite backup. Do not copy only the live `app.db` while WAL writes are in progress. The backup includes private account and photo data. **The software does not encrypt backups and does not copy them off the server**; both are operator responsibilities that are not implemented or tested in this repository. Protect the authentication secret separately, and perform a restore drill on an isolated server before launch.

Account deletion removes live records immediately (including queued account mail, by cascade) and records a pseudonymous deletion ID (internal user ID and time) for safe restoration. This is a logical delete, not a secure wipe: bytes can remain in unused database pages and in the write-ahead log until overwritten (secure-delete, WAL truncation and physical marker tests are future required work). The backup command retains local copies for seven days in `/data/backups` on the same volume as the live database, and strips temporary AI photos, queued account mail, reset tokens and session tokens from each copy; it still contains every saved account and photo as of its time. Apply the same seven-day limit to any off-server copies you make. **Restoring onto a fresh server without the live database is not supported yet** (the restore command refuses, because the deletion ledger lives only in the live database and in backups); exporting the ledger separately is future required work. Operator backups remain private and must never be exposed by the web server.

**How a backup is made (build 009).** One backup runs at a time per backups directory (the lock is an operating-system file lock held by the backup process on `backups/.backup-coordinator.db`, an empty database file that is never written to and is separate from the live database and its write gate; every process and container on the same local volume shares it; a second backup waits up to 30 s, then stops with a clear message). There is no lease, timestamp or "stale" rule: the operating system grants the lock to one process and releases it the instant that process ends, however it ends. So a backup busy in a long blocking step (VACUUM on a big database) keeps the lock however long it takes, and a backup that was killed or crashed frees it immediately, after which the next backup removes the dead process's partial. A backup that hangs forever (or a frozen process) keeps the lock until you kill it; others then time out with the clear message. **Keep `/data` on a local volume** (a Docker named volume or local disk): file locks on NFS/SMB are not reliable, and publication is also no-overwrite so a broken lock still cannot replace a completed backup. The empty `.backup-coordinator.db` stays in the backups directory between runs; do not copy it off the server. An old `.backup.lock` directory from the first 009 build is unused and can be deleted. The raw copy is first written to `style-<time>.<hex>.partial`, sanitised, vacuumed, integrity-checked, and only then renamed to a final `style-<time>.db` name that did not already exist; an existing backup is never replaced, and two backups in the same millisecond get `-1`, `-2` suffixes. **While a backup runs, and after a crash or kill, the `.partial` file exists and is not sanitised**: it holds temporary photos, queued mail, reset tokens and session tokens, unencrypted, in the private (0700) backups directory. It is never a restore source and never matches the retention rule. **Copy only `style-*.db` files off the server, never `*.partial*` or `.backup.lock`.** A failed backup deletes its own partial; the next backup deletes any partial a dead process left (it can do so safely because it holds the lock). If a partial cannot be deleted (permissions, a locked file) the backup command says so on stderr and exits with code 2 (or 1 for a failed backup); delete the named file by hand. Exit codes: 0 done, 1 failed with nothing published, 2 leftover file needs removing.

To restore, stop the app, proxy, worker and mailer, retain the latest live database containing deletion records, and run the restore command against a filename in the private backups directory. The command verifies database integrity, reapplies newer deletion records, removes temporary AI data and **all queued account mail (nothing stale is ever replayed)**, invalidates sessions and old mail tokens, **invalidates every sign-in password**, and only then replaces the stopped database. An isolated local drill has passed; repeat it on the target server before release.

**After every restore, every user must set a new password.** A backup holds the password hashes of its day; a password reset after the backup (a leaked password, say) would otherwise come back with it. The backup cannot say who changed a password, so all credential passwords are emptied in the restore transaction. Users choose a new one with "Forgot password" (the existing email link); **this needs working SMTP and a running `mailer`, so confirm both before telling users the service is back, and tell them to expect to use "Forgot password"**. Accounts, wardrobes and photos are kept. No password or secret is generated or printed. A restored user who tries to delete their account must reset their password first. Restoring onto a fresh server without the live database is still not supported (see above).

> **Build 010 supersedes two statements above.** Restoring onto a fresh server IS now supported, but only with a current deletion ledger (see "Deletion ledger and disaster recovery" below). Backups no longer fail silently on I/O errors: exit code 2 also covers a directory flush that hit a real I/O error (`BACKUP_W_DIR_SYNC_FAILED`) and a published backup whose partial name could not be removed.

### Main database connection unusable (build 016)

After a failed write whose rollback also fails, the app quarantines its main database connection and logs one line: `[database] main connection quarantined: outcome=<replaceable|unclosed|marked-only> count=<n>` (fixed text only; no SQL, path or user data).

- **`outcome=replaceable`**: the quarantined handle was closed and is eligible for reopen. This is **not** proof that a fresh connection is already in use: the next database call opens one, and if that fails (disk full, I/O errors) writes keep failing and `/api/health` still answers 200. Investigate if the count repeats.
- **`outcome=unclosed`**: the handle could not be closed. This process refuses every main-database access until it is restarted (wardrobe and photo writes fail), the stuck transaction may hold SQLite's write lock against the worker and mailer, and `/api/health` returns 503 `{"ready":false}`. The state is never cleared, even if the handle later closes; only a restart clears it.
- **`outcome=marked-only`**: the quarantined handle was not the current shared connection. It was marked quarantined, but **this call only marks it and does not close it**. The line says nothing about whether that handle was closed earlier, whether the shared connection was replaced, or whether the current connection is healthy. Treat a repeating count like `replaceable`: investigate.

**Plain Compose does not recover this.** `restart: unless-stopped` acts only when the process exits, so an unhealthy `app` is flagged but not restarted, and the current Caddy config has a plain `reverse_proxy` with no active health check, so it does not route around the 503. Alert on `app` unhealthy and on the log line above.

Action for `unclosed` (or a repeating `replaceable`):
1. Where practical drain first (let in-flight uploads and analyses finish); a restart cuts any request still running.
2. Restart the `app` service (`docker compose restart app`).
3. Inspect the `worker` and `mailer` logs for repeated busy or timeout errors; restart them if they are stuck. They have **no** equivalent unusable signal: the `worker` has no Compose health check at all, and the `mailer` health check (a heartbeat row) may stay green while its writes are blocked.
4. Confirm `/api/health` returns 200 and a test sign-in and wardrobe write work.
5. **Never** delete, move or copy the live `app.db`, `app.db-wal` or `app.db-shm` by hand.
6. Afterwards take a verified backup, record the incident (time, count, log lines) and, if it recurs, check the data volume is a local disk or Docker volume, not NFS/SMB.

Automatic recovery (an autoheal on the unhealthy status, or workers exiting after the current job) is not implemented and is an open owner decision.

## Account mail (build 008)

Verification and password-reset messages go through a durable outbox table (`mail_outbox`) and are sent by the separate `mailer` service (`scripts/mail-worker.ts`), supervised by Compose (`restart: unless-stopped`, health check via a heartbeat row). Web requests only insert a row; SMTP is never contacted by the web process or by the AI worker. Delivery is **at-least-once** (a crash after SMTP accepts a message but before the outcome is recorded sends it again; both copies share one Message-ID), not exactly-once.

| Bound | Default | Environment variable |
|---|---|---|
| Delivery window (message expires, body cleared) | 45 min | `STYLE_MAIL_WINDOW_MS` |
| SMTP attempts per message | 5 | `STYLE_MAIL_MAX_ATTEMPTS` |
| Backoff | 30 s × 4ⁿ⁻¹, capped at 20 min, +≤10 % jitter | `STYLE_MAIL_BACKOFF_MS`, `STYLE_MAIL_BACKOFF_CAP_MS` |
| Whole-send timeout | 45 s | `STYLE_MAIL_SEND_TIMEOUT_MS` |
| Per address and kind per hour | 4 | `STYLE_MAIL_PER_RECIPIENT_HOUR` |
| Per address per day (all kinds) | 12 | `STYLE_MAIL_PER_RECIPIENT_DAY` |
| Waiting plus sending, service-wide | 1000 | `STYLE_MAIL_MAX_PENDING` |
| Accepted per hour, service-wide | 600 | `STYLE_MAIL_MAX_PER_HOUR` |
| Metadata kept after delivery/expiry/failure | 24 h (no address, no body) | fixed |

**Worker health and shutdown (build 009).** The worker reports in from its own timer every `STYLE_MAIL_HEARTBEAT_MS` (10 s), whatever it is doing, but only while its loop keeps making progress; a process whose event loop is stalled, or a loop wedged for longer than one bounded step (send timeout + 3 s, or the 10 s claim budget, plus a 15 s margin), stops reporting. `--check` and the Compose health check call it healthy while the last report is younger than `STYLE_MAIL_HEALTH_FRESH_MS` (60 s, never below three beats). A long run of slow but progressing deliveries therefore no longer looks unhealthy. On SIGTERM (or SIGINT) the worker stops claiming, cancels the send in flight by destroying its SMTP socket, puts that message back in the queue (its attempt is not counted) with a short record budget (3 tries of 2 s), and exits; the worst legitimate case is about 16.5 s, anything still running after `STYLE_MAIL_SHUTDOWN_EXIT_MS` (25 s) is abandoned (exit code 1) and the row returns to the queue when its lease lapses, which can send it twice (at-least-once, as before). Compose gives the `mailer` service `stop_grace_period: 40s` and runs it as `node --import tsx` so node receives SIGTERM directly. Compose still does not restart a container only because its health check fails: alert on `unhealthy`. Not run in Docker yet.

| Bound (build 009) | Default | Environment variable |
|---|---|---|
| Heartbeat interval | 10 s | `STYLE_MAIL_HEARTBEAT_MS` |
| Health freshness window | 60 s (min three beats) | `STYLE_MAIL_HEALTH_FRESH_MS` |
| Outcome-record retries / budget per try | 8 / 5 s | `STYLE_MAIL_RECORD_RETRIES`, `STYLE_MAIL_RECORD_ACQUIRE_MS` |
| The same during shutdown | 2 / 2 s | `STYLE_MAIL_SHUTDOWN_RECORD_RETRIES`, `STYLE_MAIL_SHUTDOWN_RECORD_ACQUIRE_MS` |
| Hard exit after shutdown starts | 25 s | `STYLE_MAIL_SHUTDOWN_EXIT_MS` |

Operator commands (counts only; no addresses, bodies or tokens are ever printed or logged):

```sh
docker compose exec mailer node --import tsx scripts/mail-worker.ts --status
docker compose logs mailer
```

Alert on: `mailer` unhealthy or restarting, `oldestPendingAgeMs` above about ten minutes, and `failed`/`expired` counts rising. The sign-in and reset screens tell users that mail can take a few minutes and is limited to four per hour per address; if you change those bounds, update the copy in `src/components/AuthScreen.tsx`. Real SMTP relay behaviour (provider limits, SPF/DKIM/DMARC, bounces) is **untested**: no real relay or credentials have been used.

## Deletion ledger and disaster recovery (build 010)

**Why a separate ledger.** A restore must delete again every account that was deleted after the backup, or that person's wardrobe and photos come back. The live database knows (its `account_deletions` table). A new server does not, and a ledger saved only at backup time cannot know about later deletions. So the ledger is a separate, continuously maintained file, `/data/ledger/deletion-ledger.json`: internal user ids and deletion times only, a few bytes per deleted account, append-only, with a format version, a generation counter, an export time and a SHA-256 checksum.

**How it is kept current.**
- the `mailer` rewrites it about once a minute when the database has a deletion the file lacks (and at least every 15 minutes, so its export time stays recent);
- every `scripts/backup-database.ts` run rewrites it after the backup (so its export time is later than the backup);
- `docker compose exec app ./node_modules/.bin/tsx scripts/export-deletion-ledger.ts` writes it on demand. Run this from cron immediately before you copy the file off the server.

**What the software does NOT do.** It does not copy the ledger anywhere. The file is on the same volume as the database, so it only protects you after a total loss of the volume if **you copy it off the server, separately from the backups and much more often** (every few minutes is cheap; the file is tiny). The age of the last off-server copy is the recovery point for deletions: accounts deleted after it was copied come back on a restore from a fresh server, and the restore tells you the ledger's export time so you can delete them again. Keep the copy where only the operator can write; the checksum detects truncation and accidental edits, it is not a signature.

**Choosing the ledger for a disaster recovery.** Use the newest copy you have. The restore refuses a ledger that is damaged or not a ledger, that was exported before the backup was made, or that is older than `STYLE_RESTORE_LEDGER_MAX_AGE_HOURS` (default 24) unless you set `STYLE_RESTORE_ACCEPT_STALE_LEDGER=true` knowing which deletions you may lose. A restore with no live database and no ledger is refused outright.

**Process coordination.** Every application process that opens the live database (app, AI worker, mailer, the backup and ledger commands) holds a shared lock on `/data/.process-presence.db` while it does. The restore takes an exclusive claim on that file first, so an idle running service makes it refuse (`RESTORE_E_ACTIVE`) before anything changes; a crashed or killed process never blocks it (the operating system releases the lock). A starting service waits at most a few seconds while a restore runs and then fails; the supervisor restarts it. This covers this application's own processes only: stop everything, including any shell or script of your own that opens `app.db`. It assumes a local volume, like the backup lock.

### Restore procedure

Restore into the **same** server (live database present) or a **fresh** one (empty data volume). In both cases:

1. Stop everything that uses the volume: `docker compose stop proxy worker mailer app`.
2. Fresh server only: put the backup file in `/data/backups/` and the newest off-server ledger copy somewhere readable; the server needs the same `.env.production` (including `AUTH_SECRET`).
3. Run the restore (the exit code is 0 done, 1 refused or failed with the existing database unchanged, 2 restored with a warning):

```sh
# same server, live database present (uses its account_deletions, plus /data/ledger when valid)
docker compose run --rm -e STYLE_RESTORE_CONFIRMED=true app ./node_modules/.bin/tsx scripts/restore-database.ts style-YOUR-BACKUP-TIMESTAMP.db

# fresh server: the ledger is REQUIRED
docker compose run --rm -v /path/to/ledger-dir:/ledger:ro -e STYLE_RESTORE_CONFIRMED=true app ./node_modules/.bin/tsx scripts/restore-database.ts style-YOUR-BACKUP-TIMESTAMP.db --ledger /ledger/deletion-ledger.json
```

4. `docker compose up -d`. Before announcing the service: confirm SMTP works (the `mailer` is healthy and `--status` shows no growing `failed` count), and tell users to choose a new password with "Forgot password".

If a live database is present and a `/data/ledger/deletion-ledger.json` exists but is damaged, the restore stops (`RESTORE_E_LEDGER_INVALID`); pass `--ledger` with a good copy, or move the damaged file away. If the live database cannot be opened (`RESTORE_E_LIVE_UNREADABLE`), move `app.db` aside deliberately and restore as a fresh server. Diagnostics are fixed codes (`RESTORE_E_*`, `RESTORE_W_*`) without paths or ids.

The restore builds its replacement in a unique owner-only staging file (`app.db.restore-<hex>.pending`) in `/data`, verifies it completely (integrity, the application's tables, relationships), and only then replaces `app.db`. Any failure removes the staging file; a crash leaves it, and the next restore removes leftovers of that exact name pattern. Not run in Docker yet; local drills on Windows only.

**Backups and client addresses.** Completed backups and restores also empty Better Auth's rate-limit table, whose keys contain client IP addresses.

**Large databases.** The online backup copies in one step (`BACKUP_PAGES_PER_STEP`), because SQLite restarts a stepwise backup whenever another process writes to the source and the services write every few seconds. `tests/backupLarge.test.ts` measures a 300 MB database with a separate writer; run it on the target host (`STYLE_LARGE_BACKUP_TEST=1`). Not yet measured.

**Upload bounds (builds 012-013).** Every request body is read under an absolute 20 s deadline (`STYLE_BODY_READ_TIMEOUT_MS`, 1 s to 120 s) that progress does not extend, and a size cap: 32 KiB for account requests, 3,000,000 bytes for `PUT /api/wardrobe`, and the photo limit for `/api/photos` and `/api/analyze`. The wardrobe ceiling therefore needs about 1.2 Mbit/s sustained to finish inside 20 s; a slower upload gets a `408`, uses one of the 120 changes per minute, writes nothing, and the app keeps the user's unsaved items and shows the server's message so they can press save again. A signed-in account may have only one photo or analysis upload in flight at a time (shared by `/api/photos` and `/api/analyze`); a second gets a `429` with `Retry-After: 3` and `code: "upload-in-progress"` before it can take an image-processing slot, and the app repeats a refused photo upload a few times. Different accounts do not block each other except through the shared, unchanged image slots (`STYLE_IMAGE_CONCURRENCY`, `STYLE_IMAGE_QUEUE`, `STYLE_IMAGE_WAIT_MS`), so many accounts can still fill those slots. `GET /api/health/uploads` returns aggregate integers only (global image slots, how many accounts hold an upload, and per fixed route how bodies ended, how stream cancels ended, and how often a second upload was refused); it has no identifiers and, like `/api/health`, no authentication, so the shipped `deploy/Caddyfile` answers `404` for `/api/health/uploads` (and anything below it) by default (build 014); the route itself is unchanged and stays reachable on the internal `app:3000` address. Operators read it from inside the container, for example `docker compose exec app node -e "fetch('http://127.0.0.1:3000/api/health/uploads').then(r=>r.text()).then(console.log)"`, and should keep it off the public proxy; removing the `@upload_counters` block publishes the totals, which show when image slots are saturated. The block is covered by a static text test only (`tests/proxyConfig.test.ts`); Caddy and Docker have not been run. These counters reset when the process restarts and are per process.

Monitor disk space, memory, mail failures (`mailer` health and `--status` counts), worker heartbeat and queue saturation. Never log passwords, verification links, session tokens, wardrobe photos or AI image payloads. Keep server patches and container digests under review. This folder does not contain a purchased domain, hosting account or mail-provider account; those external setup steps remain outstanding.
