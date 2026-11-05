# Implementation 021 notes

Written for: root and the next independent reviewer. Release candidate for branch `style-studio-encrypted-backups-021`. It is a candidate only: it has not been deployed, it has not run in Docker or on Linux, and the external gates listed under "Review and release verification" below are still open. This is not a launch-ready claim.

## What build 021 adds

An operator command that makes ONE encrypted, portable backup package (sanitised database + deletion ledger), and a restore command for it that works onto a genuinely fresh data directory. The existing plain backup and restore commands behave as before.

### Files
- `src/server/encryptedPackage.ts` (new): the format, header parse/bounds, `writePackage`, two-pass `authenticatePackage` / `extractPackage`, `verifyPackage`.
- `src/server/backupPassphrase.ts` (new): passphrase from `STYLE_BACKUP_PASSPHRASE_FILE` or `STYLE_BACKUP_PASSPHRASE` only; strength rules; protected-file checks.
- `src/server/encryptedBackup.ts` (new): `createEncryptedBackup` (plain sanitised backup, ledger exported after it, write, re-verify, atomic publish, then remove the plain backup); `exportsDirectory`; partial sweep.
- `src/server/encryptedRestore.ts` (new): the `prepare` step for the shared restore (lookup by name, auth, decrypt to owner-only staging, cleanup).
- `src/server/restoreDatabase.ts` (new): the restore logic MOVED out of `scripts/restore-database.ts` unchanged in behaviour (modes, ledger policy, staging, presence claim, outputs). It now takes the backup source and explicit ledgers from a callback that runs after the exclusive presence claim and always runs its cleanup.
- `scripts/restore-database.ts` (now ~70 lines): argument parsing plus the shared function.
- `scripts/backup-encrypted.ts`, `scripts/restore-encrypted.ts` (new).
- `package.json` scripts `backup:encrypted`, `restore:encrypted`; `Dockerfile` COPY lines for both scripts (the modules are under the already copied `src/server`).
- Docs: `README.md` (two stale statements corrected), `docs/DEPLOYMENT.md` (three stale statements corrected, new section "Encrypted backup packages (build 021)").
- Tests: `tests/encryptedPackage021.test.ts` (14), `tests/encryptedBackup021.test.ts` (17), `tests/deploymentScripts.test.ts` (one new test, expected list extended).

