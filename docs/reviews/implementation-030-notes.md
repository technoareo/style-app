# Implementation 030: runtime dependency patches, audit gate and install-script policy

Status: implemented and validated by root (with one test file, `encryptedBackup021`, that failed once in a parallel full run and passed alone: see the later verification below); **uncommitted** (no commit, no push), started from clean commit 640a69d. The app is **not launch-ready**: see the remaining external gates at the end. The builder had no `npm`, `docker` or build access in the sessions that wrote this; **every result below was produced by root and is recorded as reported.**

## The advisories and the patches

Fresh `npm audit` by root on 2026-11-10 found, on the locked versions of commit 640a69d:

| Package | Locked | Advisory | Severity |
|---|---|---|---|
| `next` | 15.5.27 | GHSA-2464-fhr4-w9xw | critical |
| `next` | 15.5.27 | GHSA-p3m5-59mp-jv5r | high |
| `zod` | 4.6.5 | GHSA-mrhx-c7xc-m3w5 (fixed >=4.6.6) | high |
| `nodemailer` | 10.1.0 | three addressparser advisories (fixed >=10.1.4) | moderate |

Installed (small patch releases, no `--force`, no major migration): `next` 15.5.29, `@next/env` 15.5.29, `eslint-config-next` 15.5.29 (and `@next/eslint-plugin-next` 15.5.29, kept aligned), `zod` 4.6.7 (including the copy Better Auth uses), `nodemailer` 10.4.0, plus `@typescript-eslint/parser` 8.72.2 from `npm audit fix`. `package.json` ranges are `^15.5.29`, `^4.6.7`, `^10.4.0`, as the repository already writes them.

## Audit results (root)

- `npm audit --omit=dev`: **0 vulnerabilities** (55 production dependencies; zero info, low, moderate, high, critical).
- Full `npm audit`: **6 moderate findings, all development-only**: the `minimatch` advisory GHSA-g3hv-75wg-m249 (affects minimatch >=7 <11.0.1) reached through the `@typescript-eslint` toolchain (parser, typescript-estree, utils, plugin). `npm audit fix` without `--force` changed only `@typescript-eslint/parser` 8.71.1 -> 8.72.2 and its nested graph (including `minimatch` 10.2.6) and still reports the same six; `npm audit fix --dry-run` afterwards proposed zero changes, so there is **no compatible automatic fix**. An unreviewed major transitive override was deliberately **not** added to silence it. The production audit is the enforced gate.
- Residual risk, stated narrowly: these packages are dev-only and are not installed in the runtime image (`npm ci --omit=dev`); lint runs over repository-controlled files only; do not run lint over untrusted patterns. This is **not** a claim that the whole dependency tree is free of advisories.
- Lockfile review (root): 25 changed package records, all explained by the five patches, the aligned Next/SWC platform packages and the parser's nested dependencies; every versioned entry has a `resolved` URL and an `integrity` hash.

## CI audit gate

`.github/workflows/ci.yml`: a named step `npm audit --omit=dev` directly after `npm ci` in both the `build` job and the `docker` job (before `docker build`). Default audit level, no `continue-on-error`, `|| true` or `--audit-level`. The Dockerfile's `dependencies` stage (`npm ci --omit=dev`) and the standalone bundle (traced from the build stage's `npm ci`) install from the same `package-lock.json`, so auditing the lock audits what ships. The image build itself runs no audit (an advisory published later would otherwise stop operators rebuilding an unchanged tree).

## Install-script policy (strict, deny by name)

Evidence (root): npm 11 had approved `esbuild@0.28.2` and `unrs-resolver@1.12.2` (the two packages with install scripts that are installable on Linux and Windows; the lockfile also records the optional macOS-only `fsevents`, below). A clean `npm ci` skipped both and every validation still passed; the Build 029 Linux CI also passed worker, lint and build with them skipped. An isolated proof: with strict mode on and esbuild uncovered the install failed with `ESTRICTALLOWSCRIPTS`; with both denied it passed; `tsx`, `eslint`, the `esbuild` executable and real `unrs-resolver` resolution all worked with scripts denied; an incompatible npm failed with `EBADDEVENGINES`.

Decision, based on that evidence rather than blind approval:

