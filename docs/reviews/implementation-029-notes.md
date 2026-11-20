# Implementation 029: the app container's server becomes PID 1 (`exec`)

Status: implemented; **uncommitted** (no commit, no push). The app is **not launch-ready**: this build changes one start command and adds checks around it. Nothing here was run on an operator host or a public domain.

## The defect

`compose.yaml`'s `app` command ended `./node_modules/.bin/tsx scripts/init-auth.ts && node server.js`. In the intended behaviour the start shell stays PID 1 and does not forward SIGTERM to the Next server, so `docker stop` / `docker compose stop` waited out Docker's default 10 s grace period and then killed the container (exit code 137). Build 023 documented this and left it unfixed; the build 022 drill and the mailer/worker services already avoided it.

## The change

Only the last statement of the `app` command: `... && exec node server.js`.

- Everything before it is byte-for-byte what it was: the leftover-variable refusal, the strict timeout check, the export, and `tsx scripts/init-auth.ts`.
- `exec` is joined to `init-auth` by `&&`, so it runs only if `init-auth` exits 0. A failing `init-auth` still ends the container with its own non-zero status and the server never starts (fail closed, unchanged). Compose services that wait for the app to be healthy still never start in that case.
- After `exec` the Next server is the container's first process and receives SIGTERM directly.
- The plain CI app container in `.github/workflows/ci.yml` (the `docker` job, not the shipped compose) now starts the same way. The backup drill already used `exec`.
- Stale "AUTHORED, NOT RUN" / "not yet run" / "Docker is unavailable" comments in `compose.yaml` are reworded to say what is true: the guards and start commands are exercised in CI by the compose smoke test, not on an operator host, and no load test has sized the memory and heap limits.

## Tests (`tests/composeAppSignal029.test.ts`, new; plus edits to `tests/proxyConfig.test.ts`)

- **Exact order, from the shipped text:** the script ends with `init-auth && exec node server.js`; exactly one `exec`, one `init-auth`, one `node server.js`; only ` && ` between init-auth and exec; no `;`, `||`, background `&` or `|| true` after init-auth; init-auth itself is not exec'd; every `exit 1` guard comes before init-auth; the opening refusal and the export of `STYLE_BODY_READ_TIMEOUT_MS` are unchanged.
- **No settings that would hide the signal path:** no `init:`, `stop_signal` or `stop_grace_period` on the app service, and none in the CI override; the faithful-compose allowlist (`overrideProblems`) still rejects a changed app command or grace period and still allows only the image.
- **Real command text in `sh` with stand-ins** (skipped where there is no `sh`): a failing init-auth (exit 1, 3, 70) keeps its exit code and the server stand-in never runs; a guard refusal happens before init-auth; with a succeeding init-auth the server stand-in runs after it and **has the same process id as the starting shell** (exec replaced it), with a control (a plain child) showing a different pid; SIGTERM sent to the first process reaches the server stand-in, which exits promptly (skipped on Windows, where Node cannot deliver SIGTERM; it runs on Linux/macOS, i.e. in CI).
- **The pure parts of the CI measurement:** `pid1IsNextServer` accepts the Next process title (full or truncated) or `node server.js`, and rejects shells and look-alikes; `stopProblems` fails a stop that is slow, not exited, or exit code 137 (the old behaviour fails on both the time and the exit code); `stopArgs` has no `--timeout`; the limit (7 s) is under Docker's default grace period (10 s).
- **Documentation:** the stale known-issue sentence is gone, the fix is recorded, and the new CI check is not claimed as run.
- `tests/proxyConfig.test.ts`: the three places that pinned the old command text now pin `&& exec node server.js`.

## The CI smoke test (`scripts/ci-compose-smoke.ts`, `scripts/ci-compose-smoke-plan.ts`)

After the raised-value checks, on the still-running stack: read `/proc/1/cmdline` of the app container (the command line only, never the environment, so nothing secret is read) and require that PID 1 is the Next server; then time `docker compose stop app` **without** `--timeout`, so the shipped default grace applies; then require the container to be `exited`, with exit code other than 137, in under 7 s. The override, the faithful-compose allowlist and the secret scan are untouched. **Result (added in build 030):** the check passed in GitHub Actions run 42828271674 (commit 640a69d; `build` and `docker` jobs succeeded): PID 1 of the app container is the Next server; `docker compose stop app` took 188 ms, exit code 0, under Docker's default grace period, no SIGKILL (figures as reported by root; the builder had no Docker and did not read the logs). It is one stop of an idle server on a CI runner, not an operator host.

## Evidence and what is not claimed

- Historical CI evidence for the smoke test is GitHub Actions run 41401896088 (commit e91b01c, build 023). The maintainer reported run 42755324291 (build 028) as the current run; the builder has not seen its logs, cites it only as reported, and notes it predates the stop check, so it holds no result for it.
- Not claimed: any run on an operator host, any public domain or publicly trusted certificate, a stop time under load or on an operator host (the 188 ms figure above is one idle stop in CI), SIGTERM behaviour of the real Next server in the builder's own tests (only stand-ins were used locally; CI observed the real one), or launch readiness.

## Regression found by root's full run, and its fix

`tests/deploymentScripts.test.ts` ("every operator script that compose.yaml or the deployment guide runs in the container is copied into the runtime image") failed because it reported `scripts/ci-compose-smoke.ts` and its imports as not copied into the runtime image. Inspection shows the cause was **not** the guide's host-side smoke command (that line does not match the checker's `docker compose exec|run` filter, and the guide's `npm run ci:compose-smoke` was already out of scope). The checker scans **all of `compose.yaml` without a filter, comments included**, and two comments added in this build named `scripts/ci-compose-smoke.ts`.

Fix, without copying any CI tool into the image and without narrowing what counts as an in-container script:

- The checker now builds the in-container list with `containerScriptsReferenced`: compose.yaml's **non-comment lines** (service commands and healthchecks) plus the guide's explicit `docker compose exec|run` lines. A full-line YAML comment runs nothing, so a script named in one is not a command. The guide filter is unchanged.
- The two compose.yaml comments no longer name the CI script path (they say "the CI compose smoke test").
- The guide's smoke-test sentence now says plainly that it is a host-side command run from a checkout, never inside the runtime container, which deliberately lacks the CI tools. The runnable command is unchanged.
- A new test feeds the checker synthetic compose and guide text: a script named only in a comment, the host-side smoke command, and a non-exec guide line are ignored; real `command:` entries and `docker compose exec` / `run` lines are collected; an unpackaged one and a missing one are still reported; the CI tool is never demanded; the same script on a `docker compose exec` line is still collected. A second assertion checks the real files: the guide documents `npm run ci:compose-smoke` and no `scripts/ci-*` path is in the real in-container list.

Status: written without being able to run anything (shell commands refused for lack of approval); needs root's rerun of `tests/deploymentScripts.test.ts` and the full suite.

## Validation

The builder's validation status is recorded in the final report for this build and is updated here by whoever runs it. See the report; no result is recorded in this file by the builder.
