# Implementation 022 notes

Written for: root and the independent reviewer. Branch `style-studio-encrypted-backups-021`, on top of the committed build 021. Nothing here is committed or pushed. **The drill itself has not been run**: no Docker is available where it was written. Its first real run is the Docker job of the next CI run.

## What build 022 adds
A deterministic CI drill that proves, against the real built image, that an encrypted package made on one data volume can be copied as an artifact to a different, empty volume, authenticated with a separately held passphrase, restored with the real commands, and that the restored app is healthy.

### Files
- `scripts/ci-backup-drill.ts` (new): orchestration. `runDrill(deps, scenario)` generates the run id and two passphrases (one correct, one unrelated), creates a private host folder, runs the scenario, **always** cleans up in a `finally`, then fails if any labelled container or volume remains. `--cleanup-only` removes anything any drill labelled. `docker` is injected, which is what lets the cleanup be tested without Docker.
- `scripts/ci-backup-drill-plan.ts` (new): pure builders for every `docker` argument list, name patterns, the strong-passphrase generator, `redact`, `findSecret`. No process is started here.
- `scripts/ci-backup-drill-inspect.ts` (new): read-only inspector, bind-mounted into containers at run time (not baked into the image). `facts` prints counts, booleans, hashes, modes and owners; `mail` prints one captured link. It prints no emails, ids, names, photo or wardrobe content.
- `.github/workflows/ci.yml`: two steps in the existing `docker` job, after the smoke test and before the log step: the drill (`timeout-minutes: 15`, `IMAGE=style-studio:ci`, `DRILL_PORT=3100`) and an `if: always()` label sweep.
- `package.json`: script `ci:backup-drill`.
- `docs/DEPLOYMENT.md`: a "CI transfer-and-restore drill (build 022)" paragraph in the encrypted-package section, marked authored and not yet run.
- `tests/ciBackupDrill022.test.ts` (new, 22 tests).
- No application code, no Dockerfile change, no change to the backup or restore commands.