- `package.json` `allowScripts`: `{ "esbuild": false, "fsevents": false, "unrs-resolver": false }` (name-only, so a version bump cannot silently lose the decision; no `true` approval anywhere).
- **`fsevents` (found by the first focused run):** the lockfile records `fsevents` 2.3.3 with an install script, `optional: true` and `os: ["darwin"]` (an optional macOS file-watcher binding, pulled in by `tsx` among others). On Linux (the production platform) and Windows (root) npm ignores it as platform-ineligible, so `npm install-scripts ls` correctly reported nothing and the strict install passed there. On macOS it is eligible, and without a decision strict mode would fail the install with `ESTRICTALLOWSCRIPTS`. Decision: **deny it explicitly** instead of excluding platform-impossible packages from the contract, which would pass here and fail on the first Mac and would leave the contract weaker. The lockfile test therefore requires a decision for every install-script package whatever its platform, and rejects stale denials; a second test pins `fsevents` as the only optional/OS-restricted install-script package, so a new one forces a deliberate review. Why denial is believed safe: `fsevents` 2.3.x ships its prebuilt `fsevents.node` in the package and the script matters only if that binary is missing. **Limit: not run on macOS by the builder or root**; if a Mac developer sees file watching fail, the fix is a reviewed change to this entry, not a bypass flag.
- `.npmrc`: `strict-allow-scripts=true`, so a **new** dependency with an install script fails the install until a person reviews it and adds an explicit entry.
- `package.json`: `"packageManager": "npm@11.19.0"` and `devEngines` with `onFail: "error"` for Node `>=24.20 <25` (same as `engines`) and npm `>=11.19 <12`. The official `node:24-bookworm-slim` is Node 24.22.2 / npm 11.19.1 and fits.
- Both Dockerfile install stages (`build`, `dependencies`) now `COPY package*.json .npmrc ./` before `npm ci`, so the image enforces the same policy; `.dockerignore` already permits `.npmrc`.
- Residual compatibility risk: a future dependency that really needs its install script (for example a native build with no prebuilt binary) will fail the install under this policy instead of building silently; the fix is a reviewed, explicit entry, not a bypass. `esbuild` and `unrs-resolver` run without their scripts (esbuild's script only validates/optimises its prebuilt binary), which is proven for this tree and these versions, not for all future ones. Strict mode and `devEngines` need npm 11.19 or newer; older npm ignores or rejects them.

## Tests (`tests/dependencyAudit030.test.ts`, new; `tests/composeAppSignal029.test.ts` updated)

No `npm audit` is run by tests and no vulnerability count is hard-coded. They pin: the patched minimum versions in `package.json` and in the lockfile; Next, `@next/env`, `eslint-config-next` and `@next/eslint-plugin-next` on one version; no override that pins a patched package back; the audit step present, ordered and unsoftenable in both jobs; the Dockerfile installing only from the lockfile with `.npmrc` copied before both `npm ci` commands and no bypass flag (`--force`, `--legacy-peer-deps`, `--ignore-scripts=false`, `--allow-scripts`, `--no-audit`); the exact denials (esbuild, fsevents, unrs-resolver), with no approval; every lockfile package that has an install script covered by an explicit denial whatever its platform, and no stale denial; `fsevents` pinned as optional, darwin-only and the only OS-restricted install-script package; `.npmrc` copied before each `npm ci` asserted once (in the Docker image test, with the lockfile ordering); `strict-allow-scripts=true` set once and no bypass in `.npmrc`; the toolchain ranges and `onFail`; and the README/notes facts. `composeAppSignal029` now describes and pins the verified Build 029 CI run.

## Validation results (root, Windows workspace, as reported)

- clean `npm ci`: passed. `npm run typecheck`: passed. `npm run lint`: passed.
- Focused tests: 21 total, 18 pass, 3 expected platform skips (initial run, before the install-script policy tests were added).
- Full `npm test`: 717 tests, 704 pass, 13 expected skips, 0 failures.
- `npm run build`: passed; Next 15.5.29 compiled; the sanitizer dropped 668,952 trace entries and removed one bundled private path/link; the packaging check passed. `npm run verify:packaging`: passed. `npm run verify:standalone`: passed.
- Browser E2E: 65 passed, 1 expected mobile-auth skip, 0 failures.
- `git diff --check`: passed.
- The first, sandboxed build hit Windows `EPERM` creating `.next/standalone`; the rerun with the needed workspace permission passed. That is a workspace permission limitation, not a code failure.

### Later verification of the final tree (root, as reported)

- **Sandbox loopback, not a regression.** `tests/analysisMode018.test.ts` first failed 4 of 7 tests after the install-script/`devEngines` policy landed: the worker tick ran, the job failed, and the mock model recorded no request. Root confirmed the cause: the managed sandbox blocked loopback (`connect EACCES 127.0.0.1`). With localhost permission the four affected test groups passed **41 of 43, with two expected platform skips**. The production app did not regress, and the install-script/`devEngines` policy was not the cause. (An earlier suspicion in the builder's session that the policy or a stale lock holder was involved was not borne out. A temporary builder diagnostic test, `tests/visionMockReachability030.test.ts`, was written for that investigation, never run, and removed: the existing vision and HTTP tests already cover loopback, and the failure was environmental.)
- **Complete suite with localhost access:** **726 tests, 712 passed, 13 expected skips, 1 failed.** The failure was parallel interference in `tests/encryptedBackup021.test.ts`; that whole file then **passed alone, 17 of 17**. This is **not** an unconditional full-suite pass: it is a full run with one failure that passed in isolation. It is not shown here that the file passes in every parallel run; if it recurs, treat it as a test-isolation problem to fix in its own build, not as evidence about this build's dependency or policy changes.
- The earlier full run recorded above (717 tests, 704 pass, 13 skips, 0 failures) and the first strict clean `npm ci` remain as reported; the 726-test run is a later run of the final tree (the builder was not told what accounts for the nine additional tests).

## CI evidence recorded (as reported by root; the builder did not read the logs)

GitHub Actions run **42828271674**, commit **640a69d**: the `build` and `docker` jobs succeeded. Exact Build 029 evidence: PID 1 of the app container is the Next server; `docker compose stop app` took **188 ms**, exit code **0**, under Docker's default grace period, no SIGKILL. In the same run the app, AI worker and mail worker started from the built image and the container smoke passed account verification (local mail capture), analysis against the mock model and the wardrobe flow. This is a GitHub-hosted runner with a mock model; it used no real SMTP relay and exercised no active-send graceful shutdown.

## Docker image proof: verified in Linux CI (as reported by root; the builder did not read the logs)

**This exact Build 030 tree passed the Linux `build` job and the dependent `docker` job in CI.** Commit `0b49b28bc14a64b0bb2aae06ce270bc6851e3357` ran GitHub Actions workflow run **42950645223**, and both jobs completed successfully. That run built the Docker image with the new `.npmrc` / install-script / `devEngines` policy in force (the `.npmrc` copy and `npm ci` in both Dockerfile install stages, the `allowScripts` denials, the `packageManager`/`devEngines` fields and the patched dependency set), ran the `npm audit --omit=dev` gate in both jobs, and passed the workflow's existing Docker and live-container checks. It supersedes the earlier statement that no Build 030 image had been built: the previous successful Docker run, 42828271674 (commit 640a69d), was Build 029 and remains the evidence for the Build 029 stop check only.

What this does and does not show: it is a GitHub-hosted Linux runner. **Local Docker was unavailable** in the builder's and root's Windows workspace, so the image was not built or run locally; the Windows results above (strict clean `npm ci`, build, packaging, standalone, E2E) are separate from this container evidence. The workflow's container checks use the CI mock model and no real SMTP relay; the external launch blockers below are unchanged by it.

## Open items from this build

- `.npmrc` (one policy line, `strict-allow-scripts=true`, plus comments) is now present in the working tree but is **untracked**: it must be added with the rest of the build, because the Dockerfile `COPY` and `tests/dependencyAudit030.test.ts` depend on it. (Its creation was blocked as a sensitive file in the builder's session and was done by root.)
- The incidental E2E changes to `docs/verification/desktop.png` and `docs/verification/mobile.png` have been reverted (the working tree shows no change to them), and the stray prompt-dump file `.claude-build030-final.txt` is gone; neither is Build 030 evidence.
- `tests/encryptedBackup021.test.ts` failed once under the parallel full run (see above) and passed alone; its isolation is not addressed in this build.
- The builder ran none of the validations in this file; every figure is root's.

## Remaining launch gates (external, unchanged by this build)

Not launch-ready for public use. Still open: hosting and a real domain with a publicly trusted certificate; a real SMTP relay and delivered account mail; an off-server backup with a restore tested on a different machine; capacity and the `mem_limit`/`NODE_OPTIONS` starting values measured on the operator host under load; and a representative, rights-cleared, human-labelled real-photo benchmark that passes an approved policy (recognition quality remains unmeasured). The scope stays the easy single-item photo workflow; crowded photos are out of scope. Later product findings (single-item UI and privacy pages) belong to the next build, not this one.
