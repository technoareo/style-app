# Verified earlier Linux CI evidence

Root retrieved GitHub Actions run and job records plus decoded logs through the connected GitHub read tools. Run [38347611817](https://github.com/technoareo/style-app/actions/runs/38347611817), push event, commit `df3b3d2750b136d164b95461306854cd3056e6cd`, completed successfully on 2026-10-13. Build job115132535808 and Docker job115133693243 both succeeded. This is build016 PART1, before local part2 and revision2; it does not verify the corrected working tree.

The checked-in workflow uses Ubuntu and executes typecheck, lint, full backend tests, production build/packaging, isolated standalone verification, Chromium browser tests, then a Docker image build and an app/AI-worker/mail-worker smoke test with a mock model. Retrieved step records show each succeeded. Root inspected the actual log totals below. This establishes a real Linux/container run for that commit, superseding the blanket historical statement that no Linux execution has ever occurred. It does not establish public deployment, Caddy/TLS, real AI, SMTP delivery, offsite backup, real phones, or current-candidate acceptance. Windows full-suite contention history is still relevant.

Selected exact log lines:
```text
2026-10-13T04:42:31.6840372Z ℹ tests 269
2026-10-13T04:42:31.6841009Z ℹ pass 267
2026-10-13T04:42:31.6841261Z ℹ fail 0
2026-10-13T04:42:31.6841897Z ℹ skipped 2
2026-10-13T04:43:03.0631727Z Packaging check passed in style-app: trace manifests and the standalone tree contain no private runtime paths (paths only; no file contents were read).
2026-10-13T04:43:03.3516252Z Packaging check passed in style-app: trace manifests and the standalone tree contain no private runtime paths (paths only; no file contents were read).
2026-10-13T04:43:04.8565911Z Standalone check passed: the bundle started and served real routes from an isolated copy with no ancestor node_modules.
2026-10-13T04:45:19.7276712Z   1 skipped
2026-10-13T04:45:19.7276980Z   37 passed (1.8m)
2026-10-13T04:46:49.8878861Z Docker smoke passed: app, AI worker (mock model) and mail worker cooperate.
```