### How the drill proves each required property
1. **Isolation and fresh volume.** Four labelled named Docker volumes: source, fresh, negative, secrets. The fresh and negative volumes are checked empty (no `app.db`, no packages) before use.
2. **Real image, real commands, real routes.** The app runs from `style-studio:ci` exactly as the existing job starts it (`init-auth` then `exec node server.js`, so the server is PID 1 and `docker stop` delivers SIGTERM to it directly), on loopback only, with `no-new-privileges` and all capabilities dropped. Seeding uses the real HTTP routes (sign-up, mail verification link, sign-in, photo upload, wardrobe save, analysis submit, reset request, account deletion). `backup-encrypted` and `restore-encrypted` run in their own `docker run --rm` containers (no network, same mounts as the documented `docker compose run --rm` form), the backup while the source app is running.
3. **Passphrase.** Generated in the script (32 random bytes, base64url, checked with the product's own `validatePassphrase`), written to the secrets volume **through stdin** by a short-lived helper (`umask 077`, `chown 1001:1001`, `chmod 0400`), mounted read-only, named only by `STYLE_BACKUP_PASSPHRASE_FILE`. The drill reads the file's mode and owner back from inside the image and requires `400` and uid 1001. It is never in an argument or environment value. After the scenario the drill fails if either passphrase appears in any docker argument or captured output, and every printed error is redacted.
4. **Artifact transfer.** A root helper with only CHOWN/DAC_OVERRIDE/FOWNER copies the package from the source volume (read-only) to a host folder, then another installs it into the fresh volume's `exports/` as uid 1001, mode 0600, in a 0700 directory. The source app is stopped and removed before the restore.
5. **Preconditions.** Before the backup the inspector must find: the kept account, one photo, a wardrobe, the deleted account absent but recorded, at least one session, a reset token, an analysis job, a rate-limit row, a credential password and a captured mail file. If seeding silently fails, the drill fails rather than passing vacuously.
6. **Package shape.** Exactly one package, no partial, mode 600, owner 1001, `exports` mode 700, no plain backup left.
7. **Negative cases on an empty volume.** Wrong passphrase and tampered package: exit 1, `RESTORE_E_PKG_AUTH`. Truncated package: exit 1, `RESTORE_E_PKG_TRUNCATED`. After each: no `app.db`, no staging file, no `.pending` file.
8. **Fresh restore.** Real `restore-encrypted` onto the fresh volume. Then: `app.db` exists and is owned by 1001; integrity ok; kept account present; photo hash and wardrobe revision/hash equal the source's; deleted account absent with no rows, and recorded as deleted; sessions, verification (reset tokens), mail outbox, analysis jobs, rate-limit rows and captured-mail files all zero; credential passwords zero; no staging.
9. **Restored app.** The real image starts on the restored volume and must answer `/api/health`. The old password and the deleted account are refused; a password reset (request, captured link, token, new password, sign-in) works.
10. **Live refusal.** With that app stopped, a wrong passphrase and a tampered package against the now-live database are both refused with `RESTORE_E_PKG_AUTH`, and `app.db` is byte-identical (SHA-256) before and after.
11. **Cleanup.** Containers, then volumes, then the host folder, in `finally`; a second label-based listing must be empty or the drill fails. The workflow's `if: always()` step repeats the sweep by label.

### What I could and could not verify here
- Verified locally: typecheck, lint, and the 22 new tests (argument lists, secret ownership/mode script text, cleanup after success/failure/stuck volume, no passphrase in any argument or output, the inspector against a real database, workflow order and wiring, Dockerfile carries the two commands).
- Verified locally by hand, once: every HTTP step the drill performs (sign-up, verification link, sign-in, photo upload, wardrobe PUT, analysis submit, reset request, `delete-user`, reset-password with the token being the last path segment of the link) against a locally started standalone build, using the real inspector for the mail link and the facts. All preconditions held (session 1, verification 1, analysis job 1, rate-limit rows 5, deleted account recorded). That used a throwaway script that is not in the repository; the origin header was set to the port the app believed it had.
- **Not verified:** any `docker` invocation, the root helpers, volume ownership behaviour, `docker stop`/health timing, port 3100, the whole sequence on Ubuntu. The first CI run may well fail on one of these; that is what the drill is for. Expect the most likely trouble in the root-helper commands (capabilities, `install`/`chown` on a fresh named volume) and in the 90 s health wait.

## Constraints and risks
1. **Not yet run.** Do not describe the backup path as exercised in Docker until the CI job has passed.
2. **Transfer is a runner-local copy**, not a different machine and not off-server storage. Statements about off-server backup stay as they were.
3. **Port 3100** must be free on the runner (the existing smoke containers use 3000). `APP_URL` is tied to the port because the app checks the request origin.
4. **Runtime**: three app starts' worth of image start-up plus one default-cost scrypt derivation per backup/verify/restore (128 MiB each, run one at a time). The step has a 15 minute ceiling; actual time is unmeasured.
5. **The drill runs after the smoke step in the same job** and is skipped if the smoke step fails. It shares the job's Docker daemon with the smoke containers (different labels, names and volumes).
6. **Host folder permissions.** The drill chowns the copied-out package to the runner's uid/gid. On GitHub's runner that is a normal unprivileged user; the root helpers need Docker access only.
7. **SQLite bookkeeping.** The inspector opens the database read-only, which can leave empty `-wal`/`-shm` files next to `app.db` on a WAL database. `app.db` itself is never modified (the test and the live-refusal hash check cover that).
8. The deleted account is already absent from the source database at backup time, so "does not return" shows the deletion ledger/record carried across the package and that nothing resurrects the account; it is not a test of ledger-driven removal of a row that exists in the package (build 021's tests cover that).
9. The standalone app I started on port 3000 for the manual HTTP check (data folder `.data/drill-local-*`, gitignored) may still be running on the author's machine; stop it and delete that folder.

## Results (Windows, Node 24)
| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npm run lint` | passed |
| `tests/ciBackupDrill022.test.ts` | 22 passed |
| `tests/deploymentScripts.test.ts`, `tests/packaging.test.ts` | passed with the new files present |
| `npm test` (full unit suite) | 443 tests: 438 passed, 0 failed, 5 skipped (100 s) |
| The drill on Docker | **not run** |
