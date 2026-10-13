# Style Studio

Upload clothing photos, review the detected items, and make everyday or event outfits from clothes you own. The application now uses verified private accounts, server-backed wardrobes and photos, and a durable queue running free Ollama vision inference. Ordinary users do not need administrator approval to register, recover passwords or delete their accounts.

**Release status: under implementation and independent Claude review. Not publicly launched or certified production ready.** Account isolation and wardrobe workflows have passed local tests; the public hosting, domain, SMTP delivery, container deployment and capacity checks remain unverified. See [deployment instructions](docs/DEPLOYMENT.md) and the actual review records in `docs/reviews`.

## Local development

Use Node.js 24.20 or newer within the Node 24 LTS line. Install dependencies, initialize the account schema, start Ollama, and run the app and worker in separate processes:

```powershell
npm ci
npx tsx scripts/init-auth.ts
ollama pull qwen3-vl:4b-instruct
npm run dev -- --hostname 127.0.0.1
npx tsx scripts/analysis-worker.ts
npx tsx scripts/mail-worker.ts
```

The mail worker is optional in development without `SMTP_URL` (the web process captures mail itself) and required whenever `SMTP_URL` is set.

Keep Ollama on `127.0.0.1:11434`. This workspace already has the Windows runtime and model in `.runtime`; `scripts/start-local.ps1` is a local launcher. Never run a production build while a development server is using the same `.next` directory.

The canonical local app URL is `http://127.0.0.1:3000`. Development verification and recovery emails are captured privately under `.data/mail-outbox`; this is developer test infrastructure, not a production mail service. Configure SMTP and a verified sender before testing real users. No passwords, secrets or mail links should be shared in chat. `.data`, `.runtime` and environment files are excluded from source control.

## Consumer behavior

Start with a clear single-item photo or several separated garments. The app shrinks each photo in your browser before upload; the server accepts only JPEG, PNG or WebP up to 2.5 MB, 2400 px on the longest side and 6 million pixels (configurable, see the deployment guide) and judges the file by its header, not its claimed type. Consent is required before analysis. AI suggestions and approximate crops must be reviewed before saving. Brand and size stay blank unless supplied; fabric, fit and warmth cannot reliably be determined from a whole-garment photo.

The app builds complete outfits from a reviewed top, bottom and shoes, or a dress and shoes. Choose everyday, work, evening or formal and enter the temperature. This is a rule-based outfit composer, not live weather. Formal outfits require formal items whose dress code you chose: the upload review shows the model's guess as a suggestion but keeps "Not sure" until you pick Formal (or press "Use this"). When the model lists the two shoes of a pair separately, the review suggests a merge; nothing is merged until you confirm. Unavailable clothes are excluded; optional sample items are visibly examples.

Wardrobes and photos are isolated by authenticated account. Saved outfits retain snapshots. Removing an item preserves photos still used in saved looks; remove those looks too to erase that photo from active wardrobe storage. A conflicting edit from another browser preserves the unsaved draft rather than overwriting server data. Export a portable backup before reloading after a conflict. Restoring a backup merges items into your current account and assigns new item IDs.

The initial capacity limits are one active analysis per account, 20 active jobs globally and 20 accepted analyses per account per UTC day. Saved photos have a 100 MB account limit. Model inference is sequential. Photos awaiting analysis and temporary results expire after one hour during normal operation, and a photo is only accepted if its conservative estimated ready time plus review time fits inside that hour; the server returns your queue position, an estimated wait and the deadline. Closing the upload window does not cancel processing: the job and its result wait for you (from any reload or later sign-in) until you save, discard or the hour ends, and review choices (not photos) are kept in the browser tab. An explicit cancel or discard clears the queue data from the active database immediately and stops the model; a queued photo you cancel, or an attempt that fails because the server could not run it, is returned to your daily allowance once, while a separate attempts counter bounds repeats. **Deletion and retention, as actually implemented (build 008).** Cancelling, discarding, saving, expiry and account deletion are *logical* deletes inside the live SQLite database: the rows are removed at once, but the bytes are not securely wiped and can remain in unused database pages and in the write-ahead log until SQLite overwrites them. Secure-delete, WAL truncation and physical marker tests are future work. Backups made with the backup command never contain temporary analysis photos, queued account mail, reset tokens or session tokens, but they do contain every saved wardrobe, photo and account that existed when they were made; the command keeps local copies for 7 days. Backups are **not encrypted** by this software and the local backup folder shares the live database's disk; encryption and off-server copies are the operator's responsibility and are not yet implemented or tested here. Deleting an account removes its live rows (including its queued mail) at once and leaves a pseudonymous deletion record (internal user ID and time) that the restore command re-applies so a restored backup does not bring the account back. Restoring onto a brand-new server without the live database is **not yet supported**. **Backups and restores (build 009).** While a backup is being made, and if the process is killed, an unsanitised `style-*.partial` file exists in the private backups directory (it holds temporary photos, queued mail and tokens); it is never a backup or restore source, a failed backup removes it, and the next backup removes any left by a dead process. Only `style-*.db` files are backups. After **any** restore, every user's password is invalidated (the backup cannot tell whose password changed after it was made, and an old password must not come back), so each user must choose a new one with "Forgot password"; that needs working SMTP and the mail worker running. Wardrobes, photos and accounts are kept.

**Account email (build 008).** Verification and password-reset emails are written to a durable outbox in the same database and sent by a separate mail worker (`npm run mail-worker`), never by a web request and never behind AI inference. Delivery is at-least-once: a rare crash can send the same message twice (both copies carry the same Message-ID). Each message expires after 45 minutes undelivered, is tried at most 5 times with backoff, and is limited to 4 per kind per address per hour (12 a day per address, 1,000 waiting and 600 an hour service-wide); excess requests are dropped without telling the requester, so responses never reveal whether an address has an account. A consequence: a sign-up can complete with no email queued (a bound was hit, or the enqueue failed); signing in again requests a new link once the bound allows. In development, with no `SMTP_URL`, the web process also drains the outbox into the private `.data/mail-outbox` folder, a few tens of milliseconds after the request.

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm audit --omit=dev
```

Tests cover outfit rules, real authentication, verification, account isolation, private photo access, optimistic conflicts, password reset and session revocation, deletion, durable queue ownership, individual quotas, cancellation and lease recovery. Browser tests cover desktop and mobile wardrobe workflows plus self-service signup and cross-browser syncing. Controlled model responses test interaction; the real model is checked separately:

```powershell
npx tsx scripts/verify-browser-vision.ts
```

This verification uses a disposable local account and public evaluation photos. It is not a calibrated recognition benchmark. The older synchronous `verify-vision`, `verify-multiple` and `verify-empty-vision` scripts predate the queue and must be updated before reuse. They are not current release evidence.

Runtime dependency auditing reports no known vulnerabilities. Development tooling currently includes an unpatched upstream `braces` stack-exhaustion advisory; do not process untrusted lint patterns. Containers exclude development dependencies.

## Public deployment

The chosen launch target is one self-hosted Linux server with Node, SQLite, private photos, Ollama and Caddy HTTPS. Software has no paid AI API requirement; server resources, a domain and mail service still require provisioning. Follow [DEPLOYMENT.md](docs/DEPLOYMENT.md). Docker is not installed in the current workspace, so the container package has not yet been executed. A successful local build is not a public deployment test.

Historical product research and the earlier local-beta plan remain in `docs/PRODUCT_ANALYSIS.md` and `docs/PRODUCTION_PLAN.md`; this README and actual review evidence describe the current multi-user implementation.