### Format (version 1)
64-byte authenticated header (magic `STYLEPKG`, version, scrypt settings, salt, nonce, backup time, database length, ledger length), then AES-256-GCM ciphertext of database bytes followed by ledger bytes, then the 16-byte tag. File size must equal 64 + db + ledger + 16 exactly. scrypt N=2^17 r=8 p=1 by default (128 MiB); accepted on read: log2N 15 to 18, r 8, p 1. Limits: database 8 GiB, ledger 32 MiB (the ledger parser's own ceiling). Fresh random 16-byte salt and 12-byte nonce per package. Node built-ins only.

### Threat boundary
Protects a copied package at rest. Does not protect against anyone holding the passphrase, a compromised running server, or passphrase loss (unrecoverable by design). Not a signature scheme.

### Safety properties and where they are enforced
- Passphrase never in argv, logs, package metadata or files: read from env or a protected file (regular, at most 4 KiB, POSIX owner and mode checked, no link); at least 20 characters with at least 10 distinct; fail closed before any backup work. The env entry is deleted once read; the buffer is wiped after use. Error text is fixed; arguments are never echoed.
- Atomic publication: exclusive-create partial (0600) in the private `<data>/exports` (link/junction refused, 0700 on POSIX), flush, full re-authentication of the partial, hard link to a final name that did not exist (EEXIST picks the next free name; rename fallback under the lock), then unlink of the partial name. One export at a time per directory (OS file lock); under it only exact `style-package-<time>.<12 hex>.partial` names are swept. Plain backup removed only after publication; `--keep-local` keeps it.
- Restore: shared presence claim first; then name lookup, format and bounds before any key derivation, whole-file authentication (pass 1, writes nothing), decrypt to `<data>/restore-staging` (pass 2, tag verified again), SQLite magic check, then the existing shared checks. Staging removed on success, refusal and exception; unremovable leftovers are named (`RESTORE_W_STAGING_LEFT`, exit 2).
- Fresh-server ledger policy unchanged and applied to the packaged ledger (and an optional newer `--ledger`, merged): must not predate the backup, must not exceed the max age unless accepted.

## Tests (what each proves)
- Format: exact size, no plaintext, fresh salt/nonce, round trip; every header byte flip refused; ciphertext/tag flips refused; truncation and extension refused from the size; malformed header fields; excessive KDF settings refused with the KDF code (not a scrypt error); lengths above limits refused before allocation; lying lengths refused; stage failures; directory/link inputs; passphrase rules and file checks.
- Command core (in process): success; keep-local; failure injected at each of six stages (nothing published, no partial, plain backup kept, retry succeeds, live user count unchanged); damage and truncation during write caught by verification; duplicate final name and link not replaced; link/junction exports refused before anything is created; only owned partials swept, a directory with a partial's name left and reported.
- Commands (child processes, real files): encrypted export, then restore onto an empty directory (kept accounts, photo and wardrobe return; deleted account stays deleted; session, verification, mail, analysis jobs and rate-limit rows empty; credentials emptied; sign-in refused and reset works); a package predating a deletion alone cannot know, a newer ledger fixes it, a live database's own record wins; wrong key, tamper, truncation, version, non-package changed nothing on fresh and live directories; passphrase failure modes and argument refusal; filename/link/directory tricks; decrypted staging removed after later refusals (foreign database, stale ledger, inconsistent package); crashed staging swept by exact pattern; refusal while a process holds the database, before anything is decrypted; confirmation required; no output ever contained the passphrase, an email, an id or a password.
- Test cost design (follow-up): the production DEFAULT_KDF (scrypt N=2^17, 128 MiB) is never weakened and no environment switch or hidden option exists. Exactly ONE test runs the CLI at the default cost ("CLI at the production default cost": `backup:encrypted`, header byte shows log2N 17, then `restore:encrypted` onto a fresh directory). Every other test that needs a package makes it in process with the accepted lower setting log2N 15 (32 MiB), which `parseHeader` accepts like any other package; restore reads the cost from the header, so the restore CLI tests need no change. Refusal tests that fail before any derivation (missing/weak passphrase, bad arguments) still use the CLI. Before this change the end-to-end tests ran about 8 default-cost derivations in a row (two backups plus every restore of those packages) while the whole suite ran in parallel.
- Mutation check: disabling the header authentication data makes the header-flip test fail.
- Bug found by the tests and fixed: an empty `STYLE_BACKUP_PASSPHRASE` next to a file variable was used as an empty passphrase (`??` instead of `||`).

## Results (Windows, Node 24.20)
| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npm run lint` | passed |
| New tests | 14 (format/passphrase) + 17 (command core and CLI, one at default cost) all passed; the two files together 31/31 in about 68 s |
| Existing restore, ledger, deployment-contract tests after the refactor | passed |
| `npm test` (twice, after the test-cost change) | 421 tests: 416 passed, 0 failed, 0 cancelled, 5 skipped, both runs (106 s and 124 s) |

An earlier full run (before the test-cost change) failed under resource pressure: the scrypt-heavy CLI tests ran alongside the vision, mail, packaging and timing tests, whose servers and deadlines then timed out. The cause was the test design above, not production code. After the change both full runs were clean. Not run: browser suite (no UI change), `npm run build`, Docker, any Linux run.

## Review and release verification
The results above are the implementer's own. The items below come from the independent review and the root build and were not run by the implementer.

| Item | Result |
|---|---|
| Independent review verdict | READY TO COMMIT AS RELEASE CANDIDATE. Code blockers: none. |
| Root `npm run build` | PASS (Next production build, sanitize output, packaging check) |
| Root `npm run verify:packaging` | PASS |
| Root `npm run verify:standalone` | PASS outside the restricted sandbox. The first sandboxed attempt could not reach the temporary local health server; the run with approved local-network access passed. |

External gates that remain open, whatever the rows above say:
- Linux and Docker: owner-only modes, ownership and passphrase-file mode checks have only run on Windows, and neither encrypted command has run in a container built from this branch.
- Off-server copy and restore drill: no package has been copied off the server, and a restore of a real package onto a clean host with the separately held passphrase has not been done. The deployment guide makes no claim that either exists.
- SMTP and public deployment: nothing has been deployed or exposed.
- Real-photo accuracy: not established by this build.

## Remaining risks
1. Linux behaviour untested: owner-only modes, ownership checks and the passphrase-file mode check were written but only exercised on Windows (those assertions are skipped there). Docker was not run.
2. Nothing copies a package off the server, and nothing prunes packages (each is about the database's size). Both are operator work; the docs say so.
3. Package freshness: a package's own ledger is as old as the package; a fresh restore of an old package needs a newer `--ledger` or the stale-ledger override, and deletions after the newest ledger come back.
4. A passphrase in the environment is visible to same-user processes and `/proc/<pid>/environ` of the command; the file form is preferred. Wiping buffers in Node is best effort.
5. scrypt needs about 128 MiB (up to 256 MiB for a package at the accepted maximum); a tightly limited container could fail.
6. Decrypted staging is unlinked, not wiped; deleted plaintext can remain on disk until overwritten.
7. The sanitised plain backup still exists briefly on the same disk (it is created by the unchanged backup code first, then removed after publication).
8. Large databases: encryption and verification are streamed (1 MiB chunks) but the verification and the restore each read the whole package, and restore needs space for a decrypted copy plus the staging copy. Not measured at the 8 GiB limit.
9. The package protects confidentiality and integrity under the passphrase only; anyone who has it can forge a package (for example with a ledger that omits deletions). It is not authenticated by the server.
